import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  clearReviewGatePatch,
  reviewGateApprovalPatch,
  reviewGateRequestPatch,
  type ReviewAcknowledgedVia,
} from './review-gate.js'
import { readCurrentRunRevisionSync } from './run-revision-store.js'
import { createStateStore } from './store.js'
import { createTransitionRecordStore } from './transition-record-store.js'
import { createWorkflowRunRepository } from './workflow-run-repository.js'

/** Frozen closed-schema reader of the previous release; the release bundle gate runs the same file. */
const N_MINUS_ONE_READER = fileURLToPath(
  new URL('../../../../tools/fixtures/n-minus-one-canonical-reader.mjs', import.meta.url),
)
const clock = () => '2026-09-15T00:00:00Z'
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

async function fresh(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pl-review-channel-'))
  roots.push(root)
  return createStateStore().init({
    repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', preset: 'full', clock,
    runId: 'run-1',
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const currentPath = (dir: string): string => join(dir, '.pipeline-run', 'current.json')

async function readWire(dir: string): Promise<WireRevision> {
  return JSON.parse(await readFile(currentPath(dir), 'utf8')) as WireRevision
}

function revisionFile(record: WireRevision): string {
  return `${String(record.revision).padStart(6, '0')}-${record.revisionId}.json`
}

function channelCompanionPath(dir: string, record: WireRevision): string {
  return join(dir, '.pipeline-run', 'review-acknowledged-via', revisionFile(record))
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

async function rebindPreVerifyCompanion(dir: string, record: WireRevision): Promise<void> {
  const pathname = join(dir, '.pipeline-run', 'pre-verify-review', revisionFile(record))
  const companion = JSON.parse(await readFile(pathname, 'utf8')) as Record<string, unknown>
  companion.stateDigest = record.stateDigest
  await writeFile(pathname, `${JSON.stringify(companion)}\n`, 'utf8')
}

function nMinusOnePhase(dir: string): string {
  return execFileSync(process.execPath, [N_MINUS_ONE_READER, currentPath(dir)], { encoding: 'utf8' }).trim()
}

async function acknowledge(dir: string, via: ReviewAcknowledgedVia): Promise<void> {
  const store = createStateStore()
  await store.setMany(dir, reviewGateRequestPatch('open', 'open-complete', clock()))
  await store.setMany(dir, reviewGateApprovalPatch('2026-09-15T00:01:00Z', via))
}

describe('review_acknowledged_via companion keeps the N-1 canonical closure', () => {
  test('fresh change: wire and projection omit the channel, no companion, N-1 reader accepts it', async () => {
    const dir = await fresh()
    const wire = await readWire(dir)

    expect(wire.state.fields).not.toHaveProperty('review_acknowledged_via')
    expect(await readFile(join(dir, '.pipeline.yaml'), 'utf8')).not.toContain('review_acknowledged_via')
    expect(await readdir(join(dir, '.pipeline-run'))).not.toContain('review-acknowledged-via')
    expect((await createStateStore().read(dir)).fields.review_acknowledged_via).toBe('unknown')
    expect(nMinusOnePhase(dir)).toBe('open')
  })

  test.each(['terminal', 'dashboard'] as const)(
    'acknowledged via %s: logical channel comes from the companion; wire, projection, effects and TransitionRecord stay N-1',
    async (via) => {
      const dir = await fresh()
      const store = createStateStore()
      await acknowledge(dir, via)

      const wire = await readWire(dir)
      expect(wire.state.fields).not.toHaveProperty('review_acknowledged_via')
      expect(wire.state.fields.review_gate_status).toBe('approved')
      expect(wire.mutation.effects.map((effect) => effect.field)).toContain('review_gate_status')
      expect(wire.mutation.effects.map((effect) => effect.field)).not.toContain('review_acknowledged_via')
      expect(JSON.parse(await readFile(channelCompanionPath(dir, wire), 'utf8'))).toEqual({
        schemaVersion: 1,
        revision: wire.revision,
        revisionId: wire.revisionId,
        stateDigest: wire.stateDigest,
        via,
      })
      expect((await store.read(dir)).fields.review_acknowledged_via).toBe(via)
      expect(readCurrentRunRevisionSync(dir)?.state.fields.review_acknowledged_via).toBe(via)
      const projection = await readFile(join(dir, '.pipeline.yaml'), 'utf8')
      expect(projection).toContain('review_gate_status: approved\n')
      expect(projection).not.toContain('review_acknowledged_via')
      expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current' })
      expect(nMinusOnePhase(dir)).toBe('open')

      await store.set(dir, 'assignee', 'after-acknowledge')
      expect((await store.read(dir)).fields.review_acknowledged_via).toBe(via)

      const repo = createWorkflowRunRepository({
        store, recordStore: createTransitionRecordStore(), clock, newId: () => `record-${via}`,
      })
      await repo.transact(dir, async (tx) => {
        await tx.commit({ ...tx.state.fields, ...clearReviewGatePatch(), phase: 'explore' }, {
          event: 'open-complete', from: 'open', to: 'explore',
        })
      })
      const record = JSON.parse(await readFile(
        join(dir, '.pipeline-transitions', `000001-record-${via}.json`), 'utf8',
      )) as { effects: WireEffect[] }
      const fields = record.effects.map((effect) => effect.field)
      expect(fields).toEqual(expect.arrayContaining(['phase', 'review_gate_status']))
      expect(fields).not.toContain('review_acknowledged_via')
      const consumed = await readWire(dir)
      expect(consumed.mutation.effects).toEqual(record.effects)
      expect(consumed.state.fields).not.toHaveProperty('review_acknowledged_via')
      expect((await store.read(dir)).fields.review_acknowledged_via).toBe('unknown')
      expect(nMinusOnePhase(dir)).toBe('explore')
    },
  )

  test('a missing companion reads unknown; a mismatched or malformed one fails loud', async () => {
    const dir = await fresh()
    const store = createStateStore()
    await acknowledge(dir, 'dashboard')
    const pathname = channelCompanionPath(dir, await readWire(dir))
    const original = JSON.parse(await readFile(pathname, 'utf8')) as Record<string, unknown>

    await writeFile(pathname, `${JSON.stringify({ ...original, stateDigest: 'f'.repeat(64) })}\n`, 'utf8')
    await expect(store.read(dir)).rejects.toThrow(/review channel companion.*身份\/摘要/)
    expect(() => readCurrentRunRevisionSync(dir)).toThrow(/review channel companion.*身份\/摘要/)

    await writeFile(pathname, `${JSON.stringify({ ...original, via: 'human' })}\n`, 'utf8')
    await expect(store.read(dir)).rejects.toThrow(/review channel companion 形状非法/)

    await unlink(pathname)
    const recovered = await store.read(dir)
    expect(recovered.fields.review_acknowledged_via).toBe('unknown')
    expect(recovered.fields.review_gate_status).toBe('approved')
  })

  test('an unpublishable channel value is rejected before any canonical bytes change', async () => {
    const dir = await fresh()
    const before = await readFile(currentPath(dir), 'utf8')

    await expect(createStateStore().set(dir, 'review_acknowledged_via', 'human'))
      .rejects.toThrow(/review_acknowledged_via 非法/)
    expect(await readFile(currentPath(dir), 'utf8')).toBe(before)
    expect(await readdir(join(dir, '.pipeline-run', 'revisions'))).toHaveLength(1)
  })

  test('development-build wire with the channel in state.fields decodes, keeps its projection current and is rewritten on the next write', async () => {
    const dir = await fresh()
    const store = createStateStore()
    await store.set(dir, 'pre_verify_review_result', 'pass')
    await acknowledge(dir, 'dashboard')

    // Reshape the latest revision into the development-build form: channel inside the wire field
    // closure and effects, no channel companion, projection with the channel line.
    const legacy = await readWire(dir)
    await unlink(channelCompanionPath(dir, legacy))
    legacy.state.fields.review_acknowledged_via = 'dashboard'
    legacy.mutation.effects.push({
      kind: 'state-field-change', field: 'review_acknowledged_via', from: 'unknown', to: 'dashboard',
    })
    rehash(legacy)
    await rebindPreVerifyCompanion(dir, legacy)
    await publishWire(dir, legacy)
    const yamlPath = join(dir, '.pipeline.yaml')
    const yaml = await readFile(yamlPath, 'utf8')
    await writeFile(yamlPath, yaml
      .replace(/^(review_acknowledged_at: .*\n)/m, '$1review_acknowledged_via: dashboard\n')
      .replace(/pipeline_state_digest: [0-9a-f]{64}/, `pipeline_state_digest: ${legacy.stateDigest}`), 'utf8')

    const decoded = await store.read(dir)
    expect(decoded.fields.review_acknowledged_via).toBe('dashboard')
    expect(decoded.fields.pre_verify_review_result).toBe('pass')
    expect(readCurrentRunRevisionSync(dir)?.state.fields.review_acknowledged_via).toBe('dashboard')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current', revision: legacy.revision })

    await store.set(dir, 'assignee', 'after-legacy')
    const upgraded = await readWire(dir)
    expect(upgraded.revision).toBe(legacy.revision + 1)
    expect(upgraded.state.fields).not.toHaveProperty('review_acknowledged_via')
    expect(upgraded.mutation.effects.map((effect) => effect.field)).not.toContain('review_acknowledged_via')
    expect(JSON.parse(await readFile(channelCompanionPath(dir, upgraded), 'utf8')))
      .toMatchObject({ via: 'dashboard', stateDigest: upgraded.stateDigest })
    const after = await store.read(dir)
    expect(after.fields.review_acknowledged_via).toBe('dashboard')
    expect(after.fields.pre_verify_review_result).toBe('pass')
    expect(await readFile(yamlPath, 'utf8')).not.toContain('review_acknowledged_via')
    expect(nMinusOnePhase(dir)).toBe('open')
  })

  test('an N-1 rewrite after an acknowledgement falls back to unknown and keeps later writes working', async () => {
    const dir = await fresh()
    const store = createStateStore()
    await acknowledge(dir, 'dashboard')

    // What the previous release writes: the same closed field set, the preserved opaqueTail (now a
    // stale pre-Verify anchor), no companions, and a projection pinned to its own revision.
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
    const yamlPath = join(dir, '.pipeline.yaml')
    const yaml = await readFile(yamlPath, 'utf8')
    await writeFile(yamlPath, yaml
      .replace(/^assignee:.*\n/m, 'assignee: n1-write\n')
      .replace(/^pipeline_state_revision: \d+$/m, `pipeline_state_revision: ${next.revision}`)
      .replace(/^pipeline_state_revision_id: .*$/m, `pipeline_state_revision_id: ${next.revisionId}`)
      .replace(/pipeline_state_digest: [0-9a-f]{64}/, `pipeline_state_digest: ${next.stateDigest}`), 'utf8')

    const state = await store.read(dir)
    expect(state.fields.review_acknowledged_via).toBe('unknown')
    expect(state.fields.review_gate_status).toBe('approved')
    expect(state.fields.pre_verify_review_result).toBe('pending')
    expect(state.fields.assignee).toBe('n1-write')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current', revision: next.revision })
    expect(nMinusOnePhase(dir)).toBe('open')

    await store.set(dir, 'related_files', 'current-after-n1')
    const resumed = await store.read(dir)
    expect(resumed.fields.related_files).toBe('current-after-n1')
    expect(resumed.fields.review_acknowledged_via).toBe('unknown')
    expect(nMinusOnePhase(dir)).toBe('open')
  })
})
