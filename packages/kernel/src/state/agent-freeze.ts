/**
 * Change 创建时把它会用到的 agent 冻结进 `<change>/.pipeline-frozen/`。
 *
 * agent 内容不进 workflow 指纹（compileEffectiveWorkflowPlan 在很多没有库访问的地方被调用）；
 * 锁绑定 run_id + workflow_fingerprint 给出同样的保证：任务开始后改库不影响进行中的任务。
 * 冻结的是选中 track 分支引用到的 agent，因为 Change 的 track 在其生命周期内稳定。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentDigest, parseAgentFile } from '../agents/parse.js'
import type { AgentDefinition, AgentSource } from '../agents/types.js'
import type { WorkflowIR } from '../workflow/ir.js'
import { atomicLinkPublish } from './atomic-publish.js'

export const FROZEN_DIR = '.pipeline-frozen'
export const FROZEN_LOCK_FILE = 'lock.json'
export const FROZEN_AGENTS_DIR = 'agents'
const LOCK_VERSION = 1

export interface FrozenAgentEntry { readonly name: string; readonly source: AgentSource; readonly digest: string }
export interface FrozenAgent extends FrozenAgentEntry { readonly definition: AgentDefinition }

export interface AgentFreezeLock {
  readonly version: 1
  readonly run_id: string
  readonly workflow_fingerprint: string
  readonly agents: readonly FrozenAgentEntry[]
}

export type AgentFreezeErrorCode = 'freeze-missing' | 'freeze-corrupt' | 'freeze-binding'

export class AgentFreezeError extends Error {
  readonly code: AgentFreezeErrorCode
  constructor(code: AgentFreezeErrorCode, message: string) {
    super(message)
    this.name = 'AgentFreezeError'
    this.code = code
  }
}

/** 选中分支里被任何步骤引用到的 agent 名，去重后排序。 */
export function agentsReferenced(workflow: WorkflowIR): readonly string[] {
  const names = new Set<string>()
  for (const step of workflow.steps) {
    for (const ref of step.agents?.executors ?? []) names.add(ref.agent)
    for (const ref of step.agents?.reviewers ?? []) names.add(ref.agent)
  }
  return [...names].sort()
}

const frozenRoot = (changeDir: string): string => join(changeDir, FROZEN_DIR)
const lockPath = (changeDir: string): string => join(frozenRoot(changeDir), FROZEN_LOCK_FILE)
const agentPath = (changeDir: string, name: string): string =>
  join(frozenRoot(changeDir), FROZEN_AGENTS_DIR, `${name}.md`)

function decodeLock(text: string): AgentFreezeLock {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new AgentFreezeError('freeze-corrupt', 'agent 冻结锁不是合法 JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentFreezeError('freeze-corrupt', 'agent 冻结锁形状非法')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'agents,run_id,version,workflow_fingerprint'
    || record.version !== LOCK_VERSION
    || typeof record.run_id !== 'string' || record.run_id === ''
    || typeof record.workflow_fingerprint !== 'string'
    || !Array.isArray(record.agents)) {
    throw new AgentFreezeError('freeze-corrupt', 'agent 冻结锁形状非法')
  }
  const agents = record.agents.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AgentFreezeError('freeze-corrupt', 'agent 冻结锁条目形状非法')
    }
    const entry = item as Record<string, unknown>
    if (Object.keys(entry).sort().join(',') !== 'digest,name,source'
      || typeof entry.name !== 'string'
      || (entry.source !== 'builtin' && entry.source !== 'custom')
      || typeof entry.digest !== 'string') {
      throw new AgentFreezeError('freeze-corrupt', 'agent 冻结锁条目形状非法')
    }
    return { name: entry.name, source: entry.source as AgentSource, digest: entry.digest }
  })
  return { version: LOCK_VERSION, run_id: record.run_id, workflow_fingerprint: record.workflow_fingerprint, agents }
}

export async function readAgentFreezeLock(changeDir: string): Promise<AgentFreezeLock | undefined> {
  try {
    return decodeLock(await readFile(lockPath(changeDir), 'utf8'))
  } catch (error) {
    if (error instanceof AgentFreezeError) throw error
    return undefined
  }
}

export interface AgentFreezeInput {
  readonly changeDir: string
  readonly runId: string
  readonly workflowFingerprint: string
  readonly workflow: WorkflowIR
  /** 名称 → 已校验的库条目；缺任何一个引用都必须在发布 Change 之前抛出。 */
  readonly resolve: (name: string) => { readonly source: AgentSource; readonly content: string }
}

/**
 * 冻结选中分支引用到的 agent。同一 run_id 幂等；绑定到另一个 run_id 的旧锁只在整份重写时替换
 * （创建失败重试）。写序：先落文件，再原子发布 lock.json。
 */
export async function ensureAgentFreeze(input: AgentFreezeInput): Promise<AgentFreezeLock | undefined> {
  const names = agentsReferenced(input.workflow)
  if (names.length === 0) return undefined
  const existing = await readAgentFreezeLock(input.changeDir)
  if (existing?.run_id === input.runId && existing.workflow_fingerprint === input.workflowFingerprint) return existing
  const entries: FrozenAgentEntry[] = []
  const root = frozenRoot(input.changeDir)
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, FROZEN_AGENTS_DIR), { recursive: true })
  for (const name of names) {
    const resolved = input.resolve(name)
    await writeFile(agentPath(input.changeDir, name), resolved.content, { encoding: 'utf8', flag: 'wx' })
    entries.push({ name, source: resolved.source, digest: agentDigest(resolved.content) })
  }
  const lock: AgentFreezeLock = {
    version: LOCK_VERSION,
    run_id: input.runId,
    workflow_fingerprint: input.workflowFingerprint,
    agents: entries,
  }
  await atomicLinkPublish(root, '.lock.tmp', lockPath(input.changeDir), `${JSON.stringify(lock)}\n`)
  return lock
}

export interface ReadFrozenAgentsInput {
  readonly changeDir: string
  readonly runId: string
  readonly workflowFingerprint: string
}

/** 读冻结内容并逐个核对摘要；锁缺失、绑定不符或内容被改都抛出。 */
export async function readFrozenAgents(input: ReadFrozenAgentsInput): Promise<ReadonlyMap<string, FrozenAgent>> {
  const lock = await readAgentFreezeLock(input.changeDir)
  if (lock === undefined) {
    throw new AgentFreezeError('freeze-missing', `Change 缺少 ${FROZEN_DIR}/${FROZEN_LOCK_FILE}`)
  }
  if (lock.run_id !== input.runId || lock.workflow_fingerprint !== input.workflowFingerprint) {
    throw new AgentFreezeError('freeze-binding', 'agent 冻结锁绑定的 run 或 workflow 指纹与当前不一致')
  }
  const frozen = new Map<string, FrozenAgent>()
  for (const entry of lock.agents) {
    let content: string
    try {
      content = await readFile(agentPath(input.changeDir, entry.name), 'utf8')
    } catch {
      throw new AgentFreezeError('freeze-corrupt', `冻结的 agent '${entry.name}' 文件缺失`)
    }
    if (agentDigest(content) !== entry.digest) {
      throw new AgentFreezeError('freeze-corrupt', `冻结的 agent '${entry.name}' 内容与摘要不一致`)
    }
    try {
      frozen.set(entry.name, { ...entry, definition: parseAgentFile(content, entry.name) })
    } catch (error) {
      throw new AgentFreezeError('freeze-corrupt', `冻结的 agent '${entry.name}' 无法解析：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return frozen
}

/** 冻结目录里实际存在的 agent 文件名；只给检查工具与测试用。 */
export async function frozenAgentFiles(changeDir: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(frozenRoot(changeDir), FROZEN_AGENTS_DIR))).sort()
  } catch {
    return []
  }
}
