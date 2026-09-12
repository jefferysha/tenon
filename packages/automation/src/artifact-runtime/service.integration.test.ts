import { describe, expect, test } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openArtifactService } from '../artifacts/service.js'
import { StageArtifactRuntime } from './stage-runtime.js'

describe('artifact runtime with durable service', () => {
  test('unknown file is observed, published and retains immutable versions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-artifacts-'))
    try {
      const service = await openArtifactService({ rootDir: root, scopeId: 'run' })
      const runtime = await StageArtifactRuntime.open({ service, rootDir: root, workflowRunId: 'workflow', stageId: 'stage-a', stageAttemptId: 'attempt-a', skillId: 'writer-skill' })
      await writeFile(path.join(root, 'report.md'), 'v1')
      await runtime.reconcile()
      const first = await runtime.publish('report.md', 'deliverable')
      const consumed = await runtime.consume('report.md', first.version, { representation: 'content' })
      expect(new TextDecoder().decode(consumed.bytes)).toBe('v1')
      await writeFile(path.join(root, 'report.md'), 'v2')
      await runtime.reconcile()
      await runtime.publish('report.md', 'deliverable')
      const catalog = await service.catalog('attempt-a')
      expect(catalog.entries.map((entry) => entry.version)).toEqual(['v2'])
      expect(first.origin).toBe('stage')
      expect(first.producer?.stageAttemptId).toBe('attempt-a')
      expect((await service.inspect(first.artifactId, first.version)).version.version).toBe('v1')
      await runtime.end('completed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('adopts an unchanged pre-existing file before publishing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-artifacts-'))
    try {
      await writeFile(path.join(root, 'package.json'), '{"ok":true}')
      const service = await openArtifactService({ rootDir: root, scopeId: 'run' })
      const runtime = await StageArtifactRuntime.open({ service, rootDir: root, workflowRunId: 'workflow', stageId: 'stage-a', stageAttemptId: 'attempt-a' })
      const published = await runtime.publish('package.json', 'deliverable')
      expect(published.disposition).toBe('deliverable')
      expect((await service.events()).filter(event => event.type === 'artifact.observed' && event.attemptId === 'attempt-a')).toHaveLength(1)
      await runtime.publish('package.json', 'deliverable')
      expect((await service.events()).filter(event => event.type === 'artifact.observed' && event.attemptId === 'attempt-a')).toHaveLength(1)
      await runtime.end('completed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
