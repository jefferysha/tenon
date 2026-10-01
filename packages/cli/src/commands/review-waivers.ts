/**
 * 测试计划豁免与目录里项目级「不适用」声明（catalog.yaml 的 not_applicable）的评审批准。
 *
 *   · `tenon review request`：在 Change 锁内把计划里未批准的豁免、目录里未批准的「不适用」声明冻结成清单（边车），并逐条列给用户；
 *   · `tenon review acknowledge`（人工确认，非 `--delegated`）：在提交 approved receipt 的同一把锁内，
 *     只把清单里仍原样存在的豁免写上 `approved_by`（kernel `approveFrozenWaivers`，与 Dashboard 的确认共用），随后留一行审计。
 *
 * 豁免是「策略要求但本任务不适用」的例外，批准它就是接受一次偏差，所以委托确认（`--delegated`）、
 * AFK 都不批准。计划里还有待批准的豁免时，委托确认整个被拒（receipt 保持待确认）：让它先把 receipt 用掉，
 * 只会留下一个谁也批准不了的豁免（request 已经被消费，人工确认也没有可确认的了）。用户回复「确认继续」
 * 走人工确认，批准豁免并放行。
 */
import {
  clearReviewWaiverSelection, pendingReviewWaivers, writeReviewWaiverSelection,
  type PendingWaiver, type WaiverApprovalOutcome, type WaiverSkipReason,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { recordTestAudit } from '../testAudit.js'

/** 冻结清单（调用方持有 Change 锁）。没有待批准的豁免 / 声明（计划缺失、不可信也算）时清掉旧清单。 */
export async function freezePendingWaivers(
  repoRoot: string,
  dir: string,
  change: string,
  request: { readonly phase: string; readonly event: string; readonly requestedAt: string },
): Promise<readonly PendingWaiver[]> {
  const pending = await pendingReviewWaivers({ repoRoot, dir, change })
  if (pending.length === 0) await clearReviewWaiverSelection(dir)
  else await writeReviewWaiverSelection(dir, { ...request, waivers: pending })
  return pending
}

export function waiverLines(waivers: readonly PendingWaiver[]): readonly string[] {
  if (waivers.length === 0) return []
  return [
    `[REVIEW] 待批准的豁免 ${waivers.length} 项（用户的确认同时批准这些豁免；\`not-applicable:<种类>\` 是 catalog.yaml 里项目级的「不适用」声明，批准一次对全项目生效。请连同理由一并展示给用户）：`,
    ...waivers.map((waiver) => `  ${waiver.key} — ${waiver.reason}`),
  ]
}

const SKIP_WORDS: Readonly<Record<WaiverSkipReason, string>> = {
  missing: '已不在计划里',
  'reason-changed': '请求之后理由被改过',
  'already-approved': '已经批准过',
}

export function skippedWaiverLines(outcome: WaiverApprovalOutcome): readonly string[] {
  return outcome.skipped.map((item) => `[REVIEW] 豁免 ${item.key} 未批准：${SKIP_WORDS[item.why]}；需要时重新 review request`)
}

/**
 * 委托确认在提交 approved receipt 之前的检查（锁内）：计划里还有未批准的豁免、或目录里还有未批准的「不适用」声明就拒绝，
 * 抛错、不写任何东西。计划缺失或不可信时没有可批准的计划豁免，放行（这些状态由测试门禁自己挡）。
 */
export async function refuseDelegatedWhileWaiversPending(repoRoot: string, dir: string, change: string): Promise<void> {
  const pending = await pendingReviewWaivers({ repoRoot, dir, change })
  if (pending.length === 0) return
  throw new Error(
    `有 ${pending.length} 项测试豁免 / 不适用声明待人工批准（${pending.map((item) => item.key).join('、')}）：`
    + '委托确认不批准豁免（也不批准目录里的「不适用」声明）；请用户回复「确认继续」人工确认，或先撤掉它们',
  )
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
