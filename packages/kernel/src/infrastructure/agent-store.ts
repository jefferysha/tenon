/**
 * agent 库的三层存储：官方 `<configRoot>/agents/builtin`、用户级 `<configRoot>/agents/custom`、
 * 项目级 `<projectRoot>/.tenon/agents`（随仓库提交，团队共享）。
 *
 * builtin 由 syncBuiltinLibraries 按 payload 摘要整份同步（只读，装完或升级后第一次读时收敛）；
 * custom / project 由 `tenon agent` 与 Dashboard 读写，写入前必须能解析，所以盘上的这两层始终合法。
 * 同名：project 优先于 custom（custom 记 shadowedBy）；任何一层与官方同名都是冲突，官方从不被覆盖。
 * 读取从不因单个坏文件失败：解析不了的 agent 进 entry.error，其余照常返回。
 */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { agentDigest, parseAgentFile } from '../agents/parse.js'
import { AGENT_FILE_MAX_BYTES, AGENT_NAME_RE, type AgentDefinition, type AgentSource } from '../agents/types.js'
import { agentsReferenced } from '../state/agent-freeze.js'
import { withLock } from '../state/lock.js'
import type { WorkflowIR } from '../workflow/ir.js'
import { builtinLibrary, syncBuiltinLibrary, type BuiltinSyncResult } from './builtin-library-sync.js'

export type AgentStoreErrorCode =
  | 'agent-missing' | 'agent-invalid' | 'agent-conflict' | 'agent-exists'
  | 'agent-builtin-readonly' | 'agent-stale'

export class AgentStoreError extends Error {
  readonly code: AgentStoreErrorCode
  constructor(code: AgentStoreErrorCode, message: string) {
    super(message)
    this.name = 'AgentStoreError'
    this.code = code
  }
}

export interface AgentStoreOptions {
  /** 插件根目录；builtin agent 从 `<payloadRoot>/templates/agents` 同步。 */
  readonly payloadRoot: string
  /** 全局 config 根；agent 落在 `<configRoot>/agents/{builtin,custom}`。 */
  readonly configRoot: string
  /** 项目根；给出时一并读 `<projectRoot>/.tenon/agents`。 */
  readonly projectRoot?: string
}

export interface AgentEntry {
  readonly name: string
  readonly source: AgentSource
  readonly digest: string
  readonly content: string
  /** 文件绝对路径。 */
  readonly path?: string
  /** 解析失败或名称冲突时缺席。 */
  readonly definition?: AgentDefinition
  readonly error?: string
  /** 同名的项目级 agent 生效，本条（用户级）只列出不参与解析。 */
  readonly shadowedBy?: 'project'
}

export interface AgentLibrary {
  readonly entries: readonly AgentEntry[]
  readonly sync: BuiltinSyncResult
}

/** `<configRoot>/agents`。 */
export const agentStoreRoot = (configRoot: string): string => join(configRoot, 'agents')

/** `<projectRoot>/.tenon/agents`。 */
export const projectAgentsDir = (projectRoot: string): string => join(projectRoot, '.tenon', 'agents')

/** 可写的一层：自定义（用户级）或项目级。 */
export interface AgentScope {
  readonly source: 'custom' | 'project'
  readonly dir: string
  /** 官方副本所在目录；与它同名的写入一律拒绝。 */
  readonly builtinDir: string
  /** 写入时持有的锁目录。 */
  readonly lockDir: string
}

export function agentScope(
  source: 'custom' | 'project',
  options: { readonly configRoot: string; readonly projectRoot?: string },
): AgentScope {
  const storeRoot = agentStoreRoot(options.configRoot)
  const builtinDir = join(storeRoot, 'builtin')
  if (source === 'custom') return { source, dir: join(storeRoot, 'custom'), builtinDir, lockDir: storeRoot }
  if (options.projectRoot === undefined) throw new AgentStoreError('agent-invalid', '项目级 agent 需要项目根')
  const dir = projectAgentsDir(options.projectRoot)
  return { source, dir, builtinDir, lockDir: dir }
}

/** builtin 与其它层同名时给后者的错误文案；resolve 据它拒绝影子覆盖。 */
const CONFLICT = '名称冲突'

async function listAgents(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.md')).sort()
  } catch {
    return []
  }
}

/** builtin 同步：摘要相同直接返回 unchanged，失败不抛出（旧 builtin 原样保留）。 */
export async function ensureBuiltinAgents(options: AgentStoreOptions): Promise<BuiltinSyncResult> {
  return syncBuiltinLibrary(builtinLibrary('agents'), options.payloadRoot, options.configRoot)
}

function entryFor(name: string, source: AgentSource, path: string, content: string): AgentEntry {
  const digest = agentDigest(content)
  try {
    return { name, source, digest, content, path, definition: parseAgentFile(content, name) }
  } catch (error) {
    return { name, source, digest, content, path, error: error instanceof Error ? error.message : String(error) }
  }
}

async function readLayer(dir: string, source: AgentSource): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = []
  for (const file of await listAgents(dir)) {
    const name = file.slice(0, -'.md'.length)
    const path = join(dir, file)
    try {
      entries.push(entryFor(name, source, path, await readFile(path, 'utf8')))
    } catch (error) {
      entries.push({ name, source, digest: '', content: '', path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return entries
}

/** 读全量 agent 库；列出所有层的全部条目，冲突与被覆盖的条目带标记。 */
export async function loadAgentLibrary(options: AgentStoreOptions): Promise<AgentLibrary> {
  const sync = await ensureBuiltinAgents(options)
  const storeRoot = agentStoreRoot(options.configRoot)
  const builtin = await readLayer(join(storeRoot, 'builtin'), 'builtin')
  const custom = await readLayer(join(storeRoot, 'custom'), 'custom')
  const project = options.projectRoot === undefined ? [] : await readLayer(projectAgentsDir(options.projectRoot), 'project')
  const builtinNames = new Set(builtin.map((entry) => entry.name))
  const projectNames = new Set(project.filter((entry) => !builtinNames.has(entry.name)).map((entry) => entry.name))
  const layered = (entry: AgentEntry): AgentEntry => {
    if (builtinNames.has(entry.name)) {
      return {
        name: entry.name, source: entry.source, digest: entry.digest, content: entry.content,
        ...(entry.path === undefined ? {} : { path: entry.path }),
        error: CONFLICT,
      }
    }
    if (entry.source === 'custom' && projectNames.has(entry.name)) return { ...entry, shadowedBy: 'project' }
    return entry
  }
  return { entries: [...builtin, ...custom.map(layered), ...project.map(layered)], sync }
}

/** 名字对应的生效条目（可能不合法）；没有返回 undefined。 */
export function effectiveAgent(library: AgentLibrary, name: string): AgentEntry | undefined {
  const named = library.entries.filter((candidate) => candidate.name === name)
  return named.find((entry) => entry.source === 'project')
    ?? named.find((entry) => entry.source === 'custom' && entry.shadowedBy === undefined)
    ?? named.find((entry) => entry.source === 'builtin')
}

/** 取一个可用的 agent；缺失 / 不合法 / 冲突都抛出，工作流引用与冻结都走它。 */
export function resolveAgent(library: AgentLibrary, name: string): AgentEntry & { readonly definition: AgentDefinition } {
  const named = library.entries.filter((candidate) => candidate.name === name)
  if (named.some((candidate) => candidate.error === CONFLICT)) {
    throw new AgentStoreError('agent-conflict', `agent '${name}' 名称冲突（与官方 agent 同名）`)
  }
  const entry = effectiveAgent(library, name)
  if (entry === undefined) throw new AgentStoreError('agent-missing', `agent 库中不存在 '${name}'`)
  if (entry.definition === undefined) throw new AgentStoreError('agent-invalid', `agent '${name}' 无效：${entry.error ?? '解析失败'}`)
  return entry as AgentEntry & { readonly definition: AgentDefinition }
}

async function currentDigest(path: string): Promise<string | null> {
  try {
    return agentDigest(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function refuseSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new AgentStoreError('agent-invalid', `拒绝写入符号链接：${path}`)
  } catch (error) {
    if (error instanceof AgentStoreError) throw error
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await refuseSymlink(dirname(path))
  await refuseSymlink(path)
  const tmp = `${path}.tmp.${process.pid}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

async function builtinExists(scope: AgentScope, name: string): Promise<boolean> {
  try {
    await readFile(join(scope.builtinDir, `${name}.md`), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 写一个自定义或项目级 agent；digest 给定时做乐观并发比对，create 时必须缺席。 */
export async function writeAgent(
  scope: AgentScope, name: string, content: string,
  options: { readonly digest?: string; readonly create?: boolean } = {},
): Promise<AgentEntry> {
  if (!AGENT_NAME_RE.test(name)) throw new AgentStoreError('agent-invalid', 'agent 名称非法（仅允许小写字母、数字与 -）')
  if (new TextEncoder().encode(content).length > AGENT_FILE_MAX_BYTES) {
    throw new AgentStoreError('agent-invalid', `agent 文件超过 ${AGENT_FILE_MAX_BYTES} 字节`)
  }
  let definition: AgentDefinition
  try {
    definition = parseAgentFile(content, name)
  } catch (error) {
    throw new AgentStoreError('agent-invalid', error instanceof Error ? error.message : String(error))
  }
  await mkdir(scope.lockDir, { recursive: true })
  return withLock(scope.lockDir, async () => {
    if (await builtinExists(scope, name)) {
      throw new AgentStoreError(options.create === true ? 'agent-exists' : 'agent-builtin-readonly',
        options.create === true ? `agent '${name}' 已存在（官方）` : '官方 agent 只读')
    }
    const path = join(scope.dir, `${name}.md`)
    const now = await currentDigest(path)
    if (options.create === true && now !== null) throw new AgentStoreError('agent-exists', `agent '${name}' 已存在`)
    if (options.create !== true && now === null) throw new AgentStoreError('agent-missing', `agent 库中不存在 '${name}'`)
    if (options.digest !== undefined && now !== options.digest) {
      throw new AgentStoreError('agent-stale', 'agent 已被修改，请刷新')
    }
    await writeAtomic(path, content)
    return { name, source: scope.source, digest: agentDigest(content), content, path, definition }
  })
}

export async function deleteAgent(scope: AgentScope, name: string, digest?: string): Promise<void> {
  if (!AGENT_NAME_RE.test(name)) throw new AgentStoreError('agent-missing', `agent 库中不存在 '${name}'`)
  await mkdir(scope.lockDir, { recursive: true })
  await withLock(scope.lockDir, async () => {
    if (await builtinExists(scope, name)) throw new AgentStoreError('agent-builtin-readonly', '官方 agent 只读')
    const path = join(scope.dir, `${name}.md`)
    const now = await currentDigest(path)
    if (now === null) throw new AgentStoreError('agent-missing', `agent 库中不存在 '${name}'`)
    if (digest !== undefined && now !== digest) throw new AgentStoreError('agent-stale', 'agent 已被修改，请刷新')
    await rm(path)
  })
}

const customScopeOf = (storeRoot: string): AgentScope => ({
  source: 'custom', dir: join(storeRoot, 'custom'), builtinDir: join(storeRoot, 'builtin'), lockDir: storeRoot,
})

/** 新建或覆盖一个自定义（用户级）agent；storeRoot = agentStoreRoot(configRoot)。 */
export async function writeCustomAgent(
  storeRoot: string, name: string, content: string, options: { readonly digest?: string; readonly create?: boolean } = {},
): Promise<AgentEntry> {
  return writeAgent(customScopeOf(storeRoot), name, content, options)
}

export async function deleteCustomAgent(storeRoot: string, name: string, digest?: string): Promise<void> {
  return deleteAgent(customScopeOf(storeRoot), name, digest)
}

/** 把一份 agent 文本的 name 行改成新名字（复制时用）；没有 name 行时原样返回。 */
export function renameAgentContent(content: string, name: string): string {
  return content.replace(/^name: .*$/mu, `name: ${name}`)
}

/**
 * Change 创建前的 agent 解析：工作流一个 agent 都没引用时连库都不读，否则逐个解析并把内容
 * 交给 ensureAgentFreeze。缺失 / 不合法 / 冲突在这里抛出，Change 还没发布。
 */
export async function prepareAgentFreeze(
  workflow: WorkflowIR,
  loadLibrary: () => Promise<AgentLibrary>,
): Promise<((name: string) => { readonly source: AgentSource; readonly content: string }) | undefined> {
  const names = agentsReferenced(workflow)
  if (names.length === 0) return undefined
  const library = await loadLibrary()
  const resolved = new Map(names.map((name) => {
    const entry = resolveAgent(library, name)
    return [name, { source: entry.source, content: entry.content }]
  }))
  return (name) => {
    const entry = resolved.get(name)
    if (entry === undefined) throw new AgentStoreError('agent-missing', `agent 库中不存在 '${name}'`)
    return entry
  }
}
