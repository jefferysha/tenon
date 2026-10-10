/**
 * 豁免批准（纯函数）。评审请求时列出计划里还没批准的豁免（`pendingWaivers`），确认时只批准列出的那几条
 * （`approveWaivers`）：请求之后才加进计划、或理由被改过的豁免不在这次确认的范围内，仍然挡出口。
 *
 * 步骤测试豁免（`test:<id>`）的批准绑定被批准的那份代码：清单项带着请求时失败记录的候选，确认时与 `approved_by`
 * 一起写进计划的 `approved_candidate`。批准之后代码变了、同一测试再次失败，或旧版本留下的批准没有候选，
 * 判定都当作「待批准」（evaluate 的 stepTestWaiver），评审请求要把它们再次列给用户，确认时重新批准。
 *
 * 写盘不在这里：CLI 用 `writeTestPlan` / `writeTestPlanUnderLock` 落盘，`approved_by` 只由
 * `tenon review acknowledge` 的同一次确认写入。
 */
import { testPlanDigest, waiverKey, type PlanWaiver, type TestPlan } from './plan.js'

export interface PendingWaiver {
  /** `kind:<kind>`、`covers:<spec:…|task:…>` 或 `test:<步骤测试 id>`，与 `waiverKey` 同一口径。 */
  readonly key: string
  readonly reason: string
  /**
   * 只给 `test:` 键：请求时该测试新鲜失败记录绑定的代码候选。确认时写进计划的 `approved_candidate`，
   * 这次批准就绑定它；缺省 = 请求时没有新鲜失败可绑定（批准之后失败出现了，会再次列给用户）。
   */
  readonly candidate?: string
}

export type WaiverSkipReason = 'missing' | 'reason-changed' | 'already-approved'

export interface WaiverApproval {
  readonly plan: TestPlan
  /** 本次批准的豁免键，保持选择顺序。 */
  readonly approved: readonly string[]
  readonly skipped: readonly { readonly key: string; readonly why: WaiverSkipReason }[]
}

/**
 * 一个步骤测试当前新鲜失败的豁免事实（取自测试证据项）：`waived` = 批准有效，`waiver-pending` = 待批准
 * （未批准、批准的是别的代码、或旧批准没有候选）。`candidate` 是那条失败记录绑定的代码候选。
 */
export interface StepTestFailure {
  readonly state: 'waived' | 'waiver-pending'
  readonly candidate?: string
}
/** 键为步骤测试 id；没有新鲜失败的测试不在其中。 */
export type StepTestFailures = ReadonlyMap<string, StepTestFailure>

const NO_FAILURES: StepTestFailures = new Map()

/**
 * 需要用户（再次）批准的豁免，按键排序（计划本身就是规范化排序）：`approved_by` 为空的；以及 `test:` 豁免里
 * 当前新鲜失败判为 `waiver-pending` 的已批准项（批准绑定的代码不是现在这份、或旧批准没有候选）。
 * 带 `waiver-pending` 失败事实的 `test:` 项附上失败记录的候选；`failures` 缺省 = 只看批准位。
 */
export function pendingWaivers(plan: TestPlan, failures: StepTestFailures = NO_FAILURES): readonly PendingWaiver[] {
  return plan.waivers.flatMap((waiver): PendingWaiver[] => {
    const failure = waiver.test === undefined ? undefined : failures.get(waiver.test)
    if (waiver.approved_by !== null && failure?.state !== 'waiver-pending') return []
    return [{
      key: waiverKey(waiver),
      reason: waiver.reason,
      ...(failure?.state === 'waiver-pending' && failure.candidate !== undefined ? { candidate: failure.candidate } : {}),
    }]
  })
}

/** 写入批准人；`test:` 豁免同时写下清单里的候选（被批准的那份代码）。 */
function approvedAs(waiver: PlanWaiver, approver: string, candidate: string | undefined): PlanWaiver {
  return waiver.test !== undefined && candidate !== undefined
    ? { ...waiver, approved_by: approver, approved_candidate: candidate }
    : { ...waiver, approved_by: approver }
}

/**
 * 批准 `selection` 里列出的豁免。键相同、理由逐字相同、且当前仍待批准的才写入 `approver`（`test:` 项连同清单里的候选）；
 * 其余原样保留并在 `skipped` 里说明原因。已批准的 `test:` 豁免，清单带着与已批准候选不同的候选时是重新批准
 * （新批准人 + 新候选）；清单没带候选、或候选相同则仍是「已经批准过」。
 */
export function approveWaivers(
  plan: TestPlan,
  selection: readonly PendingWaiver[],
  approver: string,
): WaiverApproval {
  const approved: string[] = []
  const skipped: { key: string; why: WaiverSkipReason }[] = []
  const chosen = new Map(selection.map((item) => [item.key, item]))
  const waivers: PlanWaiver[] = plan.waivers.map((waiver) => {
    const key = waiverKey(waiver)
    const item = chosen.get(key)
    if (item === undefined) return waiver
    chosen.delete(key)
    const reapproval = waiver.test !== undefined && item.candidate !== undefined && waiver.approved_candidate !== item.candidate
    if (waiver.approved_by !== null && !reapproval) {
      skipped.push({ key, why: 'already-approved' })
      return waiver
    }
    if (waiver.reason !== item.reason) {
      skipped.push({ key, why: 'reason-changed' })
      return waiver
    }
    approved.push(key)
    return approvedAs(waiver, approver, item.candidate)
  })
  for (const key of chosen.keys()) skipped.push({ key, why: 'missing' })
  return { plan: approved.length === 0 ? plan : { ...plan, waivers }, approved, skipped }
}

/**
 * 计划摘要（豁免批准位全部视为未批准）。批准只是把 `approved_by` 从空写成批准人（`test:` 豁免另写被批准的候选）：
 * 计划里没有别的变化时，批准之前的运行仍绑定同一份计划，不该因为这次确认而全部过期（见 evaluate-suite 的新鲜度判定）。
 */
export function testPlanApprovalFreeDigest(plan: TestPlan): string {
  return testPlanDigest({
    ...plan,
    waivers: plan.waivers.map((waiver) => ({ ...waiver, approved_by: null, approved_candidate: undefined }) as PlanWaiver),
  })
}
