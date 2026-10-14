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
import {
  hydrateStartSha,
  hydrateStartShaFromSync,
  publishStartShaRecord,
} from './start-sha-store.js'

export async function hydrateCompanions(changeDir: string, revision: RunRevision): Promise<RunRevision> {
  return hydrateStartSha(
    changeDir,
    await hydrateReviewAcknowledgedVia(changeDir, await hydratePreVerifyReview(changeDir, revision)),
  )
}

export function hydrateCompanionsFromSync(
  readText: (relativePath: string) => string | undefined,
  revision: RunRevision,
  sourceRoot = 'canonical state',
): RunRevision {
  return hydrateStartShaFromSync(
    readText,
    hydrateReviewAcknowledgedViaFromSync(
      readText,
      hydratePreVerifyReviewFromSync(readText, revision, sourceRoot),
      sourceRoot,
    ),
    sourceRoot,
  )
}

/** The channel and start-point records validate their value before writing, so an unpublishable value writes nothing. */
export async function publishCompanions(
  changeDir: string,
  revision: RunRevision,
  logicalState: PipelineState,
): Promise<void> {
  await publishStartShaRecord(changeDir, revision)
  await publishReviewAcknowledgedViaRecord(changeDir, revision)
  await publishPreVerifyReviewRecord(changeDir, revision, logicalState)
}
