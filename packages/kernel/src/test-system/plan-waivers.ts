/**
 * 豁免批准（纯函数）。评审请求时列出计划里还没批准的豁免（`pendingWaivers`），确认时只批准列出的那几条
 * （`approveWaivers`）：请求之后才加进计划、或理由被改过的豁免不在这次确认的范围内，仍然挡出口。
 *
 * 写盘不在这里：CLI 用 `writeTestPlan` / `writeTestPlanUnderLock` 落盘，`approved_by` 只由
 * `tenon review acknowledge` 的同一次确认写入。
 */
import { testPlanDigest, waiverKey, type PlanWaiver, type TestPlan } from './plan.js'

export interface PendingWaiver {
  /** `kind:<kind>` 或 `covers:<spec:…|task:…>`，与 `waiverKey` 同一口径。 */
  readonly key: string
  readonly reason: string
}

export type WaiverSkipReason = 'missing' | 'reason-changed' | 'already-approved'

export interface WaiverApproval {
  readonly plan: TestPlan
  /** 本次批准的豁免键，保持选择顺序。 */
  readonly approved: readonly string[]
  readonly skipped: readonly { readonly key: string; readonly why: WaiverSkipReason }[]
}

/** 计划里 `approved_by` 仍为空的豁免，按键排序（计划本身就是规范化排序）。 */
export function pendingWaivers(plan: TestPlan): readonly PendingWaiver[] {
  return plan.waivers
    .filter((waiver) => waiver.approved_by === null)
    .map((waiver) => ({ key: waiverKey(waiver), reason: waiver.reason }))
}

/**
 * 批准 `selection` 里列出的豁免。键相同、理由逐字相同、且当前仍未批准的才写入 `approver`；
 * 其余原样保留并在 `skipped` 里说明原因。
 */
export function approveWaivers(
  plan: TestPlan,
  selection: readonly PendingWaiver[],
  approver: string,
): WaiverApproval {
  const approved: string[] = []
  const skipped: { key: string; why: WaiverSkipReason }[] = []
  const chosen = new Map(selection.map((item) => [item.key, item.reason]))
  const waivers: PlanWaiver[] = plan.waivers.map((waiver) => {
    const key = waiverKey(waiver)
    const reason = chosen.get(key)
    if (reason === undefined) return waiver
    chosen.delete(key)
    if (waiver.approved_by !== null) {
      skipped.push({ key, why: 'already-approved' })
      return waiver
    }
    if (waiver.reason !== reason) {
      skipped.push({ key, why: 'reason-changed' })
      return waiver
    }
    approved.push(key)
    return { ...waiver, approved_by: approver }
  })
  for (const key of chosen.keys()) skipped.push({ key, why: 'missing' })
  return { plan: approved.length === 0 ? plan : { ...plan, waivers }, approved, skipped }
}

/**
 * 计划摘要（豁免批准位全部视为未批准）。批准只是把 `approved_by` 从空写成批准人：计划里没有别的变化时，
 * 批准之前的运行仍绑定同一份计划，不该因为这次确认而全部过期（见 evaluate-suite 的新鲜度判定）。
 */
export function testPlanApprovalFreeDigest(plan: TestPlan): string {
  return testPlanDigest({ ...plan, waivers: plan.waivers.map((waiver) => ({ ...waiver, approved_by: null })) })
}
