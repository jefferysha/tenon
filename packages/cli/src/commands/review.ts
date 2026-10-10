/**
 * `tenon review request|acknowledge|revoke` ——review 出口的显式两阶段协议。
 *
 * request 只能在当前 workflow 声明为 review 的 step 调用：先将 pending receipt 原子写入
 * canonical state，再落 versioned hook marker。acknowledge 由 Codex UserPromptSubmit 或用户显式
 * CLI 调用，经 kernel 共享 application 写入 approved receipt 并清理 marker（review-acknowledge.ts）。transition 只消费 exact-phase-and-event approved
 * receipt: a decision to return from verify to build must never authorize verify-pass (or vice versa).
 */
import {
  evaluateDocumentEvidence,
  isDocumentContractPhase,
  isDocumentPolicyStep,
  resolveStep,
  stepExitTransitions,
  reviewGateApprovedFor,
  reviewGateMatches,
  reviewGatePendingFor,
  reviewGateRequestPatch,
  reviewGateStatus,
  reviewGateBindingMatches,
  readCurrentRunRevision,
  timestampAfter,
  INTERACTION_PROJECTION_WRITE_FAILED,
  assertOwner,
} from '@tenon/kernel'
import type { PipelineState } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName, resolveChangeDir } from '../paths.js'
import { requireActor } from '../userIdentity.js'
import { refuseArchived } from '../archivedGuard.js'
import { cmdCheck } from './check.js'
import { recordHistory } from './fields.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { createInteractionCapture } from '../interaction-emitter.js'
import {
  readReviewGateBindingForRequest,
  refreshReviewGateBinding,
  writeReviewMarker,
} from './review-binding.js'
import { cmdReviewAcknowledge } from './review-acknowledge.js'
import { cmdReviewRevoke } from './review-revoke.js'
import { freezePendingWaivers, reviewItemLines, type PendingReviewItems } from './review-waivers.js'
import {
  backEdgeRefused, pendingResidual, releasesFailedReviewers, reviewRoundsInfo, roundsExhaustedMessage,
} from './review-rounds.js'
import { resolveReviewEvent as resolveReviewEventFromStep } from './review-event.js'
import { msg } from '../i18n/messages.js'

type ReviewStep = {
  readonly phase: string
  readonly workflow: string
  readonly executionModel: 'phase-manifest' | 'step-graph'
  readonly events: readonly string[]
}

export interface ReviewOpts {
  readonly event?: string
  /** Explicit user-delegated review confirmation for the active Change only. */
  readonly delegated?: boolean
  /** acknowledge only: a non-owner confirms as `reviewer` (F16). */
  readonly as?: string
  /** revoke only: why an approved receipt is withdrawn (required, one line). */
  readonly reason?: string
}

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function resolveReviewStep(deps: CliDeps, state: PipelineState): ReviewStep {
  const phase = scalar(state, 'phase')
  const plan = effectiveWorkflowForState(deps, state)
  if (!plan) throw new Error(`workflow '${String(state.fields.workflow ?? '')}' 未找到或不可编译`)
  const step = resolveStep(plan.workflow, phase)
  if (!step) throw new Error(`step '${phase}' 不在 workflow '${plan.id}' 里`)
  if (step.gate !== 'review') throw new Error(`workflow '${plan.id}' 的 step '${phase}' 未声明 gate=review`)
  return {
    phase,
    workflow: plan.id,
    executionModel: plan.capabilities.execution.model,
    events: stepExitTransitions(plan, phase, state).map((transition) => transition.event),
  }
}

/**
 * `verify-fail` is an intentional rollback, not the successful verify exit. Its transition policy
 * deliberately has no success guards, so running `tenon check` here would make a failure path
 * impossible to review. We still require a real report and its governed OpenSpec evidence before
 * asking a human to select the rollback.
 */
async function checkVerifyFailReadiness(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
): Promise<number> {
  const blockers: string[] = []
  const report = scalar(state, 'verification_report')
  const fileExists = deps.guardCtx?.(name)?.fileExists
  if (report === '' || report === 'null') {
    blockers.push(msg(deps, 'review.verifyFail.reportEmpty', { current: report || 'null' }))
  } else if (fileExists?.(report) === false) {
    blockers.push(msg(deps, 'review.verifyFail.reportMissing', { current: report }))
  }

  const plan = effectiveWorkflowForState(deps, state)
  const documentPolicy = plan?.capabilities.documents.policy
  if (documentPolicy) {
    const phase = scalar(state, 'phase')
    if (!isDocumentPolicyStep(documentPolicy, phase) || !isDocumentContractPhase(phase)) {
      blockers.push(msg(deps, 'review.verifyFail.phaseInvalid', { phase: phase || msg(deps, 'review.verifyFail.empty') }))
    } else {
      // A failure exit must remain possible precisely when implementation or upstream documents
      // drifted. Requiring the successful verify evidence set here deadlocks the only governed
      // route back to build. The rollback decision therefore requires the fresh, digest-bound
      // verification report only; the next successful exit re-evaluates the complete contract.
      const evidence = deps.documentEvidence
        ? await deps.documentEvidence(deps.cwd, dir, phase)
        : await evaluateDocumentEvidence(deps.cwd, dir, phase, {
          recordKinds: ['verification-report'],
          readKinds: [],
        }, documentPolicy)
      blockers.push(...evidence.blockers.map((blocker) => `document: ${blocker}`))
    }
  }

  deps.io.out(`[CHECK] ${name} (phase=verify, event=verify-fail)`)
  if (blockers.length === 0) {
    deps.io.out(`  [PASS] ${msg(deps, 'review.verifyFail.ready')}`)
    return 0
  }
  for (const blocker of blockers) deps.io.out(`  [FAIL] ${blocker}`)
  deps.io.out(`  [FAIL] ${msg(deps, 'check.failTotal', { count: blockers.length })}`)
  return 2
}

async function checkReviewRequestReadiness(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  step: ReviewStep,
  event: string,
  releaseFailedReviewers: boolean,
): Promise<number> {
  if (step.executionModel === 'phase-manifest' && step.phase === 'verify' && event === 'verify-fail') {
    return checkVerifyFailReadiness(deps, name, dir, state)
  }
  // A successful outgoing edge must satisfy the same public exit check that transition will
  // re-evaluate under its own lock. This keeps an agent from freezing knowingly incomplete output.
  // The exceptions are what this very review asks the user to decide: a test-plan waiver awaiting
  // approval, and — once the verification rounds are used up — a required reviewer that still fails
  // (a residual blocker the user may accept). Transition still requires both to be approved.
  return cmdCheck(deps, name, {
    ...(step.executionModel === 'step-graph' ? { event } : {}),
    releasePendingWaivers: true,
    ...(releaseFailedReviewers ? { releaseFailedReviewers: true } : {}),
  })
}

export async function cmdReview(
  deps: CliDeps,
  sub: string,
  name: string | undefined,
  opts: ReviewOpts = {},
): Promise<number> {
  if (sub !== 'request' && sub !== 'acknowledge' && sub !== 'revoke') {
    deps.io.err(`ERROR: ${msg(deps, 'review.usage')}`)
    return 1
  }
  if (sub !== 'revoke' && opts.reason !== undefined) {
    deps.io.err(`ERROR: ${msg(deps, 'review.reasonOnRevoke')}`)
    return 1
  }
  if (!name || !isValidChangeName(name)) {
    deps.io.err(`ERROR: ${msg(deps, 'change.nameInvalid', { name: name ?? '' })}`)
    return 1
  }
  if (await refuseArchived(deps, name)) return 1
  const dir = resolveChangeDir(deps.cwd, name)
  const interaction = deps.interaction === undefined
    ? undefined
    : createInteractionCapture(deps.interaction, deps.clock)
  try {
    if (sub === 'revoke') return await cmdReviewRevoke(deps, name, dir, opts)
    if (sub === 'request') {
      if (opts.delegated === true) {
        deps.io.err(`ERROR: ${msg(deps, 'review.request.delegatedOnAcknowledge')}`)
        return 1
      }
      if (opts.as !== undefined) {
        deps.io.err(`ERROR: ${msg(deps, 'review.request.asOnAcknowledge')}`)
        return 1
      }
      const actor = requireActor(deps)
      if (actor === null) return 1
      const preflight = await deps.store.read(dir)
      assertOwner(name, preflight.fields, actor)
      const preflightStep = resolveReviewStep(deps, preflight)
      const event = resolveReviewEventFromStep(preflightStep, opts.event)
      // 验证轮次上限用完后：回退边的评审请求被拒；前进边放行评审者的「不通过」（随请求交给用户接受）。
      const preflightRounds = await reviewRoundsInfo(deps, dir, preflight, event)
      if (backEdgeRefused(preflightRounds)) {
        deps.io.err(`ERROR: ${roundsExhaustedMessage(deps, name, preflightRounds, event)}`)
        return 1
      }
      const check = await checkReviewRequestReadiness(
        deps, name, dir, preflight, preflightStep, event, releasesFailedReviewers(preflightRounds, event),
      )
      if (check !== 0) return check
      let requested: {
        phase: string
        event: string
        requestedAt: string
        alreadyPending: boolean
        replacedReceipt: boolean
        items: PendingReviewItems
        state: PipelineState
      } | undefined
      await deps.store.withLock(dir, async () => {
        const state = await deps.store.read(dir)
        assertOwner(name, state.fields, actor)
        const beforeRevision = interaction === undefined ? undefined : await readCurrentRunRevision(dir)
        const step = resolveReviewStep(deps, state)
        const lockedEvent = resolveReviewEventFromStep(step, opts.event)
        if (step.phase !== preflightStep.phase || lockedEvent !== event) {
          throw new Error('review request 期间当前 phase 或可选 event 已变化；请重新运行该命令')
        }
        const lockedRounds = await reviewRoundsInfo(deps, dir, state, event)
        if (backEdgeRefused(lockedRounds)) throw new Error(roundsExhaustedMessage(deps, name, lockedRounds, event))
        const residual = await pendingResidual(deps, name, dir, state, lockedRounds, event)
        const existingStatus = reviewGateStatus(state)
        if (existingStatus !== null && !reviewGateMatches(state, step.phase)) {
          throw new Error(`检测到属于 phase '${scalar(state, 'review_gate_phase')}' 的残留 review receipt；请先诊断 state 后重试`)
        }
        const existingBinding = await readReviewGateBindingForRequest(dir)
        const bindingMatches = reviewGateBindingMatches(existingBinding, state, step.phase, event)
        if (reviewGateApprovedFor(state, step.phase, event) && bindingMatches) {
          throw new Error(`phase '${step.phase}' 的 event '${event}' 已获确认；请直接执行该 transition，不能重复 request`)
        }
        const existingAt = scalar(state, 'review_requested_at')
        if (reviewGatePendingFor(state, step.phase, event) && bindingMatches) {
          const pendingAt = existingAt || deps.clock()
          await refreshReviewGateBinding(dir, state, step.phase, event, pendingAt)
          requested = {
            phase: step.phase,
            event,
            requestedAt: pendingAt,
            alreadyPending: true,
            replacedReceipt: false,
            items: await freezePendingWaivers(deps, dir, name, actor.id, { phase: step.phase, event, requestedAt: pendingAt }, residual),
            state,
          }
          if (interaction !== undefined && beforeRevision !== undefined) {
            try {
              await interaction.recordReviewRequested({
                changeDir: dir,
                changeName: name,
                state,
                revision: beforeRevision,
                beforeRevision,
                event,
                requestedAt: existingAt || deps.clock(),
                suppressed: true,
                clock: deps.clock(),
              })
            } catch (error) {
              deps.io.err(`WARN: ${INTERACTION_PROJECTION_WRITE_FAILED} ${msg(deps, 'review.warn.projectionPendingFailed', { error: errMsg(error) })}`)
            }
          } else if (interaction !== undefined) {
            deps.io.err(`WARN: ${INTERACTION_PROJECTION_WRITE_FAILED} ${msg(deps, 'review.warn.projectionPendingSkipped')}`)
          }
          return
        }
        const requestedAt = timestampAfter(existingAt, deps.clock)
        const requestedState: PipelineState = {
          ...state,
          fields: { ...state.fields, ...reviewGateRequestPatch(step.phase, event, requestedAt) },
        }
        await deps.store.writeUnderLock(dir, requestedState, { kind: 'set-many' })
        await refreshReviewGateBinding(dir, requestedState, step.phase, event, requestedAt, { tolerateUnreadable: true })
        const afterRevision = interaction === undefined ? undefined : await readCurrentRunRevision(dir)
        if (interaction !== undefined && beforeRevision !== undefined && afterRevision !== undefined) {
          try {
            await interaction.recordReviewRequested({
              changeDir: dir,
              changeName: name,
              state: requestedState,
              revision: afterRevision,
              beforeRevision,
              event,
              requestedAt,
              clock: requestedAt,
            })
          } catch (error) {
            deps.io.err(`WARN: ${INTERACTION_PROJECTION_WRITE_FAILED} ${msg(deps, 'review.warn.projectionRequestFailed', { error: errMsg(error) })}`)
          }
        } else if (interaction !== undefined) {
          deps.io.err(`WARN: ${INTERACTION_PROJECTION_WRITE_FAILED} ${msg(deps, 'review.warn.projectionRequestSkipped')}`)
        }
        requested = {
          phase: step.phase,
          event,
          requestedAt,
          alreadyPending: false,
          // Replacing a different/legacy receipt can only revoke a prior decision; it always
          // creates a fresh pending request and therefore never grants the new event permission.
          replacedReceipt: existingStatus !== null,
          items: await freezePendingWaivers(deps, dir, name, actor.id, { phase: step.phase, event, requestedAt }, residual),
          state: requestedState,
        }
      })
      if (!requested) throw new Error('review request 未产生 receipt')
      const markerOk = await writeReviewMarker(deps, requested.phase, requested.event, name, requested.requestedAt)
      if (!requested.alreadyPending) {
        await recordHistory(deps, dir, {
          ts: requested.requestedAt,
          kind: 'tool',
          raw: `review:request phase=${requested.phase} event=${requested.event}${requested.replacedReceipt ? ' replaced=true' : ''}`,
        })
      }
      deps.io.out(
        `[REVIEW] ${name} phase=${requested.phase} event=${requested.event} ` +
        msg(deps, requested.alreadyPending ? 'review.requested.pending' : 'review.requested.new'),
      )
      for (const line of await reviewItemLines(deps, requested.state, requested.items)) deps.io.out(line)
      return markerOk ? 0 : 2
    }
    return await cmdReviewAcknowledge(deps, name, dir, opts)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
}
