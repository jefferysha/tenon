/**
 * 测试计划豁免的评审批准。
 *
 *   · `tenon review request`：在 Change 锁内把计划里未批准的豁免冻结成清单（边车），并逐条列给用户；
 *   · `tenon review acknowledge`（人工确认，非 `--delegated`）：在提交 approved receipt 的同一把锁内，
 *     只把清单里仍原样存在的豁免写上 `approved_by`（kernel 计划写入口，CLI 独占），随后留一行审计。
 *
 * 豁免是「策略要求但本任务不适用」的例外，批准它就是接受一次偏差，所以委托确认（`--delegated`）、
 * AFK 都不批准：它们留下的豁免继续挡出口，直到人工确认。
 */
import {
  approveWaivers, clearReviewWaiverSelection, pendingWaivers, readReviewWaiverSelection, readTestPlanState,
  reviewGateEvent, writeReviewWaiverSelection, writeTestPlanUnderLock,
  type PendingWaiver, type PipelineState, type RecordActor, type WaiverSkipReason,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { recordTestAudit } from '../testAudit.js'

/** 冻结清单（调用方持有 Change 锁）。计划缺失 / 不可信 / 没有待批准豁免时清掉旧清单。 */
export async function freezePendingWaivers(
  dir: string,
  change: string,
  request: { readonly phase: string; readonly event: string; readonly requestedAt: string },
): Promise<readonly PendingWaiver[]> {
  const plan = await readTestPlanState(dir, change)
  const pending = plan.state === 'ok' ? pendingWaivers(plan.plan) : []
  if (pending.length === 0) await clearReviewWaiverSelection(dir)
  else await writeReviewWaiverSelection(dir, { ...request, waivers: pending })
  return pending
}

export function waiverLines(waivers: readonly PendingWaiver[]): readonly string[] {
  if (waivers.length === 0) return []
  return [
    `[REVIEW] 待批准的豁免 ${waivers.length} 项（用户的确认同时批准这些豁免，请连同理由一并展示给用户）：`,
    ...waivers.map((waiver) => `  ${waiver.key} — ${waiver.reason}`),
  ]
}

export interface WaiverApprovalOutcome {
  readonly approved: readonly string[]
  readonly skipped: readonly { readonly key: string; readonly why: WaiverSkipReason }[]
  /** 计划新摘要；没有写入时 null。 */
  readonly digest: string | null
  /** 清单存在却没能批准的原因（计划缺失 / 不可信），用于提示。 */
  readonly note: string | null
}

function scalar(state: PipelineState, field: 'review_requested_at' | 'review_gate_phase'): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

const NONE: WaiverApprovalOutcome = { approved: [], skipped: [], digest: null, note: null }

const SKIP_WORDS: Readonly<Record<WaiverSkipReason, string>> = {
  missing: '已不在计划里',
  'reason-changed': '请求之后理由被改过',
  'already-approved': '已经批准过',
}

export function skippedWaiverLines(outcome: WaiverApprovalOutcome): readonly string[] {
  return outcome.skipped.map((item) => `[REVIEW] 豁免 ${item.key} 未批准：${SKIP_WORDS[item.why]}；需要时重新 review request`)
}

/**
 * 在提交 approved receipt 的那把锁内批准冻结清单里的豁免。清单必须绑定 `state` 里的这一次请求
 * （phase / event / requestedAt 逐项相同），否则什么都不批准。写入失败向上抛：receipt 尚未提交，
 * 用户重试同一条 acknowledge 即可（已批准的豁免会被识别为「已经批准过」）。
 */
export async function approveFrozenWaivers(input: {
  readonly dir: string
  readonly change: string
  readonly state: PipelineState
  readonly actor: RecordActor
  readonly recordedAt: string
}): Promise<WaiverApprovalOutcome> {
  const selection = await readReviewWaiverSelection(input.dir)
  if (selection === undefined || selection.waivers.length === 0) return NONE
  const requestedAt = scalar(input.state, 'review_requested_at')
  const phase = scalar(input.state, 'review_gate_phase')
  if (selection.phase !== phase || selection.event !== reviewGateEvent(input.state) || selection.requestedAt !== requestedAt) {
    return { ...NONE, note: '豁免清单不属于这一次 review request，未批准任何豁免' }
  }
  const plan = await readTestPlanState(input.dir, input.change)
  if (plan.state !== 'ok') {
    return { ...NONE, note: `测试计划${plan.state === 'missing' ? '不存在' : `不可信（${plan.reason}）`}，未批准任何豁免` }
  }
  const result = approveWaivers(plan.plan, selection.waivers, input.actor.id)
  if (result.approved.length === 0) return { ...NONE, skipped: result.skipped }
  const written = await writeTestPlanUnderLock(input.dir, result.plan, { actor: input.actor, recordedAt: input.recordedAt })
  return { approved: result.approved, skipped: result.skipped, digest: written.digest, note: null }
}

/** receipt 已提交之后：清掉冻结清单（锁内、尽力而为——清单绑定请求时间，残留不会被下一次请求误用）。 */
export async function retireFrozenWaivers(dir: string): Promise<void> {
  await clearReviewWaiverSelection(dir).catch(() => undefined)
}

/** receipt 已提交之后：审计行（尽力而为）。 */
export async function auditWaiverApproval(
  deps: CliDeps,
  dir: string,
  outcome: WaiverApprovalOutcome,
  approver: string,
): Promise<void> {
  if (outcome.approved.length === 0) return
  await recordTestAudit(deps, dir, 'waiver-approve', {
    waivers: outcome.approved.join(','),
    by: approver,
    plan: outcome.digest ?? undefined,
  })
}
