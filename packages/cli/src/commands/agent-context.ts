/**
 * `tenon agent next | prompt | record` 的共同前置：change、冻结计划、当前步骤的 agent 声明、步骤访问身份、候选版本、
 * 台账里的运行、冻结的 agent 定义与必需测试是否就绪。三个命令读到的是同一份上下文。
 */
import {
  currentDocumentStepVisitId, readAgentRuns, readFrozenAgents,
  type AgentRunRow, type EffectiveWorkflowPlan, type FrozenAgent, type StepAgentsCapability, type TestPolicyReport,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { unattachedReviewersFor } from '../diffRisk.js'
import { str } from '../render.js'
import { testsReadyFor } from './agent-tests-ready.js'
import { currentCandidate } from './candidate.js'
import { resolveChangeCommand, type TestCommandContext } from './test-context.js'

export interface AgentContext extends TestCommandContext {
  readonly step: StepAgentsCapability
  readonly stepVisit: string
  readonly candidate: string
  readonly runs: readonly AgentRunRow[]
  readonly frozen: ReadonlyMap<string, FrozenAgent>
  /** 本任务的改动没有命中其 `attach_on` 的评审者：不投影、不排波、不阻断，`prompt` 也不接（diffRisk.ts 算出）。 */
  readonly unattached: readonly string[]
  readonly testsReady: { readonly ready: boolean; readonly pending: readonly string[] }
  /** 本步声明了 test_policy 时的策略判定（评审者提示词的 v2 测试摘要读它）。 */
  readonly testPolicy: TestPolicyReport | undefined
}

export function stepAgentsOf(plan: EffectiveWorkflowPlan, stepId: string): StepAgentsCapability {
  return plan.capabilities.agents.steps.find((step) => step.stepId === stepId)
    ?? { stepId, executors: [], reviewers: [] }
}

export async function resolveAgentCommand(
  deps: CliDeps,
  name: string,
  options: {
    readonly requireOwner: boolean
    /** 读完冻结内容、算候选之前的一步（生成宿主 agent 文件放在这里，候选不会因它而变）。 */
    readonly prepare?: (frozen: ReadonlyMap<string, FrozenAgent>) => Promise<void>
  },
): Promise<AgentContext | number> {
  const base = await resolveChangeCommand(deps, name, options)
  if (typeof base === 'number') return base
  const stepId = str(base.state.fields.phase)
  const step = stepAgentsOf(base.plan, stepId)
  const runId = base.state.runMetadata?.runId
  if (runId === undefined || runId === '') {
    deps.io.err(`ERROR: Change '${name}' 缺少 run 身份，无法记录 agent 运行`)
    return 1
  }
  try {
    const frozen = step.executors.length === 0 && step.reviewers.length === 0
      ? new Map<string, FrozenAgent>()
      : await readFrozenAgents({ changeDir: base.dir, runId, workflowFingerprint: base.plan.workflowFingerprint })
    await options.prepare?.(frozen)
    const tests = await testsReadyFor(deps, base, stepId)
    return {
      ...base,
      step,
      stepVisit: await currentDocumentStepVisitId(base.dir),
      candidate: await currentCandidate(deps, name, base.state, base.plan, stepId),
      runs: await readAgentRuns(base.dir),
      frozen,
      unattached: await unattachedReviewersFor(deps, name, step, frozen),
      testsReady: tests.ready,
      testPolicy: tests.policy,
    }
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
}

export function roleOf(step: StepAgentsCapability, agent: string): 'executor' | 'reviewer' | undefined {
  if (step.executors.some((ref) => ref.agent === agent)) return 'executor'
  if (step.reviewers.some((ref) => ref.agent === agent)) return 'reviewer'
  return undefined
}
