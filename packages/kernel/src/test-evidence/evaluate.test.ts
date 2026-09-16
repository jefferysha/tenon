import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { emptyFields } from '../state/parse.js'
import { publishInitialRunRevision } from '../state/run-revision-store.js'
import { compileEffectiveWorkflowPlan } from '../workflow/effective-plan.js'
import type { EffectiveWorkflowPlan } from '../workflow/effective-plan-types.js'
import type { StepTestIR } from '../workflow/ir.js'
import { evaluateTestEvidence, latestTestRun, testDigest, type TestEvidenceContext } from './evaluate.js'
import { ensureTestEvidenceDirs, testRunRecordPath, testRunningMarkerPath } from './paths.js'
import { publishTestRunRecord } from './record.js'
import { TEST_RUN_SCHEMA, type TestRunRecordV1 } from './types.js'

const CHANGE = 'catalog-flow'
const SLUG = 'a-at-x.io'
const OTHER = 'b-at-x.io'
const CANDIDATE = `workspace:sha256:${'a'.repeat(64)}`
const ACTOR = { id: 'a@x.io', name: 'A', trust: 'declared' } as const
const roots: string[] = []
let repoRoot = ''
let changeDir = ''
let sequence = 0

function plan(tests: readonly { id: string; required?: boolean }[]): EffectiveWorkflowPlan {
  return compileEffectiveWorkflowPlan('tested', {
    name: 'tested',
    steps: [
      {
        id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [],
        tests: tests.map((test) => ({
          id: test.id, direction: test.id, command: `npm run ${test.id}`,
          ...(test.required === false ? { required: false } : {}),
        })),
        guards: [], transitions: [{ event: 'done', to: 'verify' }],
      },
      { id: 'verify', label: '验证', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
    ],
  })
}

function testIr(current: EffectiveWorkflowPlan, id: string): StepTestIR {
  const test = current.workflow.steps[0]?.tests?.find((item) => item.id === id)
  if (test === undefined) throw new Error(`missing test ${id}`)
  return test
}

function record(current: EffectiveWorkflowPlan, id: string, overrides: Partial<TestRunRecordV1> = {}): TestRunRecordV1 {
  sequence += 1
  return {
    schema: TEST_RUN_SCHEMA,
    run_id: `20260915T1015${String(sequence).padStart(2, '0')}Z-ab12cd`,
    change: CHANGE,
    workflow_run_id: 'run-1',
    workflow: 'tested',
    workflow_fingerprint: current.workflowFingerprint,
    track: '',
    step: 'build',
    step_visit: { run_id: 'run-1', transition_sequence: 1 },
    test_id: id,
    test_digest: testDigest(testIr(current, id)),
    direction: id,
    command: `npm run ${id}`,
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
    duration_ms: 1000,
    exit_code: 0,
    signal: null,
    result: 'pass',
    reasons: [],
    inputs: [],
    outputs: [],
    metrics: [],
    log: { artifact: 'output.log', bytes_total: 1, bytes_kept: 1, truncated: false, digest: `sha256:${'f'.repeat(64)}` },
    ...overrides,
  }
}

async function publish(slug: string, runRecord: TestRunRecordV1): Promise<void> {
  const paths = await ensureTestEvidenceDirs(repoRoot, slug, CHANGE, runRecord.run_id)
  await publishTestRunRecord(testRunRecordPath(repoRoot, slug, CHANGE, runRecord.run_id), paths.runsDir, runRecord)
}

/** 判定要读 canonical run identity。 */
async function seedRunIdentity(runId: string): Promise<void> {
  const fields = emptyFields()
  fields.phase = 'build'
  fields.workflow = 'tested'
  await publishInitialRunRevision(changeDir, {
    fields,
    runMetadata: { runId, transitionSequence: 1, transitionHead: undefined },
    opaqueTail: '',
  }, '2026-09-15T10:00:00Z')
}

async function ensureDir(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })
}

const context: TestEvidenceContext = {
  user: { id: 'a@x.io', name: 'A', slug: SLUG },
  currentCandidate: async () => CANDIDATE,
  now: () => Date.parse('2026-09-15T10:20:00Z'),
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'tenon-test-evaluate-'))
  roots.push(repoRoot)
  changeDir = join(repoRoot, 'openspec', 'changes', CHANGE)
  await ensureDir(changeDir)
  await seedRunIdentity('run-1')
  sequence = 0
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function evaluate(current: EffectiveWorkflowPlan) {
  return evaluateTestEvidence({ repoRoot, changeDir, changeName: CHANGE, plan: current, stepId: 'build', context })
}

describe('evaluateTestEvidence', () => {
  test('没有测试的步骤直接通过，不读磁盘', async () => {
    const empty = compileEffectiveWorkflowPlan('plain', {
      name: 'plain',
      steps: [{ id: 'build', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    const report = await evaluateTestEvidence({
      repoRoot: '/nonexistent', changeDir: '/nonexistent', changeName: CHANGE, plan: empty,
      stepId: 'build', context: undefined,
    })
    expect(report).toEqual({ stepId: 'build', pass: true, blockers: [], items: [] })
  })

  test('声明了测试但宿主没给身份 → 失败关闭', async () => {
    const report = await evaluateTestEvidence({
      repoRoot, changeDir, changeName: CHANGE, plan: plan([{ id: 'unit' }]), stepId: 'build', context: undefined,
    })
    expect(report.pass).toBe(false)
    expect(report.blockers).toEqual(['测试证据无法验证：宿主未提供用户身份'])
  })

  test('未运行 / 通过 / 失败', async () => {
    const current = plan([{ id: 'unit' }])
    const missing = await evaluate(current)
    expect(missing.items[0]?.status).toBe('missing')
    expect(missing.blockers[0]).toBe(`测试 unit（unit）未运行；执行 tenon test run ${CHANGE} unit`)

    await publish(SLUG, record(current, 'unit'))
    expect((await evaluate(current)).items[0]?.status).toBe('passed')
    expect((await evaluate(current)).pass).toBe(true)

    await publish(SLUG, record(current, 'unit', {
      result: 'fail', exit_code: 3, reasons: [{ code: 'exit-code' }, { code: 'sandbox-denied' }],
    }))
    const failed = await evaluate(current)
    expect(failed.items[0]?.status).toBe('failed')
    expect(failed.blockers[0]).toContain('失败：exit-code, sandbox-denied')
    expect(failed.blockers[0]).toContain('sandbox_permissions=require_escalated')
  })

  test('候选版本 / 声明摘要 / 工作流指纹任一不同都判过期', async () => {
    const current = plan([{ id: 'unit' }])
    await publish(SLUG, record(current, 'unit', { candidate: `workspace:sha256:${'b'.repeat(64)}` }))
    const byCandidate = await evaluate(current)
    expect(byCandidate.items[0]).toMatchObject({ status: 'stale', staleBecause: 'candidate' })
    expect(byCandidate.blockers[0]).toContain('过期：代码已变化')

    await publish(SLUG, record(current, 'unit', { test_digest: `sha256:${'c'.repeat(64)}` }))
    expect((await evaluate(current)).items[0]).toMatchObject({ status: 'stale', staleBecause: 'declaration' })

    await publish(SLUG, record(current, 'unit', { workflow_fingerprint: 'd'.repeat(64) }))
    expect((await evaluate(current)).items[0]).toMatchObject({ status: 'stale', staleBecause: 'workflow' })
  })

  test('另一个 workflow_run_id 的记录与别的用户的记录都被忽略', async () => {
    const current = plan([{ id: 'unit' }])
    await publish(SLUG, record(current, 'unit', { workflow_run_id: 'run-0' }))
    expect((await evaluate(current)).items[0]?.status).toBe('missing')
    await publish(OTHER, record(current, 'unit'))
    expect((await evaluate(current)).items[0]?.status).toBe('missing')
    expect(await latestTestRun(repoRoot, CHANGE, OTHER, 'unit', 'run-1')).toBeDefined()
  })

  test('存活标记 → 运行中；过期标记回到记录状态', async () => {
    const current = plan([{ id: 'unit' }])
    await ensureTestEvidenceDirs(repoRoot, SLUG, CHANGE, '20260915T101500Z-ab12cd')
    const markerPath = testRunningMarkerPath(repoRoot, SLUG, CHANGE, 'unit')
    await writeFile(markerPath, JSON.stringify({
      run_id: '20260915T101500Z-ab12cd', pid: 1, started_at: '2026-09-15T10:15:00Z',
      deadline_at: '2026-09-15T10:30:00Z',
    }))
    const running = await evaluate(current)
    expect(running.items[0]?.status).toBe('running')
    expect(running.blockers[0]).toBe('测试 unit（unit）运行中')

    await writeFile(markerPath, JSON.stringify({
      run_id: '20260915T101500Z-ab12cd', pid: 1, started_at: '2026-09-15T10:00:00Z',
      deadline_at: '2026-09-15T10:10:00Z',
    }))
    expect((await evaluate(current)).items[0]?.status).toBe('missing')
  })

  test('可选测试失败不拦截', async () => {
    const current = plan([{ id: 'unit', required: false }])
    await publish(SLUG, record(current, 'unit', { required: false, result: 'fail', reasons: [{ code: 'exit-code' }] }))
    const report = await evaluate(current)
    expect(report.items[0]?.status).toBe('failed')
    expect(report.pass).toBe(true)
    expect(report.blockers).toEqual([])
  })

  test('损坏的记录文件被忽略，测试视为未运行', async () => {
    const current = plan([{ id: 'unit' }])
    const paths = await ensureTestEvidenceDirs(repoRoot, SLUG, CHANGE, '20260915T101500Z-ab12cd')
    await writeFile(join(paths.runsDir, '20260915T101500Z-ab12cd.json'), '{ broken')
    expect((await evaluate(current)).items[0]?.status).toBe('missing')
  })

  test('testDigest 与键序无关，改一个字段就变', () => {
    const current = plan([{ id: 'unit' }])
    const test = testIr(current, 'unit')
    const reordered = { ...test, pass: { metrics: test.pass.metrics, exit_code: test.pass.exit_code } } as StepTestIR
    expect(testDigest(reordered)).toBe(testDigest(test))
    expect(testDigest({ ...test, timeout_s: 901 })).not.toBe(testDigest(test))
  })

  test('宿主没有工作区指纹能力：跳过候选比对，其余三条绑定照查', async () => {
    const current = plan([{ id: 'unit' }])
    const withoutCandidate: TestEvidenceContext = {
      user: context.user,
      now: context.now,
    }
    const evaluateWithout = async () => evaluateTestEvidence({
      repoRoot, changeDir, changeName: CHANGE, plan: current, stepId: 'build', context: withoutCandidate,
    })

    // 候选不同也不再判过期——能力缺席时这条绑定无从比对。
    await publish(SLUG, record(current, 'unit', { candidate: `workspace:sha256:${'b'.repeat(64)}` }))
    expect((await evaluateWithout()).items[0]?.status).toBe('passed')
    expect((await evaluateWithout()).pass).toBe(true)

    // 另外三条绑定仍然生效。
    await publish(SLUG, record(current, 'unit', { test_digest: `sha256:${'c'.repeat(64)}` }))
    expect((await evaluateWithout()).items[0]).toMatchObject({ status: 'stale', staleBecause: 'declaration' })
    await publish(SLUG, record(current, 'unit', { workflow_fingerprint: 'd'.repeat(64) }))
    expect((await evaluateWithout()).items[0]).toMatchObject({ status: 'stale', staleBecause: 'workflow' })
  })

  test('指纹能力在但取不到 → 按未知判过期；没有记录可判时根本不求指纹', async () => {
    const current = plan([{ id: 'unit' }])
    let calls = 0
    const failing: TestEvidenceContext = {
      user: context.user,
      now: context.now,
      currentCandidate: async () => { calls += 1; throw new Error('raced') },
    }
    const evaluateFailing = async () => evaluateTestEvidence({
      repoRoot, changeDir, changeName: CHANGE, plan: current, stepId: 'build', context: failing,
    })

    // 一条记录都没有时，指纹（要遍历整棵实现树）根本不该被求值。
    expect((await evaluateFailing()).items[0]?.status).toBe('missing')
    expect(calls).toBe(0)

    await publish(SLUG, record(current, 'unit'))
    expect((await evaluateFailing()).items[0]).toMatchObject({ status: 'stale', staleBecause: 'candidate' })
    expect(calls).toBe(1)
  })
})
