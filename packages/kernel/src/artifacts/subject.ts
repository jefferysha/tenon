import { createHash, randomUUID } from 'node:crypto'

/** The three durable projections of one logical artifact subject. */
export type ArtifactProjectionKind = 'document' | 'field' | 'runtime'

export interface ArtifactSubjectSource {
  readonly path?: string
  readonly document_kind?: string
  readonly field?: string
}

/**
 * A versioned reference to a logical artifact.  The snake_case fields are
 * intentional: this shape is also used at executor/API boundaries.  A path
 * is source metadata only; it is never part of subject identity.
 */
export interface ArtifactSubjectRef {
  readonly subject_id: string
  readonly namespace: string
  readonly version: string
  readonly projection: ArtifactProjectionKind
  readonly content_digest: `sha256:${string}`
  readonly source?: ArtifactSubjectSource
}

/** Stable subject identity persisted alongside an artifact record. */
export interface ArtifactSubjectIdentity {
  readonly subject_id: string
  readonly namespace: string
}

/** A readable alias retained for pre-subject path-hash artifact IDs. */
export interface ArtifactSubjectAlias {
  readonly alias: string
  readonly subject_id: string
  readonly namespace: string
  readonly kind: 'legacy-path-hash'
}

/** Idempotent receipt emitted when a legacy record is first resolved. */
export interface ArtifactSubjectMigrationReceipt {
  readonly receipt_id: string
  readonly legacy_artifact_id: string
  readonly subject_id: string
  readonly namespace: string
  readonly content_digest: `sha256:${string}`
  readonly migrated_at: string
  readonly kind: 'legacy-path-hash' | 'legacy-scope'
  /** Relative store path retained until an explicit cleanup decision. */
  readonly legacy_scope_path?: string
  /** Relative canonical store path involved in scope migration diagnostics. */
  readonly canonical_scope_path?: string
  readonly retention?: 'preserved-awaiting-confirmation'
}

const namespaceRe = /^[a-z0-9][a-z0-9._/-]{0,127}$/u
const subjectIdRe = /^subject:[a-z0-9][a-z0-9._/-]{0,127}:[a-f0-9]{32}$/u
const digestRe = /^sha256:[a-f0-9]{64}$/u
const legacyArtifactIdRe = /^artifact:[a-f0-9]{24}$/u

export function isArtifactSubjectDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && digestRe.test(value)
}

export function isArtifactSubjectId(value: unknown): value is string {
  return typeof value === 'string' && subjectIdRe.test(value)
}

export function isArtifactSubjectRef(value: unknown): value is ArtifactSubjectRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  if (!isArtifactSubjectId(ref.subject_id) || typeof ref.namespace !== 'string' || !namespaceRe.test(ref.namespace)) return false
  if (!ref.subject_id.startsWith(`subject:${ref.namespace}:`)) return false
  if (typeof ref.version !== 'string' || ref.version.length === 0 || ref.version.length > 128) return false
  if (ref.projection !== 'document' && ref.projection !== 'field' && ref.projection !== 'runtime') return false
  if (!isArtifactSubjectDigest(ref.content_digest)) return false
  if (ref.source === undefined) return true
  if (!ref.source || typeof ref.source !== 'object') return false
  const source = ref.source as Record<string, unknown>
  return (source.path === undefined || typeof source.path === 'string')
    && (source.document_kind === undefined || typeof source.document_kind === 'string')
    && (source.field === undefined || typeof source.field === 'string')
}

export function assertArtifactSubjectRef(value: unknown): ArtifactSubjectRef {
  if (!isArtifactSubjectRef(value)) throw new Error('invalid artifact subject reference')
  return value
}

/** Explicit codec boundary for JSON/API callers. */
export function decodeArtifactSubjectRef(value: unknown): ArtifactSubjectRef {
  return assertArtifactSubjectRef(value)
}

/** Return a JSON-safe copy so callers cannot mutate the canonical ref. */
export function encodeArtifactSubjectRef(value: ArtifactSubjectRef): ArtifactSubjectRef {
  return {
    subject_id: value.subject_id,
    namespace: value.namespace,
    version: value.version,
    projection: value.projection,
    content_digest: value.content_digest,
    ...(value.source ? { source: { ...value.source } } : {}),
  }
}

export function assertArtifactNamespace(namespace: string): string {
  if (!namespaceRe.test(namespace)) throw new Error(`invalid artifact subject namespace: ${namespace}`)
  return namespace
}

/**
 * Generate a deterministic subject ID from an explicit logical key.  Callers
 * must pass a logical key (for example a document kind or field contract),
 * never a current filesystem path.
 */
export function artifactSubjectId(namespace: string, logicalKey: string): string {
  assertArtifactNamespace(namespace)
  if (logicalKey.length === 0 || logicalKey.length > 1024) throw new Error('artifact subject logical key must be non-empty')
  const digest = createHash('sha256').update(`${namespace}\0${logicalKey}`, 'utf8').digest('hex').slice(0, 32)
  return `subject:${namespace}:${digest}`
}

/** Host-issued identity for outputs with no stable logical key. */
export function newArtifactSubjectId(namespace: string): string {
  assertArtifactNamespace(namespace)
  return `subject:${namespace}:${createHash('sha256').update(randomUUID(), 'utf8').digest('hex').slice(0, 32)}`
}

/** Exact compatibility calculation used by legacy path-hash artifact IDs. */
export function legacyArtifactIdForPath(path: string, mediaType: string): string {
  return `artifact:${createHash('sha256').update(`${path}\0${mediaType}`, 'utf8').digest('hex').slice(0, 24)}`
}

export function isLegacyArtifactId(value: unknown): value is string {
  return typeof value === 'string' && legacyArtifactIdRe.test(value)
}

/** Compare logical identity while ignoring projection and source path. */
export function sameArtifactSubject(a: ArtifactSubjectRef | ArtifactSubjectIdentity, b: ArtifactSubjectRef | ArtifactSubjectIdentity): boolean {
  return a.subject_id === b.subject_id && a.namespace === b.namespace
}

/** Compare one immutable subject version, still ignoring projection/path. */
export function sameArtifactSubjectVersion(a: ArtifactSubjectRef, b: ArtifactSubjectRef): boolean {
  return sameArtifactSubject(a, b) && a.version === b.version && a.content_digest === b.content_digest
}
