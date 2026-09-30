/**
 * 宿主原生 agent 文件的落盘与回收：`.claude/agents/tenon-<name>.md`、`.codex/agents/tenon-<name>.toml`。
 *
 * 所有权记在项目根的 `.pipeline-owned.json`（path → 内容 hash，与 `tenon uninstall` 同一份清单）：
 *   · 只写三种情况：文件不存在、内容已经相同（补记所有权）、清单里记着且用户没改过；
 *   · 同名文件不归 Tenon（清单里没有）或被用户改过 → 不碰，该 agent 退回通用子代理；
 *   · 回收只删清单里记着且没被改过的文件，改过的保留（卸载同样保留）。
 * 同一项目的多个任务共用这些文件：生成按冻结内容覆盖，回收只删没有任何在途任务引用的名字。
 * 这些文件与清单都不属于实现候选（workspace fingerprint 排除），生成与回收不会让在途任务的评审过期。
 */
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  HOST_AGENT_FALLBACK, hostAgentName, hostAgentPath, parseHostAgentPath, renderHostAgent, type HostAgentHost,
} from '../agents/host-native.js'
import type { AgentDefinition } from '../agents/types.js'
import { withLock } from '../state/lock.js'
import {
  OWNED_MANIFEST, computeContentHash, isOwnedModified, parseOwnedManifest, serializeOwnedManifest,
} from '../state/ownership-manifest.js'

export const HOST_AGENT_OWNED_MANIFEST = OWNED_MANIFEST

export interface HostAgentFileOutcome {
  readonly agent: string
  readonly host: HostAgentHost
  /** 仓库相对路径（POSIX）。 */
  readonly path: string
  /** 宿主派发时用的子代理类型：生成成功 = `tenon-<name>`，否则通用子代理。 */
  readonly subagentType: string
  readonly native: boolean
  readonly state: 'written' | 'unchanged' | 'foreign' | 'modified' | 'failed'
  readonly detail?: string
}

export interface HostAgentPruneResult {
  readonly removed: readonly string[]
  /** 用户改过、按规则保留的文件。 */
  readonly preserved: readonly string[]
}

const lockDirOf = (repoRoot: string): string => join(repoRoot, '.tenon')
const manifestPath = (repoRoot: string): string => join(repoRoot, OWNED_MANIFEST)
const abs = (repoRoot: string, rel: string): string => join(repoRoot, ...rel.split('/'))

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

/** 路径上任何一段（相对仓库根）是符号链接就拒绝：写穿链接会落到仓库外。 */
async function unsafePath(repoRoot: string, rel: string): Promise<boolean> {
  const parts = rel.split('/')
  for (let index = 1; index <= parts.length; index++) {
    if (await isSymlink(abs(repoRoot, parts.slice(0, index).join('/')))) return true
  }
  return false
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

async function saveManifest(repoRoot: string, map: Record<string, string>): Promise<void> {
  if (Object.keys(map).length === 0) {
    await unlink(manifestPath(repoRoot)).catch(() => {})
    return
  }
  await writeAtomic(manifestPath(repoRoot), serializeOwnedManifest(map))
}

async function withManifest<T>(
  repoRoot: string,
  fn: (manifest: Record<string, string>) => Promise<{ readonly next: Record<string, string>; readonly result: T }>,
): Promise<T> {
  await mkdir(lockDirOf(repoRoot), { recursive: true })
  return withLock(lockDirOf(repoRoot), async () => {
    const text = await readText(manifestPath(repoRoot))
    const before = text === undefined ? {} : parseOwnedManifest(text)
    const { next, result } = await fn({ ...before })
    if (serializeOwnedManifest(next) !== serializeOwnedManifest(before)) await saveManifest(repoRoot, next)
    return result
  })
}

const fallback = (
  agent: string, host: HostAgentHost, path: string, state: HostAgentFileOutcome['state'], detail: string,
): HostAgentFileOutcome => ({ agent, host, path, subagentType: HOST_AGENT_FALLBACK[host], native: false, state, detail })

/**
 * 为一个宿主生成这些 agent 的原生文件（幂等）。每个 agent 各自成败：失败的退回通用子代理，
 * 结果里写明原因；清单在同一把锁里一次写回。
 */
export async function ensureHostAgentFiles(input: {
  readonly repoRoot: string
  readonly host: HostAgentHost
  readonly agents: readonly { readonly name: string; readonly definition: AgentDefinition }[]
}): Promise<readonly HostAgentFileOutcome[]> {
  const { repoRoot, host } = input
  return withManifest(repoRoot, async (manifest) => {
    const outcomes: HostAgentFileOutcome[] = []
    for (const { name, definition } of input.agents) {
      const path = hostAgentPath(host, name)
      const content = renderHostAgent(host, definition)
      const native: HostAgentFileOutcome = { agent: name, host, path, subagentType: hostAgentName(name), native: true, state: 'written' }
      try {
        if (await unsafePath(repoRoot, path)) {
          outcomes.push(fallback(name, host, path, 'failed', '路径含符号链接，拒绝写入'))
          continue
        }
        const current = await readText(abs(repoRoot, path))
        const stored = manifest[path]
        if (current === content) {
          manifest[path] = computeContentHash(content)
          outcomes.push({ ...native, state: 'unchanged' })
          continue
        }
        if (current !== undefined && stored === undefined) {
          outcomes.push(fallback(name, host, path, 'foreign', '同名文件不是 Tenon 生成的，未覆盖'))
          continue
        }
        if (current !== undefined && isOwnedModified(current, stored)) {
          outcomes.push(fallback(name, host, path, 'modified', '文件被改过，未覆盖'))
          continue
        }
        await writeAtomic(abs(repoRoot, path), content)
        manifest[path] = computeContentHash(content)
        outcomes.push(native)
      } catch (error) {
        outcomes.push(fallback(name, host, path, 'failed', error instanceof Error ? error.message : String(error)))
      }
    }
    return { next: manifest, result: outcomes }
  })
}

/** 清单里记着的 Tenon 宿主 agent 名（任一宿主）。 */
export async function ownedHostAgentNames(repoRoot: string): Promise<readonly string[]> {
  const text = await readText(manifestPath(repoRoot))
  const manifest = text === undefined ? {} : parseOwnedManifest(text)
  const names = new Set<string>()
  for (const key of Object.keys(manifest)) {
    const parsed = parseHostAgentPath(key)
    if (parsed !== null) names.add(parsed.name)
  }
  return [...names].sort()
}

async function removeEmptyDir(path: string): Promise<void> {
  await rmdir(path).catch(() => {})
}

/**
 * 回收不再被任何在途任务引用的宿主 agent 文件：清单里记着、名字不在 keep 里的逐个处理。
 * 没改过 → 删文件、去掉清单项；改过 → 保留；文件已不在 → 只去掉清单项。删空的 agents 目录顺手移除。
 */
export async function pruneHostAgentFiles(input: {
  readonly repoRoot: string
  readonly keep: ReadonlySet<string>
}): Promise<HostAgentPruneResult> {
  const { repoRoot } = input
  return withManifest(repoRoot, async (manifest) => {
    const removed: string[] = []
    const preserved: string[] = []
    const touchedDirs = new Set<string>()
    for (const [key, hash] of Object.entries(manifest)) {
      const parsed = parseHostAgentPath(key)
      if (parsed === null || input.keep.has(parsed.name)) continue
      if (await unsafePath(repoRoot, key)) {
        preserved.push(key)
        continue
      }
      const current = await readText(abs(repoRoot, key))
      if (current === undefined) {
        delete manifest[key]
        continue
      }
      if (isOwnedModified(current, hash)) {
        preserved.push(key)
        continue
      }
      await unlink(abs(repoRoot, key))
      delete manifest[key]
      removed.push(key)
      touchedDirs.add(dirname(key))
    }
    for (const dir of touchedDirs) {
      await removeEmptyDir(abs(repoRoot, dir))
      // `.claude/agents` 的父目录 `.claude`（`.codex` 同理）多半是 Tenon 为第一个文件建出来的；空了就一并移除，
      // 里面还有用户自己的东西时 rmdir 失败，原样保留。
      const parent = dirname(dir)
      if (parent !== '.' && !parent.includes('/')) await removeEmptyDir(abs(repoRoot, parent))
    }
    return { next: manifest, result: { removed, preserved } }
  })
}
