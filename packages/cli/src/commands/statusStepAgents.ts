/**
 * `step` 分块的执行者 / 评审者投影：与 `tenon agent next` 同一份判定，只换一个形状。
 */
import {
  agentWaves, currentDocumentStepVisitId, evaluateTestEvidence, nextAgentWave, projectStepAgents,
  readAgentRuns, readFrozenAgents,
  type EffectiveWorkflowPlan, type FrozenAgent, type PipelineState, type StepAgentsCapability,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { testEvidenceContextFor } from '../testEvidenceContext.js'
import { currentCandidate } from './candidate.js'

export interface StepAgentView {
  readonly agent: string
  readonly role: 'executor' | 'reviewer'
  readonly required: boolean
  readonly block_at: string | null
  readonly reads_tests: readonly string[]
  /** 依赖分层：无 depends_on 的同为 0（与 `tenon agent next` 的排波同源，kernel agentWaves）。 */
  readonly wave: number
  readonly wave_ready: boolean
  readonly status: 'pending' | 'running' | 'pass' | 'fail' | 'stale' | 'waiting'
  readonly run_id: string | null
  /** 本次运行的报告路径（仓库相对）；`running` 时运行器把报告写到这里再 `tenon agent record`。 */
  readonly report_path: string | null
  readonly blocking_findings: number
}

function statusOf(
  view: ReturnType<typeof projectStepAgents>[number],
  waiting: boolean,
): StepAgentView['status'] {
  if (view.state === 'done') return view.result === 'pass' || view.result === 'done' ? 'pass' : 'fail'
  if (view.state === 'running') return 'running'
  if (view.state === 'stale') return 'stale'
  return waiting ? 'waiting' : 'pending'
}

export async function agentStepViews(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  stepId: string,
): Promise<{ readonly executors: readonly StepAgentView[]; readonly reviewers: readonly StepAgentView[] }> {
  const step: StepAgentsCapability = plan.capabilities.agents.steps.find((item) => item.stepId === stepId)
    ?? { stepId, executors: [], reviewers: [] }
  if (step.executors.length === 0 && step.reviewers.length === 0) return { executors: [], reviewers: [] }
  const runId = state.runMetadata?.runId
  let frozen: ReadonlyMap<string, FrozenAgent>
  try {
    frozen = runId === undefined || runId === ''
      ? new Map<string, FrozenAgent>()
      : await readFrozenAgents({ changeDir: dir, runId, workflowFingerprint: plan.workflowFingerprint })
  } catch {
    frozen = new Map<string, FrozenAgent>()
  }
  const report = await (deps.testEvidence ?? evaluateTestEvidence)({
    repoRoot: deps.cwd, changeDir: dir, changeName: name, plan, stepId,
    context: testEvidenceContextFor(deps, name),
  })
  const pending = report.items
    .filter((item) => item.test.required && item.status !== 'passed')
    .map((item) => item.test.id)
  const input = {
    step,
    runs: await readAgentRuns(dir),
    stepVisit: await currentDocumentStepVisitId(dir),
    candidate: await currentCandidate(deps, name, state, plan, stepId),
    testsReady: { ready: pending.length === 0, pending },
    frozen,
  }
  const views = projectStepAgents(input)
  const { wave, waiting } = nextAgentWave(input)
  const waves = {
    executor: agentWaves(step.executors),
    reviewer: agentWaves(step.reviewers),
  }
  const project = (role: 'executor' | 'reviewer'): readonly StepAgentView[] =>
    views.filter((view) => view.role === role).map((view) => ({
      agent: view.agent,
      role,
      required: view.required,
      block_at: view.blockAt ?? null,
      reads_tests: view.readsTests,
      wave: waves[role].get(view.agent) ?? 0,
      wave_ready: wave.includes(view.agent),
      status: statusOf(view, waiting.some((item) => item.agent === view.agent)),
      run_id: view.runId,
      report_path: view.reportPath,
      blocking_findings: view.blocking,
    }))
  return { executors: project('executor'), reviewers: project('reviewer') }
}

/** 下一步（前进边指向的步骤）声明的评审者：本步的实现与自审按它们的阻断级别与关注点来做。 */
export interface StepReviewBar {
  readonly step: string
  readonly agent: string
  readonly required: boolean
  readonly block_at: string
  /** 评审者定义的一句话说明（冻结的 agent 定义）；读不到时为 null。 */
  readonly focus: string | null
}

/**
 * 真机（第五轮）：build 的实现评审（subagent-driven-development 等由模型或子代理做的审查）把两个
 * 测试健壮性问题判为不阻塞的建议，verify 的 backend-quality（block_at: medium）判成中级阻断——
 * verify-fail → build → verify 多走约两轮。两边口径对齐的办法是让 build 看得见 verify 的那份声明：
 * 前进边指向的步骤上的评审者、各自的 block_at 与关注点。回退边与自环不算。
 */
export async function downstreamReviewBar(
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  stepId: string,
  targets: readonly string[],
): Promise<readonly StepReviewBar[]> {
  const steps = plan.capabilities.agents.steps
    .filter((item) => item.stepId !== stepId && targets.includes(item.stepId) && item.reviewers.length > 0)
  if (steps.length === 0) return []
  const runId = state.runMetadata?.runId
  let frozen: ReadonlyMap<string, FrozenAgent> = new Map<string, FrozenAgent>()
  try {
    if (runId !== undefined && runId !== '') {
      frozen = await readFrozenAgents({ changeDir: dir, runId, workflowFingerprint: plan.workflowFingerprint })
    }
  } catch {
    // 冻结表读不到只少一句关注点说明；阻断级别出自工作流声明，照样给出。
  }
  return steps.flatMap((item) => item.reviewers.map((reviewer) => ({
    step: item.stepId,
    agent: reviewer.agent,
    required: reviewer.required,
    block_at: reviewer.blockAt,
    focus: frozen.get(reviewer.agent)?.definition.description ?? null,
  })))
}
