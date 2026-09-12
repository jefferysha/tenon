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
      const runtime = await StageArtifactRuntime.open({ service, rootDir: root, workflowRunId: 'workflow', stageId: 'stage-a', stageAttemptId: 'attempt-a' })
      await writeFile(path.join(root, 'report.md'), 'v1')
      await runtime.reconcile()
      const first = await runtime.publish('report.md', 'deliverable')
      await writeFile(path.join(root, 'report.md'), 'v2')
      await runtime.reconcile()
      await runtime.publish('report.md', 'deliverable')
      const catalog = await service.catalog('attempt-a')
      expect(catalog.entries.map((entry) => entry.version)).toEqual(['v2'])
      expect((await service.inspect(first.artifactId, first.version)).version.version).toBe('v1')
      const consumed = await service.read('attempt-a', first.artifactId, first.version, { consumer: 'execution' })
      expect(new TextDecoder().decode(consumed.bytes)).toBe('v1')
      await runtime.end('completed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
