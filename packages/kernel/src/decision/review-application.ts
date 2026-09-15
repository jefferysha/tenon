import { createHash } from 'node:crypto'
import type { InteractionEventRecordDraft } from '../interaction/ports.js'
import {
  reviewGateApprovalPatch,
  reviewGateApprovedFor,
  reviewGateEvent,
  reviewGateStatus,
  type ReviewAcknowledgedVia,
} from '../state/review-gate.js'
import {
  reviewGateBindingMatches,
  reviewGateDecisionStateDigest,
  type ReviewGateBinding,
} from '../state/review-gate-binding.js'
import type { RunRevision } from '../state/run-revision-codec.js'
import type { HistoryEntry, PipelineState } from '../types.js'
import { reviewDecisionPayloadDigest, type ReviewDecisionLedger, type ReviewDecisionStoredCode } from './idempotency.js'
import { reviewDecisionRef, selectReviewAnchor } from './projection.js'
import { reviewAcknowledgeHistoryEntry, reviewAcknowledgedInteractionFor } from './review-interaction.js'
import type { DecisionCommandFailureCode, DecisionCommandResult, DecisionRef } from './types.js'
import type { RecordActor } from '../users/user.js'

export {
  reviewAcknowledgedInteractionDraft,
  reviewAcknowledgedInteractionFor,
  reviewAcknowledgeHistoryEntry,
} from './review-interaction.js'

/** Dashboard supplies explicit CAS fields; the terminal derives its key inside the lock (contract A). */
export type ReviewAcknowledgeCommand =
  | {
    readonly channel: 'dashboard'
    readonly ref: string
    readonly expectedRevision: number
    readonly idempotencyKey: string
  }
  | {
    readonly channel: 'terminal' | 'delegated'
    /** Optional `--event`; it must name the pending receipt's event. */
    readonly requestedEvent?: string
    readonly historyDetail?: string
  }

/**
 * Adapter ports. Every read happens inside `withLock`; the only pre-commit write is `writeState`.
 * Interaction, history, ledger and marker effects run after the canonical commit and are reported as
 * deferred warnings when they fail, so a committed approval is never reported as an error.
 */
export interface ReviewAcknowledgePorts {
  readonly change: string
  readonly command: ReviewAcknowledgeCommand
  readonly withLock: <T>(fn: () => Promise<T>) => Promise<T>
  readonly readState: () => Promise<PipelineState>
  readonly readRevision: () => Promise<RunRevision | undefined>
  /** Unreadable or malformed sidecars must resolve to undefined so the command fails closed. */
  readonly readBinding: () => Promise<ReviewGateBinding | undefined>
  readonly ledger: ReviewDecisionLedger
  /** Outgoing events when `phase` is a review-gated step of the effective workflow; null otherwise. */
  readonly reviewExits: (state: PipelineState, phase: string) => Promise<readonly string[] | null>
  /** Dashboard: true when the shared projection still lists `ref` as a live review. */
  readonly refIsLive?: (ref: string) => Promise<boolean>
  readonly clock: () => string
  readonly writeState: (state: PipelineState) => Promise<void>
  readonly recordInteraction?: (draft: InteractionEventRecordDraft) => Promise<void>
  readonly appendHistory?: (entry: HistoryEntry) => Promise<void>
  readonly clearMarker: (event: string) => Promise<void>
  /** Declared operator recorded on the acknowledgement history row. */
  readonly actor: RecordActor
}

export type ReviewAcknowledgeDeferred = 'idempotency-ledger' | 'review-interaction' | 'review-history' | 'review-marker-clear'

export type ReviewAcknowledgeResult = DecisionCommandResult & {
  readonly deferred: readonly ReviewAcknowledgeDeferred[]
  /** Receipt phase/event read under the lock; empty when no receipt exists. */
  readonly phase: string
  readonly event: string
}

type ReceiptAnchor = { readonly phase: string; readonly event: string }

/** CLI exit codes for the contract H result union. */
export function reviewAcknowledgeExitCode(result: DecisionCommandResult): number {
  if (result.ok) return 0
  switch (result.code) {
    case 'review-approval-required': return 2
    case 'revision-conflict': return 3
    case 'idempotency-conflict': return 4
    case 'invalid-command': return 1
  }
}

/** Stable terminal key derivation. The receipt fields are excluded from the state digest. */
export function deriveReviewAcknowledgeIdempotencyKey(input: {
  readonly change: string
  readonly phase: string
  readonly event: string
  readonly requestedAt: string
  readonly state: PipelineState
  readonly channel: ReviewAcknowledgedVia
}): string {
  const runId = input.state.runMetadata?.runId ?? ''
  const anchor = `${input.change}\0${input.phase}\0${input.event}\0${input.requestedAt}\0${reviewGateDecisionStateDigest(input.state)}\0${runId}\0${input.channel}`
  return `review-ack:${createHash('sha256').update(anchor, 'utf8').digest('hex')}`
}

/** A timestamp strictly after `previous`, even under a fixed clock. */
export function timestampAfter(previous: string, now: () => string): string {
  const candidate = now()
  if (previous === '') return candidate
  const previousMs = Date.parse(previous)
  const candidateMs = Date.parse(candidate)
  if (!Number.isFinite(previousMs) || !Number.isFinite(candidateMs) || candidateMs > previousMs) return candidate
  return new Date(previousMs + 1).toISOString()
}

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function failure(anchor: ReceiptAnchor, code: DecisionCommandFailureCode, message: string, ref?: DecisionRef): ReviewAcknowledgeResult {
  return { ok: false, code, message, ...(ref === undefined ? {} : { ref }), deferred: [], ...anchor }
}

async function attempt(deferred: ReviewAcknowledgeDeferred[], kind: ReviewAcknowledgeDeferred, effect: () => Promise<void>): Promise<void> {
  try {
    await effect()
  } catch {
    deferred.push(kind)
  }
}

function success(anchor: ReceiptAnchor, input: {
  readonly code: ReviewDecisionStoredCode
  readonly changed: boolean
  readonly idempotent: boolean
  readonly ref: DecisionRef
  readonly deferred: ReviewAcknowledgeDeferred[]
}): ReviewAcknowledgeResult {
  return {
    ok: true,
    code: input.deferred.includes('review-marker-clear') ? 'marker-warning' : input.code,
    changed: input.changed,
    idempotent: input.idempotent,
    ref: input.ref,
    deferred: input.deferred,
    ...anchor,
  }
}

/**
 * The one review acknowledge application. Inside the Change lock: (1) read the idempotency ledger;
 * (2) replay the stored success or return `idempotency-conflict`; (3) verify the exact pending
 * receipt, workflow exit and binding; (4) compare the expected revision; (5) commit canonical state,
 * then the ledger, interaction, history and marker. Every failure returns before any write.
 */
export async function executeReviewAcknowledge(ports: ReviewAcknowledgePorts): Promise<ReviewAcknowledgeResult> {
  const { command } = ports
  return ports.withLock(async () => {
    const state = await ports.readState()
    const binding = await ports.readBinding()
    const current = await ports.readRevision()
    const phase = scalar(state, 'review_gate_phase')
    const event = reviewGateEvent(state)
    const requestedAt = scalar(state, 'review_requested_at')
    const revision = current?.revision ?? null
    const ref = reviewDecisionRef(ports.change, phase, event, selectReviewAnchor({
      phase, event, requestedAt, binding,
      decisionStateDigest: reviewGateDecisionStateDigest(state), runId: state.runMetadata?.runId,
    }), revision)
    const bindingMatches = phase !== '' && event !== '' && reviewGateBindingMatches(binding, state, phase, event)
    const anchor: ReceiptAnchor = { phase, event }

    if (command.channel !== 'dashboard' && command.requestedEvent !== undefined && command.requestedEvent !== event) {
      return failure(anchor, 'invalid-command', `acknowledge 的 event '${command.requestedEvent}' 与待确认 receipt '${event}' 不一致`, ref)
    }

    const key = command.channel === 'dashboard'
      ? command.idempotencyKey
      : bindingMatches
        ? deriveReviewAcknowledgeIdempotencyKey({ change: ports.change, phase, event, requestedAt, state, channel: command.channel })
        : undefined
    const payloadDigest = command.channel === 'dashboard'
      ? reviewDecisionPayloadDigest(command.ref, command.expectedRevision, 'dashboard')
      : reviewDecisionPayloadDigest(ref.id, null, command.channel)
    if (key !== undefined) {
      const prior = await ports.ledger.lookup(key, payloadDigest)
      if (prior.kind === 'conflict') {
        return failure(anchor, 'idempotency-conflict', 'idempotency key is already bound to another decision')
      }
      if (prior.kind === 'replay') {
        const deferred: ReviewAcknowledgeDeferred[] = []
        if (event !== '') await attempt(deferred, 'review-marker-clear', () => ports.clearMarker(event))
        const replayRef = command.channel === 'dashboard' && command.ref !== ref.id
          ? { id: command.ref, kind: 'review' as const, change: ports.change, anchor: '', revision }
          : ref
        return success(anchor, { code: prior.code, changed: false, idempotent: true, ref: replayRef, deferred })
      }
    }

    const receiptStatus = reviewGateStatus(state)
    if (receiptStatus === null || phase === '' || scalar(state, 'phase') !== phase) {
      return failure(anchor, 'review-approval-required', `phase '${scalar(state, 'phase')}' 当前没有待确认的 review request`, ref)
    }
    if (event === '') {
      return failure(anchor, 'review-approval-required', `phase '${phase}' 的旧 review receipt 未绑定 event；请重新运行 tenon review request ${ports.change} --event <event>`, ref)
    }
    const exits = await ports.reviewExits(state, phase)
    if (exits === null || !exits.includes(event)) {
      return failure(anchor, 'review-approval-required', `phase '${phase}' 的 receipt event '${event}' 已不在当前 workflow 出口中；请重新 request`, ref)
    }
    if (!bindingMatches) {
      return failure(anchor, 'review-approval-required', `phase '${phase}' 的 review receipt 未绑定当前 canonical decision state；请重新 request ${event}`, ref)
    }
    if (command.channel === 'dashboard') {
      const live = command.ref === ref.id && (ports.refIsLive === undefined || await ports.refIsLive(command.ref))
      if (!live) return failure(anchor, 'review-approval-required', 'decision ref does not name the pending review', ref)
      if (revision !== command.expectedRevision) return failure(anchor, 'revision-conflict', 'decision revision conflict', ref)
    }

    const deferred: ReviewAcknowledgeDeferred[] = []
    const rememberAs = (code: ReviewDecisionStoredCode, acknowledgedAt: string) => key === undefined
      ? Promise.resolve()
      : attempt(deferred, 'idempotency-ledger', () => ports.ledger.remember({
        key,
        ref: command.channel === 'dashboard' ? command.ref : ref.id,
        expectedRevision: command.channel === 'dashboard' ? command.expectedRevision : null,
        channel: command.channel,
        payloadDigest,
        acknowledgedAt,
        code,
      }))

    if (reviewGateApprovedFor(state, phase, event)) {
      await rememberAs('idempotent-replay', ports.clock())
      await attempt(deferred, 'review-marker-clear', () => ports.clearMarker(event))
      return success(anchor, { code: 'idempotent-replay', changed: false, idempotent: true, ref, deferred })
    }

    const acknowledgedAt = timestampAfter(requestedAt, ports.clock)
    const approved: PipelineState = {
      ...state,
      fields: { ...state.fields, ...reviewGateApprovalPatch(acknowledgedAt, command.channel) },
    }
    await ports.writeState(approved)
    await rememberAs('approved', acknowledgedAt)
    const recordInteraction = ports.recordInteraction
    if (recordInteraction !== undefined) {
      await attempt(deferred, 'review-interaction', async () => {
        const after = await ports.readRevision()
        if (current === undefined || after === undefined) throw new Error('interaction projection 缺 canonical run/workflow/state anchor')
        await recordInteraction(reviewAcknowledgedInteractionFor({
          state: approved, change: ports.change, phase, event, channel: command.channel, acknowledgedAt, before: current, after,
        }))
      })
    }
    const appendHistory = ports.appendHistory
    if (appendHistory !== undefined) {
      await attempt(deferred, 'review-history', () => appendHistory(reviewAcknowledgeHistoryEntry({
        acknowledgedAt, phase, event, channel: command.channel,
        detail: command.channel === 'dashboard' ? undefined : command.historyDetail,
        actor: ports.actor,
      })))
    }
    await attempt(deferred, 'review-marker-clear', () => ports.clearMarker(event))
    return success(anchor, { code: 'approved', changed: true, idempotent: false, ref, deferred })
  })
}
