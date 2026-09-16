import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicWriteFile, syncBuiltinLibraries, withLock } from '@tenon/kernel'
import type {
  RuntimeActivation,
  RuntimeAuditEntry,
  RuntimeInspection,
  RuntimePaths,
  RuntimeReleaseManifest,
  RuntimeReleaseSource,
  RuntimeStableReleaseTarget,
  RuntimeSelection,
} from './types.js'
import { RuntimeFailure } from './types.js'
import { compensateActivation } from './activation-compensation.js'
import {
  isExistingReleaseCollision,
  readAuditState,
  readReleaseManifest,
  readSelection,
  runtimeReleaseIdV2,
  stableJson,
  validReleaseId,
  writeAudit,
} from './release-store-codecs.js'
import {
  assertFile,
  copyReleasePayload,
  defaultRuntimeCommandRunner,
  hashReleasePayload,
  hashLegacyReleasePayload,
  inspectCandidatePayload,
  releaseCandidateVersion,
  runChecked,
  verifyReleasePayload,
  type RuntimeCommandRunner,
} from './release-payload.js'
export {
  inspectCandidatePayload,
  type CandidatePayloadIdentity,
  type RuntimeCommandRunner,
} from './release-payload.js'

export type RuntimeAuditWriter = (paths: RuntimePaths, entry: RuntimeAuditEntry) => Promise<void>

export interface RuntimeReleaseStoreOptions {
  readonly paths: RuntimePaths
  readonly now?: () => string
  readonly runner?: RuntimeCommandRunner
  /** Native setup/update inject the absolute Bash path frozen before any host mutation. */
  readonly bashPath?: string
  /** Physical identity proof captured before native mutation and replayed before every Bash spawn. */
  readonly verifyBash?: () => void
  readonly nodePath?: string
  readonly verifyNode?: () => void
  readonly retainedReleases?: number
  readonly auditWriter?: RuntimeAuditWriter
}
export class RuntimeReleaseStore {
  private readonly paths: RuntimePaths
  private readonly now: () => string
  private readonly runner: RuntimeCommandRunner
  private readonly bashPath: string
  private readonly nodePath: string
  private readonly retainedReleases: number
  private readonly auditWriter: RuntimeAuditWriter

  constructor(options: RuntimeReleaseStoreOptions) {
    this.paths = options.paths
    this.now = options.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
    const runner = options.runner ?? defaultRuntimeCommandRunner()
    this.bashPath = options.bashPath ?? 'bash'
    this.nodePath = options.nodePath ?? process.execPath
    this.runner = options.verifyBash === undefined && options.verifyNode === undefined
      ? runner
      : {
          run: async (file, args, cwd) => {
            const isBash = file === this.bashPath
            const isNode = file === this.nodePath
            const isProvenanceVerifier = isBash && args.some((arg) => arg.endsWith('verify-skills.sh'))
            // Keep the callbacks synchronous and adjacent to the runner call.  A provenance Bash
            // delegate owns both proofs; ordinary Bash owns only Bash, and direct Node owns only
            // Node.  Throwing from either callback prevents the runner (and all later mutation)
            // from being entered.
            if (isBash) {
              options.verifyBash?.()
              if (isProvenanceVerifier) options.verifyNode?.()
            } else if (isNode) {
              options.verifyNode?.()
            }
            return runner.run(file, args, cwd)
          },
        }
    this.retainedReleases = Math.max(2, options.retainedReleases ?? 3)
    this.auditWriter = options.auditWriter ?? writeAudit
  }

  async stageAndActivate(
    candidateRoot: string,
    host: RuntimeReleaseSource['host'],
    expectedPluginVersion?: string,
    stableTarget?: RuntimeStableReleaseTarget,
  ): Promise<RuntimeActivation> {
    const absoluteCandidate = resolve(candidateRoot)
    await this.prepareRoots()
    try {
      return await withLock(this.paths.stateRoot, async () =>
        this.stageAndActivateUnderLock(absoluteCandidate, host, expectedPluginVersion, stableTarget))
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error
      throw new RuntimeFailure('candidate-invalid', `无法安装候选 runtime: ${String(error)}`)
    }
  }

  async inspect(): Promise<RuntimeInspection> {
    await this.prepareRoots()
    return withLock(this.paths.stateRoot, async () => {
      const selection = await readSelection(this.paths)
      const active = selection.activeRelease === null ? null : await this.validateStoredRelease(selection.activeRelease)
      const previous = selection.previousRelease === null ? null : await this.validateStoredRelease(selection.previousRelease)
      const audit = await this.reconcilePendingAudit(selection)
      return {
        selection,
        active,
        previous,
        activeValid: selection.activeRelease === null ? false : active !== null,
        previousValid: selection.previousRelease === null ? false : previous !== null,
        lastAudit: audit.lastAudit,
        auditCorrupt: audit.auditCorrupt,
        auditPending: audit.auditPending,
      }
    })
  }

  async rollbackToPrevious(): Promise<RuntimeActivation> {
    await this.prepareRoots()
    return withLock(this.paths.stateRoot, async () => {
      const selection = await readSelection(this.paths)
      if (selection.previousRelease === null) {
        throw new RuntimeFailure('no-recovery-release', '没有可回滚的已验证 runtime release；请重新运行 tenon setup --<host>')
      }
      const manifest = await this.validateStoredRelease(selection.previousRelease)
      if (manifest === null) {
        throw new RuntimeFailure('no-recovery-release', 'previous runtime release 无法通过完整性校验；请重新运行 tenon setup --<host>')
      }
      const previousRoot = this.releaseRoot(manifest.releaseId)
      const next: RuntimeSelection = {
        version: 1,
        revision: selection.revision + 1,
        activeRelease: manifest.releaseId,
        previousRelease: selection.activeRelease,
        updatedAt: this.now(),
      }
      try {
        // Rollback changes only the verified selection. The active bootstrap is the current
        // backward-compatible security boundary and must never be downgraded to payload bytes.
        let auditPending = false
        await this.auditWriter(this.paths, {
          version: 1,
          at: this.now(),
          kind: 'rollback-prepared',
          releaseId: manifest.releaseId,
          previousRelease: selection.activeRelease,
          detail: 'verified rollback prepared; selection publication follows under the same lock',
        })
        await atomicWriteFile(this.paths.selectionPath, stableJson(next))
        await this.auditWriter(this.paths, {
          version: 1,
          at: this.now(),
          kind: 'rolled-back',
          releaseId: manifest.releaseId,
          previousRelease: selection.activeRelease,
          detail: 'verified rollback selection committed',
        }).catch(() => { auditPending = true })
        return {
          selection: next,
          release: manifest,
          releaseRoot: previousRoot,
          ...(auditPending ? { auditPending: true as const } : {}),
        }
      } catch (error) {
        await this.auditWriter(this.paths, {
          version: 1,
          at: this.now(),
          kind: 'rollback-rejected',
          releaseId: manifest.releaseId,
          previousRelease: selection.activeRelease,
          detail: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
        throw error
      }
    })
  }

  async revertActivation(activated: RuntimeSelection): Promise<void> {
    await this.prepareRoots()
    await withLock(this.paths.stateRoot, async () => {
      await compensateActivation({
        paths: this.paths,
        activated,
        current: await readSelection(this.paths),
        now: this.now,
        audit: (entry) => this.auditWriter(this.paths, entry),
        validateRelease: (releaseId) => this.validateStoredRelease(releaseId),
      })
    })
  }

  async recordUpdateFailure(detail: string): Promise<void> {
    await this.prepareRoots()
    await withLock(this.paths.stateRoot, async () => {
      await this.auditWriter(this.paths, {
        version: 1,
        at: this.now(),
        kind: 'update-rejected',
        detail,
      })
    })
  }

  private async stageAndActivateUnderLock(
    candidateRoot: string,
    host: RuntimeReleaseSource['host'],
    expectedPluginVersion?: string,
    stableTarget?: RuntimeStableReleaseTarget,
  ): Promise<RuntimeActivation> {
    const stageRoot = join(this.paths.stagingRoot, `release-${randomUUID()}`)
    const payloadRoot = join(stageRoot, 'payload')
    let releaseId: string | null = null
    try {
      await mkdir(payloadRoot, { recursive: true })
      await copyReleasePayload(candidateRoot, payloadRoot)
      await verifyReleasePayload(payloadRoot, this.runner, this.bashPath, this.nodePath)
      const payloadDigest = await hashReleasePayload(payloadRoot)
      const pluginVersion = await releaseCandidateVersion(payloadRoot)
      const currentCandidate = await inspectCandidatePayload(candidateRoot, {
        runner: this.runner,
        bashPath: this.bashPath,
        nodePath: this.nodePath,
      })
      if (currentCandidate.pluginVersion !== pluginVersion
        || currentCandidate.payloadDigest !== payloadDigest) {
        throw new RuntimeFailure(
          'candidate-invalid',
          '候选 payload 在 staging 后发生漂移；拒绝发布混合身份 runtime',
        )
      }
      if (expectedPluginVersion !== undefined && pluginVersion !== expectedPluginVersion) {
        throw new RuntimeFailure(
          'candidate-invalid',
          `候选 plugin version ${pluginVersion} 与冻结目标 ${expectedPluginVersion} 不一致`,
        )
      }
      const source: RuntimeReleaseSource = { host, pluginVersion }
      if (stableTarget !== undefined && stableTarget.version !== pluginVersion) {
        throw new RuntimeFailure(
          'candidate-invalid',
          `候选 plugin version ${pluginVersion} 与 stable target ${stableTarget.version} 不一致`,
        )
      }
      releaseId = runtimeReleaseIdV2(payloadDigest, source, stableTarget)
      const manifest: RuntimeReleaseManifest = {
        version: 2,
        releaseId,
        payloadDigest,
        createdAt: this.now(),
        source,
        ...(stableTarget === undefined ? {} : { stableTarget }),
      }
      await atomicWriteFile(join(stageRoot, 'release.json'), stableJson(manifest))

      const finalRoot = this.releaseRoot(releaseId)
      let effectiveManifest: RuntimeReleaseManifest = manifest
      try {
        await rename(stageRoot, finalRoot)
      } catch (error) {
        if (!isExistingReleaseCollision(error)) throw error
        const existing = await this.validateStoredRelease(releaseId)
        if (existing === null) throw new RuntimeFailure('runtime-corrupt', `现有 release 无法验证: ${releaseId}`)
        effectiveManifest = existing
      }

      const selection = await readSelection(this.paths)
      const next: RuntimeSelection = {
        version: 1,
        revision: selection.revision + 1,
        activeRelease: releaseId,
        previousRelease: selection.activeRelease === releaseId ? selection.previousRelease : selection.activeRelease,
        updatedAt: this.now(),
      }
      // Write-ahead audit: do not return an activation failure after selection already changed.
      await this.auditWriter(this.paths, {
        version: 1,
        at: this.now(),
        kind: 'activation-prepared',
        releaseId,
        previousRelease: selection.activeRelease,
        detail: `verified ${host} candidate activation prepared; publication follows under the same lock`,
      })
      await this.installBootstrap(finalRoot)
      await atomicWriteFile(this.paths.selectionPath, stableJson(next))
      let auditPending = false
      await this.auditWriter(this.paths, {
        version: 1,
        at: this.now(),
        kind: 'activated',
        releaseId,
        previousRelease: selection.activeRelease,
        detail: `verified ${host} candidate selection committed`,
      }).catch(() => { auditPending = true })
      // Retention and builtin library sync are post-commit housekeeping. A pruning/audit/sync problem
      // must not turn a successful activation into a reported failure after the canonical selection
      // has already changed; a failed sync is retried by the next dashboard start or library read.
      await syncBuiltinLibraries(join(finalRoot, 'payload'), this.paths.configRoot).catch(() => [])
      await this.prune(next).catch(() => {})
      return {
        selection: next,
        release: effectiveManifest,
        releaseRoot: finalRoot,
        ...(auditPending ? { auditPending: true as const } : {}),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await this.auditWriter(this.paths, {
        version: 1,
        at: this.now(),
        kind: 'activation-rejected',
        ...(releaseId === null ? {} : { releaseId }),
        detail,
      }).catch(() => {})
      throw error
    } finally {
      await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async prepareRoots(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.dataRoot, { recursive: true }),
      mkdir(this.paths.stateRoot, { recursive: true }),
      mkdir(this.paths.configRoot, { recursive: true }),
      mkdir(this.paths.releasesRoot, { recursive: true }),
      mkdir(this.paths.stagingRoot, { recursive: true }),
      mkdir(this.paths.bootstrapRoot, { recursive: true }),
    ])
  }

  private async reconcilePendingAudit(selection: RuntimeSelection): Promise<{
    readonly lastAudit: RuntimeAuditEntry | null
    readonly auditCorrupt: boolean
    readonly auditPending: boolean
  }> {
    const audit = await readAuditState(this.paths)
    const prepared = audit.lastAudit
    if (audit.auditCorrupt || prepared === null
      || (prepared.kind !== 'activation-prepared' && prepared.kind !== 'rollback-prepared')) {
      return { ...audit, auditPending: false }
    }
    const committed = prepared.releaseId !== undefined
      && selection.activeRelease === prepared.releaseId
      && (prepared.kind !== 'rollback-prepared'
        || selection.previousRelease === (prepared.previousRelease ?? null))
    if (!committed) return { ...audit, auditPending: true }
    const terminal: RuntimeAuditEntry = {
      version: 1,
      at: this.now(),
      kind: prepared.kind === 'activation-prepared' ? 'activated' : 'rolled-back',
      releaseId: prepared.releaseId,
      ...(prepared.previousRelease === undefined ? {} : { previousRelease: prepared.previousRelease }),
      detail: prepared.kind === 'activation-prepared'
        ? 'recovered terminal audit for committed verified activation'
        : 'recovered terminal audit for committed verified rollback',
    }
    try {
      await this.auditWriter(this.paths, terminal)
      return { lastAudit: terminal, auditCorrupt: false, auditPending: false }
    } catch {
      return { ...audit, auditPending: true }
    }
  }

  private releaseRoot(releaseId: string): string {
    if (!validReleaseId(releaseId)) throw new RuntimeFailure('runtime-corrupt', `非法 runtime release id: ${releaseId}`)
    return join(this.paths.releasesRoot, releaseId)
  }

  private async validateStoredRelease(releaseId: string): Promise<RuntimeReleaseManifest | null> {
    if (!validReleaseId(releaseId)) return null
    const root = this.releaseRoot(releaseId)
    const manifest = await readReleaseManifest(root)
    if (manifest === null || manifest.releaseId !== releaseId) return null
    const payloadRoot = join(root, 'payload')
    try {
      const digest = manifest.version === 1
        ? await hashLegacyReleasePayload(payloadRoot)
        : await hashReleasePayload(payloadRoot)
      if (digest !== manifest.payloadDigest) return null
      await verifyReleasePayload(payloadRoot, this.runner, this.bashPath, this.nodePath)
      return manifest
    } catch {
      return null
    }
  }

  private async installBootstrap(releaseRoot: string): Promise<void> {
    const source = join(releaseRoot, 'payload', 'runtime', 'tenon-bootstrap.mjs')
    await assertFile(source, 'runtime bootstrap')
    await runChecked(this.runner, this.nodePath, ['--check', source], releaseRoot, 'runtime bootstrap syntax')
    const active = join(this.paths.bootstrapRoot, 'active.mjs')
    const previous = join(this.paths.bootstrapRoot, 'previous.mjs')
    try {
      await stat(active)
      await atomicWriteFile(previous, await readFile(active, 'utf8'))
      await chmod(previous, 0o755)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await atomicWriteFile(active, await readFile(source, 'utf8'))
    await chmod(active, 0o755)
  }

  private async prune(selection: RuntimeSelection): Promise<void> {
    const protectedIds = new Set([selection.activeRelease, selection.previousRelease].filter((value): value is string => value !== null))
    const entries = await readdir(this.paths.releasesRoot, { withFileTypes: true })
    const candidates: Array<{ id: string; modifiedAt: number }> = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !validReleaseId(entry.name) || protectedIds.has(entry.name)) continue
      try {
        candidates.push({ id: entry.name, modifiedAt: (await stat(join(this.paths.releasesRoot, entry.name))).mtimeMs })
      } catch {
        // A concurrently removed unprotected release is already absent.
      }
    }
    candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
    const keep = Math.max(0, this.retainedReleases - protectedIds.size)
    for (const candidate of candidates.slice(keep)) {
      await rm(this.releaseRoot(candidate.id), { recursive: true, force: true })
      await this.auditWriter(this.paths, {
        version: 1,
        at: this.now(),
        kind: 'pruned',
        releaseId: candidate.id,
        detail: 'unprotected verified release exceeded retention limit',
      })
    }
  }
}
