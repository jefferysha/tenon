import {
  COMPANION_BACKED_FIELDS,
  PRE_VERIFY_REVIEW_FIELD,
  REVIEW_ACKNOWLEDGED_VIA_FIELD,
  type PipelineState,
} from '../types.js'
import { serializePipeline } from './parse.js'
import {
  rollbackCompatibleState,
  type RunRevision,
} from './run-revision-codec.js'

function metadataFor(revision: RunRevision): NonNullable<PipelineState['projectionMetadata']> {
  return {
    stateRevision: revision.revision,
    stateRevisionId: revision.revisionId,
    stateDigest: revision.stateDigest,
  }
}

/** N-1 writable adapter shape: old field closure plus the exact anchored opaque tail. */
export function projectionContent(revision: RunRevision): string {
  return serializePipeline({
    ...rollbackCompatibleState(revision),
    projectionMetadata: metadataFor(revision),
  }, { omitFields: COMPANION_BACKED_FIELDS })
}

/**
 * Projection shape emitted before the rollback-compatible companion migration. The review channel
 * field did not exist in that release line, so the shape never contains it.
 */
export function priorLogicalProjectionContent(revision: RunRevision): string {
  return serializePipeline({
    ...structuredClone(revision.state),
    projectionMetadata: metadataFor(revision),
  }, { omitFields: [REVIEW_ACKNOWLEDGED_VIA_FIELD] })
}

/** True when `raw` is byte-identical to a projection shape some runtime writes for `revision`. */
export function matchesKnownProjection(raw: string, revision: RunRevision): boolean {
  return raw === projectionContent(revision)
    || raw === priorLogicalProjectionContent(revision)
    || raw === legacyChannelProjectionContent(revision)
}

/**
 * Projection shape of unreleased development builds that still kept `review_acknowledged_via` in
 * the wire closure: identical to `projectionContent` except that a live receipt also writes the
 * channel line. Accepted as a current/stale adapter only; never written.
 */
export function legacyChannelProjectionContent(revision: RunRevision): string {
  const wire = rollbackCompatibleState(revision)
  return serializePipeline({
    ...wire,
    fields: {
      ...wire.fields,
      [REVIEW_ACKNOWLEDGED_VIA_FIELD]: revision.state.fields[REVIEW_ACKNOWLEDGED_VIA_FIELD],
    },
    projectionMetadata: metadataFor(revision),
  }, { omitFields: [PRE_VERIFY_REVIEW_FIELD] })
}
