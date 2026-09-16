import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  compileEffectiveWorkflowPlan, createStateStore, createTransitionRecordStore,
  createWorkflowRunRepository, ensureTestEvidenceDirs, publishTestRunRecord, testDigest,
  testRunRecordPath, type EffectiveWorkflowPlan, type TenonUser, type TestRunRecordV1,
} from '@tenon/kernel'
import { createCandidateCache } from './testCandidateCache.js'
import { projectTestEvidence } from './testEvidenceSnapshot.js'

const CHANGE = 'demo'
const SLUG = 'a-at-x.io'
const CANDIDATE = `workspace:sha256:${'a'.repeat(64)}`
const USER: TenonUser = { id: 'a@x.io', name: 'A', slug: SLUG, source: 'env', trust: 'declared' }
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function plan(): EffectiveWorkflowPlan {
  return compileEffectiveWorkflowPlan('tested', {
    name: 'tested',
    steps: [
      {
        id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [],
        tests: [
          { id: 'unit', direction: 'unit', command: 'npm test', label: '单测' },
          { id: 'bad', direction: 'unit', command: 'npm run bad' },
        ],
        guards: [], transitions: [{ event: 'done', to: 'verify' }],
      },
      { id: 'verify', label: '验证', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
    ],
  })
}

function record(current: EffectiveWorkflowPlan, id: string, overrides: Partial<TestRunRecordV1> = {}): TestRunRecordV1 {
  const test = current.workflow.steps[0]?.tests?.find((item) => item.id === id)
  if (test === undefined) throw new Error('fixture test missing')
  return {
    schema: 'tenon-test-run-v1', run_id: `20260915T1015${id === 'unit' ? '10' : '20'}Z-ab12cd`, change: CHANGE,
    workflow_run_id: 'run-1', workflow: 'tested', workflow_fingerprint: current.workflowFingerprint, track: '',
    step: 'build', step_visit: { run_id: 'run-1', transition_sequence: 1 }, test_id: id,
    test_digest: testDigest(test), direction: 'unit', command: test.command, cwd: '.', timeout_s: 900,
    required: true, actor: { id: 'a@x.io', name: 'A', trust: 'declared' },
    host: { kind: 'terminal', sandbox: null }, candidate_before: CANDIDATE, candidate: CANDIDATE,
    git_head: null, build_sha: null, started_at: '2026-09-15T10:15:00Z', finished_at: '2026-09-15T10:15:10Z',
    duration_ms: 10_000, exit_code: 0, signal: null, result: 'pass', reasons: [], inputs: [], outputs: [],
    metrics: [], log: { artifact: 'output.log', bytes_total: 1, bytes_kept: 1, truncated: false, digest: `sha256:${'f'.repeat(64)}` },
    ...overrides,
  }
}

async function freshRoot(): Promise<{ root: string; changeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-test-snapshot-'))
  roots.push(root)
  const repo = createWorkflowRunRepository({
    store: createStateStore(),
    recordStore: createTransitionRecordStore(),
    clock: () => '2026-09-15T10:00:00Z',
    newId: () => 'run-1',
  })
  const { changeDir } = await repo.initChange({
    repoRoot: root, name: CHANGE, track: 'backend', reviewSeed: 'pending',
    creator: { id: 'a@x.io', name: 'A', trust: 'declared' }, preset: 'full',
    clock: () => '2026-09-15T10:00:00Z',
    initialWorkflow: { workflow: 'tested', phase: 'build' },
  })
  return { root, changeDir }
}

describe('projectTestEvidence', () => {
  test('没有声明测试的分支不产生投影', async () => {
    const { root, changeDir } = await freshRoot()
    const plain = compileEffectiveWorkflowPlan('plain', {
      name: 'plain',
      steps: [{ id: 'build', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    expect(await projectTestEvidence({
      root, changeDir, changeName: CHANGE, plan: plain, user: USER, candidate: async () => CANDIDATE,
    })).toEqual({})
  })

  test('逐步骤投影状态与最近一次运行；候选变化后变成 stale', async () => {
    const { root, changeDir } = await freshRoot()
    const current = plan()
    const paths = await ensureTestEvidenceDirs(root, SLUG, CHANGE, '20260915T101510Z-ab12cd')
    const passing = record(current, 'unit')
    await publishTestRunRecord(testRunRecordPath(root, SLUG, CHANGE, passing.run_id), paths.runsDir, passing)
    const failing = record(current, 'bad', { result: 'fail', exit_code: 2, reasons: [{ code: 'exit-code' }] })
    await publishTestRunRecord(testRunRecordPath(root, SLUG, CHANGE, failing.run_id), paths.runsDir, failing)

    const projected = await projectTestEvidence({
      root, changeDir, changeName: CHANGE, plan: current, user: USER, candidate: async () => CANDIDATE,
    })
    expect(projected.tests).toHaveLength(1)
    expect(projected.tests?.[0]?.stepId).toBe('build')
    expect(projected.tests?.[0]?.items.map((item) => [item.id, item.status]))
      .toEqual([['unit', 'passed'], ['bad', 'failed']])
    expect(projected.tests?.[0]?.items[1]?.run).toMatchObject({
      result: 'fail', exitCode: 2, reasons: ['exit-code'], user: SLUG, actor: { id: 'a@x.io', name: 'A' },
    })

    const stale = await projectTestEvidence({
      root, changeDir, changeName: CHANGE, plan: current, user: USER,
      candidate: async () => `workspace:sha256:${'b'.repeat(64)}`,
    })
    expect(stale.tests?.[0]?.items.every((item) => item.status === 'stale')).toBe(true)
  })

  test('身份缺失 → 全部 missing（失败关闭）；损坏记录进 diagnostics', async () => {
    const { root, changeDir } = await freshRoot()
    const current = plan()
    const paths = await ensureTestEvidenceDirs(root, SLUG, CHANGE, '20260915T101510Z-ab12cd')
    await writeFile(join(paths.runsDir, '20260915T101599Z-ffffff.json'), '{ broken', 'utf8')

    const anonymous = await projectTestEvidence({
      root, changeDir, changeName: CHANGE, plan: current, user: undefined, candidate: async () => CANDIDATE,
    })
    expect(anonymous.tests?.[0]?.items.every((item) => item.status === 'missing')).toBe(true)
    expect(anonymous.diagnostics).toBeUndefined()

    const identified = await projectTestEvidence({
      root, changeDir, changeName: CHANGE, plan: current, user: USER, candidate: async () => CANDIDATE,
    })
    expect(identified.diagnostics).toEqual(['20260915T101599Z-ffffff.json'])
  })
})

describe('createCandidateCache', () => {
  test('TTL 内只算一次；TTL 过后重算；失败返回 undefined', async () => {
    let calls = 0
    let clock = 1000
    const cache = createCandidateCache(async () => {
      calls += 1
      if (calls === 3) throw new Error('raced')
      return `${CANDIDATE}`
    }, 5000, () => clock)
    expect(await cache('/root')).toBe(CANDIDATE)
    expect(await cache('/root')).toBe(CANDIDATE)
    expect(calls).toBe(1)
    clock += 6000
    expect(await cache('/root')).toBe(CANDIDATE)
    expect(calls).toBe(2)
    clock += 6000
    expect(await cache('/root')).toBeUndefined()
  })
})
