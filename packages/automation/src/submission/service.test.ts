import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { openArtifactSubmissionService } from './service.js'
import { openArtifactService } from '../artifacts/service.js'

describe('artifact submission service', () => {
  it('joins document, field, and runtime projections under one logical subject', async () => {
    const changeDir = await mkdtemp(join(tmpdir(), 'tenon-submission-'))
    try {
      await mkdir(join(changeDir, 'docs'), { recursive: true })
      await writeFile(join(changeDir, 'docs', 'design.md'), '# design\n')
      const calls: string[] = []
      const service = await openArtifactSubmissionService({
        changeDir,
        namespace: 'change-demo',
        document: { record: async () => { calls.push('document'); return { stateRevisionId: 'r1' } } },
        field: { record: async () => { calls.push('field'); return { stateRevisionId: 'r2' } } },
        runtime: { submitArtifactOutput: async () => { calls.push('runtime'); return { artifactId: 'runtime-1', version: 'v1', contentDigest: 'a'.repeat(64) } } },
      })
      const document = await service.submit({ projection: 'document', logicalKey: 'design', path: 'docs/design.md', documentKind: 'design', producer: 'skill.design' })
      const field = await service.submit({ projection: 'field', logicalKey: 'design', path: 'docs/design.md', field: 'design_doc', value: 'docs/design.md', producer: 'skill.design' })
      const runtime = await service.submit({ projection: 'runtime', logicalKey: 'design', path: 'docs/design.md', stageAttemptId: 'stage-1', runtime: {}, producer: 'skill.design' })
      expect(calls).toEqual(['document', 'field', 'runtime'])
      expect(document.status).toBe('committed')
      expect(field.subjectRef.subject_id).toBe(document.subjectRef.subject_id)
      expect(runtime.subjectRef.subject_id).toBe(document.subjectRef.subject_id)
      expect(runtime.subjectRef.version).toBe('v1')
      const registry = JSON.parse(await readFile(join(changeDir, '.pipeline-artifact-subjects.json'), 'utf8')) as { records: Array<{ logicalKey: string; projection: string; path?: string }> }
      expect(registry.records.map((record) => record.projection)).toEqual(['document', 'field', 'runtime'])
      expect(registry.records.find((record) => record.projection === 'field')?.path).toBe('docs/design.md')
    } finally { await rm(changeDir, { recursive: true, force: true }) }
  })

  it('records adapter failure without hiding the diagnostic or claiming success', async () => {
    const changeDir = await mkdtemp(join(tmpdir(), 'tenon-submission-'))
    try {
      const service = await openArtifactSubmissionService({ changeDir, namespace: 'change-demo', field: { record: async () => { throw new Error('field rejected') } } })
      const result = await service.submit({ projection: 'field', logicalKey: 'plan', field: 'plan', value: 'x', producer: 'skill.plan' })
      expect(result.status).toBe('failed')
      expect(result.diagnostics).toEqual(['field rejected'])
    } finally { await rm(changeDir, { recursive: true, force: true }) }
  })

  it('uses the durable runtime adapter while document and field remain separate projections', async () => {
    const changeDir = await mkdtemp(join(tmpdir(), 'tenon-submission-'))
    try {
      await mkdir(join(changeDir, 'docs'), { recursive: true })
      await writeFile(join(changeDir, 'docs', 'design.md'), '# design\n')
      const runtime = await openArtifactService({ rootDir: changeDir, scopeId: 'change-demo' })
      await runtime.beginAttempt({ workflowRunId: 'run-1', stageId: 'build', stageAttemptId: 'build-1' })
      const service = await openArtifactSubmissionService({
        changeDir,
        namespace: 'change-demo',
        runtime,
        document: { record: async () => ({}) },
        field: { record: async () => ({}) },
      })
      const result = await service.submit({ projection: 'runtime', logicalKey: 'design', path: 'docs/design.md', stageAttemptId: 'build-1', runtime: { path: 'docs/design.md', data: '# design\n', mediaType: 'text/markdown', disposition: 'deliverable' }, producer: 'skill.design' })
      expect(result.status).toBe('committed')
      expect((await runtime.catalog('build-1')).entries[0]?.subjectRef?.subject_id).toBe(result.subjectRef.subject_id)
    } finally { await rm(changeDir, { recursive: true, force: true }) }
  })
})
