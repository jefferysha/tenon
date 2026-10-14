/**
 * 旧版本写进项目里的宿主 agent 文件的清理：`.claude/agents/tenon-<name>.md`、`.codex/agents/tenon-<name>.toml`。
 *
 * 新版本不再往项目里写这些文件（专属子代理只来自 `tenon agent install` 写的用户级文件），但升级前的项目里还留着旧文件，
 * 它们优先级高于用户级文件，会把新装的子代理遮住。清理只做「删」：
 *   · 所有权记在项目根的 `.pipeline-owned.json`（path → 内容 hash，与 `tenon uninstall` 同一份清单）；
 *   · 删除依据取其一：清单记着且内容仍与记录摘要一致（没被改过）；或内容与当前库对应 agent 的渲染结果一致
 *     （覆盖清单条目已被 `sync --migrate` 剪掉的情况）。不再按「在途任务是否引用」区分——文件不再是任务产物；
 *   · 其余文件（被改过、不在清单且与当前渲染不同、读不了）一律保留，由调用方警告；
 *   · 路径上任何一段（父目录或文件本身）是符号链接就保留：删除不会落到仓库外；
 *   · 项目根是 linked worktree 时，按 git common dir 找到主检出再清理——旧文件与清单都在主检出。
 * 这些文件与清单都不属于实现候选（workspace fingerprint 排除），清理不会让在途任务的评审过期。
 */
import { lstat, mkdir, readdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  HOST_AGENT_HOSTS, hostAgentPath, parseHostAgentPath, renderHostAgent, type HostAgentHost,
} from '../agents/host-native.js'
import { withLock } from '../state/lock.js'
import {
  OWNED_MANIFEST, isOwnedModified, parseOwnedManifest, serializeOwnedManifest,
} from '../state/ownership-manifest.js'
import { mainCheckoutOf } from '../workspace/main-checkout.js'
import { effectiveAgent, type AgentLibrary } from './agent-store.js'
import { inspectFile, writeAtomic } from './host-agent-fs.js'

export interface LegacyHostAgentCleanup {
  /** 已删除的文件（主检出相对路径，POSIX），按路径排序。 */
  readonly removed: readonly string[]
  /** 按规则保留的文件（被改过、与当前渲染不同、含符号链接或读不了），调用方负责警告。 */
  readonly preserved: readonly string[]
}

/**
 * 把读到的 agent 库变成清理用的 `renderCurrent`：库里生效的那个 agent 适用于该宿主时返回它的渲染结果，
 * 没有 / 解析失败 / `hosts` 不含该宿主一律 undefined。CLI 与 Dashboard 服务端共用这一份，两边的删除依据不会分叉。
 */
export function renderCurrentFromLibrary(library: AgentLibrary): (host: HostAgentHost, name: string) => string | undefined {
  return (host, name) => {
    const definition = effectiveAgent(library, name)?.definition
    if (definition === undefined) return undefined
    return definition.hosts === undefined || definition.hosts.includes(host) ? renderHostAgent(host, definition) : undefined
  }
}

const lockDirOf = (root: string): string => join(root, '.tenon')
const manifestPath = (root: string): string => join(root, OWNED_MANIFEST)
const abs = (root: string, rel: string): string => join(root, ...rel.split('/'))
/** 宿主的 agents 目录（仓库相对，POSIX）：`.claude/agents`、`.codex/agents`。 */
const agentsDirOf = (host: HostAgentHost): string => dirname(hostAgentPath(host, 'x'))

/**
 * 要清理的项目根：项目根本身是 linked worktree 的顶层（顶层的 `.git` 是指针文件，主检出与普通仓库里它是目录）时指向主检出，
 * 其余一律清理项目根自己——包括主检出的子目录（monorepo 里的包），那里旧版本写的文件就在子目录下。
 * 先看 `.git` 再决定要不要调 git：绝大多数命令不在 worktree 里，也就不必起 git 进程。
 */
async function legacyRootOf(repoRoot: string): Promise<string> {
  const dotGit = await lstat(join(repoRoot, '.git')).catch(() => undefined)
  if (dotGit?.isFile() !== true) return repoRoot
  return (await mainCheckoutOf(repoRoot)) ?? repoRoot
}

async function readManifest(root: string): Promise<Record<string, string>> {
  try {
    return parseOwnedManifest(await readFile(manifestPath(root), 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 候选文件：清单里记着的宿主 agent 路径；给了 `renderCurrent` 时再加上两个 agents 目录里的 `tenon-*` 文件
 * （没有当前渲染可比时，清单外的文件无从判断，既不删也不报告）。
 */
async function candidatesOf(root: string, manifest: Record<string, string>, scanDirs: boolean): Promise<readonly string[]> {
  const found = new Set(Object.keys(manifest).filter((key) => parseHostAgentPath(key) !== null))
  if (scanDirs) {
    for (const host of HOST_AGENT_HOSTS) {
      const dir = agentsDirOf(host)
      const names = await readdir(abs(root, dir)).catch(() => [] as string[])
      for (const name of names) if (parseHostAgentPath(`${dir}/${name}`) !== null) found.add(`${dir}/${name}`)
    }
  }
  return [...found].sort()
}

/** 文件所在的任何一级父目录（相对仓库根）是符号链接 → 删除会落到仓库外，不碰。 */
async function hasLinkedParent(root: string, rel: string): Promise<boolean> {
  const parts = rel.split('/').slice(0, -1)
  for (let index = 1; index <= parts.length; index++) {
    try {
      if ((await lstat(abs(root, parts.slice(0, index).join('/')))).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

async function saveManifest(root: string, map: Record<string, string>): Promise<void> {
  if (Object.keys(map).length === 0) {
    await unlink(manifestPath(root)).catch(() => {})
    return
  }
  await writeAtomic(manifestPath(root), serializeOwnedManifest(map))
}

/** 清单的读改写在 `.tenon` 锁里完成；内容有变化才写回。清单损坏时读出来是空的，不会有变化，也就不会被覆盖。 */
async function withManifest<T>(
  root: string,
  fn: (manifest: Record<string, string>) => Promise<{ readonly next: Record<string, string>; readonly result: T }>,
): Promise<T> {
  await mkdir(lockDirOf(root), { recursive: true })
  return withLock(lockDirOf(root), async () => {
    const before = await readManifest(root)
    const { next, result } = await fn({ ...before })
    if (serializeOwnedManifest(next) !== serializeOwnedManifest(before)) await saveManifest(root, next)
    return result
  })
}

/** agents 目录删空了就移除；它的父目录（`.claude`、`.codex`）多半是 Tenon 为第一个文件建出来的，空了一并移除。 */
async function removeEmptyDirs(root: string, dirs: ReadonlySet<string>): Promise<void> {
  for (const dir of dirs) {
    await rmdir(abs(root, dir)).catch(() => {})
    // 里面还有用户自己的东西时 rmdir 失败，原样保留。
    const parent = dirname(dir)
    if (parent !== '.' && !parent.includes('/')) await rmdir(abs(root, parent)).catch(() => {})
  }
}

/**
 * 清理项目主检出里旧版本写入的宿主 agent 文件（幂等）。没有任何候选时不加锁、不创建任何目录。
 * 每个文件各自成败：处理不了的（含读写错误）列进 `preserved`，不影响其余文件；整体失败（如锁目录建不出）才抛出，
 * 调用方应当只警告、不让所在命令失败。
 */
export async function cleanupLegacyHostAgents(input: {
  readonly repoRoot: string
  /** 当前库对 `(host, name)` 的渲染结果（`renderCurrentFromLibrary`）；缺省（没装配库或读库失败）= 只按清单删。 */
  readonly renderCurrent?: (host: HostAgentHost, name: string) => string | undefined
}): Promise<LegacyHostAgentCleanup> {
  const root = await legacyRootOf(input.repoRoot)
  const scanDirs = input.renderCurrent !== undefined
  if ((await candidatesOf(root, await readManifest(root), scanDirs)).length === 0) return { removed: [], preserved: [] }
  return withManifest(root, async (manifest) => {
    const removed: string[] = []
    const preserved: string[] = []
    const touchedDirs = new Set<string>()
    for (const rel of await candidatesOf(root, manifest, scanDirs)) {
      const parsed = parseHostAgentPath(rel)
      if (parsed === null) continue
      try {
        if (await hasLinkedParent(root, rel)) {
          preserved.push(rel)
          continue
        }
        const target = await inspectFile(abs(root, rel))
        if (target.kind === 'missing') {
          delete manifest[rel]
          continue
        }
        if (target.kind === 'link') {
          preserved.push(rel)
          continue
        }
        const stored = manifest[rel]
        const untouched = stored !== undefined && !isOwnedModified(target.text, stored)
        if (!untouched && input.renderCurrent?.(parsed.host, parsed.name) !== target.text) {
          preserved.push(rel)
          continue
        }
        await unlink(abs(root, rel))
        delete manifest[rel]
        removed.push(rel)
        touchedDirs.add(dirname(rel))
      } catch {
        preserved.push(rel)
      }
    }
    await removeEmptyDirs(root, touchedDirs)
    return { next: manifest, result: { removed, preserved } }
  })
}
