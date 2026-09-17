/**
 * agent 运行台账 `<change>/.pipeline-agent-runs.jsonl`：追加写，同一 run_id 以最后一行为准。
 *
 * 一次状态变化写一整行（不是补丁），所以「进行中」既是技能门解锁的依据，也不需要第二个文件。
 * 读取无需加锁；任何畸形行都判为损坏并点名行号——守卫据此失败关闭，不当作「没有评审」放行。
 */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSeverity } from '../workflow/types.js'
import { decodeRecordActor, type RecordActor } from '../users/user.js'

export const AGENT_RUNS_FILE = '.pipeline-agent-runs.jsonl'
export const AGENT_REPORTS_DIR = '.pipeline-agent-reports'
export const AGENT_RUNS_MAX_BYTES = 1024 * 1024
export const AGENT_RUNS_MAX_RUNS = 512
export const AGENT_RUN_SCHEMA = 'agent-run/v1'
export const AGENT_FINDINGS_MAX = 200
export const AGENT_FINDING_LOCATION_MAX = 200
export const AGENT_FINDING_MESSAGE_MAX = 500

export const AGENT_SEVERITIES: readonly AgentSeverity[] = ['critical', 'high', 'medium', 'low']
const SEVERITY_RANK: Readonly<Record<AgentSeverity, number>> = { low: 1, medium: 2, high: 3, critical: 4 }

/** 级别序：low=1 … critical=4；`severityRank(x) >= severityRank(block_at)` 即为阻断。 */
export const severityRank = (severity: AgentSeverity): number => SEVERITY_RANK[severity]

export type AgentRunRole = 'executor' | 'reviewer'
export type AgentRunStatus = 'running' | 'finished'
export type AgentRunResult = 'pass' | 'fail' | 'done' | 'failed'

export interface AgentFinding {
  readonly severity: AgentSeverity
  readonly location: string
  readonly message: string
}

export interface AgentRunRow {
  readonly schema: typeof AGENT_RUN_SCHEMA
  readonly run_id: string
  readonly agent: string
  readonly agent_digest: string
  readonly role: AgentRunRole
  readonly step: string
  readonly step_visit: string
  readonly candidate: string
  readonly status: AgentRunStatus
  readonly result: AgentRunResult | null
  readonly findings: readonly AgentFinding[]
  readonly report_path: string
  readonly report_digest: string | null
  readonly actor: RecordActor
  readonly started_at: string
  readonly finished_at: string | null
}

export type AgentRunErrorCode =
  | 'runs-corrupt' | 'runs-limit' | 'report-invalid' | 'run-not-running' | 'candidate-changed'

export class AgentRunError extends Error {
  readonly code: AgentRunErrorCode
  constructor(code: AgentRunErrorCode, message: string) {
    super(message)
    this.name = 'AgentRunError'
    this.code = code
  }
}

const ROW_KEYS = [
  'actor', 'agent', 'agent_digest', 'candidate', 'findings', 'finished_at', 'report_digest',
  'report_path', 'result', 'role', 'run_id', 'schema', 'started_at', 'status', 'step', 'step_visit',
].join(',')
const RESULTS: ReadonlySet<string> = new Set<AgentRunResult>(['pass', 'fail', 'done', 'failed'])

function decodeFinding(value: unknown): AgentFinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'location,message,severity') return undefined
  const { severity, location, message } = record
  if (typeof severity !== 'string' || !AGENT_SEVERITIES.includes(severity as AgentSeverity)) return undefined
  if (typeof location !== 'string' || location.length > AGENT_FINDING_LOCATION_MAX) return undefined
  if (typeof message !== 'string' || message.length > AGENT_FINDING_MESSAGE_MAX || message.includes('\n')) return undefined
  return { severity: severity as AgentSeverity, location, message }
}

function decodeRow(value: unknown): AgentRunRow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== ROW_KEYS) return undefined
  if (record.schema !== AGENT_RUN_SCHEMA) return undefined
  const strings = ['run_id', 'agent', 'agent_digest', 'step', 'step_visit', 'candidate', 'report_path', 'started_at']
  for (const key of strings) if (typeof record[key] !== 'string' || record[key] === '') return undefined
  if (record.role !== 'executor' && record.role !== 'reviewer') return undefined
  if (record.status !== 'running' && record.status !== 'finished') return undefined
  if (record.result !== null && (typeof record.result !== 'string' || !RESULTS.has(record.result))) return undefined
  if (record.report_digest !== null && typeof record.report_digest !== 'string') return undefined
  if (record.finished_at !== null && typeof record.finished_at !== 'string') return undefined
  if (!Array.isArray(record.findings) || record.findings.length > AGENT_FINDINGS_MAX) return undefined
  const findings: AgentFinding[] = []
  for (const item of record.findings) {
    const finding = decodeFinding(item)
    if (finding === undefined) return undefined
    findings.push(finding)
  }
  const actor = decodeRecordActor(record.actor)
  if (actor === null || actor === undefined) return undefined
  return {
    schema: AGENT_RUN_SCHEMA,
    run_id: record.run_id as string,
    agent: record.agent as string,
    agent_digest: record.agent_digest as string,
    role: record.role,
    step: record.step as string,
    step_visit: record.step_visit as string,
    candidate: record.candidate as string,
    status: record.status,
    result: record.result as AgentRunResult | null,
    findings,
    report_path: record.report_path as string,
    report_digest: record.report_digest as string | null,
    actor,
    started_at: record.started_at as string,
    finished_at: record.finished_at as string | null,
  }
}

/** 每个 run_id 的最后一行，按首次出现的文件顺序返回。 */
export async function readAgentRuns(changeDir: string): Promise<readonly AgentRunRow[]> {
  let raw: string
  try {
    raw = await readFile(join(changeDir, AGENT_RUNS_FILE), 'utf8')
  } catch {
    return []
  }
  if (Buffer.byteLength(raw) > AGENT_RUNS_MAX_BYTES) {
    throw new AgentRunError('runs-limit', `agent 运行台账超过 ${AGENT_RUNS_MAX_BYTES} 字节`)
  }
  // split 的最后一段要么是结尾换行后的空串，要么是并发追加写到一半的行——两种都丢掉；
  // 文件中间的畸形行才算损坏。
  const complete = raw.split('\n').slice(0, -1)
  const order: string[] = []
  const latest = new Map<string, AgentRunRow>()
  complete.forEach((line, index) => {
    if (line.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new AgentRunError('runs-corrupt', `agent 运行台账第 ${index + 1} 行不是合法 JSON`)
    }
    const row = decodeRow(parsed)
    if (row === undefined) throw new AgentRunError('runs-corrupt', `agent 运行台账第 ${index + 1} 行形状非法`)
    if (!latest.has(row.run_id)) order.push(row.run_id)
    latest.set(row.run_id, row)
  })
  if (order.length > AGENT_RUNS_MAX_RUNS) {
    throw new AgentRunError('runs-limit', `agent 运行台账超过 ${AGENT_RUNS_MAX_RUNS} 次运行`)
  }
  return order.map((runId) => latest.get(runId)).filter((row): row is AgentRunRow => row !== undefined)
}

/** 追加一整行；调用方负责在 Change 锁内调用（同 state/lock.ts 的写者约定）。 */
export async function appendAgentRunRow(changeDir: string, row: AgentRunRow): Promise<void> {
  await appendFile(join(changeDir, AGENT_RUNS_FILE), `${JSON.stringify(row)}\n`, 'utf8')
}

export interface ParsedAgentReport {
  readonly findings: readonly AgentFinding[]
  readonly result?: 'done' | 'failed'
}

// 开头的贪婪段把游标推到**最后**一个 tenon-result 块；报告正文里的示例块不会被当成结论。
const RESULT_BLOCK_RE = /^[\s\S]*```tenon-result\s*\n([\s\S]*?)\n?```\s*$/

/**
 * 报告最后一个围栏块必须是 ```tenon-result```。评审者只报 findings（结论由阻断级别算），
 * 执行者必须自报 `result`。
 */
export function parseAgentReport(text: string, role: AgentRunRole): ParsedAgentReport {
  const match = RESULT_BLOCK_RE.exec(text.trimEnd())
  if (!match) throw new AgentRunError('report-invalid', '报告末尾缺少 tenon-result 代码块')
  let value: unknown
  try {
    value = JSON.parse(match[1] ?? '')
  } catch {
    throw new AgentRunError('report-invalid', 'tenon-result 块不是合法 JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRunError('report-invalid', 'tenon-result 块必须是对象')
  }
  const record = value as Record<string, unknown>
  const allowed = role === 'reviewer' ? ['findings'] : ['findings', 'result']
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new AgentRunError('report-invalid', role === 'reviewer' && key === 'result'
        ? '评审者不自报结论，结论由阻断级别计算'
        : `tenon-result 出现未知字段 '${key}'`)
    }
  }
  const rawFindings = record.findings ?? []
  if (!Array.isArray(rawFindings) || rawFindings.length > AGENT_FINDINGS_MAX) {
    throw new AgentRunError('report-invalid', `findings 必须是不超过 ${AGENT_FINDINGS_MAX} 条的数组`)
  }
  const findings: AgentFinding[] = []
  for (const item of rawFindings) {
    const finding = decodeFinding(item)
    if (finding === undefined) throw new AgentRunError('report-invalid', 'findings 条目形状非法')
    findings.push(finding)
  }
  if (role === 'reviewer') return { findings }
  if (record.result !== 'done' && record.result !== 'failed') {
    throw new AgentRunError('report-invalid', "执行者必须自报 result: 'done' 或 'failed'")
  }
  return { findings, result: record.result }
}
