/**
 * agent 判定的注入面装配：transition 的拦截、check 的预览与 `tenon agent` 三条命令读同一份输入。
 *
 * 声明了 agent 的步骤失败关闭——冻结内容或台账读不到时给出 `agent-records-invalid`，绝不把
 * 「读不到记录」当成「没有评审要求」。一个 agent 都没声明的步骤永远不产生拦截。
 */
import {
  currentDocumentStepVisitId, evaluateStepAgents, readAgentRuns, readFrozenAgents,
} from '@tenon/kernel'
import type {
  AgentBlocker, EffectiveWorkflowPlan, PipelineState, StepAgentsCapability, StepAgentsInput,
} from '@tenon/kernel'
import { currentCandidate } from './commands/candidate.js'
import { errMsg, type CliDeps } from './deps.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from './testEvidenceContext.js'

export function stepAgentsOf(plan: EffectiveWorkflowPlan, stepId: string): StepAgentsCapability {
  return plan.capabilities.agents.steps.find((step) => step.stepId === stepId)
    ?? { stepId, executors: [], reviewers: [] }
}

/** 必需测试是否就绪；判定注入面缺席（无身份）时视为未就绪，拦截由测试自己的门禁给文案。 */
async function testsReadyFor(
  deps: CliDeps,
  name: string,
  dir: string,
  plan: EffectiveWorkflowPlan,
  stepId: string,
): Promise<{ readonly ready: boolean; readonly pending: readonly string[] }> {
  const report = await testEvidenceReaderFor(deps)({
    repoRoot: deps.cwd,
    changeDir: dir,
    changeName: name,
    plan,
    stepId,
    context: testEvidenceContextFor(deps, name),
  })
  const pending = report.items
    .filter((item) => item.test.required && item.status !== 'passed')
    .map((item) => item.test.id)
  return { ready: pending.length === 0, pending }
}

export interface AgentGateInput {
  readonly deps: CliDeps
  readonly name: string
  readonly dir: string
  readonly stepId: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
}

/** 判定输入；步骤没有 agent 时返回 undefined，读不到记录时返回一条 invalid 原因。 */
export async function agentEvaluationInput(
  input: AgentGateInput,
): Promise<StepAgentsInput | { readonly invalid: string } | undefined> {
  const step = stepAgentsOf(input.plan, input.stepId)
  if (step.executors.length === 0 && step.reviewers.length === 0) return undefined
  const runId = input.state.runMetadata?.runId
  if (runId === undefined || runId === '') return { invalid: 'Change 缺少 run 身份' }
  try {
    await readFrozenAgents({
      changeDir: input.dir,
      runId,
      workflowFingerprint: input.plan.workflowFingerprint,
    })
    return {
      step,
      runs: await readAgentRuns(input.dir),
      stepVisit: await currentDocumentStepVisitId(input.dir),
      candidate: await currentCandidate(input.deps, input.name, input.state, input.plan, input.stepId),
      testsReady: await testsReadyFor(input.deps, input.name, input.dir, input.plan, input.stepId),
    }
  } catch (error) {
    return { invalid: errMsg(error) }
  }
}

/** 本步 agent 的阻断；transition 与 check 共用，也是 server readiness 的同一口径。 */
export async function stepAgentBlockersFor(input: AgentGateInput): Promise<readonly AgentBlocker[]> {
  const override = input.deps.stepAgents
  if (override !== undefined) {
    return override({ name: input.name, dir: input.dir, stepId: input.stepId, plan: input.plan, state: input.state })
  }
  const evaluation = await agentEvaluationInput(input)
  if (evaluation === undefined) return []
  if ('invalid' in evaluation) return [{ kind: 'agent-records-invalid', reason: evaluation.invalid }]
  return evaluateStepAgents(evaluation).blockers
}
