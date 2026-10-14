import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { COMPANION_BACKED_FIELDS } from '../types.js'
import { clearReviewGatePatch } from './review-gate.js'
import { readCurrentRunRevisionFromSync, readCurrentRunRevisionSync } from './run-revision-store.js'
import { createStateStore } from './store.js'
import { createTransitionRecordStore } from './transition-record-store.js'
import { createWorkflowRunRepository } from './workflow-run-repository.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const
const SHA = '0123456789abcdef0123456789abcdef01234567'

/** Frozen closed-schema reader of the previous release; the release bundle gate runs the same file. */
const N_MINUS_ONE_READER = fileURLToPath(
  new URL('../../../../tools/fixtures/n-minus-one-canonical-reader.mjs', import.meta.url),
)
const clock = () => '2026-10-11T00:00:00Z'
const roots: string[] = []

interface WireEffect {
  readonly kind: string
  readonly field: string
  readonly from: unknown
  readonly to: unknown
}

interface WireRevision {
  revision: number
  revisionId: string
  previousRevisionId?: string
  stateDigest: string
  state: { fields: Record<string, unknown>; opaqueTail: string; runMetadata?: unknown }
  mutation: { kind: string; observedAt: string; effects: WireEffect[] }
}

/** `null` = no start point recorded (repository without a commit): `init` gets no `startSha`. */
async function fresh(startSha: string | null = SHA): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pl-start-sha-'))
  roots.push(root)
  return createStateStore().init({
    repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock,
    runId: 'run-1', ...(startSha === null ? {} : { startSha }),
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const currentPath = (dir: string): string => join(dir, '.pipeline-run', 'current.json')
const yamlPath = (dir: string): string => join(dir, '.pipeline.yaml')

async function readWire(dir: string): Promise<WireRevision> {
  return JSON.parse(await readFile(currentPath(dir), 'utf8')) as WireRevision
}

function revisionFile(record: WireRevision): string {
  return `${String(record.revision).padStart(6, '0')}-${record.revisionId}.json`
}

function companionPath(dir: string, record: WireRevision): string {
  return join(dir, '.pipeline-run', 'start-sha', revisionFile(record))
}

function rehash(record: WireRevision): void {
  const { stateDigest: _old, ...body } = record
  record.stateDigest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

async function publishWire(dir: string, record: WireRevision): Promise<void> {
  const raw = JSON.stringify(record)
  await writeFile(join(dir, '.pipeline-run', 'revisions', revisionFile(record)), raw, 'utf8')
  await writeFile(currentPath(dir), raw, 'utf8')
}

/** The pre-Verify companion binds the revision's stateDigest, so a hand-edited wire must re-bind it. */
async function rebindPreVerifyCompanion(dir: string, record: WireRevision): Promise<void> {
  const pathname = join(dir, '.pipeline-run', 'pre-verify-review', revisionFile(record))
  const companion = JSON.parse(await readFile(pathname, 'utf8')) as Record<string, unknown>
  companion.stateDigest = record.stateDigest
  await writeFile(pathname, `${JSON.stringify(companion)}\n`, 'utf8')
}

function nMinusOnePhase(dir: string): string {
  return execFileSync(process.execPath, [N_MINUS_ONE_READER, currentPath(dir)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function nMinusOneFailure(dir: string): Promise<string> {
  try {
    nMinusOnePhase(dir)
    return ''
  } catch (error) {
    return String(error)
  }
}

describe('start_sha is a companion-backed logical field', () => {
  test('COMPANION_BACKED_FIELDS lists start_sha next to the other companion fields', () => {
    expect(COMPANION_BACKED_FIELDS).toContain('start_sha')
  })

  test('new change: wire, projection and N-1 reader keep the old closure; the companion carries the sha', async () => {
    const dir = await fresh()
    const store = createStateStore()
    const wire = await readWire(dir)

    expect(wire.state.fields).not.toHaveProperty('start_sha')
    expect(await readFile(yamlPath(dir), 'utf8')).not.toContain('start_sha')
    expect(JSON.parse(await readFile(companionPath(dir, wire), 'utf8'))).toEqual({
      schemaVersion: 1,
      revision: wire.revision,
      revisionId: wire.revisionId,
      stateDigest: wire.stateDigest,
      sha: SHA,
    })
    expect((await store.read(dir)).fields.start_sha).toBe(SHA)
    expect(await store.get(dir, 'start_sha')).toBe(SHA)
    expect(readCurrentRunRevisionSync(dir)?.state.fields.start_sha).toBe(SHA)
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current' })
    expect(nMinusOnePhase(dir)).toBe('open')
  })

  test('a change without a start point has no companion directory and reads an empty start_sha', async () => {
    const dir = await fresh(null)
    const store = createStateStore()

    expect(await readdir(join(dir, '.pipeline-run'))).not.toContain('start-sha')
    expect((await store.read(dir)).fields.start_sha).toBe('')

    await store.set(dir, 'scope', 'unrelated')
    expect(await readdir(join(dir, '.pipeline-run'))).not.toContain('start-sha')
    expect((await store.read(dir)).fields.start_sha).toBe('')
  })

  test('every later revision re-publishes the companion; effects, TransitionRecord and projection stay N-1', async () => {
    const dir = await fresh()
    const store = createStateStore()

    await store.set(dir, 'scope', 'unrelated')
    const afterSet = await readWire(dir)
    expect(afterSet.revision).toBe(1)
    expect(afterSet.state.fields).not.toHaveProperty('start_sha')
    expect(afterSet.mutation.effects.map((effect) => effect.field)).toEqual(['scope'])
    expect(JSON.parse(await readFile(companionPath(dir, afterSet), 'utf8')))
      .toMatchObject({ sha: SHA, revision: 1, stateDigest: afterSet.stateDigest })
    expect((await store.read(dir)).fields.start_sha).toBe(SHA)
    expect(await readFile(yamlPath(dir), 'utf8')).not.toContain('start_sha')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current' })

    const repo = createWorkflowRunRepository({
      store, recordStore: createTransitionRecordStore(), clock, newId: () => 'record-start-sha',
    })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, ...clearReviewGatePatch(), phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    const record = JSON.parse(await readFile(
      join(dir, '.pipeline-transitions', '000001-record-start-sha.json'), 'utf8',
    )) as { effects: WireEffect[] }
    expect(record.effects.map((effect) => effect.field)).toContain('phase')
    expect(record.effects.map((effect) => effect.field)).not.toContain('start_sha')
    const consumed = await readWire(dir)
    expect(consumed.mutation.effects).toEqual(record.effects)
    expect(consumed.state.fields).not.toHaveProperty('start_sha')
    expect((await store.read(dir)).fields.start_sha).toBe(SHA)
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current' })
    expect(nMinusOnePhase(dir)).toBe('explore')
  })

  test('the synchronous reader restores start_sha through the injected text reader', async () => {
    const dir = await fresh()
    const wire = await readWire(dir)
    const requested: string[] = []
    const readText = (relativePath: string): string | undefined => {
      requested.push(relativePath)
      return existsSync(join(dir, relativePath)) ? readFileSync(join(dir, relativePath), 'utf8') : undefined
    }

    const revision = readCurrentRunRevisionFromSync(readText, dir)

    expect(revision?.state.fields.start_sha).toBe(SHA)
    expect(requested).toContain(join('.pipeline-run', 'start-sha', revisionFile(wire)))
  })

  test('the synchronous reader reads an empty start_sha when the injected reader has no record', async () => {
    const dir = await fresh()
    const readText = (relativePath: string): string | undefined => {
      if (relativePath.includes('start-sha') || !existsSync(join(dir, relativePath))) return undefined
      return readFileSync(join(dir, relativePath), 'utf8')
    }

    expect(readCurrentRunRevisionFromSync(readText, dir)?.state.fields.start_sha).toBe('')
  })

  test('a malformed record fails loud through the synchronous reader too', async () => {
    const dir = await fresh()
    const wire = await readWire(dir)
    await writeFile(companionPath(dir, wire), '{not json', 'utf8')

    expect(() => readCurrentRunRevisionSync(dir)).toThrow(/start_sha companion JSON 损坏/)
  })
})

describe('start_sha companion integrity', () => {
  test('a missing record reads as an empty start_sha, and later writes keep working', async () => {
    const dir = await fresh()
    const store = createStateStore()
    await unlink(companionPath(dir, await readWire(dir)))

    expect((await store.read(dir)).fields.start_sha).toBe('')
    await store.set(dir, 'scope', 'after-missing')
    expect((await store.read(dir)).fields.start_sha).toBe('')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current' })
  })

  test('a record bound to another revision identity or digest fails loud', async () => {
    const dir = await fresh()
    const store = createStateStore()
    const pathname = companionPath(dir, await readWire(dir))
    const original = JSON.parse(await readFile(pathname, 'utf8')) as Record<string, unknown>

    await writeFile(pathname, `${JSON.stringify({ ...original, stateDigest: 'f'.repeat(64) })}\n`, 'utf8')
    await expect(store.read(dir)).rejects.toThrow(/start_sha companion.*身份\/摘要/)
    expect(() => readCurrentRunRevisionSync(dir)).toThrow(/start_sha companion.*身份\/摘要/)

    await writeFile(pathname, `${JSON.stringify({ ...original, revisionId: 'another-revision' })}\n`, 'utf8')
    await expect(store.read(dir)).rejects.toThrow(/start_sha companion.*身份\/摘要/)

    await writeFile(pathname, `${JSON.stringify({ ...original, revision: 7 })}\n`, 'utf8')
    await expect(store.read(dir)).rejects.toThrow(/start_sha companion.*身份\/摘要/)
  })

  test('a tampered sha or shape fails loud', async () => {
    const dir = await fresh()
    const store = createStateStore()
    const pathname = companionPath(dir, await readWire(dir))
    const original = JSON.parse(await readFile(pathname, 'utf8')) as Record<string, unknown>

    for (const sha of ['HEAD', 'main', SHA.toUpperCase(), SHA.slice(0, 39), '', 7]) {
      await writeFile(pathname, `${JSON.stringify({ ...original, sha })}\n`, 'utf8')
      await expect(store.read(dir)).rejects.toThrow(/start_sha companion 形状非法/)
    }
    await writeFile(pathname, `${JSON.stringify({ ...original, extra: true })}\n`, 'utf8')
    await expect(store.read(dir)).rejects.toThrow(/start_sha companion 形状非法/)
    await writeFile(pathname, `${JSON.stringify({ schemaVersion: 1, revision: 0 })}\n`, 'utf8')
    await expect(store.read(dir)).rejects.toThrow(/start_sha companion 形状非法/)
    await writeFile(pathname, '[]\n', 'utf8')
    await expect(store.read(dir)).rejects.toThrow(/start_sha companion 不是对象/)
    await writeFile(pathname, '{not json', 'utf8')
    await expect(store.read(dir)).rejects.toThrow(/start_sha companion JSON 损坏/)
  })

  test('a symlinked record is refused', async () => {
    const dir = await fresh()
    const store = createStateStore()
    const pathname = companionPath(dir, await readWire(dir))
    const copy = join(dir, 'start-sha-copy.json')
    await writeFile(copy, await readFile(pathname, 'utf8'), 'utf8')
    await unlink(pathname)
    await symlink(copy, pathname)

    await expect(store.read(dir)).rejects.toThrow(/start_sha companion 必须是非 symlink 普通文件/)
  })

  test('an unpublishable start_sha is rejected before any canonical bytes change', async () => {
    const dir = await fresh()
    const before = await readFile(currentPath(dir), 'utf8')

    await expect(createStateStore().set(dir, 'start_sha', 'HEAD')).rejects.toThrow(/start_sha 非法/)
    expect(await readFile(currentPath(dir), 'utf8')).toBe(before)
    expect(await readdir(join(dir, '.pipeline-run', 'revisions'))).toHaveLength(1)
    expect((await readdir(join(dir, '.pipeline-run', 'start-sha')))).toHaveLength(1)
  })
})

describe('development-build and N-1 revisions', () => {
  /** Reshape the latest revision into the development-build form: start_sha inside the wire, no record, YAML line. */
  async function reshapeAsDevelopmentBuild(dir: string): Promise<WireRevision> {
    const legacy = await readWire(dir)
    await unlink(companionPath(dir, legacy))
    legacy.state.fields.start_sha = SHA
    rehash(legacy)
    await rebindPreVerifyCompanion(dir, legacy)
    await publishWire(dir, legacy)
    const yaml = await readFile(yamlPath(dir), 'utf8')
    await writeFile(yamlPath(dir), yaml
      .replace(/^(pipeline_run_id: .*\n)/m, `start_sha: ${SHA}\n$1`)
      .replace(/pipeline_state_digest: [0-9a-f]{64}/, `pipeline_state_digest: ${legacy.stateDigest}`), 'utf8')
    return legacy
  }

  test('a development-build wire carrying start_sha decodes, keeps its projection current and is rewritten on the next write', async () => {
    const dir = await fresh()
    const store = createStateStore()
    // A non-default pre-Verify value keeps the YAML from matching the generic "older release omitted a
    // tail field" shape, so the projection can only stay current through the development-build shape.
    await store.set(dir, 'pre_verify_review_result', 'pass')
    const legacy = await reshapeAsDevelopmentBuild(dir)

    expect((await store.read(dir)).fields.start_sha).toBe(SHA)
    expect((await store.read(dir)).fields.pre_verify_review_result).toBe('pass')
    expect(readCurrentRunRevisionSync(dir)?.state.fields.start_sha).toBe(SHA)
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current', revision: legacy.revision })
    expect(await nMinusOneFailure(dir)).toMatch(/start_sha/)

    await store.set(dir, 'assignee', 'after-development-build')
    const upgraded = await readWire(dir)
    expect(upgraded.revision).toBe(legacy.revision + 1)
    expect(upgraded.state.fields).not.toHaveProperty('start_sha')
    expect(upgraded.mutation.effects.map((effect) => effect.field)).toEqual(['assignee'])
    expect(JSON.parse(await readFile(companionPath(dir, upgraded), 'utf8')))
      .toMatchObject({ sha: SHA, stateDigest: upgraded.stateDigest })
    expect((await store.read(dir)).fields.start_sha).toBe(SHA)
    expect((await store.read(dir)).fields.pre_verify_review_result).toBe('pass')
    expect(await readFile(yamlPath(dir), 'utf8')).not.toContain('start_sha')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current' })
    expect(nMinusOnePhase(dir)).toBe('open')
  })

  test('a development-build projection stays a known stale shape after the next canonical write', async () => {
    const dir = await fresh()
    const store = createStateStore()
    await store.set(dir, 'pre_verify_review_result', 'pass')
    await reshapeAsDevelopmentBuild(dir)
    const injected = createStateStore({
      writeProjection: async () => { throw new Error('projection write failed') },
    })

    const state = await injected.read(dir)
    state.fields.assignee = 'projection-lags'
    const outcome = await injected.write(dir, state, { kind: 'set' })

    expect(outcome.projection).toMatchObject({ status: 'pending' })
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'stale' })
    await expect(store.repairProjection(dir)).resolves.toMatchObject({ status: 'current' })
    expect(await readFile(yamlPath(dir), 'utf8')).not.toContain('start_sha')
  })

  test('a development-build projection with a different sha is drift, not a known shape', async () => {
    const dir = await fresh()
    const store = createStateStore()
    await store.set(dir, 'pre_verify_review_result', 'pass')
    await reshapeAsDevelopmentBuild(dir)
    const yaml = await readFile(yamlPath(dir), 'utf8')
    await writeFile(yamlPath(dir), yaml.replace(`start_sha: ${SHA}`, `start_sha: ${'f'.repeat(40)}`), 'utf8')

    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'drift' })
  })

  test('an N-1 rewrite falls back to an empty start_sha and keeps later writes working', async () => {
    const dir = await fresh()
    const store = createStateStore()

    // What the previous release writes: the same closed field set, no companions, a projection
    // pinned to its own revision.
    const previous = await readWire(dir)
    const next = structuredClone(previous)
    next.revision = previous.revision + 1
    next.revisionId = 'n-minus-one-next'
    next.previousRevisionId = previous.revisionId
    next.state.fields.assignee = 'n1-write'
    next.mutation = {
      kind: 'set',
      observedAt: clock(),
      effects: [{ kind: 'state-field-change', field: 'assignee', from: previous.state.fields.assignee, to: 'n1-write' }],
    }
    rehash(next)
    await publishWire(dir, next)
    const yaml = await readFile(yamlPath(dir), 'utf8')
    await writeFile(yamlPath(dir), yaml
      .replace(/^assignee:.*\n/m, 'assignee: n1-write\n')
      .replace(/^pipeline_state_revision: \d+$/m, `pipeline_state_revision: ${next.revision}`)
      .replace(/^pipeline_state_revision_id: .*$/m, `pipeline_state_revision_id: ${next.revisionId}`)
      .replace(/pipeline_state_digest: [0-9a-f]{64}/, `pipeline_state_digest: ${next.stateDigest}`), 'utf8')

    const state = await store.read(dir)
    expect(state.fields.start_sha).toBe('')
    expect(state.fields.assignee).toBe('n1-write')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current', revision: next.revision })
    expect(nMinusOnePhase(dir)).toBe('open')

    await store.set(dir, 'related_files', 'current-after-n1')
    const resumed = await store.read(dir)
    expect(resumed.fields.related_files).toBe('current-after-n1')
    expect(resumed.fields.start_sha).toBe('')
    expect(await readdir(join(dir, '.pipeline-run', 'start-sha'))).toHaveLength(1)
    expect(nMinusOnePhase(dir)).toBe('open')
  })
})

describe('legacy import keeps the start point', () => {
  test('import-legacy keeps start_sha and does not report it as an ignored edit', async () => {
    const dir = await fresh()
    const store = createStateStore()
    const yaml = await readFile(yamlPath(dir), 'utf8')
    await writeFile(yamlPath(dir), yaml.replace('phase: open\n', 'phase: explore\n'), 'utf8')

    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'drift' })
    const imported = await store.importLegacyProjection(dir)

    expect(imported.ignoredProtectedFields).toEqual(['phase'])
    expect(await store.get(dir, 'start_sha')).toBe(SHA)
    expect(await store.get(dir, 'phase')).toBe('open')
    const wire = await readWire(dir)
    expect(JSON.parse(await readFile(companionPath(dir, wire), 'utf8'))).toMatchObject({ sha: SHA })
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current' })
  })

  test('a legacy YAML that states a different start_sha is reported and ignored', async () => {
    const dir = await fresh()
    const store = createStateStore()
    const yaml = await readFile(yamlPath(dir), 'utf8')
    await writeFile(yamlPath(dir), yaml.replace(/^(pipeline_run_id: .*\n)/m, `start_sha: ${'e'.repeat(40)}\n$1`), 'utf8')

    const imported = await store.importLegacyProjection(dir)

    expect(imported.ignoredProtectedFields).toEqual(['start_sha'])
    expect(await store.get(dir, 'start_sha')).toBe(SHA)
  })
})
