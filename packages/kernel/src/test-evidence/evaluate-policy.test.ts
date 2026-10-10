/**
 * evaluateTestEvidence 接入测试策略（真文件系统）：有 test_policy 的步骤读目录 / 计划台账 / 记录链 /
 * delta spec，出结构化报告与渲染后的阻塞；没有策略的步骤逐字走旧路径（A11）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { emptyFields } from '../state/parse.js'
import { publishInitialRunRevision } from '../state/run-revision-store.js'
import { catalogSuitesDigest, parseTestCatalog } from '../test-system/catalog.js'
import { testSystemPaths } from '../test-system/paths.js'
import { writeTestPlan } from '../test-system/plan-ledger.js'
import { emptyTestPlan, testPlanDigest, type TestPlan } from '../test-system/plan.js'
import { testPolicyDigest } from '../test-system/policy.js'
import { appendTestRunRecordV2 } from '../test-system/record-chain.js'
import { fixtureCase, fixtureRecordDraft, fixtureSuiteRun } from '../test-system/test-support.js'
import { compileEffectiveWorkflowPlan } from '../workflow/effective-plan.js'
import type { EffectiveWorkflowPlan } from '../workflow/effective-plan-types.js'
import type { StepTestPolicyDef } from '../workflow/types.js'
import { evaluateTestEvidence, stepTestFailuresOf, testItemSettled, type TestEvidenceContext } from './evaluate.js'
import { rejectOnTestEvidence } from './transition-gate.js'

const CHANGE = 'policy-flow'
const SLUG = 'a-at-x.io'
const ACTOR = { id: 'a@x.io', name: 'A', trust: 'declared' } as const
const CANDIDATE = `workspace:sha256:${'a'.repeat(64)}`
const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: unit
    runner: vitest
    command: npx vitest run
    files: ["src/**/*.test.ts"]
    report: { format: junit, path: test-results/unit.xml }
`
let repoRoot = ''
let changeDir = ''

function plan(policy: StepTestPolicyDef | undefined, withTests = false): EffectiveWorkflowPlan {
  return compileEffectiveWorkflowPlan('tested', {
    name: 'tested',
    steps: [
      {
        id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [],
        ...(withTests ? { tests: [{ id: 'legacy', direction: 'unit', command: 'npm test' }] } : {}),
        ...(policy === undefined ? {} : { test_policy: policy }),
        guards: [], transitions: [{ event: 'build-done', to: 'verify' }],
      },
      { id: 'verify', label: '验证', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
    ],
  })
}

const context = (changedFiles?: readonly string[]): TestEvidenceContext => ({
  user: { id: ACTOR.id, name: ACTOR.name, slug: SLUG },
  currentCandidate: async () => CANDIDATE,
  now: () => Date.parse('2026-09-29T10:00:00Z'),
  ...(changedFiles === undefined ? {} : { changedFiles: async () => changedFiles }),
})

async function evaluate(current: EffectiveWorkflowPlan, changedFiles?: readonly string[]) {
  return evaluateTestEvidence({ repoRoot, changeDir, changeName: CHANGE, plan: current, stepId: 'build', context: context(changedFiles) })
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'tenon-policy-evidence-'))
  changeDir = join(repoRoot, 'openspec', 'changes', CHANGE)
  await mkdir(changeDir, { recursive: true })
  const fields = emptyFields()
  fields.phase = 'build'
  fields.workflow = 'tested'
  await publishInitialRunRevision(changeDir, {
    fields, runMetadata: { runId: 'run-1', transitionSequence: 1, transitionHead: undefined }, opaqueTail: '',
  }, '2026-09-29T09:00:00Z')
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

async function seedCatalog(): Promise<void> {
  const path = testSystemPaths(repoRoot).catalog
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, CATALOG, 'utf8')
}

async function seedPlan(testPlan: TestPlan): Promise<string> {
  return (await writeTestPlan(changeDir, testPlan, { actor: ACTOR, recordedAt: '2026-09-29T09:30:00Z' })).digest
}

describe('evaluateTestEvidence × test_policy', () => {
  test('没有策略也没有测试 → 直接通过，不产出策略报告（旧行为）', async () => {
    const report = await evaluate(plan(undefined))
    expect(report).toEqual({ stepId: 'build', pass: true, blockers: [], items: [] })
  })

  test('有策略、项目还没有目录和计划 → 结构化阻塞 + 渲染文案', async () => {
    const report = await evaluate(plan({ run: ['unit'], scope: 'changed' }))
    expect(report.pass).toBe(false)
    expect(report.policy?.blockers.map((item) => item.code)).toEqual(['test-catalog-missing', 'test-plan-missing'])
    expect(report.blockers).toEqual([
      '项目还没有测试目录（.tenon/tests/catalog.yaml）；执行 tenon test discover --write',
      '任务 policy-flow 还没有登记测试计划；执行 tenon test plan policy-flow --seed',
    ])
  })

  test('登记计划、写入绑定当前代码的 v2 记录 → 放行；diff 里的未登记测试文件 → 挡', async () => {
    await seedCatalog()
    const current = plan({ run: ['unit'], scope: 'changed', files: 'registered' })
    const testPlan: TestPlan = { ...emptyTestPlan(CHANGE), suites: [{ suite: 'unit', scope: 'changed' }], files: [{ path: 'src/a.test.ts', suite: 'unit' }] }
    const digest = await seedPlan(testPlan)
    expect(digest).toBe(testPlanDigest(testPlan))
    const catalogResult = parseTestCatalog(CATALOG)
    if (!catalogResult.ok) throw new Error('catalog')
    const policy = current.workflow.steps[0]?.test_policy
    if (policy === undefined) throw new Error('policy')
    await appendTestRunRecordV2(repoRoot, SLUG, fixtureRecordDraft({
      change: CHANGE,
      workflow: 'tested',
      workflow_run_id: 'run-1',
      actor: ACTOR,
      bindings: {
        candidate: CANDIDATE,
        workflow_fingerprint: current.workflowFingerprint,
        catalog_digest: catalogSuitesDigest(catalogResult.catalog, ['unit']),
        plan_digest: digest,
        policy_digest: testPolicyDigest(policy),
      },
      suites: [fixtureSuiteRun({ suite: 'unit', scope: 'changed', cases: [fixtureCase({ file: 'src/a.test.ts', name: 'works' })] })],
    }))
    const passing = await evaluate(current, ['src/a.test.ts', 'src/a.ts'])
    expect(passing.policy?.blockers).toEqual([])
    expect(passing.pass).toBe(true)
    expect(passing.policy?.suites[0]).toMatchObject({ suite: 'unit', state: 'passed' })
    const blocked = await evaluate(current, ['src/a.test.ts', 'src/b.test.ts'])
    expect(blocked.policy?.blockers.map((item) => [item.code, item.subject])).toEqual([['test-file-unregistered', 'src/b.test.ts']])
  })

  test('旧 tests[] 与策略并存：v1 判定结果并入策略阻塞（step: 内联套件）', async () => {
    await seedCatalog()
    await seedPlan({ ...emptyTestPlan(CHANGE) })
    const report = await evaluate(plan({ plan: 'optional' }, true))
    expect(report.policy?.blockers).toEqual([expect.objectContaining({ code: 'test-not-run', subject: 'step:legacy', fix: 'tenon test run policy-flow legacy' })])
    expect(report.items.map((item) => item.status)).toEqual(['missing'])
  })

  test('步骤测试豁免：失败记录 + 计划里的 test:<id> → item.waiver 为 waiver-pending / waived，没有豁免则仍是失败', async () => {
    await seedCatalog()
    const current = plan({ plan: 'optional' }, true)
    const policy = current.workflow.steps[0]?.test_policy
    const catalogResult = parseTestCatalog(CATALOG)
    if (policy === undefined || !catalogResult.ok) throw new Error('fixture')
    const failed = fixtureSuiteRun({ suite: 'step:legacy', result: 'fail', reasons: [{ code: 'exit-code', detail: 'exit 1' }] })
    const digest = await seedPlan({ ...emptyTestPlan(CHANGE) })
    await appendTestRunRecordV2(repoRoot, SLUG, fixtureRecordDraft({
      change: CHANGE,
      workflow: 'tested',
      workflow_run_id: 'run-1',
      actor: ACTOR,
      bindings: {
        candidate: CANDIDATE,
        workflow_fingerprint: current.workflowFingerprint,
        catalog_digest: catalogSuitesDigest(catalogResult.catalog, []),
        plan_digest: digest,
        policy_digest: testPolicyDigest(policy),
      },
      suites: [failed],
    }))

    const none = await evaluate(current)
    expect(none.policy?.blockers.map((item) => item.code)).toEqual(['test-failed'])
    expect(none.items.map((item) => testItemSettled(item))).toEqual([false])
    expect(none.items[0]?.waiver).toBeUndefined()

    await seedPlan({ ...emptyTestPlan(CHANGE), waivers: [{ test: 'legacy', reason: '迁移脚本一次性生成', approved_by: null }] })
    const pending = await evaluate(current)
    expect(pending.policy?.blockers).toEqual([expect.objectContaining({ code: 'waiver-unapproved', subject: 'test:legacy' })])
    expect(pending.pass).toBe(false)
    expect(pending.blockers).toEqual([
      '测试 legacy 失败（exit-code），豁免尚未经评审批准；执行 tenon review request policy-flow --event build-done',
    ])
    expect(pending.items[0]?.waiver).toBe('waiver-pending')
    expect(pending.items.map((item) => testItemSettled(item))).toEqual([true])

    // 批准绑定被批准的代码：旧版本留下的批准（没有候选）、批准的是另一份代码，都还是待批准。
    for (const waiver of [
      { test: 'legacy', reason: '迁移脚本一次性生成', approved_by: ACTOR.id },
      { test: 'legacy', reason: '迁移脚本一次性生成', approved_by: ACTOR.id, approved_candidate: `workspace:sha256:${'b'.repeat(64)}` },
    ]) {
      await seedPlan({ ...emptyTestPlan(CHANGE), waivers: [waiver] })
      const unbound = await evaluate(current)
      expect(unbound.policy?.blockers, JSON.stringify(waiver)).toEqual([expect.objectContaining({ code: 'waiver-unapproved', subject: 'test:legacy' })])
      expect(unbound.pass).toBe(false)
      expect(unbound.items[0]).toMatchObject({ waiver: 'waiver-pending', failedCandidate: CANDIDATE })
      expect(stepTestFailuresOf(unbound.items)).toEqual(new Map([['legacy', { state: 'waiver-pending', candidate: CANDIDATE }]]))
    }

    await seedPlan({
      ...emptyTestPlan(CHANGE),
      waivers: [{ test: 'legacy', reason: '迁移脚本一次性生成', approved_by: ACTOR.id, approved_candidate: CANDIDATE }],
    })
    const approved = await evaluate(current)
    expect(approved.policy?.blockers).toEqual([])
    expect(approved.pass).toBe(true)
    expect(approved.items[0]).toMatchObject({ waiver: 'waived', failedCandidate: CANDIDATE })
    expect(approved.policy?.notices.map((item) => item.code)).toEqual(['test-waived'])
    expect(stepTestFailuresOf(approved.items)).toEqual(new Map([['legacy', { state: 'waived', candidate: CANDIDATE }]]))
    expect(stepTestFailuresOf(none.items).size).toBe(0)
  })

  test('完整性 / 读不到改动 两类策略阻断带结构化状态（不带 subject），其余策略阻断没有；与渲染后的阻塞一一对齐', async () => {
    await seedCatalog()
    await seedPlan({ ...emptyTestPlan(CHANGE) })
    const current = plan({ plan: 'optional', integrity: 'block' })
    const withDiff = (integrityDiff: NonNullable<TestEvidenceContext['integrityDiff']>): TestEvidenceContext => ({ ...context(), integrityDiff })

    const signal = await evaluateTestEvidence({
      repoRoot, changeDir, changeName: CHANGE, plan: current, stepId: 'build',
      context: withDiff(async () => ({ files: [{ path: 'src/a.test.ts', status: 'modified', added: ["it.skip('one', () => {})"], removed: [] }] })),
    })
    expect(signal.policy?.blockers.map((item) => item.code)).toEqual(['test-integrity'])
    expect(signal.blockers).toHaveLength(1)
    expect(signal.blockerDetails).toEqual([{ state: 'integrity' }])

    const unreadable = await evaluateTestEvidence({
      repoRoot, changeDir, changeName: CHANGE, plan: current, stepId: 'build',
      context: withDiff(async () => { throw new Error('diff unreadable') }),
    })
    expect(unreadable.policy?.blockers.map((item) => item.code)).toEqual(['files-diff-unavailable'])
    expect(unreadable.blockerDetails).toEqual([{ state: 'diff-unavailable' }])

    const other = await evaluate(plan({ run: ['unit'], scope: 'changed' }))
    expect(other.policy?.blockers.map((item) => item.code)).toEqual(['test-kind-missing'])
    expect(other.blockerDetails).toEqual([undefined])
  })

  test('没有身份 → 与旧口径一致失败关闭', async () => {
    const report = await evaluateTestEvidence({ repoRoot, changeDir, changeName: CHANGE, plan: plan({}), stepId: 'build', context: undefined })
    expect(report).toMatchObject({ pass: false, blockers: ['测试证据无法验证：宿主未提供用户身份'] })
  })

  test('转换闸：策略阻塞拒绝前进边，退回边不查', async () => {
    const current = plan({ run: ['unit'] })
    const base = { repoRoot, changeDir, changeName: CHANGE, plan: current, context: context() }
    const rejection = await rejectOnTestEvidence({ ...base, from: 'build', to: 'verify' })
    expect(rejection).toMatchObject({ kind: 'test-evidence-failed', stepId: 'build' })
    expect(rejection?.blockers[0]).toMatch(/测试目录/)
    expect(await rejectOnTestEvidence({ ...base, from: 'verify', to: 'build' })).toBeUndefined()
  })
})
