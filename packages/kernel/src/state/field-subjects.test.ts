import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  FIELD_SUBJECTS_FILE,
  parseFieldSubjectLedger,
  readFieldSubjectLedger,
  recordFieldSubject,
} from './field-subjects.js'

describe('field subject projection', () => {
  test('records a stable field subject and updates source path without changing identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-field-subject-'))
    try {
      await mkdir(join(root, 'openspec', 'changes', 'demo'), { recursive: true })
      const changeDir = join(root, 'openspec', 'changes', 'demo')
      await writeFile(join(root, 'docs.txt'), 'hello')
      const first = await recordFieldSubject({
        changeDir,
        repoRoot: root,
        field: 'design_doc',
        value: 'docs.txt',
        sourcePath: 'docs.txt',
        logicalKey: 'design-document',
        namespace: 'workflow/demo',
        recordedAt: '2026-09-12T00:00:00Z',
      })
      expect(first?.records[0]?.subjectRef.subject_id).toMatch(/^subject:workflow\/demo:/)
      expect(first?.records[0]?.pathStatus).toBe('resolved')
      const subjectId = first!.records[0]!.subjectRef.subject_id
      const second = await recordFieldSubject({
        changeDir,
        repoRoot: root,
        field: 'design_doc',
        value: 'renamed.txt',
        sourcePath: 'renamed.txt',
        logicalKey: 'design-document',
        namespace: 'workflow/demo',
        recordedAt: '2026-09-12T00:01:00Z',
      })
      expect(second?.records[0]?.subjectRef.subject_id).toBe(subjectId)
      expect(second?.records[0]?.pathStatus).toBe('missing')
      expect(second?.records[0]?.subjectRef.source?.path).toBe('renamed.txt')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('missing optional sidecar is compatible with old state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-field-subject-'))
    try {
      expect(await readFieldSubjectLedger(root)).toBeUndefined()
      expect(await recordFieldSubject({
        changeDir: join(root, 'does-not-exist'),
        field: 'plan',
        value: 'plan.md',
        recordedAt: '2026-09-12T00:00:00Z',
      })).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('serialized sidecar remains strictly parseable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-field-subject-'))
    try {
      await recordFieldSubject({ changeDir: root, field: 'plan', value: 'plan.md', recordedAt: '2026-09-12T00:00:00Z' })
      const raw = await readFile(join(root, FIELD_SUBJECTS_FILE), 'utf8')
      expect(parseFieldSubjectLedger(raw).records).toHaveLength(1)
      expect(() => parseFieldSubjectLedger('{"version":1}')).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
