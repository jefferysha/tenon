import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { atomicReplaceFile, withLock } from '@tenon/kernel'
import { artifactSubjectId, newArtifactSubjectId } from '@tenon/kernel'
import type { ArtifactAttempt, ArtifactCatalog, ArtifactCatalogEntry, ArtifactCheck, ArtifactChecker, ArtifactContent, ArtifactEvent, ArtifactPolicy, ArtifactReadReceipt, ArtifactRecord, ArtifactSchemaAdapter, ArtifactSummaryProvider, ArtifactVersion, ArtifactProducer, ArtifactSubjectRef, ArtifactSubjectAlias, ArtifactSubjectMigrationReceipt } from '@tenon/kernel'
import { readArtifactSubjectRegistry, recordArtifactSubjectProjection } from '../submission/registry.js'

export interface ArtifactServiceOptions {
  readonly rootDir: string
  readonly scopeId: string
  readonly now?: () => string
  /** Production callers can register the checks appropriate for their artifact policy at open time. */
  readonly checkers?: readonly ArtifactChecker[]
  readonly schemaAdapters?: readonly ArtifactSchemaAdapter[]
  readonly summaryProviders?: readonly ArtifactSummaryProvider[]
  /** Directory containing the canonical document/field subject registry. */
  readonly subjectRegistryDir?: string
}
export interface BeginAttemptInput { readonly workflowRunId: string; readonly stageId: string; readonly stageAttemptId: string; readonly dependencyStages?: readonly string[]; readonly visibility?: ArtifactAttempt['visibility'] }
export interface ObserveInput extends ArtifactContent { readonly artifactId?: string; readonly path?: string; readonly idempotencyKey?: string; readonly disposition?: ArtifactVersion['disposition']; readonly observationSource?: 'managed-tool' | 'explicit-publish' | 'reconcile' | 'external'; readonly toolCallId?: string; readonly logicalKey?: string; readonly namespace?: string; readonly declarationStatus?: 'declared' | 'observed' | 'reconciled' | 'undeclared-candidate' }
export interface SubmitArtifactOutputInput extends ObserveInput {
  /** Stable logical key supplied by an executor envelope or workflow contract. */
  readonly logicalKey?: string
  readonly namespace?: string
  readonly declarationStatus?: 'declared' | 'observed' | 'reconciled' | 'undeclared-candidate'
  readonly publish?: boolean
}
export interface PublishInput { readonly artifactId?: string; readonly version?: string; readonly path?: string; readonly disposition?: ArtifactVersion['disposition']; readonly displayName?: string }
export interface ReadOptions { readonly representation?: ArtifactReadReceipt['representation']; readonly consumer?: ArtifactReadReceipt['consumer']; readonly maxBytes?: number }
export interface ArtifactInspection { readonly version: ArtifactVersion; bytes?: Uint8Array; structure?: unknown; summary?: string; representation?: ArtifactReadReceipt['representation']; truncated?: boolean; diagnostics?: readonly string[] }
export interface ArtifactService {
  attempts(stageId?: string): Promise<readonly ArtifactAttempt[]>
  beginAttempt(input: BeginAttemptInput): Promise<ArtifactAttempt>
  endAttempt(stageAttemptId: string, status: Exclude<ArtifactAttempt['status'], 'running'>): Promise<ArtifactAttempt>
  observe(stageAttemptId: string, input: ObserveInput): Promise<ArtifactVersion>
  /** Host-owned boundary for turning an executor declaration into an artifact projection. */
  submitArtifactOutput(stageAttemptId: string, input: SubmitArtifactOutputInput): Promise<ArtifactVersion>
  publish(stageAttemptId: string, input: PublishInput): Promise<ArtifactVersion>
  delete(stageAttemptId: string, artifactId: string, path?: string): Promise<void>
  rename(stageAttemptId: string, artifactId: string, path: string): Promise<ArtifactVersion | undefined>
  catalog(stageAttemptId: string, policy?: ArtifactPolicy): Promise<ArtifactCatalog>
  inspect(artifactId: string, version: string, options?: { readonly includeContent?: boolean; readonly maxBytes?: number }): Promise<ArtifactInspection>
  read(stageAttemptId: string, artifactId: string, version: string, options?: ReadOptions): Promise<ArtifactInspection>
  events(after?: number, limit?: number): Promise<readonly ArtifactEvent[]>
  checks(artifactId?: string, version?: string): Promise<readonly ArtifactCheck[]>
  recordCheck(check: ArtifactCheck): Promise<void>
  /** Run every registered checker that declares support for this version. */
  runChecks(artifactId: string, version: string): Promise<readonly ArtifactCheck[]>
  registerChecker(checker: ArtifactChecker): () => void
  registerSchemaAdapter(adapter: ArtifactSchemaAdapter): () => void
  registerSummaryProvider(provider: ArtifactSummaryProvider): () => void
}

/** Conservative built-ins for production entry points. They never turn an
 * unsupported artifact into a pass; callers may add stricter checkers. */
export function createDefaultArtifactCheckers(): readonly ArtifactChecker[] {
  return [
    {
      id: 'builtin-json-structure',
      version: '1',
      supports: version => version.mediaType.includes('json'),
      check: ({ bytes }) => {
        try { JSON.parse(new TextDecoder().decode(bytes)); return { status: 'passed' as const } }
        catch { return { status: 'failed' as const, diagnostics: ['invalid-json'] } }
      },
    },
    {
      id: 'builtin-unsupported-media',
      version: '1',
      supports: version => !version.mediaType.includes('json'),
      check: () => ({ status: 'not-applicable' as const, diagnostics: ['no-default-checker'] }),
    },
  ]
}

interface SubjectMapping { readonly subjectId: string; readonly namespace: string; readonly logicalKey?: string; readonly artifactId: string; readonly legacyArtifactIds?: readonly string[]; readonly paths: readonly string[]; readonly createdAt: string; readonly updatedAt: string }
interface State { version: 1; revision: number; attempts: ArtifactAttempt[]; artifacts: ArtifactRecord[]; events: ArtifactEvent[]; reads: ArtifactReadReceipt[]; checks: ArtifactCheck[]; subjectMappings: SubjectMapping[]; migrationReceipts: ArtifactSubjectMigrationReceipt[] }
const emptyState = (): State => ({ version: 1, revision: 0, attempts: [], artifacts: [], events: [], reads: [], checks: [], subjectMappings: [], migrationReceipts: [] })
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
function bytesOf(value: ArtifactContent['data'] | ArtifactContent['content']): Uint8Array { if (value instanceof Uint8Array) return value; if (typeof value === 'string') return new TextEncoder().encode(value); return jsonBytes(value) }
function safePath(root: string, p: string): string { const abs = resolve(root, p); const rel = relative(root, abs); if (!rel || rel.startsWith('..') || rel.includes(`${requireSep()}..`)) throw new Error('artifact path outside scope'); return abs }
const requireSep = () => process.platform === 'win32' ? '\\' : '/'
type RuntimeArtifactVersion = ArtifactVersion & {
  readonly subjectRef?: ArtifactSubjectRef
  readonly declarationStatus?: 'declared' | 'observed' | 'reconciled' | 'undeclared-candidate'
}
const clone = <T>(v: T): T => structuredClone(v)
const scopeMigrationLocks = new Map<string, Promise<void>>()
function decodeState(value: unknown): State {
  if (!value || typeof value !== 'object') throw new Error('invalid artifact state')
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1 || typeof candidate.revision !== 'number' || !Array.isArray(candidate.attempts) || !Array.isArray(candidate.artifacts) || !Array.isArray(candidate.events) || !Array.isArray(candidate.reads) || !Array.isArray(candidate.checks)) throw new Error('invalid artifact state')
  return {
    version: 1,
    revision: candidate.revision as number,
    attempts: candidate.attempts as ArtifactAttempt[],
    artifacts: candidate.artifacts as ArtifactRecord[],
    events: candidate.events as ArtifactEvent[],
    reads: candidate.reads as ArtifactReadReceipt[],
    checks: candidate.checks as ArtifactCheck[],
    subjectMappings: Array.isArray(candidate.subjectMappings) ? candidate.subjectMappings as SubjectMapping[] : [],
    migrationReceipts: Array.isArray(candidate.migrationReceipts) ? candidate.migrationReceipts as ArtifactSubjectMigrationReceipt[] : [],
  }
}

export async function openArtifactService(options: ArtifactServiceOptions): Promise<ArtifactService> {
  const root = resolve(options.rootDir); const store = join(root, '.pipeline-artifacts', options.scopeId); const legacyStore = join(root, '.pipeline-artifacts', 'runtime-artifacts'); const blobs = join(store, 'blobs'); const statePath = join(store, 'state.json'); const now = options.now ?? (() => new Date().toISOString())
  let legacyScopeCopied = false
  if (options.scopeId !== 'runtime-artifacts') {
    const existingMigration = scopeMigrationLocks.get(store)
    const migration = existingMigration ?? (async () => {
      try {
        try { await stat(statePath) } catch (targetError) {
          if ((targetError as NodeJS.ErrnoException).code !== 'ENOENT') throw targetError
          try { await stat(join(legacyStore, 'state.json')); await cp(legacyStore, store, { recursive: true }) } catch (legacyError) {
            if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError
          }
        }
      } finally { scopeMigrationLocks.delete(store) }
    })()
    if (existingMigration === undefined) scopeMigrationLocks.set(store, migration)
    await migration
    try {
      const current = decodeState(JSON.parse(await readFile(statePath, 'utf8')))
      await stat(join(legacyStore, 'state.json'))
      legacyScopeCopied = Array.isArray(current.migrationReceipts) && !current.migrationReceipts.some(receipt => receipt.receipt_id === `migration:scope:runtime-artifacts:${options.scopeId}`)
    } catch { /* no legacy state */ }
  }
  const checkers = new Map<string, ArtifactChecker>([...createDefaultArtifactCheckers(), ...(options.checkers ?? [])].map(checker => [checker.id, checker])); const schemas = new Map<string, ArtifactSchemaAdapter>(options.schemaAdapters?.map(adapter => [adapter.id, adapter]) ?? []); const summaries = new Map<string, ArtifactSummaryProvider>(options.summaryProviders?.map(provider => [provider.id, provider]) ?? [])
  await mkdir(blobs, { recursive: true })
  async function load(): Promise<State> { try { return decodeState(JSON.parse(await readFile(statePath, 'utf8'))) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw e } }
  async function save(state: State): Promise<void> { await mkdir(dirname(statePath), { recursive: true }); await atomicReplaceFile(statePath, JSON.stringify(state, null, 2)) }
  function migrateLegacyState(s: State): void {
    if (legacyScopeCopied && !s.migrationReceipts.some(receipt => receipt.receipt_id === `migration:scope:runtime-artifacts:${options.scopeId}`)) {
      s.migrationReceipts.push({ receipt_id: `migration:scope:runtime-artifacts:${options.scopeId}`, legacy_artifact_id: 'scope:runtime-artifacts', subject_id: `scope:${options.scopeId}`, namespace: options.scopeId, content_digest: `sha256:${'0'.repeat(64)}`, migrated_at: now(), kind: 'legacy-scope' })
    }
    for (const record of s.artifacts) {
      if (s.subjectMappings.some(mapping => mapping.artifactId === record.artifactId)) continue
      const sourcePath = record.versions.find(version => version.source?.path)?.source?.path
      const first = record.versions[0]
      const legacyArtifactId = record.artifactId
      const canonicalArtifactId = newArtifactSubjectId(options.scopeId)
      const mapping: SubjectMapping = { subjectId: canonicalArtifactId, namespace: options.scopeId, logicalKey: undefined, artifactId: canonicalArtifactId, legacyArtifactIds: [legacyArtifactId], paths: sourcePath ? [sourcePath] : [], createdAt: first?.createdAt ?? now(), updatedAt: now() }
      s.subjectMappings.push(mapping)
      const alias: ArtifactSubjectAlias = { alias: legacyArtifactId, subject_id: mapping.subjectId, namespace: options.scopeId, kind: 'legacy-path-hash' }
      s.artifacts = s.artifacts.map(candidate => candidate.artifactId === legacyArtifactId ? {
        ...candidate,
        artifactId: canonicalArtifactId,
        subject: { subject_id: mapping.subjectId, namespace: options.scopeId },
        aliases: [...(candidate.aliases ?? []).filter(item => item.alias !== alias.alias), alias],
        versions: candidate.versions.map(version => ({
          ...version,
          artifactId: canonicalArtifactId,
          subjectRef: version.subjectRef ?? { subject_id: mapping.subjectId, namespace: options.scopeId, version: version.version, projection: 'runtime' as const, content_digest: `sha256:${version.contentDigest}`, ...(version.source?.path ? { source: { path: version.source.path } } : {}) },
        })),
      } : candidate)
      if (first) s.migrationReceipts.push({ receipt_id: `migration:${legacyArtifactId}:${mapping.subjectId}`, legacy_artifact_id: legacyArtifactId, subject_id: mapping.subjectId, namespace: options.scopeId, content_digest: `sha256:${first.contentDigest}`, migrated_at: now(), kind: 'legacy-path-hash' })
    }
  }
  async function mutate<T>(fn: (s: State) => Promise<T> | T): Promise<T> { return withLock(store, async () => { const s = await load(); migrateLegacyState(s); const out = await fn(s); await save(s); return out }) }
  async function emit(s: State, type: ArtifactEvent['type'], key: string, payload: Partial<ArtifactEvent> = {}) { if (s.events.some(e => e.idempotencyKey === key)) return; s.revision += 1; s.events.push({ seq: s.revision, idempotencyKey: key, type, at: now(), ...payload }) }
  async function putBlob(bytes: Uint8Array): Promise<{ sha: string; size: number }> { const sha = digest(bytes); const path = join(blobs, sha); try { await stat(path) } catch { await writeFile(path, bytes, { flag: 'wx' }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }) } return { sha, size: bytes.byteLength } }
  function findRecord(s: State, id: string): ArtifactRecord | undefined {
    return s.artifacts.find(record => record.artifactId === id || record.aliases?.some(alias => alias.alias === id))
  }
  async function versionFor(s: State, input: ObserveInput, bytes: Uint8Array, attempt: ArtifactAttempt): Promise<ArtifactVersion> {
    const sourcePath = input.path ?? input.source?.path
    const namespace = input.namespace ?? options.scopeId
    const logicalKey = input.logicalKey
    const { sha, size } = await putBlob(bytes)
    let externalSubject: Awaited<ReturnType<typeof readArtifactSubjectRegistry>>['records'][number] | undefined
    const registry = await readArtifactSubjectRegistry(options.subjectRegistryDir ?? root)
    externalSubject = registry.records.find(record => (logicalKey !== undefined && record.logicalKey === logicalKey) || (sourcePath !== undefined && record.path === sourcePath))
    let mapping = externalSubject === undefined
      ? s.subjectMappings.find(candidate => candidate.namespace === namespace && (logicalKey !== undefined ? candidate.logicalKey === logicalKey : sourcePath !== undefined && candidate.paths.includes(sourcePath)))
      : s.subjectMappings.find(candidate => candidate.subjectId === externalSubject.subjectRef.subject_id)
    let artifactId = input.artifactId ?? mapping?.artifactId ?? externalSubject?.subjectRef.subject_id
    const diagnostics: string[] = []
    // A reconcile-only rename can retain identity when exactly one prior record
    // owns these bytes. Multiple matches are ambiguous and deliberately create
    // a new subject instead of guessing lineage.
    if (artifactId === undefined && input.observationSource === 'reconcile') {
      const matches = s.artifacts.filter(record => record.versions.some(version => version.contentDigest === sha))
      if (matches.length === 1) {
        artifactId = matches[0]?.artifactId
        if (artifactId !== undefined) diagnostics.push('reconcile-path-moved')
      } else if (matches.length > 1) diagnostics.push('identity-ambiguous')
    }
    if (mapping === undefined && artifactId !== undefined) mapping = s.subjectMappings.find(candidate => candidate.artifactId === artifactId)
    if (artifactId === undefined) artifactId = logicalKey !== undefined ? artifactSubjectId(namespace, logicalKey) : newArtifactSubjectId(namespace)
    if (mapping === undefined) {
      const subjectId = externalSubject?.subjectRef.subject_id ?? (logicalKey !== undefined ? artifactSubjectId(namespace, logicalKey) : newArtifactSubjectId(namespace))
      mapping = { subjectId, namespace: externalSubject?.subjectRef.namespace ?? namespace, ...(externalSubject?.logicalKey ?? logicalKey ? { logicalKey: externalSubject?.logicalKey ?? logicalKey } : {}), artifactId: artifactId ?? subjectId, paths: [...new Set([sourcePath, externalSubject?.path].filter((value): value is string => value !== undefined))], createdAt: now(), updatedAt: now() }
      s.subjectMappings.push(mapping)
    } else if (sourcePath !== undefined && !mapping.paths.includes(sourcePath)) {
      mapping = { ...mapping, paths: [...mapping.paths, sourcePath], updatedAt: now() }
      s.subjectMappings = s.subjectMappings.map(candidate => candidate.subjectId === mapping?.subjectId ? mapping as SubjectMapping : candidate)
    }
    const record = s.artifacts.find(a => a.artifactId === artifactId)
    const existing = record?.versions.find(v => v.contentDigest === sha)
    if (existing) {
      // Reconciliation can discover bytes before a managed publish. Adopt
      // that same version's provenance when an explicit stage observation
      // arrives later instead of leaving it attributed to an unknown writer.
      if (record !== undefined && input.origin === 'stage' && (existing.origin !== 'stage' || existing.producer === undefined)) {
        const producer = input.producer ?? { workflowRunId: attempt.workflowRunId, stageAttemptId: attempt.stageAttemptId }
        const adopted = { ...existing, origin: 'stage' as const, producer, declarationStatus: 'declared' as const }
        s.artifacts = s.artifacts.map(r => r.artifactId === artifactId ? { ...r, versions: r.versions.map(v => v.version === existing.version ? adopted : v) } : r)
        await emit(s, 'artifact.observed', `observe:${input.idempotencyKey ?? `${attempt.stageAttemptId}:${artifactId}:${sha}`}`, { artifactId, version: existing.version, attemptId: attempt.stageAttemptId, payload: { source: input.observationSource ?? 'reconcile', declarationStatus: 'declared', ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}) } })
        return adopted
      }
      await emit(s, 'artifact.observed', `observe:${input.idempotencyKey ?? `${attempt.stageAttemptId}:${artifactId}:${sha}`}`, { artifactId, version: existing.version, attemptId: attempt.stageAttemptId, payload: { source: input.observationSource ?? 'reconcile', declarationStatus: input.declarationStatus ?? (input.observationSource === 'reconcile' ? 'reconciled' : 'observed'), ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}) } })
      return existing
    }
    const version = `v${(record?.versions.length ?? 0) + 1}`
    const origin = input.origin ?? 'stage'; const producer: ArtifactProducer | undefined = input.producer ?? (origin === 'stage' ? { workflowRunId: attempt.workflowRunId, stageAttemptId: attempt.stageAttemptId } : undefined)
    const declarationStatus = input.declarationStatus ?? (input.observationSource === 'reconcile' ? 'undeclared-candidate' : input.observationSource === 'managed-tool' ? 'observed' : 'declared')
    const subjectRef: ArtifactSubjectRef = { subject_id: mapping.subjectId, namespace: mapping.namespace, projection: 'runtime', version, content_digest: `sha256:${sha}`, ...(sourcePath ? { source: { path: sourcePath } } : {}) }
    const value: RuntimeArtifactVersion = { artifactId, version, contentDigest: sha, size, mediaType: input.mediaType, kind: input.kind ?? (input.mediaType.includes('json') ? 'json' : input.mediaType.startsWith('text/') ? 'text' : 'file'), origin, ...(producer ? { producer } : {}), source: sourcePath ? { path: sourcePath } : input.source, contentUri: `artifact://${options.scopeId}/${sha}`, disposition: input.disposition ?? (input.observationSource === 'reconcile' ? 'intermediate' : 'candidate'), quality: 'unchecked', createdAt: now(), subjectRef, declarationStatus }
    const subject = { subject_id: mapping.subjectId, namespace: mapping.namespace }
    if (record) s.artifacts = s.artifacts.map(r => r.artifactId === artifactId ? { ...r, subject: r.subject ?? subject, currentVersion: version, versions: [...r.versions, value] } : r)
    else s.artifacts.push({ artifactId, subject, currentVersion: version, versions: [value], displayName: sourcePath })
    await emit(s, 'artifact.observed', `observe:${input.idempotencyKey ?? `${attempt.stageAttemptId}:${artifactId}:${sha}`}`, { artifactId, version, attemptId: attempt.stageAttemptId, payload: { source: input.observationSource ?? 'reconcile', declarationStatus, ...(diagnostics.length ? { diagnostics } : {}), ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}) } })
    return value
  }
  function visibleToAttempt(s: State, attempt: ArtifactAttempt, version: ArtifactVersion): boolean {
    if (version.producer?.stageAttemptId === attempt.stageAttemptId) return true
    if (attempt.visibility !== 'dependency-chain') return true
    if (version.producer) {
      const producerAttempt = s.attempts.find(candidate => candidate.stageAttemptId === version.producer?.stageAttemptId)
      return producerAttempt !== undefined && attempt.dependencyStages.includes(producerAttempt.stageId)
    }
    // Legacy/unknown versions have no producer claim. Use their observed event
    // attempt as a visibility hint, without fabricating a producer identity.
    const observations = s.events.filter(event => event.type === 'artifact.observed' && event.artifactId === version.artifactId && event.version === version.version && event.attemptId)
    // States written before observation events existed remain readable through
    // the legacy catalog projection; retain the missing-provenance marker.
    if (observations.length === 0) return true
    return observations.some(event => {
      if (event.attemptId === attempt.stageAttemptId) return true
      const observedAttempt = s.attempts.find(candidate => candidate.stageAttemptId === event.attemptId)
      return observedAttempt !== undefined && attempt.dependencyStages.includes(observedAttempt.stageId)
    })
  }
  function pinnedForAttempt(s: State, attempt: ArtifactAttempt): Readonly<Record<string, string>> {
    const pinned: Record<string, string> = {}
    for (const record of s.artifacts) {
      // Pin the newest visible deliverable, independent of a candidate
      // currentVersion. This makes retries deterministic when a producer has
      // an unpublished working version in the same scope.
      const version = [...record.versions].reverse().find(candidate => candidate.disposition === 'deliverable' && candidate.deletedAt === undefined && visibleToAttempt(s, attempt, candidate))
      if (version) pinned[record.artifactId] = version.version
    }
    return pinned
  }
  const service: ArtifactService = {
    attempts: async stageId => (await load()).attempts.filter(a => stageId === undefined || a.stageId === stageId).map(clone),
    beginAttempt: (input) => mutate(async s => {
      const existing = s.attempts.find(a => a.stageAttemptId === input.stageAttemptId)
      if (existing) return clone(existing)
      const draft: ArtifactAttempt = { workflowRunId: input.workflowRunId, stageId: input.stageId, stageAttemptId: input.stageAttemptId, status: 'running', dependencyStages: input.dependencyStages ?? [], visibility: input.visibility ?? 'dependency-chain', startedAt: now() }
      const a: ArtifactAttempt = { ...draft, pinnedVersions: pinnedForAttempt(s, draft) }
      s.attempts.push(a)
      await emit(s, 'attempt.started', `attempt:${a.stageAttemptId}`, { attemptId: a.stageAttemptId, payload: { pinnedVersions: a.pinnedVersions } })
      return clone(a)
    }),
    endAttempt: (id, status) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); if (a.status !== 'running') return clone(a); const ended = { ...a, status, endedAt: now() } as ArtifactAttempt; s.attempts = s.attempts.map(x => x.stageAttemptId === id ? ended : x); await emit(s, 'attempt.ended', `attempt-end:${id}:${status}`, { attemptId: id, payload: { status } }); return clone(ended) }),
    observe: (id, input) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); if (input.idempotencyKey) { const prior = s.events.find(e => e.idempotencyKey === `observe:${input.idempotencyKey}`); if (prior?.artifactId && prior.version) { const pv = s.artifacts.find(r => r.artifactId === prior.artifactId)?.versions.find(v => v.version === prior.version); if (pv) return clone(pv) } } let bytes: Uint8Array; if (input.data !== undefined || input.content !== undefined) bytes = bytesOf(input.data ?? input.content); else if (input.path) bytes = new Uint8Array(await readFile(safePath(root, input.path))); else throw new Error('artifact content or path required'); return clone(await versionFor(s, input, bytes, a)) }),
    submitArtifactOutput: async (id, input) => {
      const observed = await service.observe(id, { ...input, observationSource: input.observationSource ?? 'explicit-publish', declarationStatus: input.declarationStatus ?? 'declared' })
      const result = input.publish === false || (input.disposition !== undefined && input.disposition !== 'deliverable')
        ? observed
        : await service.publish(id, { artifactId: observed.artifactId, version: observed.version, ...(observed.source?.path ? { path: observed.source.path } : {}), disposition: input.disposition ?? 'deliverable' })
      const subjectRef = (result as RuntimeArtifactVersion).subjectRef
      if (subjectRef !== undefined) {
        await recordArtifactSubjectProjection(options.subjectRegistryDir ?? root, {
          subjectRef,
          logicalKey: input.logicalKey ?? input.path ?? result.artifactId,
          projection: 'runtime',
          ...(input.path ?? result.source?.path ? { path: input.path ?? result.source?.path } : {}),
          status: 'committed',
          receiptId: `runtime-submission:${id}:${result.artifactId}:${result.version}`,
          recordedAt: now(),
        })
      }
      return result
    },
    publish: (id, input) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); const index = input.artifactId ? s.artifacts.findIndex(x => x.artifactId === input.artifactId || x.aliases?.some(alias => alias.alias === input.artifactId)) : input.path ? s.artifacts.findIndex(x => x.displayName === input.path) : -1; if (index < 0) throw new Error('artifact candidate not found'); const record = s.artifacts[index]; if (!record) throw new Error('artifact candidate not found'); const v = input.version ? record.versions.find(candidate => candidate.version === input.version) : record.versions[record.versions.length - 1]; if (!v) throw new Error('artifact version not found'); const observedHere = s.events.some(e => e.type === 'artifact.observed' && e.attemptId === id && e.artifactId === record.artifactId && e.version === v.version); if (!observedHere) throw new Error('artifact was not observed by this attempt'); const published = { ...v, disposition: input.disposition ?? 'deliverable', declarationStatus: 'declared' as const, ...(v.publisher === undefined ? { publisher: { workflowRunId: a.workflowRunId, stageAttemptId: id } } : {}) }; s.artifacts[index] = { ...record, versions: record.versions.map(x => x.version === v.version ? published : x) }; await emit(s, 'artifact.published', `publish:${id}:${record.artifactId}:${v.version}`, { attemptId: id, artifactId: record.artifactId, version: v.version }); return clone(published) }),
    delete: (id, artifactId, path) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); const index = s.artifacts.findIndex(x => x.artifactId === artifactId || x.aliases?.some(alias => alias.alias === artifactId)); if (index < 0) return; const r = s.artifacts[index]; if (!r) return; const v = r.currentVersion ? r.versions.find(x => x.version === r.currentVersion) : undefined; if (v && !v.deletedAt) { s.artifacts[index] = { ...r, versions: r.versions.map(x => x.version === v.version ? { ...x, deletedAt: now() } : x) }; await emit(s, 'artifact.deleted', `delete:${id}:${r.artifactId}:${v.version}`, { attemptId: id, artifactId: r.artifactId, version: v.version, payload: { path } }) } }),
    rename: (id, artifactId, path) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); const safe = relative(root, safePath(root, path)); const index = s.artifacts.findIndex(x => x.artifactId === artifactId || x.aliases?.some(alias => alias.alias === artifactId)); if (index < 0) return undefined; const r = s.artifacts[index]; if (!r) return undefined; const v = r.versions.find(x => x.version === r.currentVersion); if (!v) return undefined; const renamed = { ...v, source: { ...(v.source ?? {}), path: safe }, ...(v.subjectRef ? { subjectRef: { ...v.subjectRef, source: { ...(v.subjectRef.source ?? {}), path: safe } } } : {}) }; s.artifacts[index] = { ...r, versions: r.versions.map(x => x.version === v.version ? renamed : x), displayName: safe }; const mapping = s.subjectMappings.find(candidate => candidate.artifactId === r.artifactId); if (mapping && !mapping.paths.includes(safe)) s.subjectMappings = s.subjectMappings.map(candidate => candidate.subjectId === mapping.subjectId ? { ...candidate, paths: [...candidate.paths, safe], updatedAt: now() } : candidate); await emit(s, 'artifact.renamed', `rename:${id}:${artifactId}:${v.version}:${safe}`, { attemptId: id, artifactId: r.artifactId, version: v.version, payload: { path: safe, subjectId: r.subject?.subject_id } }); return clone(renamed) }),
    catalog: async (id, policy = {}) => {
      const s = await load(); const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found')
      const visibilityAttempt = policy.dependencyStages === undefined ? a : { ...a, dependencyStages: policy.dependencyStages }
      const all: ArtifactCatalogEntry[] = []
      for (const r of s.artifacts) for (const [versionIndex, v] of r.versions.entries()) {
        const producerAttempt = v.producer ? s.attempts.find(x => x.stageAttemptId === v.producer?.stageAttemptId) : undefined
        const visible = visibleToAttempt(s, visibilityAttempt, v)
        const pinned = !policy.pinned || a.pinnedVersions === undefined || a.pinnedVersions[v.artifactId] === v.version
        if (!v.deletedAt && visible && pinned && (policy.includeCandidates || v.disposition === 'deliverable') && (!policy.requireQuality || v.quality === policy.requireQuality)) {
          const consumed = s.reads.some(read => read.stageAttemptId === id && read.artifactId === v.artifactId && read.version === v.version)
          const newer = r.versions.some((next, nextIndex) => nextIndex > versionIndex && next.disposition === 'deliverable' && !next.deletedAt)
          all.push({ ...v, consumed, pendingUpdate: consumed && newer && a.status === 'running', affected: consumed && newer && a.status !== 'running', availableFromStage: producerAttempt?.stageId })
        }
      }
      const entries = policy.includeHistory ? all : all.filter(v => s.artifacts.find(r => r.artifactId === v.artifactId)?.currentVersion === v.version)
      const cursor = policy.cursor === undefined ? 0 : Math.max(0, Number.isSafeInteger(Number(policy.cursor)) ? Number(policy.cursor) : 0); const pageSize = policy.maxEntries === undefined ? entries.length : Math.max(0, policy.maxEntries); const bounded = entries.slice(cursor, cursor + pageSize); const truncated = cursor + bounded.length < entries.length; const nextCursor = truncated ? String(cursor + bounded.length) : undefined
      const d = digest(new TextEncoder().encode(JSON.stringify(bounded.map(x => [x.artifactId, x.version, x.contentDigest, x.disposition, x.quality, x.producer, x.publisher, x.consumed, x.pendingUpdate, x.affected, x.availableFromStage]))))
      return { revision: s.revision, digest: d, stageAttemptId: id, entries: bounded, history: policy.includeHistory ? bounded : undefined, totalEntries: entries.length, truncated, ...(nextCursor ? { nextCursor } : {}) }
    },
    inspect: async (artifactId, version, options = {}) => { const s = await load(); const v = findRecord(s, artifactId)?.versions.find(x => x.version === version); if (!v) throw new Error('artifact version not found'); const result: ArtifactInspection = { version: clone(v) }; const needsAnalysis = schemas.size > 0 || summaries.size > 0; if (options.includeContent || needsAnalysis) { const bytes = await readBlob(v.contentDigest, options.maxBytes); if (options.includeContent) result.bytes = bytes; const adapter = [...schemas.values()].find(candidate => candidate.supports(v)); if (adapter) result.structure = adapter.inspect(bytes); const provider = [...summaries.values()].find(candidate => candidate.supports(v)); if (provider) result.summary = await provider.summarize(bytes) } return result },
    read: async (id, artifactId, version, options = {}) => {
      const s = await load(); const attempt = s.attempts.find(a => a.stageAttemptId === id); if (!attempt) throw new Error('attempt not found')
      const v = findRecord(s, artifactId)?.versions.find(x => x.version === version); if (!v) throw new Error('artifact version not found')
      if (!visibleToAttempt(s, attempt, v)) throw new Error('artifact is not visible to this attempt')
      const representation = options.representation ?? 'content'
      const result: ArtifactInspection = { version: clone(v), representation, diagnostics: [] }
      if (representation !== 'metadata') {
        const bytes = await readBlob(v.contentDigest, options.maxBytes)
        if (representation === 'content') result.bytes = bytes
        else if (representation === 'structure') {
          const adapter = [...schemas.values()].find(candidate => candidate.supports(v))
          if (adapter) result.structure = adapter.inspect(bytes)
          else if (v.mediaType.includes('json')) { try { result.structure = JSON.parse(new TextDecoder().decode(bytes)) } catch { result.diagnostics = ['structure-unavailable'] } }
          else result.diagnostics = ['structure-unavailable']
        } else {
          const provider = [...summaries.values()].find(candidate => candidate.supports(v))
          if (provider) result.summary = await provider.summarize(bytes)
          else result.summary = new TextDecoder().decode(bytes.slice(0, 512))
        }
      }
      if (options.consumer !== 'ui') await mutate(async state => { if (!state.reads.some(r => r.stageAttemptId === id && r.artifactId === artifactId && r.version === version && r.representation === representation)) { const receipt: ArtifactReadReceipt = { receiptId: `read:${id}:${artifactId}:${version}:${representation}`, stageAttemptId: id, artifactId, version, representation, readAt: now(), consumer: 'execution', bytes: result.bytes?.byteLength ?? 0 }; state.reads.push(receipt); await emit(state, 'artifact.consumed', receipt.receiptId, { attemptId: id, artifactId, version, payload: { representation } }) } })
      return result
    },
    events: async (after = 0, limit = 100) => (await load()).events.filter(e => e.seq > after).slice(0, Math.max(0, limit)).map(clone),
    checks: async (artifactId, version) => (await load()).checks.filter(c => (!artifactId || c.artifactId === artifactId) && (!version || c.version === version)).map(clone),
    runChecks: async (artifactId, version) => {
      const inspected = await service.inspect(artifactId, version, { includeContent: true })
      let applicable = [...checkers.values()].filter(checker => checker.supports(inspected.version))
      // The fallback media checker only speaks when no caller-provided
      // checker claims the version; a registered text checker must be able to
      // replace the conservative not-applicable result.
      if (applicable.some(checker => checker.id !== 'builtin-unsupported-media')) applicable = applicable.filter(checker => checker.id !== 'builtin-unsupported-media')
      const results: ArtifactCheck[] = []
      for (const checker of applicable) {
        const result = await checker.check({ version: inspected.version, bytes: inspected.bytes ?? new Uint8Array() })
        const check: ArtifactCheck = { ...result, checkId: `check:${checker.id}:${artifactId}:${version}`, artifactId, version, checker: checker.id, checkerVersion: checker.version, checkedAt: now() }
        await service.recordCheck(check)
        results.push(check)
      }
      return results.map(clone)
    },
    recordCheck: (check) => mutate(async s => { s.checks = s.checks.filter(c => c.checkId !== check.checkId); s.checks.push(clone(check)); const index = s.artifacts.findIndex(r => r.artifactId === check.artifactId); if (index >= 0) { const record = s.artifacts[index]; if (record) s.artifacts[index] = { ...record, versions: record.versions.map(v => v.version === check.version ? { ...v, quality: check.status } : v) } } await emit(s, 'artifact.checked', `check:${check.checkId}`, { artifactId: check.artifactId, version: check.version }) }),
    registerChecker: checker => { checkers.set(checker.id, checker); return () => { if (checkers.get(checker.id) === checker) checkers.delete(checker.id) } },
    registerSchemaAdapter: adapter => { schemas.set(adapter.id, adapter); return () => { if (schemas.get(adapter.id) === adapter) schemas.delete(adapter.id) } },
    registerSummaryProvider: provider => { summaries.set(provider.id, provider); return () => { if (summaries.get(provider.id) === provider) summaries.delete(provider.id) } },
  }
  async function readBlob(sha: string, max?: number): Promise<Uint8Array> { const b = new Uint8Array(await readFile(join(blobs, sha))); return max && b.byteLength > max ? b.slice(0, max) : b }
  return service
}
