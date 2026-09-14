import {
  projectPendingDecisions,
  readCurrentRunRevision,
  readInteractionProjection,
  readReviewGateBinding,
  readSkillInvocationEventsForApplication,
  reviewGateDecisionStateDigest,
  type ReviewGateBinding,
  type StateStore,
  type TransitionRecordStore,
  type PendingDecisionView,
} from '@tenon/kernel'

/** A malformed or unreadable binding sidecar is treated as absent (fail closed). */
export async function readReviewBindingSafely(dir: string): Promise<ReviewGateBinding | undefined> {
  try {
    return await readReviewGateBinding(dir)
  } catch {
    return undefined
  }
}

/**
 * Read the complete, immutable input set used by the pending-decision projection.
 * GET and POST must resolve the same revision, interactions, invocations, binding and transition
 * chain; otherwise a ref produced by GET can become unresolvable inside the POST lock.
 */
export async function readPendingDecisionProjection(input: {
  readonly change: string
  readonly dir: string
  readonly store: StateStore
  readonly recordStore?: TransitionRecordStore
}): Promise<PendingDecisionView> {
  const current = await readCurrentRunRevision(input.dir)
  const state = current?.state ?? await input.store.read(input.dir)
  const interactions = await readInteractionProjection(input.dir)
  const invocations = await readSkillInvocationEventsForApplication(input.dir)
  const metadata = current?.state.runMetadata
  const transitions = metadata?.transitionHead !== undefined && input.recordStore !== undefined
    ? await input.recordStore.readChain(input.dir, metadata.transitionSequence, metadata.transitionHead, metadata.runId)
    : []
  return projectPendingDecisions({
    change: input.change,
    state,
    revision: current?.revision,
    interactions: interactions.kind === 'valid' ? interactions.events : [],
    invocations,
    transitions,
    reviewBinding: await readReviewBindingSafely(input.dir),
    reviewDecisionStateDigest: reviewGateDecisionStateDigest(state),
  })
}
