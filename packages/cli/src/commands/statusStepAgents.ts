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
