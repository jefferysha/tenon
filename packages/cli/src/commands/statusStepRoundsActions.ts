/**
 * `next` 里的验证轮次上限编排（纯函数）。受上限约束的步骤（评审门且有回退边）当前轮次已达上限时，`next` 不再给出
 * 回退边的评审请求 / 选择 / 转换，按不通过的是什么分两种：
 *
 *   · 还有没登记豁免的失败必需测试 → `stop`（code `rounds-exhausted`）：停下交给用户，说明可以先登记步骤测试豁免；
 *   · 只有必需评审者不通过，或失败的必需测试都已登记豁免 → 前进边的 `request-review`，带 `residual`
 *     （待接受的剩余阻断 `reviewer:<agent>`）、`rounds` 与另外三条出路 `alternatives`，评审者的不通过随这次请求
 *     交给用户接受。
 *
 * 两种都要写清另外三条出路：用户决定调高上限后回退修复、回到规格重新规划（受约束步骤上没有直达的边，要先调高上限
 * 经回退边回到回退目标，再在那一步上回到规格，见 `statusStepRoundsRoute.ts`）、终止任务。强制层在
 * `review request` / `transition`（用完时回退边被拒），这里只是投影。
 */
import { isAbandonEvent, residualKey, roundsExhausted } from '@tenon/kernel'
import { stop, type StepAction } from './statusStepAction.js'
import type { StepRounds } from './statusStepRounds.js'
import type { RoundsRoute } from './statusStepRoundsRoute.js'
import { rollbackFailedItems, type StepTestFlow } from './statusStepTests.js'
import type { StepExit } from './stepExitReport.js'

export interface RoundsFacts {
  readonly change: string
  readonly gate: string | null
  readonly rounds?: StepRounds | null
  /** 回规格的路径（来自计划）；缺席 = 回退边取自 exits，回规格的事件不点名。 */
  readonly roundsRoute?: RoundsRoute | null
  readonly exits: readonly StepExit[]
  readonly tests: readonly { readonly id: string; readonly required: boolean; readonly status: string }[]
  readonly reviewers: readonly { readonly agent: string; readonly required: boolean; readonly status: string }[]
}

/** 前进边评审请求上随 `residual` 一起下发的说明。 */
export interface ResidualOffer {
  readonly residual: readonly string[]
  readonly rounds: StepRounds
  readonly alternatives: readonly string[]
}

export type RoundsVerdict =
  | { readonly kind: 'open' }
  | { readonly kind: 'stop'; readonly actions: readonly StepAction[] }
  | { readonly kind: 'residual'; readonly offer: ResidualOffer }

const SOURCE_LABEL: Readonly<Record<StepRounds['source'], string>> = {
  workflow: '工作流声明',
  default: '内置默认',
  task: '任务字段 max_rounds',
}

/** 没有 `roundsRoute` 的调用方：回退边取自 exits（第一条非放弃的回退边），回规格的事件不点名。 */
function routeFromExits(exits: readonly StepExit[]): RoundsRoute {
  const back = exits.find((exit) => exit.direction === 'back' && !isAbandonEvent(exit.event))
  return { back: back === undefined ? null : { event: back.event, to: back.to }, reset: null, resettable: true }
}

/**
 * 「回到规格重新规划」：受约束步骤上没有直达的边（它声明的回退边落到哪都不会让轮次清零，用完后也都被拒），
 * 所以分两步，第一步同样要用户先决定调高上限；回到更早的步骤后轮次才重新计数。
 */
function specAlternative(change: string, rounds: StepRounds, route: RoundsRoute): string {
  const { back, reset } = route
  if (back === null || !route.resettable) {
    return '回到规格不会让验证轮次重新计数（回退目标之前没有更早的步骤可落，轮次不会清零），这条路并不比上一条省事：'
      + `由用户调高上限后${back === null ? '' : `经回退边 ${back.event} `}回退修复`
  }
  const first = `先由用户定 N（须大于 ${rounds.current}），执行 tenon set ${change} max_rounds <N>，调高后重读 next，经回退边 ${back.event} 回到 ${back.to}`
  const head = '当前步骤上没有直达这条路的边（用完后它的回退边也被拒），要分两步，第一步同样要用户先决定调高上限——'
  const again = '，回到规格后验证轮次重新计数，用户可以再把 max_rounds 调回去'
  if (reset === null) {
    return `回到规格重新规划：${head}${first}；再在 ${back.to} 上执行那一步上回到规格的事件（tenon status ${change} --json 的 step.exits 里看）${again}`
  }
  return `经 ${reset.event} 回到 ${reset.to} 重新规划：${head}${first}；再在 ${back.to} 上执行 tenon transition ${change} ${reset.event} 回到 ${reset.to}${again}`
}

/** 用完之后另外三条出路（stop 与前进边的评审请求共用同一份文案）。 */
export function roundsAlternatives(change: string, rounds: StepRounds, route: RoundsRoute): readonly string[] {
  return [
    `调高上限后回退修复：这是用户的决定，没有用户明确指示不要执行；由用户定 N（须大于 ${rounds.current}），执行 tenon set ${change} max_rounds <N>。`
      + '设置会改变任务状态，已发起或已批准的评审请求随之失效，调高之后重读 next 并重新 tenon review request',
    specAlternative(change, rounds, route),
    '终止任务：用户决定不再继续时就停在这里，不要自行放弃，也不要绕过上限',
  ]
}

function roundsLabel(rounds: StepRounds): string {
  return `${rounds.current}/${rounds.max}，上限来源：${SOURCE_LABEL[rounds.source]}`
}

function roundsStop(
  change: string,
  rounds: StepRounds,
  route: RoundsRoute,
  failing: readonly string[],
): readonly StepAction[] {
  const [raise, back, end] = roundsAlternatives(change, rounds, route)
  return stop(
    'rounds-exhausted',
    `验证轮次已用完（${roundsLabel(rounds)}），不再自动回退修复；必需测试 ${failing.join('、')} 仍然失败且没有登记豁免。`
      + '停下，把下列出路交给用户，等用户决定：'
      + `① 先登记步骤测试豁免：tenon test waive ${change} --test <测试 id> --reason <理由>（目录套件的失败用 --kind <种类> 或 --covers <条目>），`
      + '豁免经评审确认批准后再重读 next；评审者仍不通过的部分会作为剩余阻断，随前进边的评审请求一并交给用户接受；'
      + `② ${raise}；③ ${back}；④ ${end}`,
  )
}

/** 用完之后 `next` 该怎么走；未用完（或不受约束、没有失败的证据）= open，行为与没有上限时一致。 */
export function roundsVerdict(facts: RoundsFacts, flow: StepTestFlow | undefined): RoundsVerdict {
  const { rounds } = facts
  if (facts.gate !== 'review' || rounds === null || rounds === undefined || !roundsExhausted(rounds)) return { kind: 'open' }
  if (!facts.exits.some((exit) => exit.direction === 'back')) return { kind: 'open' }
  const route = facts.roundsRoute ?? routeFromExits(facts.exits)
  const failingTests = [...new Set([
    ...facts.tests.filter((test) => test.required && test.status === 'failed').map((test) => test.id),
    ...rollbackFailedItems(flow).map((item) => item.subject ?? item.code),
  ])]
  if (failingTests.length > 0) return { kind: 'stop', actions: roundsStop(facts.change, rounds, route, failingTests) }
  const failing = facts.reviewers.filter((view) => view.required && view.status === 'fail')
  if (failing.length === 0) return { kind: 'open' }
  return {
    kind: 'residual',
    offer: {
      residual: failing.map((view) => residualKey(view.agent)),
      rounds,
      alternatives: roundsAlternatives(facts.change, rounds, route),
    },
  }
}

/**
 * `status --json` 的 `exits`：用完后受约束步骤的回退边不再算就绪（命令会拒绝它），带一条 `rounds-exhausted` 阻断。
 * 放弃边（scope-expanded）永远可用，前进边不受影响。未用完 / 不受约束时原样返回同一份。
 */
export function blockExhaustedBackExits(
  change: string,
  exits: readonly StepExit[],
  rounds: StepRounds | null | undefined,
): readonly StepExit[] {
  if (rounds === null || rounds === undefined || !roundsExhausted(rounds)) return exits
  return exits.map((exit) => {
    if (exit.direction !== 'back' || isAbandonEvent(exit.event)) return exit
    return {
      ...exit,
      ready: false,
      blockers: [...exit.blockers, {
        source: 'guard',
        code: 'rounds-exhausted',
        message: `验证轮次已用完（${roundsLabel(rounds)}），回退边 ${exit.event} 不再放行；调高上限是用户的决定：tenon set ${change} max_rounds <N>（N 须大于 ${rounds.current}）`,
      }],
    }
  })
}

/** 前进边的评审请求；有剩余阻断时带上 residual / rounds / alternatives。 */
export function requestReviewAction(
  event: string,
  waivers: readonly (string | null)[],
  offer: ResidualOffer | null,
): StepAction {
  return {
    action: 'request-review',
    event,
    ...(waivers.length === 0 ? {} : { waivers }),
    ...(offer === null ? {} : { residual: offer.residual, rounds: offer.rounds, alternatives: offer.alternatives }),
  }
}

const isFailedReviewer = (blocker: { readonly source: string; readonly code: string }): boolean =>
  blocker.source === 'reviewer' && blocker.code === 'reviewer-failed'

/** 评审者不通过随评审请求交给用户接受：前进边上的这类阻断不再算「出口未就绪」（回退边本来就不带它们）。 */
export function releaseFailedReviewers(exits: readonly StepExit[]): readonly StepExit[] {
  return exits.map((exit) => {
    if (exit.direction === 'back') return exit
    const blockers = exit.blockers.filter((blocker) => !isFailedReviewer(blocker))
    return blockers.length === exit.blockers.length ? exit : { ...exit, blockers, ready: blockers.length === 0 }
  })
}

/** 这条出边上还有评审者不通过的阻断（接受没有覆盖它）。 */
export function hasFailedReviewer(exit: StepExit | undefined): boolean {
  return exit?.blockers.some(isFailedReviewer) === true
}
