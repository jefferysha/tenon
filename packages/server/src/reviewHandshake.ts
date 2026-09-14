import { stepExitTransitions } from '@tenon/kernel'
import type { EffectiveWorkflowPlan, PipelineState } from '@tenon/kernel'
import type { ReviewHandshakeSnapshot } from './types.js'

function stringField(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

export function projectReviewHandshake(
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  phase: string,
): ReviewHandshakeSnapshot {
  const receipt = {
    phase: stringField(state.fields.review_gate_phase),
    status: stringField(state.fields.review_gate_status),
    event: stringField(state.fields.review_gate_event),
    requestedAt: stringField(state.fields.review_requested_at),
    acknowledgedAt: stringField(state.fields.review_acknowledged_at),
  }
  if (Object.values(receipt).every((value) => value === '')) {
    return { status: 'not-requested' }
  }

  const step = plan.workflow.steps.find((candidate) => candidate.id === phase)
  const eventExists = stepExitTransitions(plan, phase).some((transition) => transition.event === receipt.event)
  const pending = receipt.status === 'pending' && receipt.acknowledgedAt === ''
  const approved = receipt.status === 'approved' && receipt.acknowledgedAt !== ''
  if (
    step?.gate !== 'review'
    || receipt.phase !== phase
    || receipt.event === ''
    || !eventExists
    || receipt.requestedAt === ''
    || (!pending && !approved)
  ) {
    throw new Error('review handshake canonical receipt 与当前冻结 workflow 不一致')
  }

  return pending
    ? { status: 'pending', event: receipt.event, requestedAt: receipt.requestedAt }
    : {
        status: 'approved',
        event: receipt.event,
        requestedAt: receipt.requestedAt,
        acknowledgedAt: receipt.acknowledgedAt,
      }
}
