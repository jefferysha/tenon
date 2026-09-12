import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArtifactScopeMigrationError, openArtifactService } from './service.js'
import { artifactSubjectId } from '@tenon/kernel'
import { artifactNamespaceForChange } from '../submission/namespace.js'
import { recordArtifactSubjectProjection } from '../submission/registry.js'
import { StageArtifactRuntime } from '../artifact-runtime/stage-runtime.js'
import { openArtifactSubmissionService } from '../submission/service.js'

describe('runtime artifact service', () => {
  it('retains immutable versions, deduplicates bytes and records execution reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    const svc = await openArtifactService({ rootDir: root, scopeId: 'run-1', now: () => '2026-01-01T00:00:00.000Z' })
    await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-1' })
    await svc.observe('build-1', { path: 'report.md', data: 'one', mediaType: 'text/markdown' })
    const first = await svc.publish('build-1', { path: 'report.md' })
    await svc.observe('build-1', { path: 'report.md', data: 'one', mediaType: 'text/markdown' })
    await svc.observe('build-1', { path: 'report.md', data: 'two', mediaType: 'text/markdown' })
    const second = await svc.publish('build-1', { path: 'report.md' })
    expect(first.version).toBe('v1'); expect(second.version).toBe('v2')
    await svc.beginAttempt({ workflowRunId: 'w', stageId: 'verify', stageAttemptId: 'verify-1', dependencyStages: ['build'] })
    const catalog = await svc.catalog('verify-1')
    expect(catalog.entries.map(x => x.version)).toEqual(['v2'])
    const read = await svc.read('verify-1', first.artifactId, first.version, { consumer: 'execution' })
    expect(new TextDecoder().decode(read.bytes)).toBe('one')
    expect((await svc.read('verify-1', first.artifactId, first.version, { consumer: 'ui' })).bytes).toBeDefined()
    expect((await svc.events()).filter(e => e.type === 'artifact.consumed')).toHaveLength(1)
    await svc.beginAttempt({ workflowRunId: 'w', stageId: 'unrelated', stageAttemptId: 'unrelated-1' })
    await expect(svc.read('unrelated-1', first.artifactId, first.version, { consumer: 'execution' })).rejects.toThrow('not visible')
    const metadata = await svc.read('verify-1', first.artifactId, first.version, { consumer: 'execution', representation: 'metadata' })
    expect(metadata.bytes).toBeUndefined()
    await svc.endAttempt('verify-1', 'completed')
    const impacted = await svc.catalog('verify-1', { includeHistory: true })
    expect(impacted.history?.some(entry => entry.version === 'v1' && entry.affected)).toBe(true)
  })

  it('changes the catalog digest when version metadata changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    try {
      const svc = await openArtifactService({ rootDir: root, scopeId: 'scope' })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-1' })
      const version = await svc.observe('build-1', { path: 'report.txt', data: 'same', mediaType: 'text/plain' })
      const candidate = await svc.catalog('build-1', { includeCandidates: true })
      await svc.publish('build-1', { artifactId: version.artifactId, disposition: 'deliverable' })
      const deliverable = await svc.catalog('build-1')
      expect(deliverable.digest).not.toBe(candidate.digest)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adopts an unknown reconciliation version when an explicit stage publish follows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    try {
      const svc = await openArtifactService({ rootDir: root, scopeId: 'scope' })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-1' })
      const discovered = await svc.observe('build-1', { path: 'report.txt', data: 'same', mediaType: 'text/plain', origin: 'unknown', observationSource: 'reconcile' })
      const adopted = await svc.observe('build-1', { path: 'report.txt', data: 'same', mediaType: 'text/plain', origin: 'stage', producer: { workflowRunId: 'w', stageAttemptId: 'build-1', skillId: 'skill-a', actorId: 'worker-1' }, observationSource: 'explicit-publish' })
      expect(adopted.version).toBe(discovered.version)
      expect(adopted.origin).toBe('stage')
      expect(adopted.producer?.skillId).toBe('skill-a')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('paginates catalog entries with a stable cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    try {
      const svc = await openArtifactService({ rootDir: root, scopeId: 'scope' })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-1' })
      for (const name of ['a.txt', 'b.txt', 'c.txt']) {
        const value = await svc.observe('build-1', { path: name, data: name, mediaType: 'text/plain' })
        await svc.publish('build-1', { artifactId: value.artifactId })
      }
      const first = await svc.catalog('build-1', { maxEntries: 2 })
      expect(first.entries).toHaveLength(2)
      expect(first.totalEntries).toBe(3)
      expect(first.truncated).toBe(true)
      const second = await svc.catalog('build-1', { maxEntries: 2, cursor: first.nextCursor })
      expect(second.entries).toHaveLength(1)
      expect(second.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is durable across service instances and rejects path escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    const svc = await openArtifactService({ rootDir: root, scopeId: 'scope' })
    await svc.beginAttempt({ workflowRunId: 'w', stageId: 's', stageAttemptId: 'a' })
    await expect(svc.observe('a', { path: '../outside', mediaType: 'text/plain' })).rejects.toThrow()
    await svc.observe('a', { artifactId: 'fixed', data: new Uint8Array([1, 2]), mediaType: 'application/octet-stream' })
    const again = await openArtifactService({ rootDir: root, scopeId: 'scope' })
    expect((await again.events()).length).toBeGreaterThan(0)
    const state = JSON.parse(await readFile(join(root, '.pipeline-artifacts', 'scope', 'state.json'), 'utf8')) as { artifacts: unknown[] }
    expect(state.artifacts).toHaveLength(1)
    await writeFile(join(root, 'outside'), 'x')
  })

  it('scopes dependency catalogs and runs registered checkers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    const svc = await openArtifactService({ rootDir: root, scopeId: 'scope' })
    await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-1' })
    const build = await svc.observe('build-1', { path: 'build.txt', data: 'ok', mediaType: 'text/plain' })
    await svc.publish('build-1', { artifactId: build.artifactId })
    await svc.beginAttempt({ workflowRunId: 'w', stageId: 'other', stageAttemptId: 'other-1' })
    await svc.observe('other-1', { path: 'other.txt', data: 'x', mediaType: 'text/plain' })
    const hidden = await svc.catalog('other-1')
    expect(hidden.entries).toHaveLength(0)
    await svc.beginAttempt({ workflowRunId: 'w', stageId: 'verify', stageAttemptId: 'verify-1', dependencyStages: ['build'] })
    expect((await svc.catalog('verify-1')).entries.map(x => x.artifactId)).toEqual([build.artifactId])
    const dispose = svc.registerChecker({ id: 'text-check', version: '1', supports: v => v.mediaType === 'text/plain', check: () => ({ status: 'passed' }) })
    const checks = await svc.runChecks(build.artifactId, build.version)
    expect(checks[0]?.status).toBe('passed')
    dispose()
    await expect(svc.publish('verify-1', { artifactId: build.artifactId })).rejects.toThrow('observed by this attempt')
    await rm(root, { recursive: true, force: true })
  })

  it('persists initial pins and distinguishes pending updates from affected updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    try {
      const svc = await openArtifactService({ rootDir: root, scopeId: 'scope' })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-1' })
      const v1 = await svc.observe('build-1', { path: 'contract.txt', data: 'v1', mediaType: 'text/plain' })
      await svc.publish('build-1', { artifactId: v1.artifactId })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'verify', stageAttemptId: 'verify-1', dependencyStages: ['build'] })
      await svc.read('verify-1', v1.artifactId, v1.version, { consumer: 'execution', representation: 'metadata' })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-2' })
      const v2 = await svc.observe('build-2', { path: 'contract.txt', data: 'v2', mediaType: 'text/plain' })
      await svc.publish('build-2', { artifactId: v2.artifactId })
      const pinned = await svc.catalog('verify-1', { pinned: true, includeHistory: true })
      expect(pinned.entries.map(entry => entry.version)).toEqual(['v1'])
      const running = await svc.catalog('verify-1', { includeHistory: true })
      expect(running.history?.find(entry => entry.version === 'v1')?.pendingUpdate).toBe(true)
      expect(running.history?.find(entry => entry.version === 'v1')?.affected).toBe(false)
      await svc.endAttempt('verify-1', 'completed')
      const finished = await svc.catalog('verify-1', { includeHistory: true })
      expect(finished.history?.find(entry => entry.version === 'v1')?.affected).toBe(true)
      expect(finished.history?.find(entry => entry.version === 'v1')?.pendingUpdate).toBe(false)
      const restarted = await openArtifactService({ rootDir: root, scopeId: 'scope' })
      expect((await restarted.catalog('verify-1', { pinned: true, includeHistory: true })).entries.map(entry => entry.version)).toEqual(['v1'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses stable subject identity and keeps reconcile-only files out of deliverables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    try {
      const svc = await openArtifactService({ rootDir: root, scopeId: 'scope' })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-1' })
      const declared = await svc.submitArtifactOutput('build-1', { logicalKey: 'contract', path: 'docs/contract.md', data: '# contract', mediaType: 'text/markdown', disposition: 'deliverable' })
      expect(declared.subjectRef?.subject_id).toMatch(/^subject:scope:[a-f0-9]{32}$/)
      expect(declared.artifactId).not.toMatch(/^artifact:[a-f0-9]{24}$/)
      await svc.observe('build-1', { path: 'tmp/debug.log', data: 'debug', mediaType: 'text/plain', observationSource: 'reconcile', origin: 'unknown' })
      expect((await svc.catalog('build-1')).entries.map(entry => entry.source?.path)).toEqual(['docs/contract.md'])
      expect((await svc.catalog('build-1', { includeCandidates: true })).entries.some(entry => entry.source?.path === 'tmp/debug.log' && entry.disposition === 'intermediate')).toBe(true)
      const renamed = await svc.rename('build-1', declared.artifactId, 'docs/renamed.md')
      expect(renamed?.subjectRef?.subject_id).toBe(declared.subjectRef?.subject_id)
      expect(renamed?.contentDigest).toBe(declared.contentDigest)
      expect(renamed?.source?.path).toBe('docs/renamed.md')
      const restarted = await openArtifactService({ rootDir: root, scopeId: 'scope' })
      const afterRestart = await restarted.inspect(declared.artifactId, declared.version)
      expect(afterRestart.version.subjectRef?.subject_id).toBe(declared.subjectRef?.subject_id)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('migrates a legacy path-hash record once and keeps the old id readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    try {
      const legacyId = 'artifact:' + 'a'.repeat(24)
      const digest = 'b'.repeat(64)
      await mkdir(join(root, '.pipeline-artifacts', 'scope'), { recursive: true })
      await writeFile(join(root, '.pipeline-artifacts', 'scope', 'state.json'), JSON.stringify({
        version: 1, revision: 0,
        attempts: [], events: [], reads: [], checks: [], subjectMappings: [], migrationReceipts: [],
        artifacts: [{ artifactId: legacyId, currentVersion: 'v1', displayName: 'docs/legacy.md', versions: [{ artifactId: legacyId, version: 'v1', contentDigest: digest, size: 1, mediaType: 'text/markdown', kind: 'text', origin: 'stage', source: { path: 'docs/legacy.md' }, contentUri: `artifact://scope/${digest}`, disposition: 'deliverable', quality: 'unchecked', createdAt: '2026-01-01T00:00:00.000Z' }] }],
      }, null, 2))
      const svc = await openArtifactService({ rootDir: root, scopeId: 'scope' })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'verify', stageAttemptId: 'verify-1' })
      const migrated = await svc.inspect(legacyId, 'v1')
      expect(migrated.version.artifactId).toMatch(/^subject:scope:/)
      expect(migrated.version.subjectRef?.subject_id).toBe(migrated.version.artifactId)
      const state = JSON.parse(await readFile(join(root, '.pipeline-artifacts', 'scope', 'state.json'), 'utf8')) as { migrationReceipts: unknown[] }
      expect(state.migrationReceipts).toHaveLength(1)
      const restarted = await openArtifactService({ rootDir: root, scopeId: 'scope' })
      expect((await restarted.inspect(legacyId, 'v1')).version.artifactId).toBe(migrated.version.artifactId)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses the production runtime path to converge with a field-first canonical subject', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-production-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'design.md'), '# design\n')
      const namespace = artifactNamespaceForChange(root)
      const subjectRef = { subject_id: artifactSubjectId(namespace, 'field:design_doc'), namespace, version: 'v1', projection: 'field' as const, content_digest: `sha256:${'a'.repeat(64)}`, source: { path: 'docs/design.md', field: 'design_doc' } }
      await recordArtifactSubjectProjection(root, { subjectRef, logicalKey: 'field:design_doc', projection: 'field', path: 'docs/design.md', field: 'design_doc', status: 'committed', receiptId: 'field-first', recordedAt: new Date().toISOString() })
      const service = await openArtifactService({ rootDir: root, scopeId: namespace })
      const runtime = await StageArtifactRuntime.open({ service, rootDir: root, workflowRunId: 'run-1', stageId: 'build', stageAttemptId: 'build-1' })
      const output = await runtime.submit('docs/design.md', 'deliverable')
      expect(output.subjectRef?.subject_id).toBe(subjectRef.subject_id)
      const registry = JSON.parse(await readFile(join(root, '.pipeline-artifact-subjects.json'), 'utf8')) as { records: Array<{ projection: string; subjectRef: { subject_id: string }; path?: string }> }
      expect(registry.records.some(record => record.projection === 'runtime' && record.subjectRef.subject_id === subjectRef.subject_id && record.path === 'docs/design.md')).toBe(true)
      await runtime.end('completed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('converges unified document and field submissions with a real runtime submit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-unified-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'design.md'), '# design\n')
      const namespace = artifactNamespaceForChange(root)
      const service = await openArtifactService({ rootDir: root, scopeId: namespace })
      const submission = await openArtifactSubmissionService({
        changeDir: root,
        namespace,
        document: { record: async () => ({}) },
        field: { record: async () => ({}) },
      })
      const document = await submission.submit({ projection: 'document', logicalKey: 'design', path: 'docs/design.md', documentKind: 'design', producer: 'skill.design' })
      const field = await submission.submit({ projection: 'field', logicalKey: 'design', path: 'docs/design.md', field: 'design_doc', value: 'docs/design.md', producer: 'skill.design' })
      await service.beginAttempt({ workflowRunId: 'run-1', stageId: 'build', stageAttemptId: 'build-1' })
      const runtime = await StageArtifactRuntime.open({ service, rootDir: root, workflowRunId: 'run-1', stageId: 'build', stageAttemptId: 'build-1' })
      const output = await runtime.submit('docs/design.md', 'deliverable')
      expect(document.status).toBe('committed')
      expect(field.status).toBe('committed')
      expect(document.subjectRef.subject_id).toBe(field.subjectRef.subject_id)
      expect(output.subjectRef?.subject_id).toBe(document.subjectRef.subject_id)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('serializes concurrent reconcile calls and migrates the legacy runtime scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-migration-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'legacy.md'), 'legacy')
      const legacy = await openArtifactService({ rootDir: root, scopeId: 'runtime-artifacts' })
      await legacy.beginAttempt({ workflowRunId: 'run-legacy', stageId: 'build', stageAttemptId: 'legacy-1' })
      await legacy.submitArtifactOutput('legacy-1', { logicalKey: 'legacy', path: 'docs/legacy.md', data: 'legacy', mediaType: 'text/plain', disposition: 'deliverable' })
      const namespace = artifactNamespaceForChange(root)
      const migrated = await openArtifactService({ rootDir: root, scopeId: namespace })
      const migratedState = JSON.parse(await readFile(join(root, '.pipeline-artifacts', namespace, 'state.json'), 'utf8')) as { migrationReceipts: Array<{ kind: string; legacy_scope_path?: string; retention?: string }> }
      expect(migratedState.migrationReceipts).toEqual([expect.objectContaining({ kind: 'legacy-scope', legacy_scope_path: '.pipeline-artifacts/runtime-artifacts', retention: 'preserved-awaiting-confirmation' })])
      await migrated.beginAttempt({ workflowRunId: 'run-legacy', stageId: 'build', stageAttemptId: 'legacy-1' })
      expect((await migrated.events()).length).toBeGreaterThan(0)
      const state = JSON.parse(await readFile(join(root, '.pipeline-artifacts', namespace, 'state.json'), 'utf8')) as { migrationReceipts: Array<{ kind: string }> }
      expect(state.migrationReceipts.some(receipt => receipt.kind === 'legacy-scope')).toBe(true)
      const runtime = await StageArtifactRuntime.open({ service: migrated, rootDir: root, workflowRunId: 'run-2', stageId: 'build', stageAttemptId: 'build-2' })
      await writeFile(join(root, 'docs', 'new.md'), 'new')
      const [first, second] = await Promise.all([runtime.reconcile(), runtime.reconcile()])
      expect(first).toEqual(second)
      expect((await migrated.events()).filter(event => event.type === 'artifact.observed' && event.attemptId === 'build-2')).toHaveLength(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fails loudly when canonical and legacy scopes both contain unmerged data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-conflict-'))
    try {
      const state = (digest: string, stageAttemptId: string) => ({
        version: 1, revision: 0, attempts: [{ workflowRunId: 'w', stageId: 'build', stageAttemptId, status: 'running', dependencyStages: [], visibility: 'run', startedAt: '2026-01-01T00:00:00.000Z' }], events: [], reads: [], checks: [], subjectMappings: [], migrationReceipts: [],
        artifacts: [{ artifactId: `artifact:${digest.slice(0, 24)}`, currentVersion: 'v1', displayName: 'report.md', versions: [{ artifactId: `artifact:${digest.slice(0, 24)}`, version: 'v1', contentDigest: digest, size: 1, mediaType: 'text/markdown', kind: 'text', origin: 'stage', source: { path: 'report.md' }, contentUri: `artifact://scope/${digest}`, disposition: 'deliverable', quality: 'unchecked', createdAt: '2026-01-01T00:00:00.000Z' }] }],
      })
      await mkdir(join(root, '.pipeline-artifacts', 'runtime-artifacts'), { recursive: true })
      await mkdir(join(root, '.pipeline-artifacts', 'change-scope'), { recursive: true })
      await writeFile(join(root, '.pipeline-artifacts', 'runtime-artifacts', 'state.json'), JSON.stringify(state('a'.repeat(64), 'legacy-attempt')))
      await writeFile(join(root, '.pipeline-artifacts', 'change-scope', 'state.json'), JSON.stringify(state('a'.repeat(64), 'canonical-attempt')))
      await expect(openArtifactService({ rootDir: root, scopeId: 'change-scope' })).rejects.toMatchObject({ code: 'legacy-scope-unmerged' } satisfies Partial<ArtifactScopeMigrationError>)
      const canonical = JSON.parse(await readFile(join(root, '.pipeline-artifacts', 'change-scope', 'state.json'), 'utf8')) as { migrationReceipts: Array<{ receipt_id: string; legacy_scope_path?: string; canonical_scope_path?: string; retention?: string }> }
      expect(canonical.migrationReceipts.map(receipt => receipt.receipt_id)).toContain('migration:scope-conflict:runtime-artifacts:change-scope')
      expect(canonical.migrationReceipts).toEqual([expect.objectContaining({ legacy_scope_path: '.pipeline-artifacts/runtime-artifacts', canonical_scope_path: '.pipeline-artifacts/change-scope', retention: 'preserved-awaiting-confirmation' })])
      await expect(readFile(join(root, '.pipeline-artifacts', 'runtime-artifacts', 'state.json'), 'utf8')).resolves.toBeTruthy()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('records one checked receipt when canonical and legacy scopes are equivalent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-equivalent-'))
    try {
      const legacy = await openArtifactService({ rootDir: root, scopeId: 'runtime-artifacts' })
      await legacy.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'same-attempt' })
      await cp(join(root, '.pipeline-artifacts', 'runtime-artifacts'), join(root, '.pipeline-artifacts', 'change-scope'), { recursive: true })
      const canonical = await openArtifactService({ rootDir: root, scopeId: 'change-scope' })
      const state = JSON.parse(await readFile(join(root, '.pipeline-artifacts', 'change-scope', 'state.json'), 'utf8')) as { migrationReceipts: Array<{ receipt_id: string; retention?: string }> }
      expect(state.migrationReceipts).toEqual([expect.objectContaining({ receipt_id: 'migration:scope:runtime-artifacts:change-scope', retention: 'preserved-awaiting-confirmation' })])
      await canonical.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'later-attempt' })
      const after = JSON.parse(await readFile(join(root, '.pipeline-artifacts', 'change-scope', 'state.json'), 'utf8')) as { migrationReceipts: unknown[] }
      expect(after.migrationReceipts).toHaveLength(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('cross-attempt content reuse', () => {
  it('records an observation for each attempt when bytes reuse an immutable version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-artifact-'))
    try {
      const svc = await openArtifactService({ rootDir: root, scopeId: 'scope', now: () => '2026-01-01T00:00:00.000Z' })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-1' })
      const first = await svc.observe('build-1', { path: 'report.md', data: 'same', mediaType: 'text/markdown' })
      await svc.publish('build-1', { artifactId: first.artifactId })
      await svc.beginAttempt({ workflowRunId: 'w', stageId: 'build', stageAttemptId: 'build-2' })
      const reused = await svc.observe('build-2', { path: 'report.md', data: 'same', mediaType: 'text/markdown' })
      expect(reused.version).toBe(first.version)
      const published = await svc.publish('build-2', { artifactId: reused.artifactId })
      expect(published.version).toBe(first.version)
      expect(published.publisher?.stageAttemptId).toBe('build-1')
      expect((await svc.events()).filter((event) => event.type === 'artifact.observed' && event.attemptId === 'build-2')).toHaveLength(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
