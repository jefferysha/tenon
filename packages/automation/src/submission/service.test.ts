import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
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

  it('accepts repository documents outside the change and refreshes a reused subject to the committed bytes', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'tenon-submission-repo-'))
    try {
      const changeDir = join(repoRoot, 'openspec', 'changes', 'demo')
      const designFile = join(repoRoot, 'docs', 'superpowers', 'specs', 'demo-design.md')
      await mkdir(changeDir, { recursive: true })
      await mkdir(join(repoRoot, 'docs', 'superpowers', 'specs'), { recursive: true })
      await writeFile(designFile, '# design v1\n')
      const committed: string[] = []
      const service = await openArtifactSubmissionService({
        changeDir,
        namespace: 'change-demo',
        repoRoot,
        document: { record: async ({ subjectRef }) => { committed.push(subjectRef.content_digest); return {} } },
        field: { record: async () => ({}) },
      })
      const design = { projection: 'document', logicalKey: 'document:superpower-design', path: relative(changeDir, designFile), documentKind: 'superpower-design', producer: 'brainstorming' } as const
      const first = await service.submit(design)
      await writeFile(designFile, '# design v2\n')
      const second = await service.submit(design)
      expect([first.status, second.status]).toEqual(['committed', 'committed'])
      expect(second.subjectRef.subject_id).toBe(first.subjectRef.subject_id)
      expect(second.subjectRef.content_digest).toBe(`sha256:${createHash('sha256').update('# design v2\n').digest('hex')}`)
      expect(committed).toEqual([first.subjectRef.content_digest, second.subjectRef.content_digest])
      await expect(service.submit({ ...design, logicalKey: 'document:escape', path: relative(changeDir, join(repoRoot, '..', 'outside.md')) }))
        .rejects.toThrow('submission path outside repository')
      const field = await service.submit({ projection: 'field', logicalKey: 'field:design_doc', path: design.path, field: 'design_doc', value: 'docs/superpowers/specs/demo-design.md', producer: 'brainstorming' })
      expect(field.status).toBe('committed')
      expect(field.subjectRef.subject_id).toBe(first.subjectRef.subject_id)
      await expect(service.submit({ projection: 'runtime', logicalKey: 'runtime:design', path: design.path, stageAttemptId: 'stage-1', runtime: { mediaType: 'text/markdown' }, producer: 'brainstorming' }))
        .rejects.toThrow('submission path outside change scope')
    } finally { await rm(repoRoot, { recursive: true, force: true }) }
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
