import { reviewGateApprovedFor, reviewGatePendingFor, reviewGateApprovalPatch } from '../state/review-gate.js'
import type { PipelineState } from '../types.js'

/**
 * Platform-neutral review acknowledge orchestration. CLI and Dashboard adapt their own IO,
 * marker and history ports around this function; neither surface owns a second receipt protocol.
 */
export interface ReviewAcknowledgeApplicationInput {
  readonly state: PipelineState
  readonly phase: string
  readonly event: string
  readonly acknowledgedAt: string
  readonly bindingMatches: boolean
  readonly writeState: (patch: Partial<Record<string, string>>) => Promise<void>
  readonly recordInteraction?: (input: { readonly state: PipelineState; readonly acknowledgedAt: string; readonly rejected?: boolean }) => Promise<void>
  readonly onRejected?: (error: Error) => Promise<void>
}

export interface ReviewAcknowledgeApplicationResult {
  readonly changed: boolean
  readonly acknowledgedAt: string
}

export async function acknowledgeReview(input: ReviewAcknowledgeApplicationInput): Promise<ReviewAcknowledgeApplicationResult> {
  if (!input.bindingMatches) {
    const error = new Error(`phase '${input.phase}' 的 review receipt 未绑定当前 canonical decision state；请重新 request ${input.event}`)
    if (input.onRejected !== undefined) await input.onRejected(error)
    if (input.recordInteraction !== undefined) await input.recordInteraction({ state: input.state, acknowledgedAt: input.acknowledgedAt, rejected: true })
    throw error
  }
  if (reviewGateApprovedFor(input.state, input.phase, input.event)) {
    return { changed: false, acknowledgedAt: input.acknowledgedAt }
  }
  if (!reviewGatePendingFor(input.state, input.phase, input.event)) {
    const error = new Error(`phase '${input.phase}' 尚未为 event '${input.event}' request review`)
    if (input.onRejected !== undefined) await input.onRejected(error)
    throw error
  }
  const patch = reviewGateApprovalPatch(input.acknowledgedAt)
  await input.writeState(patch)
  if (input.recordInteraction !== undefined) {
    await input.recordInteraction({ state: { ...input.state, fields: { ...input.state.fields, ...patch } }, acknowledgedAt: input.acknowledgedAt })
  }
  return { changed: true, acknowledgedAt: input.acknowledgedAt }
}
