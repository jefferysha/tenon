/** Runtime artifact protocol. Definitions describe policy; these records describe observed facts. */
export const ARTIFACT_PROTOCOL_VERSION = 1 as const

export type ArtifactOrigin = 'stage' | 'external' | 'unknown'
export type ArtifactDisposition = 'candidate' | 'deliverable' | 'intermediate'
export type ArtifactQuality = 'unchecked' | 'passed' | 'failed' | 'unavailable' | 'not-applicable'
export type ArtifactMediaKind = 'file' | 'document' | 'json' | 'text' | 'diff' | 'value' | 'url' | 'report' | 'unknown'

export interface ArtifactProducer { readonly workflowRunId: string; readonly stageAttemptId: string; readonly actorId?: string; readonly skillId?: string }
export interface ArtifactSource { readonly path?: string; readonly provider?: string; readonly ref?: string }
export interface ArtifactVersion {
  readonly artifactId: string
  readonly version: string
  readonly contentDigest: string
  readonly size: number
  readonly mediaType: string
  readonly kind: ArtifactMediaKind
  readonly origin: ArtifactOrigin
  readonly producer?: ArtifactProducer
  readonly publisher?: ArtifactProducer
  readonly source?: ArtifactSource
  readonly contentUri: string
  readonly disposition: ArtifactDisposition
  readonly quality: ArtifactQuality
  readonly schemaRef?: string
  readonly createdAt: string
  readonly deletedAt?: string
}
export interface ArtifactRecord { readonly artifactId: string; readonly currentVersion?: string; readonly versions: readonly ArtifactVersion[]; readonly displayName?: string }
export interface ArtifactAttempt {
  readonly workflowRunId: string; readonly stageId: string; readonly stageAttemptId: string; readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly dependencyStages: readonly string[]; readonly visibility: 'dependency-chain' | 'run' | 'project'; readonly startedAt: string; readonly endedAt?: string
}
export interface ArtifactEvent { readonly seq: number; readonly idempotencyKey: string; readonly type: 'attempt.started'|'attempt.ended'|'artifact.observed'|'artifact.published'|'artifact.deleted'|'artifact.renamed'|'artifact.consumed'|'artifact.checked'; readonly at: string; readonly attemptId?: string; readonly artifactId?: string; readonly version?: string; readonly payload?: Readonly<Record<string, unknown>> }
export interface ArtifactCatalogEntry extends ArtifactVersion { readonly availableFromStage?: string; readonly consumed?: boolean; readonly affected?: boolean }
export interface ArtifactCatalog { readonly revision: number; readonly digest: string; readonly stageAttemptId: string; readonly entries: readonly ArtifactCatalogEntry[]; readonly history?: readonly ArtifactCatalogEntry[]; readonly nextCursor?: string; readonly totalEntries?: number; readonly truncated?: boolean }
export interface ArtifactReadReceipt { readonly receiptId: string; readonly stageAttemptId: string; readonly artifactId: string; readonly version: string; readonly representation: 'metadata'|'structure'|'summary'|'content'; readonly readAt: string; readonly consumer: 'execution'|'ui'; readonly bytes: number }
export interface ArtifactCheck { readonly checkId: string; readonly artifactId: string; readonly version: string; readonly checker: string; readonly checkerVersion: string; readonly status: ArtifactQuality; readonly diagnostics?: readonly string[]; readonly checkedAt: string }
export interface ArtifactChecker { readonly id: string; readonly version: string; readonly supports: (version: ArtifactVersion) => boolean; readonly check: (input: { version: ArtifactVersion; bytes: Uint8Array }) => Promise<Omit<ArtifactCheck, 'artifactId'|'version'|'checkedAt'>> | Omit<ArtifactCheck, 'artifactId'|'version'|'checkedAt'> }
export interface ArtifactSchemaAdapter { readonly id: string; readonly version: string; readonly supports: (version: ArtifactVersion) => boolean; readonly inspect: (bytes: Uint8Array) => unknown }
export interface ArtifactSummaryProvider { readonly id: string; readonly version: string; readonly supports: (version: ArtifactVersion) => boolean; readonly summarize: (bytes: Uint8Array) => Promise<string> | string }

const digestRe = /^[a-f0-9]{64}$/u
export function isArtifactDigest(value: unknown): value is string { return typeof value === 'string' && digestRe.test(value) }
export function isArtifactVersion(value: unknown): value is ArtifactVersion {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.artifactId === 'string' && typeof v.version === 'string' && isArtifactDigest(v.contentDigest) && typeof v.size === 'number' && typeof v.mediaType === 'string' && typeof v.contentUri === 'string' && typeof v.createdAt === 'string'
}
export function assertArtifactVersion(value: unknown): ArtifactVersion { if (!isArtifactVersion(value)) throw new Error('invalid artifact version'); return value }

export interface ArtifactContent { readonly data?: Uint8Array | string | unknown; readonly content?: Uint8Array | string | unknown; readonly mediaType: string; readonly kind?: ArtifactMediaKind; readonly source?: ArtifactSource; readonly origin?: ArtifactOrigin; readonly producer?: ArtifactProducer }
export interface ArtifactPolicy { readonly dependencyStages?: readonly string[]; readonly includeCandidates?: boolean; readonly includeHistory?: boolean; readonly requireQuality?: ArtifactQuality; readonly maxEntries?: number; readonly cursor?: string; readonly pinned?: boolean }
