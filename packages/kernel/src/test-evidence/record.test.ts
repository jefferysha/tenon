import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  claimRunningMarker, decodeTestBaseline, decodeTestRunRecord, nextBaseline, pruneTestArtifacts,
  publishTestRunRecord, readTestRunRecord, selectArtifactDirsToPrune, writeTestBaseline,
} from './record.js'
import { ensureTestEvidenceDirs, testRunArtifactsDir, testRunRecordPath, testRunningMarkerPath } from './paths.js'
import { TEST_BASELINE_SCHEMA, TEST_RUN_SCHEMA, type TestBaselineV1, type TestRunRecordV1 } from './types.js'

const roots: string[] = []
const SLUG = 'a-at-x.io'
const ACTOR = { id: 'a@x.io', name: 'A', trust: 'declared' } as const
const CANDIDATE = `workspace:sha256:${'a'.repeat(64)}`

async function freshRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-test-record-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const RECORD: TestRunRecordV1 = {
  schema: TEST_RUN_SCHEMA,
  run_id: '20260915T101530Z-ab12cd',
  change: 'catalog-flow',
  workflow_run_id: 'run-1',
  workflow: 'demo',
  workflow_fingerprint: 'b'.repeat(64),
  track: 'frontend',
  step: 'build',
  step_visit: { run_id: 'run-1', transition_sequence: 3 },
  test_id: 'unit',
  test_digest: `sha256:${'c'.repeat(64)}`,
  direction: 'unit',
  label: '单测',
  command: 'npm test',
  cwd: '.',
  timeout_s: 900,
  required: true,
  actor: ACTOR,
  host: { kind: 'terminal', sandbox: null },
  candidate_before: CANDIDATE,
  candidate: CANDIDATE,
  git_head: null,
  build_sha: null,
  started_at: '2026-09-15T10:15:20Z',
  finished_at: '2026-09-15T10:15:30Z',
  duration_ms: 10_000,
  exit_code: 0,
  signal: null,
  result: 'pass',
  reasons: [],
  inputs: [
    { kind: 'document', ref: 'delta-spec', present: true, entries: [{ path: 'specs/a.md', digest: `sha256:${'d'.repeat(64)}` }] },
    { kind: 'env', name: 'DATABASE_URL', present: false, digest: null },
    { kind: 'service', name: 'database' },
  ],
  outputs: [{
    path: 'test-results/junit.xml', kind: 'report', required: true, present: true,
    digest: `sha256:${'e'.repeat(64)}`, bytes: 120, files: 1, artifact: 'outputs/test-results/junit.xml',
  }],
  metrics: [{ name: 'p95_ms', value: 12, baseline: 10, delta_pct: 20, max: 50, better: 'lower', ok: true }],
  log: { artifact: 'output.log', bytes_total: 1024, bytes_kept: 1024, truncated: false, digest: `sha256:${'f'.repeat(64)}` },
}

describe('decodeTestRunRecord', () => {
  test('接受完整记录并逐字保真', () => {
    expect(decodeTestRunRecord(JSON.parse(JSON.stringify(RECORD)))).toEqual(RECORD)
  })

  test('附加键、非法 run-id、非法候选前缀、未知原因、伪造 actor 判为损坏', () => {
    expect(decodeTestRunRecord({ ...RECORD, extra: 1 })).toBeUndefined()
    expect(decodeTestRunRecord({ ...RECORD, run_id: '2026-09-15-ab12cd' })).toBeUndefined()
    expect(decodeTestRunRecord({ ...RECORD, candidate: 'sha256:abc' })).toBeUndefined()
    expect(decodeTestRunRecord({ ...RECORD, reasons: [{ code: 'nope' }] })).toBeUndefined()
    expect(decodeTestRunRecord({ ...RECORD, actor: { id: 'a@x.io', name: 'A' } })).toBeUndefined()
    expect(decodeTestRunRecord({ ...RECORD, schema: 'tenon-test-run-v2' })).toBeUndefined()
    expect(decodeTestRunRecord('{}')).toBeUndefined()
  })
})

describe('记录发布与读取', () => {
  test('独占发布，同一 run-id 第二次失败', async () => {
    const root = await freshRepo()
    const paths = await ensureTestEvidenceDirs(root, SLUG, RECORD.change, RECORD.run_id)
    const path = testRunRecordPath(root, SLUG, RECORD.change, RECORD.run_id)
    await publishTestRunRecord(path, paths.runsDir, RECORD)
    expect(await readTestRunRecord(path)).toEqual(RECORD)
    await expect(publishTestRunRecord(path, paths.runsDir, RECORD)).rejects.toThrow()
    expect(path.includes(join('.tenon', 'users', SLUG, 'tests', RECORD.change))).toBe(true)
  })

  test('损坏 JSON 读成 undefined，门禁据此视为未运行', async () => {
    const root = await freshRepo()
    const paths = await ensureTestEvidenceDirs(root, SLUG, RECORD.change, RECORD.run_id)
    const path = join(paths.runsDir, 'broken.json')
    await writeFile(path, '{ not json')
    expect(await readTestRunRecord(path)).toBeUndefined()
  })
})

describe('基准', () => {
  test('新基准把旧值推进 history，最多 20 条', async () => {
    const root = await freshRepo()
    const paths = await ensureTestEvidenceDirs(root, SLUG, RECORD.change, RECORD.run_id)
    const entry = (run: string): Omit<TestBaselineV1, 'schema' | 'history'> => ({
      test_id: 'bench', command: 'npm run bench', cwd: '.', metrics: { p95_ms: 10 },
      source: { change: 'c', run_id: run }, actor: ACTOR, updated_at: '2026-09-15T10:00:00Z',
    })
    let baseline = nextBaseline(undefined, entry('20260915T100000Z-000001'))
    expect(baseline.history).toEqual([])
    for (let index = 0; index < 25; index++) {
      baseline = nextBaseline(baseline, entry(`20260915T1000${String(index).padStart(2, '0')}Z-0000ff`))
    }
    expect(baseline.history).toHaveLength(20)
    expect(baseline.schema).toBe(TEST_BASELINE_SCHEMA)

    const path = join(paths.baselinesDir, 'bench.json')
    await writeTestBaseline(path, paths.baselinesDir, baseline)
    expect(decodeTestBaseline(JSON.parse(await readFile(path, 'utf8')))).toEqual(baseline)
    expect(decodeTestBaseline({ ...baseline, history: new Array(21).fill(baseline.history[0]) })).toBeUndefined()
  })
})

describe('运行中标记', () => {
  test('未过期时第二次占用失败；过期后回收', async () => {
    const root = await freshRepo()
    const paths = await ensureTestEvidenceDirs(root, SLUG, RECORD.change, RECORD.run_id)
    const path = testRunningMarkerPath(root, SLUG, RECORD.change, 'unit')
    const marker = {
      run_id: RECORD.run_id, pid: 4242,
      started_at: '2026-09-15T10:15:20Z', deadline_at: '2026-09-15T10:30:20Z',
    }
    const now = Date.parse('2026-09-15T10:16:00Z')
    expect(await claimRunningMarker(path, paths.runningDir, marker, now)).toEqual({ claimed: true })
    const second = await claimRunningMarker(path, paths.runningDir, marker, now)
    expect(second).toEqual({ claimed: false, held: marker })
    const later = Date.parse('2026-09-15T10:31:30Z')
    expect(await claimRunningMarker(path, paths.runningDir, marker, later)).toEqual({ claimed: true })
  })
})

describe('保留策略', () => {
  test('按 run-id 逆序保留最近 keep_runs 个产物目录', async () => {
    expect(selectArtifactDirsToPrune(['20260915T100000Z-000001', '20260915T100100Z-000002'], 5)).toEqual([])
    const ids = Array.from({ length: 7 }, (_, index) => `2026091${index}T100000Z-00000${index}`)
    expect(selectArtifactDirsToPrune(ids, 5)).toEqual([ids[1], ids[0]])

    const root = await freshRepo()
    for (const id of ids) await ensureTestEvidenceDirs(root, SLUG, RECORD.change, id)
    const artifactsDir = join(testRunArtifactsDir(root, SLUG, RECORD.change, ids[0] ?? ''), '..')
    expect((await pruneTestArtifacts(artifactsDir, ids, 5)).sort()).toEqual([ids[0], ids[1]].sort())
  })
})
