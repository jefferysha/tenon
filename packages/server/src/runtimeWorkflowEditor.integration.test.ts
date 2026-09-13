import { describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactNamespaceForChange, openArtifactService, StageArtifactRuntime } from '@tenon/automation'
import { buildSnapshot } from './snapshot.js'
import { initChange, makeProject, newStore } from './test-support.js'

/**
 * Production-shaped provenance path used by the workflow editor:
 * executor runtime -> durable artifact service -> server snapshot projection.
 * The dashboard consumes the resulting `artifactAttempts` and uses the exact
 * workflow step id (`open`) to request its catalog by stageAttemptId.
 */
describe('runtime artifact provenance reaches workflow editor context', () => {
  it('projects a real executor submission with run identity and catalogable stage', async () => {
    const root = await makeProject()
    const store = newStore()
    try {
      const changeDir = await initChange(store, root, 'runtime-editor', { track: 'backend' })
      const service = await openArtifactService({
        rootDir: changeDir,
        scopeId: artifactNamespaceForChange(changeDir),
        now: () => '2026-09-13T01:02:03.000Z',
      })
      // This is the same adapter used by the production executor. Its stage id
      // is the workflow step id produced by the frozen blueprint.
      const runtime = await StageArtifactRuntime.open({
        service,
        rootDir: changeDir,
        workflowRunId: 'workflow-run-runtime-editor',
        stageId: 'open',
        stageAttemptId: 'attempt-runtime-editor-open',
        skillId: 'tenon-open',
      })
      await mkdir(join(changeDir, 'outputs'), { recursive: true })
      await writeFile(join(changeDir, 'outputs', 'result.md'), '# runtime output\n', 'utf8')
      const published = await runtime.submit('outputs/result.md', 'deliverable', 'runtime-result')
      await runtime.end('completed')

      const snapshot = await buildSnapshot({
        registry: () => [root],
        store,
        version: '1',
        clock: () => '2026-09-13T01:02:03.000Z',
        artifactServiceForRoot: async () => service,
      })
      const change = snapshot.projects[0]?.changes.find((candidate) => candidate.name === 'runtime-editor')
      const attempt = change?.artifactAttempts?.find((candidate) => candidate.stageId === 'open')
      expect(attempt).toMatchObject({
        stageId: 'open',
        stageAttemptId: 'attempt-runtime-editor-open',
        workflowRunId: 'workflow-run-runtime-editor',
        startedAt: '2026-09-13T01:02:03.000Z',
      })
      expect(change?.artifactAttempts?.some((candidate) => candidate.stageId === 'work-runtime-editor')).toBe(false)

      // The editor's second hop is the catalog API. Calling the same service
      // verifies that the projected attempt id is a real, catalogable id.
      const catalog = await service.catalog(attempt!.stageAttemptId)
      expect(catalog.stageAttemptId).toBe(attempt!.stageAttemptId)
      expect(catalog.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactId: published.artifactId, version: published.version, source: { path: 'outputs/result.md' } }),
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
