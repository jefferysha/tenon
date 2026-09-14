/**
 * Every companion-backed logical field of a WorkflowRun revision (`COMPANION_BACKED_FIELDS`),
 * restored and published as one unit. Canonical readers hydrate each parsed wire revision through
 * here; publishers write the companions before any immutable revision/current bytes that reference
 * them.
 */
import type { PipelineState } from '../types.js'
import {
  hydratePreVerifyReview,
  hydratePreVerifyReviewFromSync,
  publishPreVerifyReviewRecord,
} from './pre-verify-review-store.js'
import {
  hydrateReviewAcknowledgedVia,
  hydrateReviewAcknowledgedViaFromSync,
  publishReviewAcknowledgedViaRecord,
} from './review-acknowledged-via-store.js'
import type { RunRevision } from './run-revision-codec.js'

export async function hydrateCompanions(changeDir: string, revision: RunRevision): Promise<RunRevision> {
  return hydrateReviewAcknowledgedVia(changeDir, await hydratePreVerifyReview(changeDir, revision))
}

export function hydrateCompanionsFromSync(
  readText: (relativePath: string) => string | undefined,
  revision: RunRevision,
  sourceRoot = 'canonical state',
): RunRevision {
  return hydrateReviewAcknowledgedViaFromSync(
    readText,
    hydratePreVerifyReviewFromSync(readText, revision, sourceRoot),
    sourceRoot,
  )
}

/** The channel record validates its value before writing, so an unpublishable channel writes nothing. */
export async function publishCompanions(
  changeDir: string,
  revision: RunRevision,
  logicalState: PipelineState,
): Promise<void> {
  await publishReviewAcknowledgedViaRecord(changeDir, revision)
  await publishPreVerifyReviewRecord(changeDir, revision, logicalState)
}
