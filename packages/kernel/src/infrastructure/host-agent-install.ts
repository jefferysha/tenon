/**
 * 宿主原生 agent 的用户级安装与卸载：`<Claude 配置目录>/agents/tenon-<name>.md`、`<Codex 配置目录>/agents/tenon-<name>.toml`。
 * 配置目录取环境变量 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`（绝对路径才采用），否则 `~/.claude`、`~/.codex`；宿主只读它自己的
 * 配置目录，所以安装、卸载与派发判定都要用 `hostAgentsDir` 解析出的同一个目录（调用方传进来，本文件不读 `process.env`）。
 * 只在终端里由 `tenon agent install|uninstall` 调用；会话内的命令不写这些文件（会话中途新增的子代理文件什么时候被宿主
 * 加载不可预期，只有会话启动前就存在的才可靠）。
 *
 * 所有权记在 `<configRoot>/agents/host-owned.json`：`{ "<子代理目录绝对路径>": { "<hostAgentPath 相对路径>": "<内容 hash>" } }`。
 *   · 按子代理目录分组：安装、卸载只读写当前目录那一组，其余分组（含开发期按宿主名写下的 `claude` / `codex` 组）原样保留、
 *     不解释——在一个目录上操作不会删除、改写或认领另一个目录里的文件；
 *   · 只写三种情况：文件不存在、内容已经相同（补记所有权）、清单记着且内容仍与记录一致；
 *   · 同名文件不在清单里（用户自有）或被改过 → 不碰，结果里列出；
 *   · 不再需要的 agent（清单记着、这次没传）：没改过 → 删，改过 → 保留（安装结果 preserved，卸载结果 modified）；
 *     卸载就是「一个都不需要」；库里还在但这次装不了的（`keep`）不回收，库整体读不出来时（`reclaim: false`）整个跳过回收；
 *   · 只有目标文件本身是符号链接才拒绝；父目录（例如 dotfiles 管理的 `~/.claude`）是符号链接照常读写；
 *   · 清单读不出来（损坏）→ 无法确认谁写的：已有文件一律不改不删，只写不存在的文件，且不动清单，由调用方提示用户处理。
 * 清单的读改写在 `<configRoot>/agents/.host-owned.lock` 的锁里完成；先落文件、后落清单——中途失败时文件已写而清单没记，
 * 下次安装要么内容相同补记，要么当作用户自有文件不覆盖，不会误删。
 */
import { lstat, mkdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { hostAgentPath, parseHostAgentPath, renderHostAgent, type HostAgentHost } from '../agents/host-native.js'
import type { AgentDefinition } from '../agents/types.js'
import { absoluteDirectory } from '../instructions/hosts.js'
import { withLock } from '../state/lock.js'
import { computeContentHash, isOwnedModified } from '../state/ownership-manifest.js'
import { inspectFile, isNotFound, writeAtomic } from './host-agent-fs.js'

export type HostInstallState = 'written' | 'unchanged' | 'foreign' | 'modified' | 'removed' | 'preserved' | 'failed'

export interface HostInstallOutcome {
  readonly agent: string
  /** 用户级文件的绝对路径（清单损坏时是清单本身）。 */
  readonly path: string
  readonly state: HostInstallState
  readonly detail?: string
}

/** 子代理目录（绝对路径）→ `hostAgentPath` 相对路径（POSIX）→ 内容 hash。 */
type OwnedByDir = Record<string, Record<string, string>>
type ManifestState = { readonly ok: true; readonly owned: OwnedByDir } | { readonly ok: false }

const CORRUPT_INSTALL = '清单损坏（用户级 host-owned.json 无法解析）：已有文件一律未改动，新写入的文件未记所有权；修复或删除该清单后重新安装'
const CORRUPT_UNINSTALL = '清单损坏（用户级 host-owned.json 无法解析）：无法确定哪些文件由 Tenon 写入，未删除任何文件；修复或删除该清单后重试'

const manifestFile = (configRoot: string): string => join(configRoot, 'agents', 'host-owned.json')
const lockRoot = (configRoot: string): string => join(configRoot, 'agents', '.host-owned.lock')

/** 宿主配置目录的环境变量与默认目录（相对 home）。 */
const CONFIG_DIR: Readonly<Record<HostAgentHost, { readonly env: string; readonly fallback: string }>> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', fallback: '.claude' },
  codex: { env: 'CODEX_HOME', fallback: '.codex' },
}

/** 宿主读用户级子代理的目录：配置目录取环境变量（绝对路径才采用，与用户级 AGENTS.md 同一判定），否则 home 下的默认目录。 */
export function hostAgentsDir(host: HostAgentHost, context: {
  readonly homeDir: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: NodeJS.Platform
}): string {
  const { env, fallback } = CONFIG_DIR[host]
  return join(absoluteDirectory(context.env[env], context.platform) ?? join(context.homeDir, fallback), 'agents')
}

/** 用户级宿主 agent 文件的绝对路径：子代理目录 + `tenon-<name>.<扩展名>`（文件名沿用 `hostAgentPath`）。 */
export function userHostAgentPath(agentsDir: string, host: HostAgentHost, name: string): string {
  return join(agentsDir, posix.basename(hostAgentPath(host, name)))
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function outcome(agent: string, path: string, state: HostInstallState, detail?: string): HostInstallOutcome {
  return detail === undefined ? { agent, path, state } : { agent, path, state, detail }
}

/** 形状不对（含非法 JSON）返回 undefined；用 fromEntries 建对象，`__proto__` 之类的键只会成为普通字段。 */
function parseManifest(text: string): OwnedByDir | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const groups: [string, Record<string, string>][] = []
  for (const [group, entries] of Object.entries(parsed)) {
    if (!isRecord(entries)) return undefined
    const pairs = Object.entries(entries)
    if (!pairs.every((pair): pair is [string, string] => typeof pair[1] === 'string')) return undefined
    groups.push([group, Object.fromEntries(pairs)])
  }
  return Object.fromEntries(groups)
}

/** 确定性序列化（键排序、2 空格、尾换行）；没有任何条目时返回空串，表示不需要清单文件。 */
function serializeManifest(owned: OwnedByDir): string {
  const sorted: OwnedByDir = {}
  for (const group of Object.keys(owned).sort()) {
    const entries = owned[group] ?? {}
    const keys = Object.keys(entries).sort()
    if (keys.length > 0) sorted[group] = Object.fromEntries(keys.map((key) => [key, entries[key] ?? '']))
  }
  return Object.keys(sorted).length === 0 ? '' : `${JSON.stringify(sorted, null, 2)}\n`
}

async function readManifest(configRoot: string): Promise<ManifestState> {
  let text: string
  try {
    text = await readFile(manifestFile(configRoot), 'utf8')
  } catch (error) {
    return isNotFound(error) ? { ok: true, owned: {} } : { ok: false }
  }
  const owned = parseManifest(text)
  return owned === undefined ? { ok: false } : { ok: true, owned }
}

async function saveManifest(configRoot: string, owned: OwnedByDir): Promise<void> {
  const text = serializeManifest(owned)
  if (text !== '') return writeAtomic(manifestFile(configRoot), text)
  try {
    await unlink(manifestFile(configRoot))
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

/** 锁内读清单 → 执行 → 内容有变化才写回；清单损坏时不写回（原样留给用户处理）。 */
async function withManifest<T>(
  configRoot: string,
  fn: (state: ManifestState) => Promise<{ readonly next: OwnedByDir; readonly result: T }>,
): Promise<T> {
  await mkdir(lockRoot(configRoot), { recursive: true })
  return withLock(lockRoot(configRoot), async () => {
    const state = await readManifest(configRoot)
    const { next, result } = await fn(state)
    if (state.ok && serializeManifest(next) !== serializeManifest(state.owned)) await saveManifest(configRoot, next)
    return result
  })
}

async function installOne(
  agentsDir: string,
  host: HostAgentHost,
  hostMap: Record<string, string>,
  trusted: boolean,
  agent: { readonly name: string; readonly definition: AgentDefinition },
): Promise<HostInstallOutcome> {
  const rel = hostAgentPath(host, agent.name)
  // 名字要能被 parseHostAgentPath 原样反解：挡住含 `/`、`..` 的名字，路径不会逃出宿主 agents 目录。
  if (parseHostAgentPath(rel) === null) return outcome(agent.name, rel, 'failed', 'agent 名不合法，拒绝写入')
  const path = userHostAgentPath(agentsDir, host, agent.name)
  try {
    const content = renderHostAgent(host, agent.definition)
    const target = await inspectFile(path)
    if (target.kind === 'link') return outcome(agent.name, path, 'failed', '目标文件是符号链接，拒绝写入')
    if (target.kind === 'file') {
      if (target.text === content) {
        if (trusted) hostMap[rel] = computeContentHash(content)
        return outcome(agent.name, path, 'unchanged')
      }
      const stored = trusted ? hostMap[rel] : undefined
      if (stored === undefined) return outcome(agent.name, path, 'foreign', '同名文件不是 Tenon 写入的，未覆盖')
      if (isOwnedModified(target.text, stored)) return outcome(agent.name, path, 'modified', '文件被改过，未覆盖')
    }
    await writeAtomic(path, content)
    if (trusted) hostMap[rel] = computeContentHash(content)
    return outcome(agent.name, path, 'written')
  } catch (error) {
    return outcome(agent.name, path, 'failed', errorMessage(error))
  }
}

/**
 * 回收清单里记着、名字不在 keep 里的文件：没改过 → 删；改过 → 保留，结果状态由 `editedState` 给（安装时是 preserved，
 * 卸载时是 modified）；符号链接 → 保留（preserved）；文件已不在 → 只移出清单。
 */
async function reclaim(
  agentsDir: string,
  host: HostAgentHost,
  hostMap: Record<string, string>,
  keep: ReadonlySet<string>,
  editedState: 'preserved' | 'modified',
): Promise<HostInstallOutcome[]> {
  const outcomes: HostInstallOutcome[] = []
  let removedAny = false
  for (const [rel, hash] of Object.entries(hostMap)) {
    // 清单是用户可写的文件：只认能被 parseHostAgentPath 反解的条目，绝对路径由当前子代理目录与名字重新拼，不信任清单里的键。
    const parsed = parseHostAgentPath(rel)
    if (parsed === null || parsed.host !== host || keep.has(parsed.name)) continue
    const path = userHostAgentPath(agentsDir, host, parsed.name)
    try {
      const target = await inspectFile(path)
      if (target.kind === 'missing') {
        delete hostMap[rel]
      } else if (target.kind === 'link') {
        outcomes.push(outcome(parsed.name, path, 'preserved', '目标文件是符号链接，保留'))
      } else if (isOwnedModified(target.text, hash)) {
        outcomes.push(outcome(parsed.name, path, editedState, '文件被改过，保留'))
      } else {
        await unlink(path)
        delete hostMap[rel]
        removedAny = true
        outcomes.push(outcome(parsed.name, path, 'removed'))
      }
    } catch (error) {
      outcomes.push(outcome(parsed.name, path, 'failed', errorMessage(error)))
    }
  }
  // agents 目录删空了就移除（里面还有用户自己的文件时 rmdir 失败，原样保留）；它的父目录（配置目录）永远不动。
  if (removedAny) await rmdir(agentsDir).catch(() => {})
  return outcomes
}

/**
 * 为一个宿主在子代理目录 `agentsDir`（`hostAgentsDir` 解析出的）里安装这些 agent（幂等）。每个 agent 各自成败；传入列表里没有、
 * 但清单里 `agentsDir` 这一组记着的 agent 文件按回收规则处理，别的子代理目录的分组不碰。
 * 库里还在、只是这次装不了（解析失败、读失败）的 agent 由调用方按名字放进 `keep`：不装也不回收，已装的文件原样留着；
 * 库整体读不出来（没有一个可用条目）时调用方传 `reclaim: false`，整个跳过回收——此时「不在传入列表里」不代表「库里已删除」。
 * 清单损坏时已有文件一概不动，所有非 failed 的结果都带损坏说明。
 */
export async function installHostAgents(input: {
  readonly agentsDir: string
  readonly configRoot: string
  readonly host: HostAgentHost
  readonly agents: readonly { readonly name: string; readonly definition: AgentDefinition }[]
  /** 不回收的 agent 名（库里还在、这次无法安装）。 */
  readonly keep?: readonly string[]
  /** `false` = 整个跳过回收；缺省 `true`。 */
  readonly reclaim?: boolean
}): Promise<readonly HostInstallOutcome[]> {
  const { agentsDir, configRoot, host } = input
  return withManifest(configRoot, async (state) => {
    const owned = state.ok ? state.owned : {}
    const hostMap = { ...(owned[agentsDir] ?? {}) }
    const outcomes: HostInstallOutcome[] = []
    for (const agent of input.agents) outcomes.push(await installOne(agentsDir, host, hostMap, state.ok, agent))
    if (!state.ok) {
      const noted = outcomes.map((o) => (o.state === 'failed' ? o : outcome(o.agent, o.path, o.state, CORRUPT_INSTALL)))
      return { next: owned, result: noted }
    }
    if (input.reclaim !== false) {
      const keep = new Set([...input.agents.map((agent) => agent.name), ...(input.keep ?? [])])
      outcomes.push(...await reclaim(agentsDir, host, hostMap, keep, 'preserved'))
    }
    return { next: { ...owned, [agentsDir]: hostMap }, result: outcomes }
  })
}

/** 删除清单里 `agentsDir` 这一组记着且未被改动的用户级文件；改过的保留。该目录没有条目、或还没有清单时什么都不做。 */
export async function uninstallHostAgents(input: {
  readonly agentsDir: string
  readonly configRoot: string
  readonly host: HostAgentHost
}): Promise<readonly HostInstallOutcome[]> {
  const { agentsDir, configRoot, host } = input
  try {
    await lstat(manifestFile(configRoot))
  } catch (error) {
    // 没有清单 = Tenon 没写过任何用户级文件：直接返回，不为此创建锁目录。
    if (isNotFound(error)) return []
  }
  return withManifest(configRoot, async (state) => {
    if (!state.ok) {
      return { next: {}, result: [outcome('host-owned.json', manifestFile(configRoot), 'failed', CORRUPT_UNINSTALL)] }
    }
    const hostMap = { ...(state.owned[agentsDir] ?? {}) }
    const outcomes = await reclaim(agentsDir, host, hostMap, new Set(), 'modified')
    return { next: { ...state.owned, [agentsDir]: hostMap }, result: outcomes }
  })
}
