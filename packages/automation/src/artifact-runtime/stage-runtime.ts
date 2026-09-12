import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ArtifactAttempt, ArtifactContent, ArtifactVersion } from '@tenon/kernel'

/** Minimal structural port implemented by the durable artifact service. */
export interface ArtifactServicePort {
  beginAttempt(input: { workflowRunId: string; stageId: string; stageAttemptId: string; dependencyStages?: readonly string[]; visibility?: 'dependency-chain' | 'run' | 'project' }): Promise<ArtifactAttempt>
  observe(stageAttemptId: string, content: ArtifactContent): Promise<unknown>
  publish(stageAttemptId: string, input: { artifactId?: string; path: string; disposition?: 'candidate' | 'deliverable' | 'intermediate' }): Promise<ArtifactVersion>
  endAttempt(stageAttemptId: string, status: 'completed' | 'failed' | 'cancelled'): Promise<unknown>
  delete?(stageAttemptId: string, artifactId: string, path?: string): Promise<unknown>
}

export interface StageRuntimeOptions {
  readonly service: ArtifactServicePort
  readonly rootDir: string
  readonly workflowRunId: string
  readonly stageId: string
  readonly stageAttemptId: string
  readonly dependencyStages?: readonly string[]
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
  private baseline = new Map<string, string>()
  private readonly artifactIdsByPath = new Map<string, string>()

  private constructor(options: StageRuntimeOptions) {
    this.service = options.service
    this.rootDir = path.resolve(options.rootDir)
    this.stageAttemptId = options.stageAttemptId
  }

  static async open(options: StageRuntimeOptions): Promise<StageArtifactRuntime> {
    const runtime = new StageArtifactRuntime(options)
    runtime.baseline = await runtime.snapshot()
    await options.service.beginAttempt({ workflowRunId: options.workflowRunId, stageId: options.stageId, stageAttemptId: options.stageAttemptId, dependencyStages: options.dependencyStages ?? [], visibility: 'dependency-chain' })
    return runtime
  }

  /** Reconcile all files under the scoped root. Unknown writers remain unknown. */
  async reconcile(): Promise<readonly ArtifactChange[]> {
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
      const version = await this.service.observe(this.stageAttemptId, { source: { path: change.path }, data: bytes, mediaType: mediaTypeFor(change.path), origin: 'unknown' })
      if (version !== null && typeof version === 'object' && 'artifactId' in version) this.artifactIdsByPath.set(change.path, String((version as { artifactId: string }).artifactId))
    }
    this.baseline = next
    return Object.freeze(changes)
  }

  async publish(relativePath: string, disposition: 'candidate' | 'deliverable' | 'intermediate' = 'candidate'): Promise<ArtifactVersion> {
    const relative = this.safeRelative(relativePath)
    return this.service.publish(this.stageAttemptId, { path: relative, disposition })
  }

  async end(status: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    await this.reconcile()
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
    return normalized
  }

  private async snapshot(): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.tenon-artifacts' || entry.name === '.pipeline-artifacts' || entry.name === '.git') continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(absolute)
        else if (entry.isFile()) {
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
