import { ApiError, readJson, wrapNetwork } from './transport'

export type ArtifactQuality = 'unchecked' | 'passed' | 'failed' | 'unavailable' | 'not-applicable'
export type ArtifactDisposition = 'candidate' | 'deliverable' | 'intermediate'
export interface ArtifactVersion {
  artifactId: string; version: string; contentDigest: string; size: number; mediaType: string; kind: string
  origin: string; contentUri: string; disposition: ArtifactDisposition; quality: ArtifactQuality
  createdAt: string; deletedAt?: string; source?: { path?: string }; availableFromStage?: string; consumed?: boolean; affected?: boolean; pendingUpdate?: boolean
  subjectId?: string; projectionKind?: 'document' | 'field' | 'runtime'; declarationStatus?: 'declared' | 'observed' | 'reconciled' | 'undeclared-candidate'
  producer?: { workflowRunId: string; stageAttemptId: string; actorId?: string; skillId?: string }
}
export interface ArtifactCatalog { revision: number; digest: string; stageAttemptId: string; entries: ArtifactVersion[]; nextCursor?: string; totalEntries?: number; truncated?: boolean }
export interface ArtifactSubjectProjection { logicalKey: string; projection: 'document' | 'field' | 'runtime'; status: 'declared' | 'committed' | 'pending' | 'failed'; receiptId: string; recordedAt: string; subjectRef: { subject_id: string; namespace: string; version: string; projection: 'document' | 'field' | 'runtime'; content_digest: string; source?: { path?: string; document_kind?: string; field?: string } }; path?: string; documentKind?: string; field?: string; stateRevisionId?: string }
export interface ArtifactSubjectRegistry { version: 1; records: ArtifactSubjectProjection[] }
export interface ArtifactReadResult { version: ArtifactVersion; bytes?: string; encoding?: 'base64' }

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null }
function version(v: unknown): ArtifactVersion | null {
  if (!isRecord(v) || typeof v.artifactId !== 'string' || typeof v.version !== 'string' || typeof v.contentDigest !== 'string' || typeof v.size !== 'number' || typeof v.mediaType !== 'string' || typeof v.contentUri !== 'string' || typeof v.createdAt !== 'string') return null
  const disposition = v.disposition; const quality = v.quality
  if (disposition !== 'candidate' && disposition !== 'deliverable' && disposition !== 'intermediate') return null
  if (quality !== 'unchecked' && quality !== 'passed' && quality !== 'failed' && quality !== 'unavailable' && quality !== 'not-applicable') return null
  const producer = isRecord(v.producer) && typeof v.producer.workflowRunId === 'string' && typeof v.producer.stageAttemptId === 'string' ? { workflowRunId: v.producer.workflowRunId, stageAttemptId: v.producer.stageAttemptId, ...(typeof v.producer.actorId === 'string' ? { actorId: v.producer.actorId } : {}), ...(typeof v.producer.skillId === 'string' ? { skillId: v.producer.skillId } : {}) } : undefined
  const subjectRef = isRecord(v.subjectRef) ? v.subjectRef : undefined
  const subjectId = typeof v.subjectId === 'string' ? v.subjectId : subjectRef && typeof subjectRef.subject_id === 'string' ? subjectRef.subject_id : undefined
  const projectionKind = v.projectionKind === 'document' || v.projectionKind === 'field' || v.projectionKind === 'runtime' ? v.projectionKind : subjectRef && (subjectRef.projection === 'document' || subjectRef.projection === 'field' || subjectRef.projection === 'runtime') ? subjectRef.projection : undefined
  const declarationStatus = v.declarationStatus === 'declared' || v.declarationStatus === 'observed' || v.declarationStatus === 'reconciled' || v.declarationStatus === 'undeclared-candidate' ? v.declarationStatus : undefined
  return { artifactId: v.artifactId, version: v.version, contentDigest: v.contentDigest, size: v.size, mediaType: v.mediaType, kind: typeof v.kind === 'string' ? v.kind : 'unknown', origin: typeof v.origin === 'string' ? v.origin : 'unknown', contentUri: v.contentUri, disposition, quality, createdAt: v.createdAt, ...(typeof v.deletedAt === 'string' ? { deletedAt: v.deletedAt } : {}), ...(isRecord(v.source) ? { source: { ...(typeof v.source.path === 'string' ? { path: v.source.path } : {}) } } : {}), ...(typeof v.availableFromStage === 'string' ? { availableFromStage: v.availableFromStage } : {}), ...(typeof v.consumed === 'boolean' ? { consumed: v.consumed } : {}), ...(typeof v.affected === 'boolean' ? { affected: v.affected } : {}), ...(typeof v.pendingUpdate === 'boolean' ? { pendingUpdate: v.pendingUpdate } : {}), ...(subjectId === undefined ? {} : { subjectId }), ...(projectionKind === undefined ? {} : { projectionKind }), ...(declarationStatus === undefined ? {} : { declarationStatus }), ...(producer === undefined ? {} : { producer }) }
}
function catalog(v: unknown): ArtifactCatalog | null {
  if (!isRecord(v) || typeof v.revision !== 'number' || typeof v.digest !== 'string' || typeof v.stageAttemptId !== 'string' || !Array.isArray(v.entries)) return null
  const entries = v.entries.map(version); if (entries.some((x) => x === null)) return null
  const history = Array.isArray(v.history) ? v.history.map(version) : []
  if (history.some((x) => x === null)) return null
  // The server applies maxEntries to both current entries and history. Keep the
  // current projection bounded; history is intentionally available only through
  // the server's bounded catalog response and is not duplicated into the UI list.
  return {
    revision: v.revision,
    digest: v.digest,
    stageAttemptId: v.stageAttemptId,
    entries: entries as ArtifactVersion[],
    ...(typeof v.nextCursor === 'string' ? { nextCursor: v.nextCursor } : {}),
    ...(typeof v.totalEntries === 'number' ? { totalEntries: v.totalEntries } : {}),
    ...(typeof v.truncated === 'boolean' ? { truncated: v.truncated } : {}),
  }
}
async function get(path: string): Promise<unknown> {
  let response: Response
  try { response = await fetch(path, { headers: { Accept: 'application/json' } }) } catch (error) { wrapNetwork(error) }
  if (!response.ok) throw new ApiError(`artifact request failed (${response.status})`, response.status)
  try { return await readJson(response) } catch { throw new ApiError('artifact response is invalid') }
}
export async function fetchArtifactCatalog(root: string, stageAttemptId: string | undefined, options: { includeCandidates?: boolean; includeHistory?: boolean; maxEntries?: number; cursor?: string; pinned?: boolean; stageId?: string; change?: string } = {}): Promise<ArtifactCatalog> {
  const params = new URLSearchParams({ root, ...(stageAttemptId ? { stageAttemptId } : {}), ...(options.stageId ? { stageId: options.stageId } : {}), ...(options.change ? { change: options.change } : {}) }); if (options.includeCandidates) params.set('includeCandidates', 'true'); if (options.includeHistory) params.set('includeHistory', 'true'); if (options.maxEntries) params.set('maxEntries', String(options.maxEntries))
  if (options.cursor) params.set('cursor', options.cursor); if (options.pinned) params.set('pinned', 'true')
  const body = await get(`/api/artifacts/catalog?${params}`); const value = isRecord(body) ? catalog(body.catalog) : null; if (!value) throw new ApiError('artifact catalog response is invalid'); return value
}
export async function fetchArtifactSubjectRegistry(root: string, change?: string): Promise<ArtifactSubjectRegistry> {
  const params = new URLSearchParams({ root, ...(change ? { change } : {}) })
  const body = await get(`/api/artifacts/subjects?${params}`)
  if (!isRecord(body) || !isRecord(body.registry) || body.registry.version !== 1 || !Array.isArray(body.registry.records)) throw new ApiError('artifact subject registry response is invalid')
  return { version: 1, records: body.registry.records as ArtifactSubjectProjection[] }
}
export async function fetchArtifactContent(root: string, stageAttemptId: string, artifactId: string, versionId: string, maxBytes = 512 * 1024, change?: string): Promise<ArtifactReadResult> {
  const params = new URLSearchParams({ root, stageAttemptId, artifactId, version: versionId, maxBytes: String(maxBytes), ...(change ? { change } : {}) }); const body = await get(`/api/artifacts/read?${params}`)
  if (!isRecord(body) || !version(body.version)) throw new ApiError('artifact read response is invalid')
  return { version: version(body.version) as ArtifactVersion, ...(typeof body.bytes === 'string' ? { bytes: body.bytes, encoding: 'base64' as const } : {}) }
}
