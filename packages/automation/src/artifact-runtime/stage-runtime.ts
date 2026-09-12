import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ArtifactAttempt, ArtifactCatalog, ArtifactContent, ArtifactEvent, ArtifactPolicy, ArtifactVersion } from '@tenon/kernel'
import type { ArtifactInspection } from '../artifacts/service.js'

/** Minimal structural port implemented by the durable artifact service. */
export interface ArtifactServicePort {
  beginAttempt(input: { workflowRunId: string; stageId: string; stageAttemptId: string; dependencyStages?: readonly string[]; visibility?: 'dependency-chain' | 'run' | 'project' }): Promise<ArtifactAttempt>
  observe(stageAttemptId: string, content: ArtifactContent & { readonly observationSource?: 'managed-tool' | 'explicit-publish' | 'reconcile' | 'external'; readonly toolCallId?: string }): Promise<unknown>
  submitArtifactOutput?(stageAttemptId: string, input: ArtifactContent & { readonly path?: string; readonly logicalKey?: string; readonly declarationStatus?: 'declared' | 'observed' | 'reconciled' | 'undeclared-candidate'; readonly publish?: boolean; readonly disposition?: 'candidate' | 'deliverable' | 'intermediate'; readonly observationSource?: 'managed-tool' | 'explicit-publish' | 'reconcile' | 'external' }): Promise<ArtifactVersion>
  publish(stageAttemptId: string, input: { artifactId?: string; version?: string; path: string; disposition?: 'candidate' | 'deliverable' | 'intermediate' }): Promise<ArtifactVersion>
  endAttempt(stageAttemptId: string, status: 'completed' | 'failed' | 'cancelled'): Promise<unknown>
  delete?(stageAttemptId: string, artifactId: string, path?: string): Promise<unknown>
  catalog?(stageAttemptId: string, policy?: { readonly includeCandidates?: boolean; readonly includeHistory?: boolean; readonly maxEntries?: number; readonly pinned?: boolean; readonly cursor?: string }): Promise<ArtifactCatalog>
  inspect?(artifactId: string, version: string, options?: { readonly includeContent?: boolean; readonly maxBytes?: number }): Promise<ArtifactInspection>
  read?(stageAttemptId: string, artifactId: string, version: string, options?: { readonly representation?: 'metadata' | 'structure' | 'summary' | 'content'; readonly consumer?: 'execution' | 'ui'; readonly maxBytes?: number }): Promise<ArtifactInspection>
  events?(after?: number, limit?: number): Promise<readonly ArtifactEvent[]>
  runChecks?(artifactId: string, version: string): Promise<unknown>
}

export interface StageRuntimeOptions {
  readonly service: ArtifactServicePort
  readonly rootDir: string
  readonly workflowRunId: string
  readonly stageId: string
  readonly stageAttemptId: string
  readonly dependencyStages?: readonly string[]
  /** Optional skill/actor identity attached to newly created versions. */
  readonly skillId?: string
  readonly actorId?: string
  /** Directory names that are runtime/system state rather than user artifacts. */
  readonly ignoredDirectories?: readonly string[]
}

export interface ArtifactChange { readonly path: string; readonly kind: 'created' | 'changed' | 'deleted'; readonly digest?: string }

/**
 * Runtime adapter for arbitrary skills. It observes bytes at stage boundaries and
 * never treats skill loading or a successful process exit as publication.
 */
export class StageArtifactRuntime {
  private readonly service: ArtifactServicePort
  private readonly rootDir: string
  private readonly stageAttemptId: string
  private readonly workflowRunId: string
  private readonly skillId?: string
  private readonly actorId?: string
  private readonly ignoredDirectories: ReadonlySet<string>
  private baseline = new Map<string, string>()
  private readonly artifactIdsByPath = new Map<string, string>()
  private readonly observedDigestsByPath = new Map<string, string>()
  private readonly observedVersionsByPath = new Map<string, ArtifactVersion>()
  private readonly pinnedVersions = new Map<string, string>()
  private reconcileInFlight?: Promise<readonly ArtifactChange[]>

  private constructor(options: StageRuntimeOptions) {
    this.service = options.service
    this.rootDir = path.resolve(options.rootDir)
    this.stageAttemptId = options.stageAttemptId
    this.workflowRunId = options.workflowRunId
    this.skillId = options.skillId
    this.actorId = options.actorId
    this.ignoredDirectories = new Set(['.git', '.pipeline-artifacts', '.tenon-artifacts', '.orchestration-v2', ...(options.ignoredDirectories ?? [])])
  }

  static async open(options: StageRuntimeOptions): Promise<StageArtifactRuntime> {
    const runtime = new StageArtifactRuntime(options)
    runtime.baseline = await runtime.snapshot()
    await options.service.beginAttempt({ workflowRunId: options.workflowRunId, stageId: options.stageId, stageAttemptId: options.stageAttemptId, dependencyStages: options.dependencyStages ?? [], visibility: 'dependency-chain' })
    if (options.service.catalog) {
      const initial = await options.service.catalog(options.stageAttemptId, { includeCandidates: false, includeHistory: false, maxEntries: 1000, pinned: true })
      for (const entry of initial.entries) runtime.pinnedVersions.set(entry.artifactId, entry.version)
    }
    return runtime
  }

  /** Reconcile all files under the scoped root. Unknown writers remain unknown. */
  async reconcile(): Promise<readonly ArtifactChange[]> {
    if (this.reconcileInFlight !== undefined) return this.reconcileInFlight
    const operation = this.reconcileNow()
    this.reconcileInFlight = operation
    try { return await operation } finally { if (this.reconcileInFlight === operation) this.reconcileInFlight = undefined }
  }

  private async reconcileNow(): Promise<readonly ArtifactChange[]> {
    const next = await this.snapshot()
    const changes: ArtifactChange[] = []
    for (const [relative, digest] of next) {
      const previous = this.baseline.get(relative)
      if (previous === undefined) changes.push({ path: relative, kind: 'created', digest })
      else if (previous !== digest) changes.push({ path: relative, kind: 'changed', digest })
    }
    for (const relative of this.baseline.keys()) if (!next.has(relative)) changes.push({ path: relative, kind: 'deleted' })
    for (const change of changes) {
      if (change.kind === 'deleted') {
        const artifactId = this.artifactIdsByPath.get(change.path)
        if (artifactId !== undefined && this.service.delete !== undefined) await this.service.delete(this.stageAttemptId, artifactId, change.path)
        continue
      }
      const absolute = this.resolve(change.path)
      const bytes = await readFile(absolute)
      const version = await this.service.observe(this.stageAttemptId, {
        source: { path: change.path },
        data: bytes,
        mediaType: mediaTypeFor(change.path),
        origin: 'unknown',
        observationSource: 'reconcile',
      })
      this.observedDigestsByPath.set(change.path, change.digest ?? digest(bytes))
      if (version !== null && typeof version === 'object' && 'artifactId' in version) this.observedVersionsByPath.set(change.path, version as ArtifactVersion)
      if (version !== null && typeof version === 'object' && 'artifactId' in version) this.artifactIdsByPath.set(change.path, String((version as { artifactId: string }).artifactId))
    }
    this.baseline = next
    return Object.freeze(changes)
  }

  async publish(relativePath: string, disposition: 'candidate' | 'deliverable' | 'intermediate' = 'candidate'): Promise<ArtifactVersion> {
    const relative = this.safeRelative(relativePath)
    // A skill may explicitly publish a pre-existing file without modifying it
    // during this attempt. Observe/adopt the exact bytes first so the durable
    // service can attach an observation receipt for this attempt. The digest
    // guard keeps repeated publish calls idempotent and avoids duplicate events.
    const absolute = this.resolve(relative)
    const bytes = await readFile(absolute)
    const currentDigest = digest(bytes)
    const prior = this.observedVersionsByPath.get(relative)
    const needsManagedObservation = prior === undefined || prior.contentDigest !== currentDigest || prior.origin !== 'stage' || prior.producer?.stageAttemptId !== this.stageAttemptId
    if (needsManagedObservation) {
      const observed = await this.service.observe(this.stageAttemptId, {
        source: { path: relative },
        data: bytes,
        mediaType: mediaTypeFor(relative),
        origin: 'stage',
        producer: {
          workflowRunId: this.workflowRunId,
          stageAttemptId: this.stageAttemptId,
          ...(this.skillId ? { skillId: this.skillId } : {}),
          ...(this.actorId ? { actorId: this.actorId } : {}),
        },
        observationSource: 'explicit-publish',
      })
      this.observedDigestsByPath.set(relative, currentDigest)
      if (observed !== null && typeof observed === 'object' && 'artifactId' in observed) { this.artifactIdsByPath.set(relative, String((observed as { artifactId: string }).artifactId)); this.observedVersionsByPath.set(relative, observed as ArtifactVersion) }
    }
    const observed = this.observedVersionsByPath.get(relative)
    return this.service.publish(this.stageAttemptId, { path: relative, ...(observed ? { artifactId: observed.artifactId, version: observed.version } : {}), disposition })
  }

  /** Submit an executor-declared output through the host-owned boundary. */
  async submit(relativePath: string, disposition: 'candidate' | 'deliverable' | 'intermediate' = 'deliverable', logicalKey?: string): Promise<ArtifactVersion> {
    const relative = this.safeRelative(relativePath)
    if (this.service.submitArtifactOutput === undefined) return this.publish(relative, disposition)
    const bytes = await readFile(this.resolve(relative))
    const version = await this.service.submitArtifactOutput(this.stageAttemptId, {
      data: bytes,
      path: relative,
      mediaType: mediaTypeFor(relative),
      kind: mediaTypeFor(relative).includes('json') ? 'json' : mediaTypeFor(relative).startsWith('text/') ? 'text' : 'file',
      origin: 'stage',
      producer: { workflowRunId: this.workflowRunId, stageAttemptId: this.stageAttemptId, ...(this.skillId ? { skillId: this.skillId } : {}), ...(this.actorId ? { actorId: this.actorId } : {}) },
      logicalKey,
      declarationStatus: 'declared',
      publish: disposition === 'deliverable',
      disposition,
      observationSource: 'explicit-publish',
    })
    this.observedVersionsByPath.set(relative, version)
    this.observedDigestsByPath.set(relative, digest(bytes))
    this.artifactIdsByPath.set(relative, version.artifactId)
    return version
  }

  async observePath(relativePath: string, options: { readonly source?: 'managed-tool' | 'explicit-publish'; readonly toolCallId?: string } = {}): Promise<ArtifactVersion> {
    const relative = this.safeRelative(relativePath); const bytes = await readFile(this.resolve(relative))
    const value = await this.service.observe(this.stageAttemptId, { source: { path: relative }, data: bytes, mediaType: mediaTypeFor(relative), origin: 'stage', producer: { workflowRunId: this.workflowRunId, stageAttemptId: this.stageAttemptId, ...(this.skillId ? { skillId: this.skillId } : {}), ...(this.actorId ? { actorId: this.actorId } : {}) }, observationSource: options.source ?? 'managed-tool', ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}) })
    const version = value as ArtifactVersion; this.observedDigestsByPath.set(relative, digest(bytes)); this.observedVersionsByPath.set(relative, version); this.artifactIdsByPath.set(relative, version.artifactId); return version
  }

  async catalog(policy: ArtifactPolicy = {}): Promise<ArtifactCatalog> { if (!this.service.catalog) throw new Error('artifact catalog unavailable'); return this.service.catalog(this.stageAttemptId, policy.maxEntries === undefined ? { ...policy, maxEntries: 100 } : policy) }
  async inspect(artifactId: string, version: string, options: { readonly includeContent?: boolean; readonly maxBytes?: number } = {}): Promise<ArtifactInspection> { if (!this.service.inspect) throw new Error('artifact inspect unavailable'); return this.service.inspect(artifactId, version, options) }
  async read(artifactId: string, version: string, options: { readonly representation?: 'metadata'|'structure'|'summary'|'content'; readonly maxBytes?: number } = {}): Promise<ArtifactInspection> { if (!this.service.read) throw new Error('artifact read unavailable'); return this.service.read(this.stageAttemptId, artifactId, version, { ...options, consumer: 'execution' }) }
  async consume(ref: string, version?: string, options: { readonly representation?: 'metadata'|'structure'|'summary'|'content'; readonly maxBytes?: number } = {}): Promise<ArtifactInspection> {
    const catalog = await this.catalog({ includeCandidates: true, includeHistory: true, maxEntries: 1000 }); const entries = [...(catalog.history ?? catalog.entries)]
    const match = entries.find(entry => entry.artifactId === ref || entry.contentUri === ref || entry.source?.path === ref || entry.source?.ref === ref)
    if (!match) throw new Error(`artifact reference not found: ${ref}`)
    const selected = version ?? this.pinnedVersions.get(match.artifactId) ?? match.version
    return this.read(match.artifactId, selected, options)
  }
  async events(after = 0, limit = 100): Promise<readonly ArtifactEvent[]> { if (!this.service.events) throw new Error('artifact events unavailable'); return this.service.events(after, limit) }

  async end(status: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    await this.reconcile()
    if (this.service.runChecks !== undefined) {
      for (const version of this.observedVersionsByPath.values()) await this.service.runChecks(version.artifactId, version.version)
    }
    await this.service.endAttempt(this.stageAttemptId, status)
  }

  private resolve(relative: string): string {
    const absolute = path.resolve(this.rootDir, relative)
    if (absolute !== this.rootDir && !absolute.startsWith(`${this.rootDir}${path.sep}`)) throw new Error(`artifact path escapes root: ${relative}`)
    return absolute
  }

  private safeRelative(relative: string): string {
    const normalized = path.relative(this.rootDir, this.resolve(relative))
    if (!normalized || normalized.startsWith('..')) throw new Error(`invalid artifact path: ${relative}`)
    if (this.isIgnored(normalized)) throw new Error(`ignored artifact path: ${relative}`)
    return normalized
  }

  private isIgnored(relative: string): boolean {
    return relative.split(path.sep).some(segment => this.ignoredDirectories.has(segment))
  }

  private async snapshot(): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (this.ignoredDirectories.has(entry.name)) continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(absolute)
        else if (entry.isFile() && !this.isIgnored(path.relative(this.rootDir, absolute))) {
          const bytes = await readFile(absolute)
          result.set(path.relative(this.rootDir, absolute), createHash('sha256').update(bytes).digest('hex'))
        }
      }
    }
    try { await stat(this.rootDir); await walk(this.rootDir) } catch { /* missing scope is an empty baseline */ }
    return result
  }
}

function mediaTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.json') return 'application/json'
  if (ext === '.md' || ext === '.markdown') return 'text/markdown'
  if (ext === '.txt' || ext === '.log') return 'text/plain'
  if (ext === '.html' || ext === '.htm') return 'text/html'
  return 'application/octet-stream'
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
