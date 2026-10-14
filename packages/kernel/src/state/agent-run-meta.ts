/**
 * agent 运行台账的 v0.3 旁注 `<change>/.pipeline-agent-run-meta.jsonl`：`host`、`host_source`、`rerun_reason` 三项，
 * 以及 `subagent_reason`（台账行里 `subagent.reason` 的落点），按 run_id 记在这里，不写进台账
 * `.pipeline-agent-runs.jsonl` 的行里。
 *
 * 为什么要分开：上一个发行版（v0.2.1）的台账读取器是闭集——一行里出现不认识的键就判整份台账损坏（`runs-corrupt`），
 * agent next / check / status 都会因此失败。前三项是 v0.3 每次 `agent record` 都会产生的（宿主几乎总能判出），
 * 写进行里，升级后回滚的用户或还在用 v0.2.1 的同事就读不了任何一份有 agent 运行的任务。`subagent_reason` 同理：
 * 没装专属子代理而退回通用子代理时每次 `agent prompt` 都会产生它，而 `subagent` 对象的键集合也是闭集（host,native,type）。
 * 旁注是 v0.2.1 不认识也不会读的独立文件，所以台账的行保持它能读的形状。
 *
 * 追加写，同一 run_id 的多行按文件顺序逐项叠加（后写的覆盖先写的同名项）。读取不加锁；写者与台账的写者是同一批，
 * 都在 Change 锁内调用。旁注行是否有对应的台账行不影响读取（先写旁注再写台账行，中途崩溃只会留下一条没人引用的旁注）。
 * 任何畸形行都判为损坏并点名行号——前三项决定评审裁决是否有效（宿主不符、有说明的重跑），守卫据此失败关闭。
 */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isHostSubagentReason, type HostSubagentReason } from '../agents/host-native.js'

export const AGENT_RUN_META_FILE = '.pipeline-agent-run-meta.jsonl'
export const AGENT_RUN_META_SCHEMA = 'agent-run-meta/v1'
export const AGENT_RUN_META_MAX_BYTES = 1024 * 1024
export const AGENT_RERUN_REASON_MAX = 300

export type AgentRunHostSource = 'detected' | 'declared'

/**
 * 旁注里的项。前三项原本在台账行里（v0.2.1 不认识；旁注与本地 integ 构建写过的、带这三项的旧行共用同一套校验）；
 * `subagent_reason` 是台账行里 `subagent.reason` 的平铺形式，只出现在旁注里。
 */
export interface AgentRunMeta {
  readonly host?: string
  readonly host_source?: AgentRunHostSource
  readonly rerun_reason?: string
  readonly subagent_reason?: HostSubagentReason
}

export const AGENT_RUN_META_KEYS = ['host', 'host_source', 'rerun_reason', 'subagent_reason'] as const

/** 带旁注项的行：三个顶层项，外加可能带 `reason` 的 `subagent`（native 用来判断原因贴不贴得上）。 */
export interface AgentRunMetaCarrier extends Omit<AgentRunMeta, 'subagent_reason'> {
  readonly subagent?: { readonly native: boolean; readonly reason?: HostSubagentReason }
}

/** 拆出去的三个顶层项：写台账行时不带。 */
type RowMetaKey = 'host' | 'host_source' | 'rerun_reason'

const RUN_HOST_RE = /^[a-z][a-z0-9-]{0,31}$/u

/**
 * 校验一个对象上的四个可选项：形状合法返回取出的值（缺席的项不出现），否则 undefined。
 * `host_source` 必须伴随 `host`；`rerun_reason` 不能为空白、含换行或超长；`subagent_reason` 只取 `HOST_SUBAGENT_REASONS`。
 */
export function decodeAgentRunMeta(record: Readonly<Record<string, unknown>>): AgentRunMeta | undefined {
  const { host, host_source: hostSource, rerun_reason: rerunReason, subagent_reason: subagentReason } = record
  if (rerunReason !== undefined && (typeof rerunReason !== 'string' || rerunReason.trim() === ''
    || rerunReason.length > AGENT_RERUN_REASON_MAX || /[\r\n]/.test(rerunReason))) return undefined
  if (host !== undefined && (typeof host !== 'string' || !RUN_HOST_RE.test(host))) return undefined
  if (hostSource !== undefined && ((hostSource !== 'detected' && hostSource !== 'declared') || host === undefined)) return undefined
  if (subagentReason !== undefined && !isHostSubagentReason(subagentReason)) return undefined
  return {
    ...(host === undefined ? {} : { host: host as string }),
    ...(hostSource === undefined ? {} : { host_source: hostSource as AgentRunHostSource }),
    ...(rerunReason === undefined ? {} : { rerun_reason: rerunReason as string }),
    ...(subagentReason === undefined ? {} : { subagent_reason: subagentReason as HostSubagentReason }),
  }
}

/**
 * 把一行拆成「台账行」（不含三个顶层项，`subagent` 去掉 `reason`，回到 v0.2.1 读得了的 host,type,native 三键）与
 * 「旁注」（四项都缺席时为 undefined）。
 */
export function splitAgentRunMeta<T extends AgentRunMetaCarrier>(row: T): { readonly ledger: Omit<T, RowMetaKey>; readonly meta: AgentRunMeta | undefined } {
  const { host, host_source: hostSource, rerun_reason: rerunReason, ...rest } = row
  const subagentReason = row.subagent?.reason
  const meta: AgentRunMeta = {
    ...(host === undefined ? {} : { host }),
    ...(hostSource === undefined ? {} : { host_source: hostSource }),
    ...(rerunReason === undefined ? {} : { rerun_reason: rerunReason }),
    ...(subagentReason === undefined ? {} : { subagent_reason: subagentReason }),
  }
  const ledger = subagentReason === undefined ? rest : { ...rest, subagent: withoutReason(row.subagent) }
  return { ledger: ledger as Omit<T, RowMetaKey>, meta: Object.keys(meta).length === 0 ? undefined : meta }
}

function withoutReason<S extends { readonly reason?: unknown }>(subagent: S | undefined): Omit<S, 'reason'> | undefined {
  if (subagent === undefined) return undefined
  const { reason: _reason, ...shape } = subagent
  return shape
}

/**
 * 台账行自带的项优先（本地 integ 构建写进行里的旧行），旁注补上行里缺的项。`subagent_reason` 只贴在通用子代理上
 * （`native: false`）：原因解释的是「为什么没用专属子代理」，`record --subagent` 把运行改记成专属类型后，
 * 旁注里 prompt 当时写下的原因不再适用；行里没有 `subagent` 时也无处可贴。
 */
export function withAgentRunMeta<T extends AgentRunMetaCarrier>(row: T, meta: AgentRunMeta | undefined): T {
  if (meta === undefined) return row
  return {
    ...row,
    ...(row.host === undefined && meta.host !== undefined ? { host: meta.host } : {}),
    ...(row.host_source === undefined && meta.host_source !== undefined && (row.host ?? meta.host) !== undefined
      ? { host_source: meta.host_source } : {}),
    ...(row.rerun_reason === undefined && meta.rerun_reason !== undefined ? { rerun_reason: meta.rerun_reason } : {}),
    ...(meta.subagent_reason !== undefined && row.subagent !== undefined && !row.subagent.native && row.subagent.reason === undefined
      ? { subagent: { ...row.subagent, reason: meta.subagent_reason } } : {}),
  }
}

export class AgentRunMetaError extends Error {
  readonly kind: 'limit' | 'json' | 'shape'
  readonly line: number
  constructor(kind: 'limit' | 'json' | 'shape', line: number) {
    super(`agent run meta ${kind} at line ${line}`)
    this.name = 'AgentRunMetaError'
    this.kind = kind
    this.line = line
  }
}

function decodeMetaRow(value: unknown): { readonly runId: string; readonly meta: AgentRunMeta } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const allowed: readonly string[] = ['schema', 'run_id', ...AGENT_RUN_META_KEYS]
  if (Object.keys(record).some((key) => !allowed.includes(key))) return undefined
  if (record.schema !== AGENT_RUN_META_SCHEMA) return undefined
  if (typeof record.run_id !== 'string' || record.run_id === '') return undefined
  const meta = decodeAgentRunMeta(record)
  return meta === undefined ? undefined : { runId: record.run_id, meta }
}

/**
 * 读旁注，按 run_id 把多行叠加成一份（后写的覆盖先写的同名项）。文件不存在 = 没有旁注；
 * 最后一段若是并发追加写到一半的行就丢掉，文件中间的畸形行抛 `AgentRunMetaError`。
 */
export async function readAgentRunMeta(changeDir: string): Promise<ReadonlyMap<string, AgentRunMeta>> {
  let raw: string
  try {
    raw = await readFile(join(changeDir, AGENT_RUN_META_FILE), 'utf8')
  } catch {
    return new Map()
  }
  if (Buffer.byteLength(raw) > AGENT_RUN_META_MAX_BYTES) throw new AgentRunMetaError('limit', 0)
  const merged = new Map<string, AgentRunMeta>()
  raw.split('\n').slice(0, -1).forEach((line, index) => {
    if (line.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new AgentRunMetaError('json', index + 1)
    }
    const row = decodeMetaRow(parsed)
    if (row === undefined) throw new AgentRunMetaError('shape', index + 1)
    merged.set(row.runId, { ...merged.get(row.runId), ...row.meta })
  })
  return merged
}

/** 追加一行旁注；调用方在 Change 锁内调用，并且先于对应的台账行写入。 */
export async function appendAgentRunMeta(changeDir: string, runId: string, meta: AgentRunMeta): Promise<void> {
  const row = { schema: AGENT_RUN_META_SCHEMA, run_id: runId, ...meta }
  await appendFile(join(changeDir, AGENT_RUN_META_FILE), `${JSON.stringify(row)}\n`, 'utf8')
}
