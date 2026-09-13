import type { InteractionEventV1 } from '../interaction/contract.js'
import type { PipelineState } from '../types.js'
import type { SkillInvocationEventV1 } from '../skill-invocation/types.js'
import type { TransitionRecord } from '../workflow/run-types.js'

export type DecisionKind = 'review' | 'skill-question' | 'afk'
export type DecisionStatus = 'pending' | 'answered' | 'consumed' | 'superseded' | 'expired' | 'unknown'
export type DecisionCommandKind = 'review-acknowledge' | 'skill-answer' | 'afk-answer'
export type DecisionChannel = 'terminal' | 'dashboard' | 'automation' | 'unknown'

export interface DecisionRef {
  readonly id: string
  readonly kind: DecisionKind
  readonly change: string
  readonly anchor: string
  readonly revision: number | null
}

export interface PendingDecision {
  readonly ref: DecisionRef
  readonly type: DecisionKind
  readonly status: DecisionStatus
  readonly anchor: { readonly phase?: string; readonly event?: string; readonly invocationId?: string; readonly questionId?: string }
  readonly revision: number | null
  readonly evidence: readonly string[]
  readonly source: 'user' | 'recommended-default' | 'afk' | 'unknown'
  readonly channel: DecisionChannel
  readonly command: DecisionCommandKind
}

export interface PendingDecisionView {
  readonly schemaVersion: 'pending-decision-view/v1'
  readonly revision: number | null
  readonly items: readonly PendingDecision[]
}

export interface PendingDecisionProjectionInput {
  readonly change: string
  readonly state: PipelineState
  readonly revision?: number
  readonly transitions?: readonly TransitionRecord[]
  readonly interactions?: readonly InteractionEventV1[]
  readonly invocations?: readonly SkillInvocationEventV1[]
  /** Optional wall clock used by adapters to derive TTL expiry; omitted keeps pure historical replay. */
  readonly now?: string
}

export interface DecisionCommandInput {
  readonly ref: DecisionRef
  readonly expectedRevision: number | null
  readonly idempotencyKey: string
  readonly answer?: readonly string[]
  readonly channel: DecisionChannel
}

export type DecisionCommandResult =
  | { readonly ok: true; readonly idempotent: boolean; readonly ref: DecisionRef }
  | { readonly ok: false; readonly code: 'revision-conflict' | 'decision-not-pending' | 'decision-ref-mismatch' | 'invalid-command'; readonly message: string }

export interface DecisionCommandAdapter {
  readonly execute: (input: DecisionCommandInput) => Promise<DecisionCommandResult>
}
