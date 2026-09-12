import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { atomicReplaceFile, withLock } from '@tenon/kernel'
import type { ArtifactAttempt, ArtifactCatalog, ArtifactCatalogEntry, ArtifactCheck, ArtifactChecker, ArtifactContent, ArtifactEvent, ArtifactPolicy, ArtifactReadReceipt, ArtifactRecord, ArtifactSchemaAdapter, ArtifactSummaryProvider, ArtifactVersion, ArtifactProducer } from '@tenon/kernel'

export interface ArtifactServiceOptions { readonly rootDir: string; readonly scopeId: string; readonly now?: () => string }
export interface BeginAttemptInput { readonly workflowRunId: string; readonly stageId: string; readonly stageAttemptId: string; readonly dependencyStages?: readonly string[]; readonly visibility?: ArtifactAttempt['visibility'] }
export interface ObserveInput extends ArtifactContent { readonly artifactId?: string; readonly path?: string; readonly idempotencyKey?: string; readonly disposition?: ArtifactVersion['disposition'] }
export interface PublishInput { readonly artifactId?: string; readonly path?: string; readonly disposition?: ArtifactVersion['disposition']; readonly displayName?: string }
export interface ReadOptions { readonly representation?: ArtifactReadReceipt['representation']; readonly consumer?: ArtifactReadReceipt['consumer']; readonly maxBytes?: number }
export interface ArtifactInspection { readonly version: ArtifactVersion; bytes?: Uint8Array; readonly structure?: unknown; readonly summary?: string }
export interface ArtifactService {
  attempts(stageId?: string): Promise<readonly ArtifactAttempt[]>
  beginAttempt(input: BeginAttemptInput): Promise<ArtifactAttempt>
  endAttempt(stageAttemptId: string, status: Exclude<ArtifactAttempt['status'], 'running'>): Promise<ArtifactAttempt>
  observe(stageAttemptId: string, input: ObserveInput): Promise<ArtifactVersion>
  publish(stageAttemptId: string, input: PublishInput): Promise<ArtifactVersion>
  delete(stageAttemptId: string, artifactId: string, path?: string): Promise<void>
  rename(stageAttemptId: string, artifactId: string, path: string): Promise<ArtifactVersion | undefined>
  catalog(stageAttemptId: string, policy?: ArtifactPolicy): Promise<ArtifactCatalog>
  inspect(artifactId: string, version: string, options?: { readonly includeContent?: boolean; readonly maxBytes?: number }): Promise<ArtifactInspection>
  read(stageAttemptId: string, artifactId: string, version: string, options?: ReadOptions): Promise<ArtifactInspection>
  events(after?: number): Promise<readonly ArtifactEvent[]>
  checks(artifactId?: string, version?: string): Promise<readonly ArtifactCheck[]>
  recordCheck(check: ArtifactCheck): Promise<void>
  /** Run every registered checker that declares support for this version. */
  runChecks(artifactId: string, version: string): Promise<readonly ArtifactCheck[]>
  registerChecker(checker: ArtifactChecker): () => void
  registerSchemaAdapter(adapter: ArtifactSchemaAdapter): () => void
  registerSummaryProvider(provider: ArtifactSummaryProvider): () => void
}

interface State { version: 1; revision: number; attempts: ArtifactAttempt[]; artifacts: ArtifactRecord[]; events: ArtifactEvent[]; reads: ArtifactReadReceipt[]; checks: ArtifactCheck[] }
const emptyState = (): State => ({ version: 1, revision: 0, attempts: [], artifacts: [], events: [], reads: [], checks: [] })
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
function bytesOf(value: ArtifactContent['data'] | ArtifactContent['content']): Uint8Array { if (value instanceof Uint8Array) return value; if (typeof value === 'string') return new TextEncoder().encode(value); return jsonBytes(value) }
function safePath(root: string, p: string): string { const abs = resolve(root, p); const rel = relative(root, abs); if (!rel || rel.startsWith('..') || rel.includes(`${requireSep()}..`)) throw new Error('artifact path outside scope'); return abs }
const requireSep = () => process.platform === 'win32' ? '\\' : '/'
const idFor = (path: string, mediaType: string) => `artifact:${createHash('sha256').update(`${path}\0${mediaType}`).digest('hex').slice(0, 24)}`
const clone = <T>(v: T): T => structuredClone(v)
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
  }
}

export async function openArtifactService(options: ArtifactServiceOptions): Promise<ArtifactService> {
  const root = resolve(options.rootDir); const store = join(root, '.pipeline-artifacts', options.scopeId); const blobs = join(store, 'blobs'); const statePath = join(store, 'state.json'); const now = options.now ?? (() => new Date().toISOString())
  const checkers = new Map<string, ArtifactChecker>(); const schemas = new Map<string, ArtifactSchemaAdapter>(); const summaries = new Map<string, ArtifactSummaryProvider>()
  await mkdir(blobs, { recursive: true })
  async function load(): Promise<State> { try { return decodeState(JSON.parse(await readFile(statePath, 'utf8'))) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw e } }
  async function save(state: State): Promise<void> { await mkdir(dirname(statePath), { recursive: true }); await atomicReplaceFile(statePath, JSON.stringify(state, null, 2)) }
  async function mutate<T>(fn: (s: State) => Promise<T> | T): Promise<T> { return withLock(store, async () => { const s = await load(); const out = await fn(s); await save(s); return out }) }
  async function emit(s: State, type: ArtifactEvent['type'], key: string, payload: Partial<ArtifactEvent> = {}) { if (s.events.some(e => e.idempotencyKey === key)) return; s.revision += 1; s.events.push({ seq: s.revision, idempotencyKey: key, type, at: now(), ...payload }) }
  async function putBlob(bytes: Uint8Array): Promise<{ sha: string; size: number }> { const sha = digest(bytes); const path = join(blobs, sha); try { await stat(path) } catch { await writeFile(path, bytes, { flag: 'wx' }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }) } return { sha, size: bytes.byteLength } }
  async function versionFor(s: State, input: ObserveInput, bytes: Uint8Array, attempt: ArtifactAttempt): Promise<ArtifactVersion> {
    const sourcePath = input.path ?? input.source?.path; const artifactId = input.artifactId ?? idFor(sourcePath ?? `${attempt.stageAttemptId}:${s.revision}`, input.mediaType); const { sha, size } = await putBlob(bytes); const record = s.artifacts.find(a => a.artifactId === artifactId)
    const existing = record?.versions.find(v => v.contentDigest === sha)
    if (existing) {
      await emit(s, 'artifact.observed', `observe:${input.idempotencyKey ?? `${attempt.stageAttemptId}:${artifactId}:${sha}`}`, { artifactId, version: existing.version, attemptId: attempt.stageAttemptId })
      return existing
    }
    const version = `v${(record?.versions.length ?? 0) + 1}`
    const origin = input.origin ?? 'stage'; const producer: ArtifactProducer | undefined = input.producer ?? (origin === 'stage' ? { workflowRunId: attempt.workflowRunId, stageAttemptId: attempt.stageAttemptId } : undefined)
    const value: ArtifactVersion = { artifactId, version, contentDigest: sha, size, mediaType: input.mediaType, kind: input.kind ?? (input.mediaType.includes('json') ? 'json' : input.mediaType.startsWith('text/') ? 'text' : 'file'), origin, ...(producer ? { producer } : {}), source: sourcePath ? { path: sourcePath } : input.source, contentUri: `artifact://${options.scopeId}/${sha}`, disposition: input.disposition ?? 'candidate', quality: 'unchecked', createdAt: now() }
    if (record) s.artifacts = s.artifacts.map(r => r.artifactId === artifactId ? { ...r, currentVersion: version, versions: [...r.versions, value] } : r)
    else s.artifacts.push({ artifactId, currentVersion: version, versions: [value], displayName: sourcePath })
    await emit(s, 'artifact.observed', `observe:${input.idempotencyKey ?? `${attempt.stageAttemptId}:${artifactId}:${sha}`}`, { artifactId, version, attemptId: attempt.stageAttemptId })
    return value
  }
  const service: ArtifactService = {
    attempts: async stageId => (await load()).attempts.filter(a => stageId === undefined || a.stageId === stageId).map(clone),
    beginAttempt: (input) => mutate(async s => { const existing = s.attempts.find(a => a.stageAttemptId === input.stageAttemptId); if (existing) return clone(existing); const a: ArtifactAttempt = { workflowRunId: input.workflowRunId, stageId: input.stageId, stageAttemptId: input.stageAttemptId, status: 'running', dependencyStages: input.dependencyStages ?? [], visibility: input.visibility ?? 'dependency-chain', startedAt: now() }; s.attempts.push(a); await emit(s, 'attempt.started', `attempt:${a.stageAttemptId}`, { attemptId: a.stageAttemptId }); return clone(a) }),
    endAttempt: (id, status) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); if (a.status !== 'running') return clone(a); const ended = { ...a, status, endedAt: now() } as ArtifactAttempt; s.attempts = s.attempts.map(x => x.stageAttemptId === id ? ended : x); await emit(s, 'attempt.ended', `attempt-end:${id}:${status}`, { attemptId: id, payload: { status } }); return clone(ended) }),
    observe: (id, input) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); if (input.idempotencyKey) { const prior = s.events.find(e => e.idempotencyKey === `observe:${input.idempotencyKey}`); if (prior?.artifactId && prior.version) { const pv = s.artifacts.find(r => r.artifactId === prior.artifactId)?.versions.find(v => v.version === prior.version); if (pv) return clone(pv) } } let bytes: Uint8Array; if (input.data !== undefined || input.content !== undefined) bytes = bytesOf(input.data ?? input.content); else if (input.path) bytes = new Uint8Array(await readFile(safePath(root, input.path))); else throw new Error('artifact content or path required'); return clone(await versionFor(s, input, bytes, a)) }),
    publish: (id, input) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); const index = input.artifactId ? s.artifacts.findIndex(x => x.artifactId === input.artifactId) : input.path ? s.artifacts.findIndex(x => x.displayName === input.path) : -1; if (index < 0) throw new Error('artifact candidate not found'); const record = s.artifacts[index]; if (!record) throw new Error('artifact candidate not found'); const v = record.versions[record.versions.length - 1]; if (!v) throw new Error('artifact version not found'); const observedHere = s.events.some(e => e.type === 'artifact.observed' && e.attemptId === id && e.artifactId === record.artifactId && e.version === v.version); if (!observedHere) throw new Error('artifact was not observed by this attempt'); const published = { ...v, disposition: input.disposition ?? 'deliverable', ...(v.publisher === undefined ? { publisher: { workflowRunId: a.workflowRunId, stageAttemptId: id } } : {}) }; s.artifacts[index] = { ...record, versions: record.versions.map(x => x.version === v.version ? published : x) }; await emit(s, 'artifact.published', `publish:${id}:${record.artifactId}:${v.version}`, { attemptId: id, artifactId: record.artifactId, version: v.version }); return clone(published) }),
    delete: (id, artifactId, path) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); const index = s.artifacts.findIndex(x => x.artifactId === artifactId); if (index < 0) return; const r = s.artifacts[index]; if (!r) return; const v = r.currentVersion ? r.versions.find(x => x.version === r.currentVersion) : undefined; if (v && !v.deletedAt) { s.artifacts[index] = { ...r, versions: r.versions.map(x => x.version === v.version ? { ...x, deletedAt: now() } : x) }; await emit(s, 'artifact.deleted', `delete:${id}:${artifactId}:${v.version}`, { attemptId: id, artifactId, version: v.version, payload: { path } }) } }),
    rename: (id, artifactId, path) => mutate(async s => { const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); const index = s.artifacts.findIndex(x => x.artifactId === artifactId); if (index < 0) return undefined; const r = s.artifacts[index]; if (!r) return undefined; const v = r.versions.find(x => x.version === r.currentVersion); if (!v) return undefined; const renamed = { ...v, source: { ...(v.source ?? {}), path } }; s.artifacts[index] = { ...r, versions: r.versions.map(x => x.version === v.version ? renamed : x), displayName: path }; await emit(s, 'artifact.renamed', `rename:${id}:${artifactId}:${v.version}:${path}`, { attemptId: id, artifactId, version: v.version }); return clone(renamed) }),
    catalog: async (id, policy = {}) => { const s = await load(); const a = s.attempts.find(a => a.stageAttemptId === id); if (!a) throw new Error('attempt not found'); const allowed = new Set(policy.dependencyStages ?? a.dependencyStages); const all: ArtifactCatalogEntry[] = []; for (const r of s.artifacts) for (const [versionIndex, v] of r.versions.entries()) { const producerAttempt = v.producer ? s.attempts.find(x => x.stageAttemptId === v.producer?.stageAttemptId) : undefined; const own = producerAttempt?.stageAttemptId === id; const visible = !v.producer || own || a.visibility !== 'dependency-chain' || allowed.has(producerAttempt?.stageId ?? ''); if (!v.deletedAt && visible && (policy.includeCandidates || v.disposition === 'deliverable') && (!policy.requireQuality || v.quality === policy.requireQuality)) { const consumed = s.reads.some(read => read.stageAttemptId === id && read.artifactId === v.artifactId && read.version === v.version); const newer = r.versions.some((next, nextIndex) => nextIndex > versionIndex && next.disposition === 'deliverable' && !next.deletedAt); all.push({ ...v, consumed, affected: consumed && newer && a.status === 'completed', availableFromStage: producerAttempt?.stageId }) } } const entries = policy.includeHistory ? all : all.filter(v => s.artifacts.find(r => r.artifactId === v.artifactId)?.currentVersion === v.version); const bounded = policy.maxEntries ? entries.slice(0, policy.maxEntries) : entries; const d = digest(new TextEncoder().encode(JSON.stringify(bounded.map(x => [x.artifactId, x.version, x.contentDigest])))); return { revision: s.revision, digest: d, stageAttemptId: id, entries: bounded, history: policy.includeHistory ? bounded : undefined } },
    inspect: async (artifactId, version, options = {}) => { const s = await load(); const v = s.artifacts.find(x => x.artifactId === artifactId)?.versions.find(x => x.version === version); if (!v) throw new Error('artifact version not found'); const result: { version: ArtifactVersion; bytes?: Uint8Array; structure?: unknown; summary?: string } = { version: clone(v) }; const needsAnalysis = schemas.size > 0 || summaries.size > 0; if (options.includeContent || needsAnalysis) { const bytes = await readBlob(v.contentDigest, options.maxBytes); if (options.includeContent) result.bytes = bytes; const adapter = [...schemas.values()].find(candidate => candidate.supports(v)); if (adapter) result.structure = adapter.inspect(bytes); const provider = [...summaries.values()].find(candidate => candidate.supports(v)); if (provider) result.summary = await provider.summarize(bytes) } return result },
    read: async (id, artifactId, version, options = {}) => { const s = await load(); if (!s.attempts.some(a => a.stageAttemptId === id)) throw new Error('attempt not found'); const v = s.artifacts.find(x => x.artifactId === artifactId)?.versions.find(x => x.version === version); if (!v) throw new Error('artifact version not found'); const bytes = await readBlob(v.contentDigest, options.maxBytes); if (options.consumer !== 'ui') await mutate(async state => { if (!state.reads.some(r => r.stageAttemptId === id && r.artifactId === artifactId && r.version === version && r.representation === (options.representation ?? 'content'))) { const receipt: ArtifactReadReceipt = { receiptId: `read:${id}:${artifactId}:${version}:${options.representation ?? 'content'}`, stageAttemptId: id, artifactId, version, representation: options.representation ?? 'content', readAt: now(), consumer: 'execution', bytes: bytes.byteLength }; state.reads.push(receipt); await emit(state, 'artifact.consumed', receipt.receiptId, { attemptId: id, artifactId, version }) } }); return { version: clone(v), bytes } },
    events: async (after = 0) => (await load()).events.filter(e => e.seq > after).map(clone),
    checks: async (artifactId, version) => (await load()).checks.filter(c => (!artifactId || c.artifactId === artifactId) && (!version || c.version === version)).map(clone),
    runChecks: async (artifactId, version) => {
      const inspected = await service.inspect(artifactId, version, { includeContent: true })
      const applicable = [...checkers.values()].filter(checker => checker.supports(inspected.version))
      const results: ArtifactCheck[] = []
      for (const checker of applicable) {
        const result = await checker.check({ version: inspected.version, bytes: inspected.bytes ?? new Uint8Array() })
        const check: ArtifactCheck = { ...result, artifactId, version, checker: checker.id, checkerVersion: checker.version, checkedAt: now() }
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
