export type UserDecisionMode = 'hitl' | 'afk'
export type DecisionStrategy = 'interactive' | 'recommended-defaults' | 'afk'

export interface DecisionModeSwitchEvent {
  readonly type: 'decision-mode-switched'
  readonly from: UserDecisionMode
  readonly to: UserDecisionMode
  readonly strategy: DecisionStrategy
  readonly occurredAt: string
  readonly actor: 'user' | 'automation'
}

export function strategyForDecisionMode(mode: UserDecisionMode, recommendedDefaults = false): DecisionStrategy {
  if (mode === 'afk') return 'afk'
  return recommendedDefaults ? 'recommended-defaults' : 'interactive'
}

export function modeSwitchEvent(input: {
  readonly from: UserDecisionMode
  readonly to: UserDecisionMode
  readonly recommendedDefaults?: boolean
  readonly occurredAt: string
  readonly actor: 'user' | 'automation'
}): DecisionModeSwitchEvent {
  return { type: 'decision-mode-switched', from: input.from, to: input.to, strategy: strategyForDecisionMode(input.to, input.recommendedDefaults), occurredAt: input.occurredAt, actor: input.actor }
}

export interface PendingAccessObservation {
  readonly pendingDecisionId: string
  readonly channel: 'terminal' | 'dashboard' | 'hook' | 'automation'
  readonly operation: 'read-token' | 'local-api-call'
  readonly tokenDigest?: string
  readonly observedAt: string
}

export interface SelfApprovalAlert {
  readonly type: 'pending-decision-self-approval-suspected'
  readonly pendingDecisionId: string
  readonly channel: PendingAccessObservation['channel']
  readonly operation: PendingAccessObservation['operation']
  readonly tokenDigest: string | null
  readonly observedAt: string
  readonly severity: 'warning'
}

/** Detection only: a bearer token never proves that its holder is a human. */
export function pendingAccessAlert(observation: PendingAccessObservation): SelfApprovalAlert {
  return {
    type: 'pending-decision-self-approval-suspected', pendingDecisionId: observation.pendingDecisionId,
    channel: observation.channel, operation: observation.operation,
    tokenDigest: observation.tokenDigest === undefined ? null : observation.tokenDigest,
    observedAt: observation.observedAt, severity: 'warning',
  }
}
