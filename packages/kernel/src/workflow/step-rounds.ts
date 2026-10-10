/**
 * 验证轮次：哪些步骤受上限约束、当前是第几轮。纯函数，不碰文件系统；转换记录由调用方读出来再传进来。
 *
 * 受约束的步骤 = 设了评审门（`gate: review`）且至少有一条回退边。build 这类没有评审门的步骤不受约束，
 * 它的回退边（如 `requirements-changed`）始终可用。回退边的判定沿用 `isForwardEdge`（与出边报告同一口径）。
 */
import type { GateKind } from './types.js'
import { isForwardEdge } from './implicit-completion.js'

export * from './max-rounds.js'

/** 判定回退边只需要的计划形状（EffectiveWorkflowPlan 与编译中的 IR 都满足）。 */
export interface RoundsPlan {
  readonly executionModel: 'phase-manifest' | 'step-graph'
  readonly workflow: {
    readonly steps: readonly {
      readonly id: string
      readonly gate: GateKind
      readonly transitions: readonly { readonly event: string; readonly to: string }[]
    }[]
  }
}

/** 本步所有回退边的目标步骤，按声明序去重。 */
export function stepBackTargets(plan: RoundsPlan, stepId: string): readonly string[] {
  const step = plan.workflow.steps.find((candidate) => candidate.id === stepId)
  if (step === undefined) return []
  const ids = plan.workflow.steps.map((candidate) => candidate.id)
  const targets: string[] = []
  for (const transition of step.transitions) {
    if (isForwardEdge(plan.executionModel, ids, stepId, transition.to, transition.event)) continue
    if (!targets.includes(transition.to)) targets.push(transition.to)
  }
  return targets
}

/** 受上限约束：设了评审门，且至少有一条回退边。 */
export function isRoundsLimited(plan: RoundsPlan, stepId: string): boolean {
  const step = plan.workflow.steps.find((candidate) => candidate.id === stepId)
  return step?.gate === 'review' && stepBackTargets(plan, stepId).length > 0
}

export interface RoundTransition {
  readonly to: string
  /** 转换记录所属的 run；旧任务的历史行没有这个键，照常计入。 */
  readonly runId?: string
}

/**
 * 当前是第几轮 = 自最近一次清零以来进入 `stepId` 的次数（含当前这次；任务当前不在该步时是已进入的次数）。
 *
 * 清零：任务落到**早于所有回退目标**的步骤（default 里是经 `requirements-changed` 回到规格）。落到回退目标
 * 本身、或夹在多个回退目标之间的步骤，都不清零。只数 `runId` 对应的 run（另一个 run 的记录不计）；
 * `runId` 为 null 时全部计入。工作流的第一步就是受约束步骤时，任务创建时的那次进入也算一轮。
 */
export function currentRound(input: {
  readonly stepId: string
  readonly steps: readonly string[]
  readonly backTargets: readonly string[]
  readonly transitions: readonly RoundTransition[]
  readonly runId: string | null
}): number {
  const targetIndexes = input.backTargets.map((target) => input.steps.indexOf(target)).filter((index) => index >= 0)
  const resetBelow = targetIndexes.length === 0 ? -1 : Math.min(...targetIndexes)
  let rounds = input.steps[0] === input.stepId ? 1 : 0
  for (const transition of input.transitions) {
    if (input.runId !== null && transition.runId !== undefined && transition.runId !== input.runId) continue
    const index = input.steps.indexOf(transition.to)
    if (index < 0) continue
    if (transition.to === input.stepId) rounds += 1
    else if (index < resetBelow) rounds = 0
  }
  return rounds
}
