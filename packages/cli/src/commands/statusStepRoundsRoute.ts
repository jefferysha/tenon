/**
 * 验证轮次用完后「回到规格重新规划」的真实路径（纯函数，只读计划）。
 *
 * 受约束步骤（评审门且有回退边）自己没有一条会让轮次清零的边：它声明的每条回退边本身都是它的回退目标，轮次只在落到
 * **早于所有回退目标**的步骤时清零（kernel `currentRound`），而用完之后这些回退边也都被拒（`rejectOnRoundsExhausted`）。
 * 所以出路是两步：用户先调高上限，经回退边回到回退目标步骤，再在**那一步**上执行落到更早步骤的边。default 里就是
 * verify 经 `verify-fail` 回 build，再在 build 上用 `requirements-changed` 回 spec。
 */
import { isAbandonEvent, isRoundsLimited, stepBackTargets, type RoundsPlan } from '@tenon/kernel'

interface RouteEdge {
  readonly event: string
  readonly to: string
}

export interface RoundsRoute {
  /** 经它回到回退目标步骤的回退边（放弃边除外）；本步只有放弃边这一类回退边时为 null。 */
  readonly back: RouteEdge | null
  /** 回退目标步骤上落到更早步骤（轮次因此清零）的边；找不到 = null。 */
  readonly reset: RouteEdge | null
  /** 工作流里有早于所有回退目标的步骤可落；false = 回规格不会让轮次清零。 */
  readonly resettable: boolean
}

/** 受约束步骤的回规格路径；不受约束的步骤（没有评审门或没有回退边、不在计划里）为 null。 */
export function roundsRoute(plan: RoundsPlan, stepId: string): RoundsRoute | null {
  if (!isRoundsLimited(plan, stepId)) return null
  const steps = plan.workflow.steps
  const ids = steps.map((step) => step.id)
  const targets = stepBackTargets(plan, stepId)
  const indexes = targets.map((target) => ids.indexOf(target)).filter((index) => index >= 0)
  const resetBelow = indexes.length === 0 ? -1 : Math.min(...indexes)
  const backEdges = (steps.find((step) => step.id === stepId)?.transitions ?? [])
    .filter((edge) => !isAbandonEvent(edge.event) && targets.includes(edge.to))
  for (const edge of backEdges) {
    const landing = steps.find((step) => step.id === edge.to)?.transitions.find((candidate) => {
      const index = ids.indexOf(candidate.to)
      return !isAbandonEvent(candidate.event) && index >= 0 && index < resetBelow
    })
    if (landing !== undefined) {
      return {
        back: { event: edge.event, to: edge.to },
        reset: { event: landing.event, to: landing.to },
        resettable: true,
      }
    }
  }
  const first = backEdges[0]
  return {
    back: first === undefined ? null : { event: first.event, to: first.to },
    reset: null,
    resettable: first !== undefined && resetBelow > 0,
  }
}
