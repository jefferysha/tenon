/**
 * agent 库的全局存储 `<configRoot>/agents/{builtin,custom}`。
 *
 * builtin 由 syncBuiltinLibraries 按 payload 摘要整份同步（只读，装完或升级后第一次读时收敛）；
 * custom 由 Dashboard 读写，写入前必须能解析，所以盘上的自定义 agent 始终合法。
 * 读取从不因单个坏文件失败：解析不了的 agent 进 entry.error，其余照常返回。
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentDigest, parseAgentFile } from '../agents/parse.js'
import { AGENT_FILE_MAX_BYTES, AGENT_NAME_RE, type AgentDefinition, type AgentSource } from '../agents/types.js'
import { withLock } from '../state/lock.js'
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
}

export interface AgentEntry {
  readonly name: string
  readonly source: AgentSource
  readonly digest: string
  readonly content: string
  /** 解析失败或名称冲突时缺席。 */
  readonly definition?: AgentDefinition
  readonly error?: string
}

export interface AgentLibrary {
  readonly entries: readonly AgentEntry[]
  readonly sync: BuiltinSyncResult
}

/** `<configRoot>/agents`。 */
export const agentStoreRoot = (configRoot: string): string => join(configRoot, 'agents')

const sourceDir = (storeRoot: string, source: AgentSource): string => join(storeRoot, source)

/** builtin 与 custom 同名时给 custom 条目的错误文案；resolve 据它拒绝影子覆盖。 */
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

/** 读全量 agent 库；builtin 与 custom 同名时 custom 记为冲突并排除（内建从不被影子覆盖）。 */
export async function loadAgentLibrary(options: AgentStoreOptions): Promise<AgentLibrary> {
  const sync = await ensureBuiltinAgents(options)
  const storeRoot = agentStoreRoot(options.configRoot)
  const entries: AgentEntry[] = []
  const builtinNames = new Set<string>()
  for (const source of ['builtin', 'custom'] as const) {
    const dir = sourceDir(storeRoot, source)
    for (const file of await listAgents(dir)) {
      const name = file.slice(0, -'.md'.length)
      let content: string
      try {
        content = await readFile(join(dir, file), 'utf8')
      } catch (error) {
        entries.push({ name, source, digest: '', content: '', error: error instanceof Error ? error.message : String(error) })
        continue
      }
      const digest = agentDigest(content)
      if (source === 'builtin') builtinNames.add(name)
      else if (builtinNames.has(name)) {
        entries.push({ name, source, digest, content, error: CONFLICT })
        continue
      }
      try {
        entries.push({ name, source, digest, content, definition: parseAgentFile(content, name) })
      } catch (error) {
        entries.push({ name, source, digest, content, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return { entries, sync }
}

/** 取一个可用的 agent；缺失 / 不合法 / 冲突都抛出，工作流引用与冻结都走它。 */
export function resolveAgent(library: AgentLibrary, name: string): AgentEntry & { readonly definition: AgentDefinition } {
  const named = library.entries.filter((candidate) => candidate.name === name)
  if (named.some((candidate) => candidate.error === CONFLICT)) {
    throw new AgentStoreError('agent-conflict', `agent '${name}' 名称冲突（builtin 与 custom 同名）`)
  }
  const entry = named[0]
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

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

async function builtinExists(storeRoot: string, name: string): Promise<boolean> {
  try {
    await readFile(join(sourceDir(storeRoot, 'builtin'), `${name}.md`), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 新建或覆盖一个自定义 agent；digest 给定时做乐观并发比对，create 时必须缺席。 */
export async function writeCustomAgent(
  storeRoot: string, name: string, content: string, options: { readonly digest?: string; readonly create?: boolean } = {},
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
  await mkdir(storeRoot, { recursive: true })
  return withLock(storeRoot, async () => {
    if (await builtinExists(storeRoot, name)) {
      throw new AgentStoreError(options.create === true ? 'agent-exists' : 'agent-builtin-readonly',
        options.create === true ? `agent '${name}' 已存在` : '内置 agent 只读')
    }
    const path = join(sourceDir(storeRoot, 'custom'), `${name}.md`)
    const now = await currentDigest(path)
    if (options.create === true && now !== null) throw new AgentStoreError('agent-exists', `agent '${name}' 已存在`)
    if (options.create !== true && now === null) throw new AgentStoreError('agent-missing', `agent 库中不存在 '${name}'`)
    if (options.digest !== undefined && now !== options.digest) {
      throw new AgentStoreError('agent-stale', 'agent 已被修改，请刷新')
    }
    await writeAtomic(path, content)
    return { name, source: 'custom' as const, digest: agentDigest(content), content, definition }
  })
}

export async function deleteCustomAgent(storeRoot: string, name: string, digest?: string): Promise<void> {
  if (!AGENT_NAME_RE.test(name)) throw new AgentStoreError('agent-missing', `agent 库中不存在 '${name}'`)
  await mkdir(storeRoot, { recursive: true })
  await withLock(storeRoot, async () => {
    if (await builtinExists(storeRoot, name)) throw new AgentStoreError('agent-builtin-readonly', '内置 agent 只读')
    const path = join(sourceDir(storeRoot, 'custom'), `${name}.md`)
    const now = await currentDigest(path)
    if (now === null) throw new AgentStoreError('agent-missing', `agent 库中不存在 '${name}'`)
    if (digest !== undefined && now !== digest) throw new AgentStoreError('agent-stale', 'agent 已被修改，请刷新')
    await rm(path)
  })
}
