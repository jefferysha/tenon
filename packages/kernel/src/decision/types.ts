import type { InteractionEventV1 } from '../interaction/contract.js'
import type { ReviewGateBinding } from '../state/review-gate-binding.js'
import type { PipelineState } from '../types.js'
import type { SkillInvocationEventV1 } from '../skill-invocation/types.js'
import type { TransitionRecord } from '../workflow/run-types.js'

export type DecisionKind = 'review' | 'skill-question' | 'afk'
export type DecisionStatus = 'pending' | 'answered' | 'consumed' | 'superseded' | 'expired' | 'unknown'
export type DecisionCommandKind = 'review-acknowledge' | 'skill-answer'
export type DecisionChannel = 'terminal' | 'dashboard' | 'automation' | 'delegated' | 'unknown'

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
  /** Route provenance; decision strategy is carried by Skill invocation evidence. */
  readonly source: DecisionChannel
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
  /** Review binding sidecar; its `decisionStateDigest` anchors the request identity. */
  readonly reviewBinding?: ReviewGateBinding
  /** Fallback digest of the current canonical decision state when no matching sidecar exists. */
  readonly reviewDecisionStateDigest?: string
}

export type DecisionCommandSuccessCode = 'approved' | 'idempotent-replay' | 'marker-warning'
export type DecisionCommandFailureCode = 'review-approval-required' | 'revision-conflict' | 'idempotency-conflict' | 'invalid-command'

/** Contract H result union shared by terminal and Dashboard review acknowledgements. */
export type DecisionCommandResult =
  | {
    readonly ok: true
    readonly code: DecisionCommandSuccessCode
    readonly changed: boolean
    readonly idempotent: boolean
    readonly ref: DecisionRef
  }
  | {
    readonly ok: false
    readonly code: DecisionCommandFailureCode
    readonly message: string
    readonly ref?: DecisionRef
  }
