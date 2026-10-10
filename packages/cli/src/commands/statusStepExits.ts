/**
 * `next` 的出口动作（statusStepNext.ts 的顺序表走到最后才到这里）：回退边也要过本步的人工确认门，评审门上
 * 先 request → await → transition，非评审门直接 transition / complete，没有就绪出口时给 fix。
 *
 * 纯函数；证据（必需测试 / 必需评审者）是否已经不通过由 `requiredEvidenceFailed` 判，顺序表里决定要不要填结果字段也用它。
 */
import { isAbandonEvent } from '@tenon/kernel'
import type { StepAction } from './statusStepAction.js'
import {
  hasFailedReviewer, releaseFailedReviewers, requestReviewAction, roundsVerdict,
} from './statusStepRoundsActions.js'
import type { StepRounds } from './statusStepRounds.js'
import type { RoundsRoute } from './statusStepRoundsRoute.js'
import type { StepTestFlow, TestFlowWaiver } from './statusStepTests.js'
import type { StepBlocker, StepExit } from './stepExitReport.js'

interface Verdict {
  readonly required: boolean
  readonly status: string
}

export function requiredEvidenceFailed(input: {
  readonly tests: readonly Verdict[]
  readonly reviewers: readonly Verdict[]
}): boolean {
  return input.tests.some((test) => test.required && test.status === 'failed')
    || input.reviewers.some((view) => view.required && view.status === 'fail')
}

/**
 * 回退边也要过本步的人工确认门。
 *
 * 真机实测：评审者打回后 `next` 直接给 `choose-exit: [verify-fail]`，照做却得到
 * 「phase 'verify' 的 event 'verify-fail' 尚未取得人工确认；先运行 tenon review request …
 * --event verify-fail」——`review request` 的事件绑定是逐边的（一次「回到实现」的决定不能顺便
 * 授权 verify-pass），所以回退边和前进边一样要走 request → await → transition 这条链。
 */
export function gatedBackActions(
  input: { readonly gate: string | null; readonly review: { readonly status: string; readonly event: string | null } },
  back: readonly StepExit[],
): readonly StepAction[] {
  const choose: StepAction = { action: 'choose-exit', exits: back.map((exit) => exit.event) }
  if (input.gate !== 'review') return [choose]
  const bound = back.find((exit) => exit.event === input.review.event)
  if (bound !== undefined) {
    if (input.review.status === 'pending') return [{ action: 'await-review', event: bound.event }]
    if (input.review.status === 'approved') return [{ action: 'transition', event: bound.event }]
  }
  const only = back.length === 1 ? back[0] : undefined
  return only === undefined ? [choose] : [{ action: 'request-review', event: only.event }]
}

/**
 * 评审已确认，但出口上仍有没被这次确认批准的豁免 / 配置改动：transition 必被拒，next 不发它，说明为什么批准不了。
 * 步骤测试豁免（`test:<id>`）的批准绑定被批准的那份代码，已批准的回执对现在这份失败没有效力；`review request` 不接受已确认的
 * 事件，所以要先撤回已批准的回执（回到待确认），再重新发起评审。
 */
function strandedBlocker(change: string, waiver: TestFlowWaiver): StepBlocker {
  if (waiver.protected === true) {
    return {
      source: 'test',
      code: 'protected-file-unapproved',
      message: `${waiver.text}；评审确认时它的内容与现在不同，没能被批准：重新发起 review request 让用户确认现在的内容`,
    }
  }
  const stepTest = waiver.subject?.startsWith('test:') === true
  return {
    source: 'test',
    code: 'waiver-unapproved',
    message: stepTest
      ? `${waiver.text}；评审确认时没有批准现在这份代码上的失败（豁免是确认之后才登记的，或批准绑定的是另一份代码），没能被批准：`
        + `先 tenon review revoke ${change} --reason <原因> 撤回已批准的回执，再重新发起 review request 让用户对现在这份失败重新确认`
      : `${waiver.text}；评审确认时它还不在计划里，没能被批准：撤掉这条豁免，或回退到上一步重新发起评审`,
  }
}

/**
 * 用完且评审者仍不通过，而前进边已被确认：确认时必须接受了这些评审者现在的不通过结论，否则前进边的 transition 必被拒。
 * 接受只对确认时的那次运行与代码候选有效，之后评审者有了新运行（含同一候选上带 rerun_reason 的重跑）或代码变了，
 * 已批准的回执对现在的结论没有效力——要先撤回回执，再重新发起评审让用户对现在的结论重新确认。
 */
function unacceptedBlocker(change: string, exit: StepExit): readonly StepBlocker[] {
  return exit.blockers.filter((blocker) => blocker.source === 'reviewer' && blocker.code === 'reviewer-failed').map((blocker) => ({
    ...blocker,
    code: 'residual-unaccepted',
    message: `${blocker.message}；评审确认时没有接受这个评审者现在的不通过结论（接受只对确认时的运行与代码有效），没能放行：`
      + `先 tenon review revoke ${change} --reason <原因> 撤回已批准的回执，再重新发起 review request 让用户对现在的结论重新确认`,
  }))
}

export function exitActions(input: {
  readonly change: string
  readonly review: { readonly status: string; readonly event: string | null }
  readonly gate: string | null
  readonly exits: readonly StepExit[]
  readonly tests: readonly (Verdict & { readonly id: string })[]
  readonly reviewers: readonly (Verdict & { readonly agent: string })[]
  /** 验证轮次（受上限约束的步骤）；缺席 = 不受约束。 */
  readonly rounds?: StepRounds | null
  /** 用完后回规格的路径（写进出路文案）；缺席时回退边取自 exits。 */
  readonly roundsRoute?: RoundsRoute | null
}, flow: StepTestFlow | undefined): readonly StepAction[] {
  const verdict = roundsVerdict(input, flow)
  if (verdict.kind === 'stop') return verdict.actions
  const offer = verdict.kind === 'residual' ? verdict.offer : null
  const back = input.exits.filter((exit) => exit.direction === 'back')
  if (offer === null && requiredEvidenceFailed(input) && back.length > 0) return gatedBackActions(input, back)
  // 用完且只剩评审者不通过：评审者的不通过随这次评审请求交给用户接受，不再算前进边未就绪。
  const exits = offer === null ? input.exits : releaseFailedReviewers(input.exits)
  // 用完之前发出的、绑在回退边上的评审请求没有用了（回退边被拒）：当作还没有请求，重新发前进边的。
  const bound = input.exits.find((candidate) => candidate.event === input.review.event)
  const review = offer !== null && bound?.direction === 'back' ? { status: 'none', event: null } : input.review
  // 放弃边永远就绪，却从来不是「走完这一步」的候选：留着它会把唯一的前进边挤成 choose-exit。
  const forward = exits.filter((exit) => exit.direction !== 'back' && !isAbandonEvent(exit.event))
  const readyForward = forward.filter((exit) => exit.ready)
  if (input.gate === 'review') {
    if (review.status === 'pending') {
      // 请求之后才加进计划的豁免不在冻结清单里，这次确认批准不了它们：先重新发起（幂等）再等人。
      const pendingExit = input.exits.find((candidate) => candidate.event === review.event)
      if (flow?.refreshRequest === true && review.event !== null && pendingExit?.direction !== 'back') {
        return [requestReviewAction(review.event, flow.waivers.map((waiver) => waiver.subject), offer)]
      }
      return [{ action: 'await-review', event: review.event }]
    }
    if (review.status === 'approved' && review.event !== null) {
      const exit = input.exits.find((candidate) => candidate.event === review.event)
      // 确认之后才出现的豁免没有被这次确认批准：前进边的 transition 必被拒（回退边不看测试证据）。
      const stranded = exit?.direction === 'back' ? [] : flow?.waivers ?? []
      if (stranded.length > 0) {
        return [{ action: 'fix', blockers: stranded.map((waiver) => strandedBlocker(input.change, waiver)) }]
      }
      if (offer !== null && exit !== undefined && exit.direction !== 'back' && hasFailedReviewer(exit)) {
        return [{ action: 'fix', blockers: unacceptedBlocker(input.change, exit) }]
      }
      return [{
        action: exit?.direction === 'completion' ? 'complete' : 'transition',
        event: review.event,
      }]
    }
    if (readyForward.length === 1 && readyForward[0] !== undefined) {
      // 计划里等待批准的豁免随请求一起下发：用户的确认同时批准它们，所以要连同理由展示给用户。
      const waivers = flow?.waivers ?? []
      return [requestReviewAction(readyForward[0].event, waivers.map((waiver) => waiver.subject), offer)]
    }
  } else if (readyForward.length === 1 && readyForward[0] !== undefined) {
    const exit = readyForward[0]
    return [{ action: exit.direction === 'completion' ? 'complete' : 'transition', event: exit.event }]
  }
  if (readyForward.length > 1) {
    return [{ action: 'choose-exit', exits: readyForward.map((exit) => exit.event) }]
  }
  return [{ action: 'fix', blockers: forward.flatMap((exit) => exit.blockers) }]
}
