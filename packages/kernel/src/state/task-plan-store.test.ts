import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeTaskPlanRevisionV1, TASK_PLAN_LIMITS, type TaskPlanRevisionV1 } from '../task-plan/index.js'
import {
  TASK_PLAN_CURRENT_FILE,
  TASK_PLAN_STATE_DIR,
  TaskPlanRevisionConflictError,
  TaskPlanStateCorruptError,
  readTaskPlanForChange,
  taskPlanTasksThroughPhaseForChange,
} from './task-plan-store.js'
import { publishTaskPlanRevision } from '../task-plan/publication.js'
import { withTaskPlanPublicationFaultForTest } from './task-plan-publication-test-harness.js'

function plan(overrides: Partial<TaskPlanRevisionV1> = {}): TaskPlanRevisionV1 {
  return {
    schema_version: 'task-plan/v1',
    plan_id: 'plan-1',
    revision_id: 'revision-1',
    revision_number: 1,
    status: 'frozen',
    created_at: '2026-08-03T09:00:00.000Z',
    requirements: [{ id: 'req-1', title: 'Read model' }],
    acceptance_criteria: [{ id: 'acc-1', title: 'Stable response' }],
    groups: [{ id: 'group-1', title: 'Build', parent_id: null, work_item_ids: ['wi-1'] }],
    work_items: [{
      id: 'wi-1', title: 'Implement', group_id: 'group-1', requirement_refs: ['req-1'],
      acceptance_refs: ['acc-1'], depends_on: [], resource_claims: [], expected_outputs: [], validators: [],
    }],
    ...overrides,
  }
}

async function changeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'task-plan-store-'))
  const dir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(dir, { recursive: true })
  return dir
}

async function seedCanonicalHistory(
  dir: string,
  revisions: readonly TaskPlanRevisionV1[],
  current: TaskPlanRevisionV1,
): Promise<string> {
  const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
  await mkdir(revisionsDir, { recursive: true })
  for (const revision of revisions) {
    await writeFile(
      join(revisionsDir, `${String(revision.revision_number).padStart(6, '0')}-${revision.revision_id}.json`),
      `${JSON.stringify(revision)}\n`,
      'utf8',
    )
  }
  await writeFile(
    join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE),
    `${JSON.stringify(current)}\n`,
    'utf8',
  )
  return revisionsDir
}

function revisionRaw(revision: TaskPlanRevisionV1): string {
  return `${encodeTaskPlanRevisionV1(revision)}\n`
}

function canonicalRevisionFileName(revision: TaskPlanRevisionV1): string {
  const planNamespace = createHash('sha256').update(revision.plan_id).digest('hex')
  return `${String(revision.revision_number).padStart(6, '0')}--${planNamespace}--${revision.revision_id}.json`
}

function maximumPersistedRevision(): TaskPlanRevisionV1 {
  const requirements = Array.from({ length: 64 }, (_, index) => ({
    id: `req-${index}`,
    title: 'x'.repeat(7_000),
  }))
  const acceptanceCriteria = Array.from({ length: 64 }, (_, index) => ({
    id: `acc-${index}`,
    title: 'y'.repeat(7_000),
  }))
  const revision: TaskPlanRevisionV1 = plan({
    plan_id: 'plan-boundary',
    revision_id: 'revision-boundary',
    requirements,
    acceptance_criteria: acceptanceCriteria,
    groups: [{ id: 'group-boundary', title: 'Boundary', parent_id: null, work_item_ids: ['wi-boundary'] }],
    work_items: [{
      id: 'wi-boundary', title: 'Boundary', group_id: 'group-boundary',
      requirement_refs: requirements.map((entry) => entry.id),
      acceptance_refs: acceptanceCriteria.map((entry) => entry.id),
      depends_on: [], resource_claims: [], expected_outputs: [], validators: [],
    }],
  })
  let remaining = TASK_PLAN_LIMITS.maxDocumentBytes - Buffer.byteLength(encodeTaskPlanRevisionV1(revision))
  for (const entry of [...requirements, ...acceptanceCriteria]) {
    const added = Math.min(TASK_PLAN_LIMITS.maxTextBytes - Buffer.byteLength(entry.title), remaining)
    entry.title += 'z'.repeat(added)
    remaining -= added
    if (remaining === 0) break
  }
  if (remaining !== 0) throw new Error('Could not construct exact TaskPlan document boundary fixture')
  if (Buffer.byteLength(encodeTaskPlanRevisionV1(revision)) !== TASK_PLAN_LIMITS.maxDocumentBytes) {
    throw new Error('TaskPlan document boundary fixture is not exact')
  }
  return revision
}

/**
 * A revision whose encoded bytes (newline included) are exactly `desiredBytes`, built from requirement titles of
 * FULL_TITLE bytes plus one shorter last title. The size is computed from the per-item overhead, so the fixture
 * costs one encode instead of re-serialising the whole growing document for every requirement it adds: that
 * quadratic loop made this helper the bulk of the byte-budget tests' runtime (about 3 s unloaded, over the 15 s
 * timeout under CPU contention) while the code under test is only asked to read the files afterwards.
 */
function sizedOrphanRaw(index: number, desiredBytes: number): string {
  const FULL_TITLE = 7_000
  const fixture = (requirements: readonly { id: string; title: string }[]): TaskPlanRevisionV1 => plan({
    plan_id: `budget-plan-${index}`,
    revision_id: `budget-revision-${index}`,
    requirements: [...requirements],
    acceptance_criteria: [],
    groups: [],
    work_items: [],
  })
  const requirements: { id: string; title: string }[] = []
  let remaining = desiredBytes - Buffer.byteLength(revisionRaw(fixture([])))
  for (;;) {
    const id = `budget-req-${index}-${requirements.length}`
    // One more array element: its object without a title, plus the comma that separates it from the previous element.
    const overhead = Buffer.byteLength(JSON.stringify({ id, title: '' })) + (requirements.length === 0 ? 0 : 1)
    const last = remaining - overhead
    if (last < 0) throw new Error('Requested revision fixture is too small')
    // The last title may be a little over FULL_TITLE (never over maxTextBytes) rather than a sliver that cannot hold an item.
    if (last <= FULL_TITLE + 100) {
      requirements.push({ id, title: 'x'.repeat(last) })
      break
    }
    requirements.push({ id, title: 'x'.repeat(FULL_TITLE) })
    remaining -= overhead + FULL_TITLE
  }
  const encoded = revisionRaw(fixture(requirements))
  if (Buffer.byteLength(encoded) !== desiredBytes) throw new Error('Encoded revision fixture size is not exact')
  return encoded
}

async function populateSizedOrphans(
  revisionsDir: string,
  count: number,
  totalBytes: number,
): Promise<void> {
  const each = Math.floor(totalBytes / count)
  let remainder = totalBytes % count
  for (let index = 0; index < count; index += 1) {
    const bytes = each + (remainder > 0 ? 1 : 0)
    remainder = Math.max(0, remainder - 1)
    await writeFile(join(revisionsDir, `000001-budget-revision-${index}.json`), sizedOrphanRaw(index, bytes), 'utf8')
  }
}

describe('task plan store', () => {
  it('publishes immutable revision before current and builds a canonical read model', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null, completed_work_item_ids: [] })
    const read = await readTaskPlanForChange(dir)
    expect(read).toMatchObject({
      schema_version: 'task-plan-read/v1', source: 'canonical', revision_id: 'revision-1', schedulable: true,
      projection: { state: 'current' },
    })
    const immutable = await readFile(
      join(dir, TASK_PLAN_STATE_DIR, 'revisions', canonicalRevisionFileName(plan())),
      'utf8',
    )
    const current = await readFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), 'utf8')
    expect(current).toBe(immutable)
    expect(await readFile(join(dir, 'tasks.md'), 'utf8')).toContain('work-item:wi-1')
  })

  it('round-trips the maximum newline-terminated revision and can extend its lineage', async () => {
    const dir = await changeDir()
    const boundary = maximumPersistedRevision()
    const boundaryRaw = revisionRaw(boundary)
    expect(Buffer.byteLength(boundaryRaw)).toBe(TASK_PLAN_LIMITS.maxRevisionBytes)

    await expect(publishTaskPlanRevision(dir, boundary, { expected_current_revision_id: null }))
      .resolves.toMatchObject({ revision_id: 'revision-boundary' })
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      source: 'canonical', revision_id: 'revision-boundary', projection: { state: 'current' },
    })

    const next = plan({
      plan_id: boundary.plan_id,
      revision_id: 'revision-after-boundary',
      revision_number: 2,
    })
    await expect(publishTaskPlanRevision(
      dir,
      next,
      { expected_current_revision_id: boundary.revision_id },
    )).resolves.toMatchObject({ revision_id: 'revision-after-boundary', revision_number: 2 })
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({ revision_id: 'revision-after-boundary' })
  })

  it('publishes and reads a canonical plan with NFC Unicode opaque IDs', async () => {
    const dir = await changeDir()
    const unicode = plan({
      plan_id: 'plan-计划',
      revision_id: 'revision-修订',
      requirements: [{ id: 'req-ä', title: 'Unicode requirement' }],
      acceptance_criteria: [{ id: 'acc-東京', title: 'Unicode acceptance' }],
      groups: [{ id: 'group-组', title: 'Unicode group', parent_id: null, work_item_ids: ['wi-東京'] }],
      work_items: [{
        id: 'wi-東京', title: 'Unicode item', group_id: 'group-组',
        requirement_refs: ['req-ä'], acceptance_refs: ['acc-東京'], depends_on: [],
        resource_claims: [], expected_outputs: [{ id: 'out-产物', kind: 'artifact', ref: 'unicode-report' }],
        validators: [{ id: 'validator-验证', kind: 'test-report', version: 1, output_ids: ['out-产物'] }],
      }],
    })

    await expect(publishTaskPlanRevision(dir, unicode, { expected_current_revision_id: null }))
      .resolves.toMatchObject({ revision_id: 'revision-修订', schedulable: true })
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      source: 'canonical', plan_id: 'plan-计划', revision_id: 'revision-修订',
      groups: [{ id: 'group-组', work_item_ids: ['wi-東京'] }],
    })
  })

  it('rejects byte-different invalid UTF-8 current and immutable twins before replacement decoding', async () => {
    const dir = await changeDir()
    const replacement = plan({
      requirements: [{ id: 'req-1', title: 'Contains a legal � scalar' }],
    })
    await publishTaskPlanRevision(dir, replacement, { expected_current_revision_id: null })
    const stateDir = join(dir, TASK_PLAN_STATE_DIR)
    const currentPath = join(stateDir, TASK_PLAN_CURRENT_FILE)
    const immutablePath = join(stateDir, 'revisions', canonicalRevisionFileName(replacement))
    const validRaw = await readFile(currentPath)
    const marker = Buffer.from('�', 'utf8')
    const markerOffset = validRaw.indexOf(marker)
    expect(markerOffset).toBeGreaterThanOrEqual(0)
    const corrupt = (byte: number): Buffer => Buffer.concat([
      validRaw.subarray(0, markerOffset),
      Buffer.from([byte]),
      validRaw.subarray(markerOffset + marker.byteLength),
    ])
    const currentCorrupt = corrupt(0x80)
    const immutableCorrupt = corrupt(0xff)
    expect(currentCorrupt.equals(immutableCorrupt)).toBe(false)
    expect(currentCorrupt.toString('utf8')).toBe(immutableCorrupt.toString('utf8'))
    await writeFile(currentPath, currentCorrupt)
    await writeFile(immutablePath, immutableCorrupt)

    await expect(readTaskPlanForChange(dir)).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
    await expect(publishTaskPlanRevision(
      dir,
      replacement,
      { expected_current_revision_id: replacement.revision_id },
    )).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
    expect(await readFile(currentPath)).toEqual(currentCorrupt)
    expect(await readFile(immutablePath)).toEqual(immutableCorrupt)
  })

  it('preserves a legal U+FFFD scalar in byte-identical canonical state', async () => {
    const dir = await changeDir()
    const replacement = plan({
      requirements: [{ id: 'req-1', title: 'Legal � scalar' }],
    })

    await expect(publishTaskPlanRevision(dir, replacement, { expected_current_revision_id: null }))
      .resolves.toMatchObject({ requirements: [{ title: 'Legal � scalar' }] })
    await expect(readTaskPlanForChange(dir))
      .resolves.toMatchObject({ requirements: [{ title: 'Legal � scalar' }] })
  })

  it('does not expose an immutable orphan without a committed current pointer', async () => {
    const dir = await changeDir()
    await mkdir(join(dir, TASK_PLAN_STATE_DIR, 'revisions'), { recursive: true })
    await writeFile(
      join(dir, TASK_PLAN_STATE_DIR, 'revisions', '000001-revision-1.json'),
      `${JSON.stringify(plan())}\n`,
      'utf8',
    )
    await writeFile(join(dir, 'tasks.md'), '## Build\n- [ ] Legacy only\n', 'utf8')
    expect(await readTaskPlanForChange(dir)).toMatchObject({ source: 'legacy', schedulable: false })
  })

  it('does not execute callbacks smuggled through the public publish options', async () => {
    const dir = await changeDir()
    let callbackInvoked = false
    const options = {
      expected_current_revision_id: null,
      __test_after_immutable_publish: () => { callbackInvoked = true },
    }

    await expect(publishTaskPlanRevision(dir, plan(), options)).resolves.toMatchObject({
      revision_id: 'revision-1',
    })
    expect(callbackInvoked).toBe(false)
  })

  it('recovers a byte-identical immutable revision after failure before current publication', async () => {
    const dir = await changeDir()
    const previous = plan()
    const revision = plan({ revision_id: 'revision-2', revision_number: 2 })
    const injectedFailure = new Error('injected failure after immutable publication')
    await publishTaskPlanRevision(dir, previous, { expected_current_revision_id: null })

    await expect(withTaskPlanPublicationFaultForTest(
      () => { throw injectedFailure },
      () => publishTaskPlanRevision(dir, revision, {
        expected_current_revision_id: previous.revision_id,
      }),
    )).rejects.toBe(injectedFailure)

    expect(await readFile(
      join(dir, TASK_PLAN_STATE_DIR, 'revisions', canonicalRevisionFileName(revision)),
      'utf8',
    )).toBe(revisionRaw(revision))
    expect(await readFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), 'utf8'))
      .toBe(revisionRaw(previous))
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      source: 'canonical', revision_id: 'revision-1', projection: { state: 'current' },
    })

    await expect(publishTaskPlanRevision(dir, revision, { expected_current_revision_id: previous.revision_id }))
      .resolves.toMatchObject({ revision_id: 'revision-2', projection: { state: 'current' } })
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      source: 'canonical', revision_id: 'revision-2', projection: { state: 'current' },
    })
    expect((await readdir(join(dir, TASK_PLAN_STATE_DIR, 'revisions'))).sort()).toEqual([
      canonicalRevisionFileName(previous),
      canonicalRevisionFileName(revision),
    ].sort())
  })

  it('keeps marker-shaped prose when a legacy-only tasks file spoofs a canonical header', async () => {
    const dir = await changeDir()
    await writeFile(join(dir, 'tasks.md'), [
      '# Tasks',
      '',
      '<!-- tenon-task-plan revision=spoof digest=spoof -->',
      '',
      '## Notes <!-- task-group:user-group -->',
      '- [ ] Preserve this prose <!-- work-item:user-text -->',
      '',
    ].join('\n'), 'utf8')
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      source: 'legacy',
      items: [{
        stage: 'Notes <!-- task-group:user-group -->',
        title: 'Preserve this prose <!-- work-item:user-text -->',
      }],
    })
  })

  it('rejects invalid UTF-8 legacy tasks before phase-completion parsing', async () => {
    const dir = await changeDir()
    await writeFile(join(dir, 'tasks.md'), Buffer.from([0xc3, 0x28]))
    await expect(taskPlanTasksThroughPhaseForChange(dir, 'build')).resolves.toEqual({
      pass: false,
      failure: 'build 出口：tasks.md 不可信或超出预算',
    })
  })

  it('fails every governed phase exit when canonical current exists but tasks projection is missing', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    await rm(join(dir, 'tasks.md'))

    for (const phase of ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'] as const) {
      await expect(taskPlanTasksThroughPhaseForChange(dir, phase)).resolves.toEqual({
        pass: false,
        failure: `${phase} 出口：tasks.md 缺失`,
      })
    }

    const legacyDir = await changeDir()
    await expect(taskPlanTasksThroughPhaseForChange(legacyDir, 'verify')).resolves.toEqual({ pass: true })
  })

  it('never falls back to legacy when current exists but is corrupt or lacks its immutable twin', async () => {
    const dir = await changeDir()
    await mkdir(join(dir, TASK_PLAN_STATE_DIR), { recursive: true })
    await writeFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), '{broken', 'utf8')
    await writeFile(join(dir, 'tasks.md'), '## Build\n- [ ] Do not trust this\n', 'utf8')
    await expect(readTaskPlanForChange(dir)).rejects.toBeInstanceOf(TaskPlanStateCorruptError)

    await writeFile(
      join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE),
      `${JSON.stringify(plan())}\n`,
      'utf8',
    )
    await expect(readTaskPlanForChange(dir)).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
  })

  it('rejects a symlinked canonical leaf without following it', async () => {
    const dir = await changeDir()
    await mkdir(join(dir, TASK_PLAN_STATE_DIR), { recursive: true })
    await writeFile(join(dir, 'outside.json'), `${JSON.stringify(plan())}\n`, 'utf8')
    await symlink(join(dir, 'outside.json'), join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE))
    await expect(readTaskPlanForChange(dir)).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
  })

  it('reports projection drift without demoting a committed canonical plan', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null, completed_work_item_ids: [] })
    await writeFile(join(dir, 'tasks.md'), '## Build\n- [ ] Hand edited\n', 'utf8')
    expect(await readTaskPlanForChange(dir)).toMatchObject({
      source: 'canonical', revision_id: 'revision-1', projection: { state: 'drift' },
    })
  })

  it('reports drift when the marker is retained but the projected body is edited', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null, completed_work_item_ids: [] })
    const projected = await readFile(join(dir, 'tasks.md'), 'utf8')
    await writeFile(join(dir, 'tasks.md'), projected.replace('Implement', 'Hand edited'), 'utf8')
    expect(await readTaskPlanForChange(dir)).toMatchObject({
      source: 'canonical', revision_id: 'revision-1', projection: { state: 'drift' },
    })
  })

  it('allows completion-only projection updates without treating them as canonical drift', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null, completed_work_item_ids: [] })
    const projected = await readFile(join(dir, 'tasks.md'), 'utf8')
    await writeFile(join(dir, 'tasks.md'), projected.replace('- [ ] Implement', '- [x] Implement'), 'utf8')
    expect(await readTaskPlanForChange(dir)).toMatchObject({
      source: 'canonical', revision_id: 'revision-1', projection: { state: 'current' },
    })
  })

  it('rejects an invalid or draft plan before publishing any current state', async () => {
    const dir = await changeDir()
    await expect(publishTaskPlanRevision(dir, plan({ status: 'draft' }), { expected_current_revision_id: null }))
      .rejects.toThrow('TaskPlan revision is not freezable')
    await expect(readFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses expected-current and lineage checks to reject a stale rollback', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    await publishTaskPlanRevision(dir, plan({ revision_id: 'revision-2', revision_number: 2 }), {
      expected_current_revision_id: 'revision-1',
    })
    await expect(publishTaskPlanRevision(dir, plan({ revision_id: 'revision-stale', revision_number: 2 }), {
      expected_current_revision_id: 'revision-1',
    })).rejects.toThrow('TaskPlan current revision changed')
    expect(await readTaskPlanForChange(dir)).toMatchObject({ revision_id: 'revision-2' })
  })

  it('rejects reusing the current revision id and leaves the current pointer unchanged', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })

    await expect(publishTaskPlanRevision(dir, plan({ revision_number: 2 }), {
      expected_current_revision_id: 'revision-1',
    })).rejects.toThrow('TaskPlan revision id already exists in the current lineage')

    expect(await readTaskPlanForChange(dir)).toMatchObject({ revision_id: 'revision-1', revision_number: 1 })
  })

  it('rejects reusing a historical revision id and leaves the current pointer unchanged', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    await publishTaskPlanRevision(dir, plan({ revision_id: 'revision-2', revision_number: 2 }), {
      expected_current_revision_id: 'revision-1',
    })

    await expect(publishTaskPlanRevision(dir, plan({ revision_number: 3 }), {
      expected_current_revision_id: 'revision-2',
    })).rejects.toThrow('TaskPlan revision id already exists in the current lineage')

    expect(await readTaskPlanForChange(dir)).toMatchObject({ revision_id: 'revision-2', revision_number: 2 })
  })

  it('accepts a fresh revision id despite an unrelated same-plan orphan and a different-plan same-id orphan', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    await publishTaskPlanRevision(dir, plan({ revision_id: 'revision-2', revision_number: 2 }), {
      expected_current_revision_id: 'revision-1',
    })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    await writeFile(
      join(revisionsDir, '000099-unrelated-orphan-id.json'),
      `${JSON.stringify(plan({ revision_id: 'unrelated-orphan-id', revision_number: 99 }))}\n`,
      'utf8',
    )
    await writeFile(
      join(revisionsDir, '000001-revision-3.json'),
      `${JSON.stringify(plan({ plan_id: 'other-plan', revision_id: 'revision-3' }))}\n`,
      'utf8',
    )

    await expect(publishTaskPlanRevision(dir, plan({ revision_id: 'revision-3', revision_number: 3 }), {
      expected_current_revision_id: 'revision-2',
    })).resolves.toMatchObject({ revision_id: 'revision-3', revision_number: 3 })
  })

  it('publishes when a different-plan legacy orphan has the same revision number and id', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    const legacyOrphanPath = join(revisionsDir, '000002-shared-revision.json')
    const legacyOrphanRaw = revisionRaw(plan({
      plan_id: 'other-plan',
      revision_id: 'shared-revision',
      revision_number: 2,
    }))
    await writeFile(legacyOrphanPath, legacyOrphanRaw, 'utf8')

    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'shared-revision', revision_number: 2 }),
      { expected_current_revision_id: 'revision-1' },
    )).resolves.toMatchObject({
      plan_id: 'plan-1',
      revision_id: 'shared-revision',
      revision_number: 2,
    })

    expect(await readFile(legacyOrphanPath, 'utf8')).toBe(legacyOrphanRaw)
    expect((await readdir(revisionsDir)).filter((name) => name.startsWith('000002-'))).toHaveLength(2)
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      plan_id: 'plan-1',
      revision_id: 'shared-revision',
      revision_number: 2,
    })
  })

  it('publishes when a legal foreign legacy id collides with the old single-hyphen namespace shape', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    const target = plan({ revision_id: 'target-revision', revision_number: 2 })
    const targetPlanHash = createHash('sha256').update(target.plan_id).digest('hex')
    const foreign = plan({
      plan_id: 'other-plan',
      revision_id: `${targetPlanHash}-target-revision`,
      revision_number: 2,
    })
    const collidingLegacyPath = join(
      revisionsDir,
      `${String(foreign.revision_number).padStart(6, '0')}-${foreign.revision_id}.json`,
    )
    const foreignRaw = revisionRaw(foreign)
    await writeFile(collidingLegacyPath, foreignRaw, 'utf8')

    await expect(publishTaskPlanRevision(
      dir,
      target,
      { expected_current_revision_id: 'revision-1' },
    )).resolves.toMatchObject({
      plan_id: 'plan-1',
      revision_id: 'target-revision',
      revision_number: 2,
    })

    expect(await readFile(collidingLegacyPath, 'utf8')).toBe(foreignRaw)
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      plan_id: 'plan-1',
      revision_id: 'target-revision',
      revision_number: 2,
    })
  })

  it('reads and idempotently republishes a healthy legacy flat immutable without rewriting it', async () => {
    const dir = await changeDir()
    const current = plan()
    const revisionsDir = await seedCanonicalHistory(dir, [current], current)
    const legacyPath = join(revisionsDir, '000001-revision-1.json')
    const legacyRaw = await readFile(legacyPath, 'utf8')

    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      source: 'canonical',
      plan_id: 'plan-1',
      revision_id: 'revision-1',
      projection: { state: 'pending' },
    })
    await expect(publishTaskPlanRevision(
      dir,
      current,
      { expected_current_revision_id: 'revision-1' },
    )).resolves.toMatchObject({
      plan_id: 'plan-1',
      revision_id: 'revision-1',
      projection: { state: 'current' },
    })

    expect(await readFile(legacyPath, 'utf8')).toBe(legacyRaw)
    await expect(readFile(join(revisionsDir, canonicalRevisionFileName(current)), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed instead of accepting a reused id hidden behind a seven-digit revision number', async () => {
    const dir = await changeDir()
    const historical = plan({ revision_id: 'historical-big', revision_number: 1_000_000 })
    const current = plan({ revision_id: 'current-big', revision_number: 1_000_001 })
    await seedCanonicalHistory(dir, [historical, current], current)

    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'historical-big', revision_number: 1_000_002 }),
      { expected_current_revision_id: 'current-big' },
    )).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
    expect(await readFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), 'utf8')).toContain('current-big')
  })

  it('fails closed when the committed lineage already contains duplicate revision ids', async () => {
    const dir = await changeDir()
    const first = plan({ revision_id: 'reused-id' })
    const current = plan({ revision_id: 'reused-id', revision_number: 2 })
    await seedCanonicalHistory(dir, [first, current], current)

    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'fresh-id', revision_number: 3 }),
      { expected_current_revision_id: 'reused-id' },
    )).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
  })

  it.each([
    ['draft', () => plan({ status: 'draft' })],
    ['incomplete coverage', () => plan({
      requirements: [...plan().requirements, { id: 'req-uncovered', title: 'Must be covered' }],
    })],
    ['dependency cycle', () => plan({
      groups: [{ id: 'group-1', title: 'Build', parent_id: null, work_item_ids: ['wi-1', 'wi-2'] }],
      work_items: [
        { ...plan().work_items[0]!, depends_on: ['wi-2'] },
        {
          ...plan().work_items[0]!, id: 'wi-2', title: 'Second',
          requirement_refs: [], acceptance_refs: [], depends_on: ['wi-1'],
        },
      ],
    })],
  ])('fails closed before extending semantically invalid committed %s history', async (_case, fixture) => {
    const dir = await changeDir()
    const invalid = fixture()
    const revisionsDir = await seedCanonicalHistory(dir, [invalid], invalid)
    const currentPath = join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE)
    const currentBefore = await readFile(currentPath, 'utf8')
    const targetPath = join(revisionsDir, canonicalRevisionFileName(plan({
      revision_id: 'revision-2',
      revision_number: 2,
    })))

    await expect(readTaskPlanForChange(dir)).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'revision-2', revision_number: 2 }),
      { expected_current_revision_id: invalid.revision_id },
    )).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
    expect(await readFile(currentPath, 'utf8')).toBe(currentBefore)
    await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the committed lineage has a missing revision number', async () => {
    const dir = await changeDir()
    const first = plan()
    const current = plan({ revision_id: 'revision-3', revision_number: 3 })
    await seedCanonicalHistory(dir, [first, current], current)

    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'revision-4', revision_number: 4 }),
      { expected_current_revision_id: 'revision-3' },
    )).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
  })

  it('fails closed when a committed lineage filename disagrees with its content', async () => {
    const dir = await changeDir()
    const first = plan()
    const current = plan({ revision_id: 'revision-2', revision_number: 2 })
    const revisionsDir = await seedCanonicalHistory(dir, [current], current)
    await writeFile(join(revisionsDir, '000001-wrong-id.json'), `${JSON.stringify(first)}\n`, 'utf8')

    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'revision-3', revision_number: 3 }),
      { expected_current_revision_id: 'revision-2' },
    )).rejects.toBeInstanceOf(TaskPlanStateCorruptError)
  })

  it('fails closed when revision directory enumeration exceeds its entry budget', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    for (let index = 0; index < TASK_PLAN_LIMITS.maxRevisionHistoryEntries; index += 1) {
      await writeFile(join(revisionsDir, `orphan-${String(index).padStart(3, '0')}`), '', 'utf8')
    }

    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'revision-2', revision_number: 2 }),
      { expected_current_revision_id: 'revision-1' },
    )).rejects.toThrow('TaskPlan revision directory entry budget exceeded')
  })

  it('fails closed when revision history reads exceed their cumulative byte budget', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    let historyBytes = 0
    for (let index = 0; historyBytes <= TASK_PLAN_LIMITS.maxRevisionHistoryBytes; index += 1) {
      const requirements = Array.from({ length: 64 }, (_, itemIndex) => ({
        id: `req-${index}-${itemIndex}`,
        title: 'x'.repeat(7_000),
      }))
      const acceptance = Array.from({ length: 64 }, (_, itemIndex) => ({
        id: `acc-${index}-${itemIndex}`,
        title: 'y'.repeat(7_000),
      }))
      const orphan = plan({
        plan_id: `other-plan-${index}`,
        revision_id: `other-revision-${index}`,
        requirements,
        acceptance_criteria: acceptance,
        groups: [{ id: `group-${index}`, title: 'Build', parent_id: null, work_item_ids: [`wi-${index}`] }],
        work_items: [{
          id: `wi-${index}`, title: 'Implement', group_id: `group-${index}`,
          requirement_refs: requirements.map((entry) => entry.id),
          acceptance_refs: acceptance.map((entry) => entry.id), depends_on: [],
          resource_claims: [], expected_outputs: [], validators: [],
        }],
      })
      const raw = `${JSON.stringify(orphan)}\n`
      await writeFile(
        join(revisionsDir, `000001-${orphan.revision_id}.json`),
        raw,
        'utf8',
      )
      historyBytes += Buffer.byteLength(raw)
    }

    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'revision-2', revision_number: 2 }),
      { expected_current_revision_id: 'revision-1' },
    )).rejects.toThrow('TaskPlan revision history byte budget exceeded')
  })

  it('rejects a new target before writing when the committed lineage fills the entry budget', async () => {
    const dir = await changeDir()
    const lineage = Array.from({ length: TASK_PLAN_LIMITS.maxRevisionHistoryEntries }, (_, index) => plan({
      revision_id: `revision-${index + 1}`,
      revision_number: index + 1,
    }))
    const current = lineage[lineage.length - 1]!
    const revisionsDir = await seedCanonicalHistory(dir, lineage, current)
    const currentPath = join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE)
    const currentBefore = await readFile(currentPath, 'utf8')
    const target = plan({ revision_id: 'revision-257', revision_number: 257 })
    const targetPath = join(revisionsDir, canonicalRevisionFileName(target))

    await expect(publishTaskPlanRevision(dir, target, {
      expected_current_revision_id: current.revision_id,
    })).rejects.toBeInstanceOf(TaskPlanRevisionConflictError)
    await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(currentPath, 'utf8')).toBe(currentBefore)
  })

  it('rejects a new target before writing when only its raw bytes exceed the history byte budget', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    const currentPath = join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE)
    const currentBefore = await readFile(currentPath, 'utf8')
    const target = plan({ revision_id: 'revision-2', revision_number: 2 })
    const targetRaw = revisionRaw(target)
    const existingTargetBytes = TASK_PLAN_LIMITS.maxRevisionHistoryBytes - Buffer.byteLength(targetRaw) + 1
    await populateSizedOrphans(
      revisionsDir,
      18,
      existingTargetBytes - Buffer.byteLength(currentBefore),
    )

    await expect(publishTaskPlanRevision(dir, target, {
      expected_current_revision_id: 'revision-1',
    })).rejects.toBeInstanceOf(TaskPlanRevisionConflictError)
    await expect(readFile(join(revisionsDir, canonicalRevisionFileName(target)), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(currentPath, 'utf8')).toBe(currentBefore)
  }, 15_000)

  it('applies proposed admission to an initial publish with an orphan directory at the entry cap', async () => {
    const dir = await changeDir()
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    await mkdir(revisionsDir, { recursive: true })
    for (let index = 0; index < TASK_PLAN_LIMITS.maxRevisionHistoryEntries; index += 1) {
      await writeFile(join(revisionsDir, `orphan-${String(index).padStart(3, '0')}`), '', 'utf8')
    }

    await expect(publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null }))
      .rejects.toBeInstanceOf(TaskPlanRevisionConflictError)
    await expect(readFile(join(revisionsDir, canonicalRevisionFileName(plan())), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('rejects a single oversized proposed revision as a typed conflict before creating state', async () => {
    const dir = await changeDir()
    const oversized = plan({
      requirements: Array.from({ length: 140 }, (_, index) => ({
        id: `oversized-requirement-${index}`,
        title: 'x'.repeat(TASK_PLAN_LIMITS.maxTextBytes),
      })),
    })

    await expect(publishTaskPlanRevision(dir, oversized, { expected_current_revision_id: null }))
      .rejects.toBeInstanceOf(TaskPlanRevisionConflictError)
    await expect(readFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('validates corrupted history before an exact-current republish and leaves projection untouched', async () => {
    const dir = await changeDir()
    const first = plan({ revision_id: 'reused-id' })
    const current = plan({ revision_id: 'reused-id', revision_number: 2 })
    await seedCanonicalHistory(dir, [first, current], current)
    await writeFile(join(dir, 'tasks.md'), 'projection sentinel\n', 'utf8')

    await expect(publishTaskPlanRevision(dir, current, { expected_current_revision_id: 'reused-id' }))
      .rejects.toBeInstanceOf(TaskPlanStateCorruptError)
    expect(await readFile(join(dir, 'tasks.md'), 'utf8')).toBe('projection sentinel\n')
  })

  it('allows an exact-current republish after validating a healthy committed lineage', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    const current = plan({ revision_id: 'revision-2', revision_number: 2 })
    await publishTaskPlanRevision(dir, current, { expected_current_revision_id: 'revision-1' })

    await expect(publishTaskPlanRevision(dir, current, { expected_current_revision_id: 'revision-2' }))
      .resolves.toMatchObject({ revision_id: 'revision-2', projection: { state: 'current' } })
  })

  it('fails closed when an exact-current republish finds its id reused by another same-plan immutable', async () => {
    const dir = await changeDir()
    const current = plan()
    await publishTaskPlanRevision(dir, current, { expected_current_revision_id: null })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    await writeFile(
      join(revisionsDir, '000009-revision-1.json'),
      revisionRaw(plan({ revision_id: 'revision-1', revision_number: 9 })),
      'utf8',
    )
    const currentPath = join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE)
    const currentBefore = await readFile(currentPath, 'utf8')
    await writeFile(join(dir, 'tasks.md'), 'projection sentinel\n', 'utf8')

    await expect(publishTaskPlanRevision(dir, current, { expected_current_revision_id: 'revision-1' }))
      .rejects.toBeInstanceOf(TaskPlanStateCorruptError)
    expect(await readFile(currentPath, 'utf8')).toBe(currentBefore)
    expect(await readFile(join(dir, 'tasks.md'), 'utf8')).toBe('projection sentinel\n')
  })

  it('counts an identical pre-existing target only once across entry, read, and byte admission budgets', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    const currentRaw = await readFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), 'utf8')
    const target = plan({ revision_id: 'revision-2', revision_number: 2 })
    const targetRaw = revisionRaw(target)
    await writeFile(join(revisionsDir, '000002-revision-2.json'), targetRaw, 'utf8')
    const orphanCount = TASK_PLAN_LIMITS.maxRevisionHistoryEntries - 2
    const existingTargetBytes = TASK_PLAN_LIMITS.maxRevisionHistoryBytes - Buffer.byteLength(targetRaw) + 1
    await populateSizedOrphans(
      revisionsDir,
      orphanCount,
      existingTargetBytes - Buffer.byteLength(currentRaw) - Buffer.byteLength(targetRaw),
    )

    await expect(publishTaskPlanRevision(dir, target, { expected_current_revision_id: 'revision-1' }))
      .resolves.toMatchObject({ revision_id: 'revision-2', revision_number: 2 })
    expect(await readFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), 'utf8')).toBe(targetRaw)
  })

  it('rejects a proposed revision number preoccupied by a different same-plan future orphan', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    const currentPath = join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE)
    const currentBefore = await readFile(currentPath, 'utf8')
    const orphan = plan({ revision_id: 'orphan-revision-2', revision_number: 2 })
    const orphanPath = join(revisionsDir, '000002-orphan-revision-2.json')
    const orphanRaw = revisionRaw(orphan)
    await writeFile(orphanPath, orphanRaw, 'utf8')
    const targetPath = join(revisionsDir, canonicalRevisionFileName(plan({
      revision_id: 'target-revision-2',
      revision_number: 2,
    })))

    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'target-revision-2', revision_number: 2 }),
      { expected_current_revision_id: 'revision-1' },
    )).rejects.toBeInstanceOf(TaskPlanRevisionConflictError)
    expect(await readFile(currentPath, 'utf8')).toBe(currentBefore)
    await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(orphanPath, 'utf8')).toBe(orphanRaw)
  })

  it('rejects a proposed revision id reserved by a different same-plan future immutable', async () => {
    const dir = await changeDir()
    await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    const revisionsDir = join(dir, TASK_PLAN_STATE_DIR, 'revisions')
    const currentPath = join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE)
    const orphan = plan({ revision_id: 'reserved-revision-id', revision_number: 9 })
    const orphanPath = join(revisionsDir, '000009-reserved-revision-id.json')
    const orphanRaw = revisionRaw(orphan)
    await writeFile(orphanPath, orphanRaw, 'utf8')
    const targetPath = join(revisionsDir, canonicalRevisionFileName(plan({
      revision_id: 'reserved-revision-id',
      revision_number: 2,
    })))

    const currentBefore = await readFile(currentPath, 'utf8')
    await expect(publishTaskPlanRevision(
      dir,
      plan({ revision_id: 'reserved-revision-id', revision_number: 2 }),
      { expected_current_revision_id: 'revision-1' },
    )).rejects.toBeInstanceOf(TaskPlanRevisionConflictError)
    expect(await readFile(currentPath, 'utf8')).toBe(currentBefore)
    await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(orphanPath, 'utf8')).toBe(orphanRaw)
  })

  it('reports projection pending after current commits but tasks.md publication fails', async () => {
    const dir = await changeDir()
    await mkdir(join(dir, 'tasks.md'))
    const published = await publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null })
    expect(published).toMatchObject({
      source: 'canonical', revision_id: 'revision-1', projection: { state: 'pending' },
    })
    expect(await readFile(join(dir, TASK_PLAN_STATE_DIR, TASK_PLAN_CURRENT_FILE), 'utf8')).toContain('revision-1')
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      source: 'canonical', revision_id: 'revision-1', projection: { state: 'drift' },
    })
    await rm(join(dir, 'tasks.md'), { recursive: true })
    await expect(publishTaskPlanRevision(dir, plan(), { expected_current_revision_id: null }))
      .resolves.toMatchObject({ projection: { state: 'current' } })
  })

  it('keeps a valid projection above the legacy 256 KiB ceiling readable and current', async () => {
    const dir = await changeDir()
    const itemIds = Array.from({ length: 40 }, (_, index) => `wi-${index}`)
    const largeProjection = plan({
      requirements: [],
      acceptance_criteria: [],
      groups: [{ id: 'group-1', title: 'Build', parent_id: null, work_item_ids: itemIds }],
      work_items: itemIds.map((id, index) => ({
        id,
        title: `${index}-` + 'x'.repeat(8_100),
        group_id: 'group-1',
        requirement_refs: [],
        acceptance_refs: [],
        depends_on: [],
        resource_claims: [],
        expected_outputs: [],
        validators: [],
      })),
    })

    const published = await publishTaskPlanRevision(
      dir,
      largeProjection,
      { expected_current_revision_id: null },
    )
    expect(Buffer.byteLength(await readFile(join(dir, 'tasks.md')))).toBeGreaterThan(256 * 1024)
    expect(published).toMatchObject({ projection: { state: 'current' } })
    await expect(readTaskPlanForChange(dir)).resolves.toMatchObject({
      revision_id: 'revision-1', projection: { state: 'current' },
    })
  })
})
