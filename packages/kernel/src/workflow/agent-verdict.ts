/**
 * 步骤 agent 的投影、放行判定与波次调度——纯逻辑，不碰 fs，也不渲染除阻断行以外的文案。
 *
 * 相关的运行是「本次步骤访问（step_visit）内该 agent 的最后一次运行」；更早访问的运行只是历史。
 * 评审者按候选版本判过期（代码变了旧结论就不算），执行者不判——它们本身就是改代码的人。
 */
import { DEFAULT_EVENT_POLICY } from '../flow/default-event-policy.js'
import { IMPLICIT_COMPLETION_EVENT } from './implicit-completion.js'
import { severityRank, type AgentFinding, type AgentRunRow } from '../state/agent-runs.js'
import type { EffectiveWorkflowPlan, StepAgentsCapability } from './effective-plan-types.js'
import type { AgentSeverity } from './types.js'

export type AgentRunState = 'idle' | 'running' | 'done' | 'stale'
export type AgentRole = 'executor' | 'reviewer'

export interface AgentView {
  readonly agent: string
  readonly role: AgentRole
  readonly required: boolean
  readonly blockAt?: AgentSeverity
  readonly dependsOn: readonly string[]
  readonly readsTests: readonly string[]
  readonly state: AgentRunState
  readonly result: 'pass' | 'fail' | 'done' | 'failed' | null
  readonly findings: number
  readonly blocking: number
  readonly runId: string | null
  readonly reportPath: string | null
  readonly actor: { readonly id: string; readonly name: string } | null
  readonly finishedAt: string | null
}

export type AgentBlocker =
  | { readonly kind: 'executor-missing' | 'executor-running' | 'executor-failed'; readonly agent: string }
  | { readonly kind: 'reviewer-missing' | 'reviewer-running' | 'reviewer-stale'; readonly agent: string }
  | {
      readonly kind: 'reviewer-failed'
      readonly agent: string
      readonly blockAt: AgentSeverity
      readonly blocking: readonly AgentFinding[]
    }
  | { readonly kind: 'agent-records-invalid'; readonly reason: string }

export interface StepAgentsInput {
  readonly step: StepAgentsCapability
  readonly runs: readonly AgentRunRow[]
  readonly stepVisit: string
  readonly candidate: string
  readonly testsReady: { readonly ready: boolean; readonly pending: readonly string[] }
}

/** 本次访问内该 agent 的最后一次运行。 */
function latestRun(input: StepAgentsInput, agent: string): AgentRunRow | undefined {
  let found: AgentRunRow | undefined
  for (const row of input.runs) {
    if (row.agent === agent && row.step_visit === input.stepVisit) found = row
  }
  return found
}

function blockingFindings(row: AgentRunRow, blockAt: AgentSeverity): readonly AgentFinding[] {
  return row.findings.filter((finding) => severityRank(finding.severity) >= severityRank(blockAt))
}

function stateOf(row: AgentRunRow | undefined, role: AgentRole, candidate: string): AgentRunState {
  if (row === undefined) return 'idle'
  const fresh = row.candidate === candidate
  if (row.status === 'running') return role === 'reviewer' && !fresh ? 'stale' : 'running'
  return role === 'executor' || fresh ? 'done' : 'stale'
}

function viewOf(
  input: StepAgentsInput,
  agent: string,
  role: AgentRole,
  required: boolean,
  dependsOn: readonly string[],
  readsTests: readonly string[],
  blockAt?: AgentSeverity,
): AgentView {
  const row = latestRun(input, agent)
  const state = stateOf(row, role, input.candidate)
  const blocking = row === undefined || blockAt === undefined ? [] : blockingFindings(row, blockAt)
  const result = row === undefined || row.status === 'running'
    ? null
    : role === 'reviewer' ? (blocking.length > 0 ? 'fail' : 'pass') : row.result
  return {
    agent,
    role,
    required,
    ...(blockAt === undefined ? {} : { blockAt }),
    dependsOn: [...dependsOn],
    readsTests: [...readsTests],
    state,
    result: result === 'pass' || result === 'fail' || result === 'done' || result === 'failed' ? result : null,
    findings: row?.findings.length ?? 0,
    blocking: blocking.length,
    runId: row?.run_id ?? null,
    reportPath: row?.report_path ?? null,
    actor: row === undefined ? null : { id: row.actor.id, name: row.actor.name },
    finishedAt: row?.finished_at ?? null,
  }
}

/** 按声明顺序投影：先全部执行者，再全部评审者。 */
export function projectStepAgents(input: StepAgentsInput): readonly AgentView[] {
  return [
    ...input.step.executors.map((ref) => viewOf(input, ref.agent, 'executor', true, ref.dependsOn, [])),
    ...input.step.reviewers.map((ref) =>
      viewOf(input, ref.agent, 'reviewer', ref.required, ref.dependsOn, ref.readsTests, ref.blockAt)),
  ]
}

/**
 * 离开步骤的判定，按声明顺序：每个执行者必须 done 且结果 done；每个必需评审者必须 done 且
 * 在当前候选上通过。参考评审者从不产生阻断。
 */
export function evaluateStepAgents(
  input: StepAgentsInput,
): { readonly pass: boolean; readonly blockers: readonly AgentBlocker[] } {
  const blockers: AgentBlocker[] = []
  for (const ref of input.step.executors) {
    const row = latestRun(input, ref.agent)
    const state = stateOf(row, 'executor', input.candidate)
    if (state === 'idle') blockers.push({ kind: 'executor-missing', agent: ref.agent })
    else if (state === 'running') blockers.push({ kind: 'executor-running', agent: ref.agent })
    else if (row?.result !== 'done') blockers.push({ kind: 'executor-failed', agent: ref.agent })
  }
  for (const ref of input.step.reviewers) {
    if (!ref.required) continue
    const row = latestRun(input, ref.agent)
    const state = stateOf(row, 'reviewer', input.candidate)
    if (state === 'idle') { blockers.push({ kind: 'reviewer-missing', agent: ref.agent }); continue }
    if (state === 'running') { blockers.push({ kind: 'reviewer-running', agent: ref.agent }); continue }
    if (state === 'stale') { blockers.push({ kind: 'reviewer-stale', agent: ref.agent }); continue }
    const blocking = row === undefined ? [] : blockingFindings(row, ref.blockAt)
    if (blocking.length > 0) blockers.push({ kind: 'reviewer-failed', agent: ref.agent, blockAt: ref.blockAt, blocking })
  }
  return { pass: blockers.length === 0, blockers }
}

/** wave(x) = 0 无依赖，否则 1 + 依赖的最大 wave（同 skillDag / SkillFlow 的列模型）。 */
function waveOf(refs: readonly { agent: string; dependsOn: readonly string[] }[]): Map<string, number> {
  const byName = new Map(refs.map((ref) => [ref.agent, ref]))
  const waves = new Map<string, number>()
  const visit = (name: string, seen: ReadonlySet<string>): number => {
    const cached = waves.get(name)
    if (cached !== undefined) return cached
    const ref = byName.get(name)
    if (ref === undefined || seen.has(name)) return 0
    const next = new Set([...seen, name])
    const wave = ref.dependsOn.reduce((max, dep) => Math.max(max, visit(dep, next) + 1), 0)
    waves.set(name, wave)
    return wave
  }
  for (const ref of refs) visit(ref.agent, new Set())
  return waves
}

export interface AgentWave {
  readonly wave: readonly string[]
  readonly waiting: readonly { readonly agent: string; readonly for: readonly string[] }[]
}

/**
 * 可运行判定：执行者等它依赖的执行者 done；评审者等全部执行者 done、必需测试就绪、
 * 它依赖的评审者在当前候选上已有结论（结果不限）。已经在当前候选上通过的评审者不再排进波次。
 */
export function nextAgentWave(input: StepAgentsInput): AgentWave {
  const views = new Map(projectStepAgents(input).map((view) => [view.agent, view]))
  const executorDone = (agent: string): boolean => {
    const view = views.get(agent)
    return view?.state === 'done' && view.result === 'done'
  }
  const pendingExecutors = input.step.executors.filter((ref) => !executorDone(ref.agent))
  const waitingFor = (view: AgentView): readonly string[] => view.role === 'executor'
    ? view.dependsOn.filter((dep) => !executorDone(dep)).map((dep) => `executor:${dep}`)
    : [
        ...pendingExecutors.map((ref) => `executor:${ref.agent}`),
        ...(input.testsReady.ready ? [] : input.testsReady.pending.map((id) => `test:${id}`)),
        ...view.dependsOn.filter((dep) => views.get(dep)?.state !== 'done').map((dep) => `agent:${dep}`),
      ]
  const finished = (view: AgentView): boolean => view.role === 'executor'
    ? executorDone(view.agent)
    : view.state === 'done' && view.result === 'pass'
  const unfinished = [...views.values()].filter((view) => !finished(view))
  // 执行者全部完成之前不排评审者：步骤内的顺序恒为「执行者波次 → 必需测试 → 评审者波次」。
  const role: AgentRole = pendingExecutors.length > 0 ? 'executor' : 'reviewer'
  const waves = waveOf(role === 'executor' ? input.step.executors : input.step.reviewers)
  const runnable = unfinished.filter((view) =>
    view.role === role && view.state !== 'running' && waitingFor(view).length === 0)
  const lowest = runnable.length === 0 ? undefined : Math.min(...runnable.map((view) => waves.get(view.agent) ?? 0))
  return {
    wave: lowest === undefined
      ? []
      : runnable.filter((view) => (waves.get(view.agent) ?? 0) === lowest).map((view) => view.agent),
    waiting: unfinished
      .map((view) => ({ agent: view.agent, for: waitingFor(view) }))
      .filter((item) => item.for.length > 0),
  }
}

/**
 * 前进出边 = 目标在 `plan.workflow.steps` 里更靠后，或隐式完结自边，或（phase-manifest）
 * 该事件的 `enforceTaskExit` 为真。退回边（verify-fail、requirements-changed、自定义回边）
 * 从不检查 agent——修问题的路必须一直开着。
 */
export function isForwardExit(
  plan: Pick<EffectiveWorkflowPlan, 'executionModel' | 'workflow'>,
  from: string,
  to: string,
  event: string,
): boolean {
  if (event === IMPLICIT_COMPLETION_EVENT && from === to) return true
  if (plan.executionModel === 'phase-manifest') {
    const policy = (DEFAULT_EVENT_POLICY as Record<string, { readonly enforceTaskExit: boolean } | undefined>)[event]
    return policy?.enforceTaskExit === true
  }
  const ids = plan.workflow.steps.map((step) => step.id)
  const fromIndex = ids.indexOf(from)
  const toIndex = ids.indexOf(to)
  return fromIndex >= 0 && toIndex > fromIndex
}

const FINDING_PREVIEW = 5

/** 每条阻断都点名解锁它的那条命令——门禁文案的既定规则：说清楚怎么解开。 */
export function renderAgentBlocker(blocker: AgentBlocker, change: string): string {
  switch (blocker.kind) {
    case 'executor-missing':
      return `执行者 '${blocker.agent}' 未运行；运行：tenon agent next ${change}`
    case 'executor-running':
      return `执行者 '${blocker.agent}' 进行中；完成后：tenon agent record ${change} <run>`
    case 'executor-failed':
      return `执行者 '${blocker.agent}' 失败；重跑：tenon agent prompt ${change} ${blocker.agent}`
    case 'reviewer-missing':
      return `评审者 '${blocker.agent}' 未运行；运行：tenon agent next ${change}`
    case 'reviewer-running':
      return `评审者 '${blocker.agent}' 进行中；完成后：tenon agent record ${change} <run>`
    case 'reviewer-stale':
      return `评审者 '${blocker.agent}' 的结论已过期（候选已变化）；重跑：tenon agent prompt ${change} ${blocker.agent}`
    case 'reviewer-failed': {
      const shown = blocker.blocking.slice(0, FINDING_PREVIEW)
        .map((finding) => `${finding.location} ${finding.message}`)
        .join('；')
      return `评审者 '${blocker.agent}' 未通过（${blocker.blocking.length} 个问题 ≥ ${blocker.blockAt}）：${shown}；`
        + `修复后重跑：tenon agent prompt ${change} ${blocker.agent}`
    }
    case 'agent-records-invalid':
      return `agent 记录不可读：${blocker.reason}`
    default: {
      const exhaustive: never = blocker
      throw new Error(`renderAgentBlocker: 未知 blocker ${JSON.stringify(exhaustive)}`)
    }
  }
}
