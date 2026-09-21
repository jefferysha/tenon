/**
 * `agents:` 块的窄解析（modelled on parse-tests.ts）。块形态与单行 flow map 形态都接受，
 * serializer 只写块形态。值域校验（名称字符集、重复、跨身份重名）留给 compileStepAgents。
 */
import type { WorkflowParseCursor as Cursor } from './parse-document-contract.js'
import { indentOf, parseInlineList, parseInlineMap } from './parse-primitives.js'
import type { AgentSeverity, StepAgentsDef, StepExecutorRef, StepReviewerRef } from './types.js'

const SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low']
const EXECUTOR_KEYS: readonly string[] = ['agent', 'depends_on']
const REVIEWER_KEYS: readonly string[] = ['agent', 'required', 'block_at', 'depends_on', 'reads_tests']

function fail(message: string): never {
  throw new Error(`workflow 解析错误：${message}`)
}

function severity(raw: string, where: string): AgentSeverity {
  if (!SEVERITIES.includes(raw)) fail(`${where}.block_at: 必须是 ${SEVERITIES.join(' | ')}`)
  return raw as AgentSeverity
}

function boolean(raw: string, where: string): boolean {
  if (raw !== 'true' && raw !== 'false') fail(`${where}.required: 必须是 true | false`)
  return raw === 'true'
}

function list(value: string | readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? [...value] : parseInlineList(`${value}`)
}

function executorFrom(fields: Record<string, string | string[]>, where: string): StepExecutorRef {
  for (const key of Object.keys(fields)) if (!EXECUTOR_KEYS.includes(key)) fail(`${where} 出现未知字段 '${key}'`)
  const agent = fields.agent
  if (typeof agent !== 'string' || agent === '') fail(`${where} 缺 agent`)
  const dependsOn = list(fields.depends_on)
  return { agent, ...(dependsOn === undefined ? {} : { depends_on: dependsOn }) }
}

function reviewerFrom(fields: Record<string, string | string[]>, where: string): StepReviewerRef {
  for (const key of Object.keys(fields)) if (!REVIEWER_KEYS.includes(key)) fail(`${where} 出现未知字段 '${key}'`)
  const agent = fields.agent
  if (typeof agent !== 'string' || agent === '') fail(`${where} 缺 agent`)
  const dependsOn = list(fields.depends_on)
  const readsTests = list(fields.reads_tests)
  return {
    agent,
    required: typeof fields.required === 'string' ? boolean(fields.required, where) : true,
    block_at: typeof fields.block_at === 'string' ? severity(fields.block_at, where) : 'high',
    ...(dependsOn === undefined ? {} : { depends_on: dependsOn }),
    ...(readsTests === undefined ? {} : { reads_tests: readsTests }),
  }
}

/** 逐项读一个 agent 列表；每项是 `- agent: x` 后跟缩进子字段，或 `- { agent: x, … }`。 */
function parseRefs<T>(cur: Cursor, baseIndent: number, role: string, build: (fields: Record<string, string | string[]>, where: string) => T): T[] {
  const items: T[] = []
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) < baseIndent) break
    const inline = /^\s*-\s*(\{.*\})\s*$/.exec(line)
    if (inline) {
      cur.i++
      items.push(build(parseInlineMap(inline[1] ?? ''), `${role}[${items.length}]`))
      continue
    }
    const lead = /^\s*-\s+agent:\s*(\S+)\s*$/.exec(line)
    if (!lead) break
    const itemIndent = indentOf(line)
    cur.i++
    const fields: Record<string, string | string[]> = { agent: lead[1] ?? '' }
    while (cur.i < cur.lines.length) {
      const next = cur.lines[cur.i] ?? ''
      if (next.trim() === '') { cur.i++; continue }
      if (indentOf(next) <= itemIndent) break
      const field = /^\s*([a-z_]+):\s*(.+?)\s*$/.exec(next)
      if (!field) fail(`${role}[${items.length}] 出现未知字段行 '${next.trim()}'`)
      const key = field?.[1] ?? ''
      if (Object.hasOwn(fields, key)) fail(`${role}[${items.length}] 重复声明 ${key}`)
      fields[key] = field?.[2] ?? ''
      cur.i++
    }
    items.push(build(fields, `${role}[${items.length}]`))
  }
  return items
}

/** `agents:` 块；两个列表都空 → undefined（等同未声明），serialize 据此省略整块。 */
export function parseStepAgents(cur: Cursor, keyIndent: number, stepId: string): StepAgentsDef | undefined {
  let executors: StepExecutorRef[] | undefined
  let reviewers: StepReviewerRef[] | undefined
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= keyIndent) break
    const empty = /^\s*(executors|reviewers):\s*\[\]\s*$/.exec(line)
    if (empty) {
      if (empty[1] === 'executors') executors = []
      else reviewers = []
      cur.i++
      continue
    }
    const block = /^\s*(executors|reviewers):\s*$/.exec(line)
    if (!block) fail(`step '${stepId}' agents 出现未知字段 '${line.trim()}'`)
    const blockIndent = indentOf(line)
    cur.i++
    if (block[1] === 'executors') {
      if (executors !== undefined) fail(`step '${stepId}' agents 重复声明 executors`)
      executors = parseRefs(cur, blockIndent, 'executors', executorFrom)
    } else {
      if (reviewers !== undefined) fail(`step '${stepId}' agents 重复声明 reviewers`)
      reviewers = parseRefs(cur, blockIndent, 'reviewers', reviewerFrom)
    }
  }
  const def: StepAgentsDef = { executors: executors ?? [], reviewers: reviewers ?? [] }
  return def.executors.length === 0 && def.reviewers.length === 0 ? undefined : def
}
