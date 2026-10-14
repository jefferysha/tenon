/**
 * 「归属 agent 的技能」：本步声明的执行者与评审者，其冻结定义的 `skills` 列表的并集。
 *
 * 这类技能只在对应 agent 运行期间可加载（CLI 的 agentSkillGate），主线在 agent 开始之前拿不到它们的回执。
 * 所以离开步骤的退回边不能再要求它们——退回边是修问题的路，要求一个只能在 agent 里加载的技能，等于
 * 逼着用户为了退回去先开始一个根本不会用的 agent。不归属任何 agent 的主线技能不在这个集合里，退回边照旧要求。
 *
 * 归属关系取任务冻结的 agent 定义（`.pipeline-frozen`），不读库：任务开始后改库不影响进行中的任务。
 */
import { readFrozenAgents, type FrozenAgent } from '../state/agent-freeze.js'
import type { PipelineState } from '../types.js'
import { isForwardExit } from './agent-verdict.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'

const NONE: ReadonlySet<string> = new Set()

/** 本步声明的 agent 名（执行者在前、评审者在后）；步骤不在计划里或没有声明 = 空。 */
function declaredAgents(plan: EffectiveWorkflowPlan, stepId: string): readonly string[] {
  const step = plan.capabilities.agents.steps.find((candidate) => candidate.stepId === stepId)
  if (step === undefined) return []
  return [...step.executors.map((ref) => ref.agent), ...step.reviewers.map((ref) => ref.agent)]
}

/** 本步声明的 agent 的冻结定义里 `skills` 的并集；冻结里没有的 agent 被忽略。 */
export function agentOwnedSkills(input: {
  readonly plan: EffectiveWorkflowPlan
  readonly stepId: string
  readonly frozen: ReadonlyMap<string, FrozenAgent>
}): ReadonlySet<string> {
  const owned = new Set<string>()
  for (const agent of declaredAgents(input.plan, input.stepId)) {
    for (const skill of input.frozen.get(agent)?.definition.skills ?? []) owned.add(skill)
  }
  return owned
}

/**
 * 读任务的冻结内容后求 `agentOwnedSkills`。步骤没有声明 agent 时不读盘。
 * 状态缺 run 身份、冻结缺失 / 绑定不符 / 内容损坏时返回空集：读不到就不豁免任何技能，保持改动前的要求，
 * 不因为读失败而放宽门禁（agent 门自己会就同一原因报 `agent-records-invalid`）。
 */
export async function readAgentOwnedSkills(input: {
  readonly changeDir: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly stepId: string
}): Promise<ReadonlySet<string>> {
  if (declaredAgents(input.plan, input.stepId).length === 0) return NONE
  const runId = input.state.runMetadata?.runId
  if (runId === undefined || runId === '') return NONE
  try {
    const frozen = await readFrozenAgents({
      changeDir: input.changeDir,
      runId,
      workflowFingerprint: input.plan.workflowFingerprint,
    })
    return agentOwnedSkills({ plan: input.plan, stepId: input.stepId, frozen })
  } catch {
    return NONE
  }
}

/**
 * 离开 `stepId` 的这条边不要求哪些技能：前进边（含隐式完结）一个都不豁免，退回边豁免归属本步 agent 的技能。
 * transition 的技能门与 status / check 的出口报告共用这一份，两边对同一条边给出同一个答案。
 */
export async function skillsExemptOnExit(input: {
  readonly changeDir: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly stepId: string
  readonly to: string
  readonly event: string
}): Promise<ReadonlySet<string>> {
  if (isForwardExit(input.plan, input.stepId, input.to, input.event)) return NONE
  return readAgentOwnedSkills(input)
}
