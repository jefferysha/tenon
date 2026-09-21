/**
 * agent 技能的渐进解锁：一个 agent 的技能只在它自己跑着的时候可加载。
 *
 * 判定输入是冻结的 agent 定义 + 运行台账，不读库——任务开始后改库不影响进行中的任务。
 * 声明了 agent 的步骤失败关闭：冻结内容或台账读不到时拦住并说明原因，绝不放行。
 * 同一波并行的 agent 共享解锁集（hook 无法把一次工具调用归到某个子 agent），这是设计接受的。
 */
import { currentDocumentStepVisitId, readAgentRuns, readFrozenAgents } from '@tenon/kernel'
import type { EffectiveWorkflowPlan, PipelineState } from '@tenon/kernel'
import { stepAgentsOf } from './agentGate.js'
import { currentCandidate } from './commands/candidate.js'
import { errMsg, type CliDeps } from './deps.js'

export type AgentSkillDecision =
  | { readonly kind: 'not-agent-skill' }
  | { readonly kind: 'allow' }
  | { readonly kind: 'block'; readonly message: string }

export interface AgentSkillGateInput {
  readonly deps: CliDeps
  readonly name: string
  readonly dir: string
  readonly stepId: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly skillId: string
}

/**
 * 该技能是否属于本步骤某个 agent，以及此刻能否加载。
 * 返回 `not-agent-skill` 时调用方继续走原有的步骤 DAG 判定。
 */
export async function agentSkillDecision(input: AgentSkillGateInput): Promise<AgentSkillDecision> {
  const step = stepAgentsOf(input.plan, input.stepId)
  if (step.executors.length === 0 && step.reviewers.length === 0) return { kind: 'not-agent-skill' }
  const runId = input.state.runMetadata?.runId
  if (runId === undefined || runId === '') {
    return { kind: 'block', message: `【Tenon 门】步骤 '${input.stepId}' 的 agent 记录不可读：Change 缺少 run 身份` }
  }
  let frozen
  let runs
  let stepVisit
  try {
    frozen = await readFrozenAgents({
      changeDir: input.dir,
      runId,
      workflowFingerprint: input.plan.workflowFingerprint,
    })
    runs = await readAgentRuns(input.dir)
    stepVisit = await currentDocumentStepVisitId(input.dir)
  } catch (error) {
    return { kind: 'block', message: `【Tenon 门】步骤 '${input.stepId}' 的 agent 记录不可读：${errMsg(error)}` }
  }
  const declared = [...step.executors.map((ref) => ref.agent), ...step.reviewers.map((ref) => ref.agent)]
  const owners = declared.filter((agent) => frozen.get(agent)?.definition.skills.includes(input.skillId) === true)
  if (owners.length === 0) return { kind: 'not-agent-skill' }
  // 候选版本只在真有 running 行时才算——它要遍历实现树，不能挂在每次技能调用上。
  const latestOf = (agent: string) => {
    let latest
    for (const row of runs) if (row.agent === agent && row.step_visit === stepVisit) latest = row
    return latest
  }
  const running = owners.filter((agent) => latestOf(agent)?.status === 'running')
  if (running.length === 0) {
    return {
      kind: 'block',
      message: `【Tenon 门】技能 '${input.skillId}' 属于 agent '${owners[0] ?? ''}'（步骤 '${input.stepId}'）；`
        + `先运行 tenon agent prompt ${input.name} ${owners[0] ?? ''} 开始该 agent 后再加载`,
    }
  }
  let candidate: string
  try {
    candidate = await currentCandidate(input.deps, input.name, input.state, input.plan, input.stepId)
  } catch (error) {
    return { kind: 'block', message: `【Tenon 门】步骤 '${input.stepId}' 的 agent 记录不可读：${errMsg(error)}` }
  }
  // 执行者本就是改代码的人，不按候选判过期；评审者的候选变了，它的这次运行已经作废。
  const fresh = running.filter((agent) => {
    const latest = latestOf(agent)
    return latest !== undefined && (latest.role === 'executor' || latest.candidate === candidate)
  })
  if (fresh.length > 0) return { kind: 'allow' }
  return {
    kind: 'block',
    message: `【Tenon 门】技能 '${input.skillId}' 属于 agent '${owners[0] ?? ''}'（步骤 '${input.stepId}'）；`
      + `候选已变化，重跑：tenon agent prompt ${input.name} ${owners[0] ?? ''}`,
  }
}
