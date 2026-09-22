/**
 * 每步 agent 的执行态投影（工作台用）。与 skillRuns 同一条口径：步序早于当前 → 只看它上次访问留下的
 * 结论，晚于当前 → 未运行，当前步按冻结声明 + 运行台账判定（含候选版本的过期）。
 *
 * 读不动冻结内容或台账时返回空投影：工作台是只读视图，绝不因为它挡住任何操作——真正的拦截在
 * transition / check / 技能门里，各自失败关闭。
 */
import {
  currentDocumentStepVisitId, projectStepAgents, readAgentRuns, readFrozenAgents,
  type AgentBlocker, type AgentRunRow, type AgentView, type EffectiveWorkflowPlan, type PipelineState,
  type StepAgentsCapability,
} from '@tenon/kernel'

export interface StepAgentRuns { readonly stepId: string; readonly agents: readonly AgentView[] }
export type AgentRunsSnapshot = readonly StepAgentRuns[]

export interface AgentRunsInput {
  readonly changeDir: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly phase: string
  /** 当前候选版本；取不到时按「与记录不同」处理，评审结论一律显示为过期。 */
  readonly candidate?: () => Promise<string | undefined>
  /** 必需测试是否就绪；缺省视为就绪（等待项只影响波次提示，不影响结论）。 */
  readonly testsReady?: { readonly ready: boolean; readonly pending: readonly string[] }
}

/** 更早步骤的占位候选：让投影里不出现「过期」。 */
const PAST_CANDIDATE = 'past'

const empty = (step: StepAgentsCapability): StepAgentRuns => ({
  stepId: step.stepId,
  agents: projectStepAgents({
    step,
    runs: [],
    stepVisit: '',
    candidate: '',
    testsReady: { ready: true, pending: [] },
  }),
})

export async function projectAgentRuns(input: AgentRunsInput): Promise<AgentRunsSnapshot> {
  const steps = input.plan.capabilities.agents.steps
  if (steps.length === 0) return []
  const stepIds = input.plan.workflow.steps.map((step) => step.id)
  const currentIndex = stepIds.indexOf(input.phase)
  const runId = input.state.runMetadata?.runId
  let runs: readonly AgentRunRow[] = []
  let stepVisit = ''
  if (runId !== undefined && runId !== '') {
    try {
      await readFrozenAgents({
        changeDir: input.changeDir,
        runId,
        workflowFingerprint: input.plan.workflowFingerprint,
      })
      runs = await readAgentRuns(input.changeDir)
    } catch {
      return steps.map(empty)
    }
    try {
      stepVisit = await currentDocumentStepVisitId(input.changeDir)
    } catch {
      // 只读视图不因为拿不到访问身份就空着：退回「该步骤台账里最后一次访问」。
      stepVisit = [...runs].reverse().find((row) => row.step === input.phase)?.step_visit ?? ''
    }
  }
  let candidate = ''
  if (input.candidate !== undefined) {
    try {
      candidate = (await input.candidate() ?? '').trim()
    } catch {
      candidate = ''
    }
  }
  return steps.map((step) => {
    const index = stepIds.indexOf(step.stepId)
    if (index > currentIndex || currentIndex < 0) return empty(step)
    if (index < currentIndex) {
      // 更早的步骤展示它最后一次访问留下的结论，不判过期——那一步已经离开了。把候选统一成同一个
      // 占位值，投影里就不会出现 stale。
      const own = runs.filter((row) => row.step === step.stepId)
      const lastVisit = own.at(-1)?.step_visit ?? ''
      return {
        stepId: step.stepId,
        agents: projectStepAgents({
          step,
          runs: own.map((row) => ({ ...row, candidate: PAST_CANDIDATE })),
          stepVisit: lastVisit,
          candidate: PAST_CANDIDATE,
          testsReady: { ready: true, pending: [] },
        }),
      }
    }
    return {
      stepId: step.stepId,
      agents: projectStepAgents({
        step,
        runs,
        stepVisit,
        candidate,
        testsReady: input.testsReady ?? { ready: true, pending: [] },
      }),
    }
  })
}

/**
 * 由已算好的投影得出当前步骤的阻断，供 readiness 复用——两处同一口径，且不再读第二次台账。
 * 参考评审者从不产生阻断；执行者未完成、必需评审者未通过/过期/进行中/未运行各自成一条。
 */
export function agentBlockersOf(
  runs: AgentRunsSnapshot,
  plan: EffectiveWorkflowPlan,
  phase: string,
): readonly AgentBlocker[] {
  const step = plan.capabilities.agents.steps.find((candidate) => candidate.stepId === phase)
  const projected = runs.find((candidate) => candidate.stepId === phase)
  if (step === undefined || projected === undefined) return []
  const blockers: AgentBlocker[] = []
  for (const view of projected.agents) {
    if (view.role === 'executor') {
      if (view.state === 'idle') blockers.push({ kind: 'executor-missing', agent: view.agent })
      else if (view.state === 'running') {
        blockers.push({ kind: 'executor-running', agent: view.agent, runId: view.runId })
      }
      else if (view.result !== 'done') blockers.push({ kind: 'executor-failed', agent: view.agent })
      continue
    }
    if (!view.required) continue
    if (view.state === 'idle') blockers.push({ kind: 'reviewer-missing', agent: view.agent })
    else if (view.state === 'running') {
      blockers.push({ kind: 'reviewer-running', agent: view.agent, runId: view.runId })
    }
    else if (view.state === 'stale') blockers.push({ kind: 'reviewer-stale', agent: view.agent })
    else if (view.result === 'fail') {
      blockers.push({
        kind: 'reviewer-failed',
        agent: view.agent,
        blockAt: view.blockAt ?? 'high',
        blocking: [],
      })
    }
  }
  return blockers
}
