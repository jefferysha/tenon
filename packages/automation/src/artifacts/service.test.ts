import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openArtifactService } from './service.js'

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
