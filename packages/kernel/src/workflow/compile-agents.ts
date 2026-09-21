/**
 * 步骤 agent 块的编译（定义层 → IR）：闭集键、名称字符集、重复与跨身份重名校验。
 * 结构化输入（server 的 decodeWorkflowDef 直调）与 YAML 走同一条校验链，所以 Dashboard
 * 保存的 JSON 必须显式给出 `required` 与 `block_at`。
 * 两个列表都空归一为「无 agents 键」，未声明 agent 的工作流编译成与本特性之前逐字相同的 IR。
 */
import { AGENT_NAME_RE } from '../agents/types.js'
import type { AgentSeverity, StepAgentsDef, StepExecutorRef, StepReviewerRef } from './types.js'

const AGENTS_KEYS: ReadonlySet<string> = new Set(['executors', 'reviewers'])
const EXECUTOR_KEYS: ReadonlySet<string> = new Set(['agent', 'depends_on'])
const REVIEWER_KEYS: ReadonlySet<string> = new Set(['agent', 'required', 'block_at', 'depends_on', 'reads_tests'])
const SEVERITIES: readonly AgentSeverity[] = ['critical', 'high', 'medium', 'low']

function compileError(path: string, message: string): never {
  throw new Error(`compileWorkflow: ${path}: ${message}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    compileError(path, `必须是对象（实际 ${JSON.stringify(value)}）`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) compileError(path, `必须是数组（实际 ${JSON.stringify(value)}）`)
  return value
}

function rejectExtraKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      compileError(path, `出现该变体不接受的附加键 '${key}'（闭集：${[...allowed].join('/')}）`)
    }
  }
}

function agentName(value: unknown, path: string): string {
  if (typeof value !== 'string' || !AGENT_NAME_RE.test(value)) {
    compileError(`${path}.agent`, 'agent 名称非法（仅允许小写字母、数字与 -）')
  }
  return value
}

function nameList(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined
  return asArray(value, path).map((item, index) => {
    if (typeof item !== 'string' || item === '') compileError(`${path}[${index}]`, `必须是非空字符串（实际 ${JSON.stringify(item)}）`)
    return item
  })
}

function compileExecutor(raw: unknown, path: string): StepExecutorRef {
  const record = asRecord(raw, path)
  rejectExtraKeys(record, EXECUTOR_KEYS, path)
  const dependsOn = nameList(record.depends_on, `${path}.depends_on`)
  return { agent: agentName(record.agent, path), ...(dependsOn === undefined ? {} : { depends_on: dependsOn }) }
}

function compileReviewer(raw: unknown, path: string): StepReviewerRef {
  const record = asRecord(raw, path)
  rejectExtraKeys(record, REVIEWER_KEYS, path)
  if (typeof record.required !== 'boolean') compileError(`${path}.required`, '必须是 true | false')
  if (typeof record.block_at !== 'string' || !SEVERITIES.includes(record.block_at as AgentSeverity)) {
    compileError(`${path}.block_at`, `必须是 ${SEVERITIES.join(' | ')}`)
  }
  const dependsOn = nameList(record.depends_on, `${path}.depends_on`)
  const readsTests = nameList(record.reads_tests, `${path}.reads_tests`)
  return {
    agent: agentName(record.agent, path),
    required: record.required,
    block_at: record.block_at as AgentSeverity,
    ...(dependsOn === undefined ? {} : { depends_on: dependsOn }),
    ...(readsTests === undefined ? {} : { reads_tests: readsTests }),
  }
}

export function compileStepAgents(raw: unknown, path: string): StepAgentsDef | undefined {
  if (raw === undefined) return undefined
  const record = asRecord(raw, path)
  rejectExtraKeys(record, AGENTS_KEYS, path)
  const executors = record.executors === undefined
    ? []
    : asArray(record.executors, `${path}.executors`).map((item, index) => compileExecutor(item, `${path}.executors[${index}]`))
  const reviewers = record.reviewers === undefined
    ? []
    : asArray(record.reviewers, `${path}.reviewers`).map((item, index) => compileReviewer(item, `${path}.reviewers[${index}]`))
  const seen = new Map<string, string>()
  for (const [role, refs] of [['executors', executors], ['reviewers', reviewers]] as const) {
    const inRole = new Set<string>()
    refs.forEach((ref, index) => {
      if (inRole.has(ref.agent)) compileError(`${path}.${role}[${index}]`, `同一步骤重复声明 agent '${ref.agent}'`)
      inRole.add(ref.agent)
      const other = seen.get(ref.agent)
      if (other !== undefined && other !== role) {
        compileError(`${path}.${role}[${index}]`, `agent '${ref.agent}' 在同一步骤不能既是执行者又是评审者`)
      }
      seen.set(ref.agent, role)
    })
  }
  return executors.length === 0 && reviewers.length === 0 ? undefined : { executors, reviewers }
}
