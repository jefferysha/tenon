/**
 * `tenon review acknowledge` adapter. Receipt, binding, workflow exit, idempotency, commit and
 * post-commit effects all live in the kernel `executeReviewAcknowledge` application shared with the
 * Dashboard; this file only wires CLI ports and maps the contract H result to exit codes.
 */
import {
  actorOf,
  approveFrozenWaivers,
  createReviewDecisionLedger,
  executeReviewAcknowledge,
  formatUserRef,
  INTERACTION_PROJECTION_WRITE_FAILED,
  nodeReviewDecisionLedgerFs,
  ownerDecision,
  readCurrentRunRevision,
  resolveStep,
  reviewAcknowledgeExitCode,
  stepExitTransitions,
  type PipelineState,
  type ReviewAcknowledgeDeferred,
  type UserRef,
  type WaiverApprovalOutcome,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { readDelegatedReviewAuthority } from '../continuousAuthority.js'
import { requireUser } from '../userIdentity.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { readReviewGateBindingForRequest } from './review-binding.js'
import {
  auditWaiverApproval, refuseDelegatedWhileWaiversPending, retireFrozenWaivers, skippedWaiverLines,
} from './review-waivers.js'

const DEFERRED_WARNINGS: Readonly<Record<ReviewAcknowledgeDeferred, string>> = {
  'idempotency-ledger': 'WARN: decision idempotency ledger 写入失败（approval receipt 已提交；重试会按当前状态重新判定）',
  'review-interaction': `WARN: ${INTERACTION_PROJECTION_WRITE_FAILED} interaction projection 写入失败（canonical review acknowledgement 已提交）`,
  'review-history': 'WARN: history 写入失败（canonical review acknowledgement 已提交）',
  'review-marker-clear': 'WARN: review marker 清理失败（approval receipt 已提交，可重试 acknowledge）',
}

function reviewExits(deps: CliDeps, state: PipelineState, phase: string): readonly string[] | null {
  const plan = effectiveWorkflowForState(deps, state)
  if (!plan) throw new Error(`workflow '${String(state.fields.workflow ?? '')}' 未找到或不可编译`)
  const step = resolveStep(plan.workflow, phase)
  if (!step || step.gate !== 'review') return null
  return stepExitTransitions(plan, phase, state).map((transition) => transition.event)
}

/** `--as` 目前只有一个角色：非负责人以评审人身份确认。 */
const REVIEWER_ROLE = 'reviewer'

/** 负责人规则的拒绝文案（目录里的两条，zh 与 kernel 的 reviewerRequiredMessage 逐字一致）。 */
function reviewerRequired(deps: CliDeps, name: string, owner: UserRef | null): string {
  return owner === null
    ? msg(deps, 'review.ownerRequired.none', { name })
    : msg(deps, 'review.ownerRequired.other', { name, owner: formatUserRef(owner) })
}

export async function cmdReviewAcknowledge(
  deps: CliDeps,
  name: string,
  dir: string,
  opts: { readonly event?: string; readonly delegated?: boolean; readonly as?: string },
): Promise<number> {
  if (opts.as !== undefined && opts.as !== REVIEWER_ROLE) {
    deps.io.err(`ERROR: ${msg(deps, 'review.asRoleInvalid', { role: REVIEWER_ROLE, got: opts.as })}`)
    return 1
  }
  const user = requireUser(deps)
  if (user === null) return 1
  const actor = actorOf(user)
  const delegatedAuthority = opts.delegated === true
    ? await readDelegatedReviewAuthority(
        deps.cwd,
        user.slug,
        name,
        deps.env?.('TENON_HOST_SESSION_ID') ?? deps.env?.('CODEX_THREAD_ID'),
      )
    : null
  if (opts.delegated === true && delegatedAuthority === null) {
    deps.io.err(`ERROR: ${msg(deps, 'review.noDelegatedAuthority', { name })}`)
    return 1
  }
  const { interaction, history } = deps
  // 确认评审只认负责人（真机验收 F16）：非负责人显式 --as reviewer 才行，角色与负责人记进历史。
  const owner = ownerDecision((await deps.store.read(dir)).fields, actor)
  if (!owner.allowed && opts.as !== REVIEWER_ROLE) {
    deps.io.err(`ERROR: ${reviewerRequired(deps, name, owner.owner)}`)
    return 1
  }
  const roleDetail = owner.allowed ? '' : `as=${REVIEWER_ROLE} owner=${owner.owner?.id ?? 'none'}`
  // 豁免只由人工确认批准：委托确认（--delegated）不批准，留下的豁免继续挡出口。
  let waivers: WaiverApprovalOutcome | undefined
  const result = await executeReviewAcknowledge({
    change: name,
    command: delegatedAuthority === null
      ? { channel: 'terminal', requestedEvent: opts.event, ...(roleDetail === '' ? {} : { historyDetail: roleDetail }) }
      : {
          channel: 'delegated',
          requestedEvent: opts.event,
          historyDetail: `authority_issued_at=${delegatedAuthority.issuedAt} authority_host_session=${delegatedAuthority.hostSessionId ?? ''}${roleDetail === '' ? '' : ` ${roleDetail}`}`,
        },
    withLock: (fn) => deps.store.withLock(dir, fn),
    readState: async () => {
      const state = await deps.store.read(dir)
      // 负责人在预检与加锁之间换了人：没有 --as reviewer 就不能沿用预检的结论。
      const decision = ownerDecision(state.fields, actor)
      if (!decision.allowed && opts.as !== REVIEWER_ROLE) throw new Error(reviewerRequired(deps, name, decision.owner))
      return state
    },
    readRevision: () => readCurrentRunRevision(dir),
    readBinding: () => readReviewGateBindingForRequest(dir),
    ledger: createReviewDecisionLedger(dir, nodeReviewDecisionLedgerFs),
    reviewExits: async (state, phase) => reviewExits(deps, state, phase),
    clock: deps.clock,
    writeState: async (state) => {
      // 同一把锁、同一次确认：先批准冻结清单里的豁免，再提交 receipt。前一步失败 receipt 不提交，
      // 重试同一条命令即可；后一步失败时已批准的豁免在重试里被识别为「已经批准过」。
      if (delegatedAuthority === null) {
        waivers = await approveFrozenWaivers({ repoRoot: deps.cwd, dir, change: name, state, actor, recordedAt: deps.clock() })
      } else {
        await refuseDelegatedWhileWaiversPending(deps, dir, name, actor.id)
      }
      await deps.store.writeUnderLock(dir, state, { kind: 'set-many' })
      await retireFrozenWaivers(dir)
    },
    recordInteraction: interaction === undefined
      ? undefined
      : async (draft) => {
          await interaction.recordUnderLock(dir, draft)
        },
    appendHistory: history === undefined ? undefined : (entry) => history.append(dir, entry),
    clearMarker: async (event) => {
      await deps.clearReviewMarker?.(name, event)
    },
    actor,
  })
  for (const kind of result.deferred) deps.io.err(DEFERRED_WARNINGS[kind])
  if (!result.ok) {
    deps.io.err(`ERROR: ${result.message}`)
    return reviewAcknowledgeExitCode(result)
  }
  deps.io.out(
    `[REVIEW] ${name} phase=${result.phase} event=${result.event} ` +
    `${delegatedAuthority === null ? '已确认' : '已按用户委托的持续授权确认'}` +
    `${owner.allowed ? '' : `（评审人 ${formatUserRef(user)}，负责人 ${owner.owner === null ? '无' : formatUserRef(owner.owner)}）`}，可重发 transition`,
  )
  await reportWaivers(deps, dir, actor.id, waivers)
  return 0
}

/** 确认之后的豁免收尾：批准了哪些、哪些没批准、委托确认时还剩哪些待人工批准；批准留一行审计。 */
async function reportWaivers(
  deps: CliDeps,
  dir: string,
  approver: string,
  outcome: WaiverApprovalOutcome | undefined,
): Promise<void> {
  if (outcome === undefined) return
  await auditWaiverApproval(deps, dir, outcome, approver)
  if (outcome.approved.length > 0) {
    deps.io.out(`[REVIEW] 已批准豁免 ${outcome.approved.length} 项：${outcome.approved.join('、')}`)
  }
  if (outcome.protectedApproved.length > 0) {
    deps.io.out(`[REVIEW] 已批准测试配置改动 ${outcome.protectedApproved.length} 项：${outcome.protectedApproved.join('、')}`)
  }
  if (outcome.note !== null) deps.io.err(`WARN: ${outcome.note}`)
  for (const line of skippedWaiverLines(outcome)) deps.io.out(line)
}
