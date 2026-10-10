/**
 * `tenon review revoke <change> --reason <原因>` —— 撤回当前步已批准、尚未被 transition 消费的评审回执。
 *
 * 用途：误记的批准（例如串会话的放行语）在被 transition 消费之前可以正规撤回。撤销只会让状态更保守，所以 agent 可执行，
 * 不需要人在场证明；但必须写原因，且只认任务负责人（与 request 一致）。在 Change 锁内：只作用于「回执存在、属于当前 phase、
 * 状态是 approved」的情形，把它撤回为同一 event 的 pending（requestedAt 与 `.pipeline-review-gate-binding.json` 原样沿用），
 * 经 store.writeUnderLock 提交（canonical 与 .pipeline.yaml 投影同一次落盘）；同一把锁内先追加 `review.revoked` 审计行
 * （写失败则状态不动、exit 1），状态提交后再重写 v2 评审标记。缺原因、回执不存在 / 本就待确认 / 已被消费、非负责人都拒绝，exit 1 且不改任何状态。
 * 与 acknowledge / transition 共用同一把 Change 锁，所以撤销与它们互斥。
 */
import {
  assertOwner,
  formatAuditDetail,
  reviewDecisionRef,
  reviewGateDecisionStateDigest,
  reviewGateEvent,
  reviewGateMatches,
  reviewGateRevokePatch,
  reviewGateStatus,
  selectReviewAnchor,
  REVIEW_GATE_PENDING,
} from '@tenon/kernel'
import type { PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { requireActor } from '../userIdentity.js'
import { readReviewGateBindingForRequest, writeReviewMarker } from './review-binding.js'

const REASON_MAX = 200

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/** 一行、非空、≤200 字、不含控制字符；否则 null（审计行里不得出现换行或控制字符）。 */
function revokeReason(raw: string | undefined): string | null {
  const reason = (raw ?? '').trim()
  if (reason === '' || reason.length > REASON_MAX || /\p{Cc}/u.test(reason)) return null
  return reason
}

export async function cmdReviewRevoke(
  deps: CliDeps,
  name: string,
  dir: string,
  opts: { readonly event?: string; readonly delegated?: boolean; readonly as?: string; readonly reason?: string },
): Promise<number> {
  if (opts.event !== undefined || opts.delegated === true || opts.as !== undefined) {
    deps.io.err(`ERROR: ${msg(deps, 'review.revoke.onlyReason')}`)
    return 1
  }
  const reason = revokeReason(opts.reason)
  if (reason === null) {
    deps.io.err(`ERROR: ${msg(deps, 'review.revoke.reasonRequired', { max: REASON_MAX })}`)
    return 1
  }
  const actor = requireActor(deps)
  if (actor === null) return 1

  let revoked: { readonly phase: string; readonly event: string } | undefined
  let markerOk = true
  let refusal = ''
  await deps.store.withLock(dir, async () => {
    const state = await deps.store.read(dir)
    assertOwner(name, state.fields, actor)
    const phase = scalar(state, 'phase')
    const status = reviewGateStatus(state)
    if (status === null || !reviewGateMatches(state, phase)) {
      refusal = msg(deps, 'review.revoke.none', { phase })
      return
    }
    const event = reviewGateEvent(state)
    if (status === REVIEW_GATE_PENDING) {
      refusal = msg(deps, 'review.revoke.pending', { phase, event })
      return
    }
    const requestedAt = scalar(state, 'review_requested_at')
    const binding = await readReviewGateBindingForRequest(dir)
    const receipt = reviewDecisionRef(name, phase, event, selectReviewAnchor({
      phase,
      event,
      requestedAt,
      binding,
      decisionStateDigest: reviewGateDecisionStateDigest(state),
      runId: state.runMetadata?.runId,
    }), null).id
    // 先写审计（意图）再改状态：审计写不进去就抛错、状态原样不动（exit 1）；不用 best-effort 的 recordHistory。
    // 审计事件名按设计取 review.revoked；与 review:request / review:acknowledge 同为 kind=tool 的历史行，actor 是声明身份。
    await deps.history?.append(dir, {
      ts: deps.clock(),
      kind: 'tool',
      raw: `review.revoked ${formatAuditDetail({
        phase,
        event,
        receipt,
        acknowledged_at: scalar(state, 'review_acknowledged_at'),
        via: scalar(state, 'review_acknowledged_via'),
        reason,
      })}`,
      actor,
    })
    const next: PipelineState = { ...state, fields: { ...state.fields, ...reviewGateRevokePatch() } }
    await deps.store.writeUnderLock(dir, next, { kind: 'set-many' })
    // 评审标记在同一把锁内重写：锁外写会让别的会话在锁释放后完成 acknowledge 清掉标记，再被这里写回一个多余的 pending 标记。
    markerOk = await writeReviewMarker(deps, phase, event, name, requestedAt)
    revoked = { phase, event }
  })
  if (refusal !== '') {
    deps.io.err(`ERROR: ${refusal}`)
    return 1
  }
  if (!revoked) throw new Error('review revoke 未产生结果')
  deps.io.out(`[REVIEW] ${name} phase=${revoked.phase} event=${revoked.event} ${msg(deps, 'review.revoke.done', { reason })}`)
  return markerOk ? 0 : 2
}
