/**
 * 策略判定（纯函数）：§9 的每一个阻塞码、旧步骤内联测试并入、提示与追溯矩阵。
 */
import { describe, expect, it } from 'vitest'
import { compileStepTestPolicy } from '../workflow/compile-test-policy.js'
import type { StepTestPolicyDef } from '../workflow/types.js'
import { nextBaselineV2, type TestBaselineV2 } from './baseline-v2.js'
import { TEST_BLOCKER_CODES, TEST_BLOCKER_LABELS, type TestBlockerCode } from './blockers.js'
import { catalogSuitesDigest, parseTestCatalog } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import { evaluateTestPolicy, renderPolicyBlockers } from './evaluate-v2.js'
import { baselineKey, type TestPolicyEvaluationInput, type TestPolicyReport } from './evaluate-types.js'
import type { KnownFailure } from './known-failures.js'
import { extractScenarios, extractTaskItems } from './openspec-trace.js'
import { emptyTestPlan, testPlanDigest, type TestPlan } from './plan.js'
import { inlineSuiteFromTest, testPolicyDigest } from './policy.js'
import { verifyRecordChain, type ChainReport } from './record-chain.js'
import type { SuiteRunV2, TestRunRecordV2, TestRunRecordV2Draft } from './record-v2-types.js'
import {
  FIXTURE_FINGERPRINT, fixtureCase, fixtureChain, fixtureRecordDraft, fixtureSuiteRun,
} from './test-support.js'

const CATALOG_TEXT = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: unit
    runner: vitest
    command: npx vitest run
    files: ["src/**/*.test.ts"]
    report: { format: junit, path: test-results/unit.xml }
    coverage: { format: istanbul-summary, path: coverage/coverage-summary.json }
  - id: e2e
    kind: playwright
    runner: playwright
    command: npx playwright test
    files: ["e2e/**/*.spec.ts"]
    report: { format: playwright-json, path: test-results/results.json }
    browsers: [chromium]
  - id: bench
    kind: benchmark
    runner: custom
    command: node bench.mjs
    report: { format: benchmark-json, path: test-results/bench.json }
    benchmark:
      metrics:
        - { name: p95_ms, better: lower, max_regression_pct: 10, max: 250 }
  - id: types
    kind: typecheck
    runner: tsc
    command: npx tsc --noEmit
`

function parsedCatalog(text = CATALOG_TEXT): TestCatalog {
  const result = parseTestCatalog(text)
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('\n'))
  return result.catalog
}

const CATALOG = parsedCatalog()
const PROFILE = 'darwin-arm64-m3max-node22-1a2b3c4d'
const BASE_PLAN: TestPlan = { ...emptyTestPlan('demo'), suites: [{ suite: 'unit', scope: 'changed' }] }

interface Scenario {
  readonly policy?: StepTestPolicyDef
  readonly plan?: TestPlan
  readonly runs?: readonly SuiteRunV2[]
  readonly records?: (context: { policyDigest: string; planDigest: string }) => readonly TestRunRecordV2Draft[]
  readonly input?: Partial<TestPolicyEvaluationInput>
}

function recordFor(runs: readonly SuiteRunV2[], context: { policyDigest: string; planDigest: string }, catalog = CATALOG): TestRunRecordV2Draft {
  return fixtureRecordDraft({
    suites: [...runs],
    machine_profile: PROFILE,
    bindings: {
      candidate: null,
      workflow_fingerprint: FIXTURE_FINGERPRINT,
      catalog_digest: catalogSuitesDigest(catalog, runs.filter((run) => run.origin === 'catalog').map((run) => run.suite)),
      plan_digest: context.planDigest,
      policy_digest: context.policyDigest,
    },
  })
}

function evaluate(scenario: Scenario = {}): TestPolicyReport {
  const policy = compileStepTestPolicy(scenario.policy ?? { run: ['unit'], scope: 'changed' }, 'test')
  if (policy === undefined) throw new Error('policy')
  const plan = scenario.plan ?? BASE_PLAN
  const context = { policyDigest: testPolicyDigest(policy), planDigest: testPlanDigest(plan) }
  const drafts = scenario.records?.(context) ?? (scenario.runs === undefined ? [] : [recordFor(scenario.runs, context)])
  const chain: ChainReport = verifyRecordChain({
    records: fixtureChain(drafts).map((record) => ({ file: `${record.run_id}.json`, record })),
    problems: [],
  })
  return evaluateTestPolicy({
    change: 'demo',
    stepId: 'build',
    policy,
    inline: [],
    catalog: { state: 'ok', catalog: CATALOG },
    plan: { state: 'ok', plan, digest: context.planDigest },
    chain,
    knownFailures: [],
    baselines: new Map(),
    changedFiles: undefined,
    scenarios: [],
    tasks: [],
    bindings: { candidate: undefined, workflowFingerprint: FIXTURE_FINGERPRINT, workflowRunId: 'run-1' },
    today: '2026-09-29',
    exitEvent: 'build-complete',
    ...scenario.input,
  })
}

function codes(report: TestPolicyReport): TestBlockerCode[] {
  return report.blockers.filter((item) => item.blocking).map((item) => item.code)
}

const UNIT_PASS = fixtureSuiteRun({ suite: 'unit', scope: 'changed' })

describe('evaluateTestPolicy —— 放行路径', () => {
  it('计划、记录、绑定全部新鲜且通过 → pass', () => {
    const report = evaluate({ runs: [UNIT_PASS] })
    expect(report.blockers).toEqual([])
    expect(report.pass).toBe(true)
    expect(report.suites).toEqual([expect.objectContaining({ suite: 'unit', state: 'passed', reason: 'run' })])
    expect(report.chain).toBe('intact')
  })

  it('每个阻塞码都有中英短标签', () => {
    for (const code of TEST_BLOCKER_CODES) {
      expect(TEST_BLOCKER_LABELS[code].zh.length).toBeGreaterThan(0)
      expect(TEST_BLOCKER_LABELS[code].en.length).toBeGreaterThan(0)
    }
  })
})

describe('evaluateTestPolicy —— 目录与计划', () => {
  it('test-catalog-missing：目录不存在 / 无效 / 计划登记的套件不在目录', () => {
    expect(codes(evaluate({ input: { catalog: { state: 'missing' } } }))).toContain('test-catalog-missing')
    const invalid = evaluate({ input: { catalog: { state: 'invalid', issues: ['catalog.yaml:3: x', 'b', 'c', 'd'] } } })
    expect(invalid.blockers[0]).toMatchObject({ code: 'test-catalog-missing', fix: 'tenon test catalog validate' })
    expect(invalid.blockers[0]?.message).toMatch(/等 4 处/)
    const stale = evaluate({ plan: { ...BASE_PLAN, suites: [...BASE_PLAN.suites, { suite: 'gone', scope: 'full' }] }, runs: [UNIT_PASS] })
    expect(stale.blockers).toEqual([expect.objectContaining({ code: 'test-catalog-missing', subject: 'gone', fix: 'tenon test unregister demo --suite gone' })])
  })

  it('test-plan-missing：策略要求计划；plan: optional 时不挡', () => {
    const report = evaluate({ input: { plan: { state: 'missing' } } })
    expect(report.blockers[0]).toMatchObject({ code: 'test-plan-missing', fix: 'tenon test plan demo --seed' })
    expect(codes(evaluate({ policy: { plan: 'optional' }, input: { plan: { state: 'missing' } } }))).toEqual([])
  })

  it('test-plan-tampered', () => {
    const report = evaluate({ input: { plan: { state: 'tampered', reason: '计划文件内容与登记摘要不符（被手工改动）' } } })
    expect(report.blockers[0]).toMatchObject({ code: 'test-plan-tampered' })
    expect(report.blockers[0]?.message).toMatch(/被手工改动/)
  })

  it('test-kind-missing：有候选套件给登记命令，没有给豁免命令', () => {
    const report = evaluate({ policy: { kinds: ['playwright', 'integration'] }, runs: [UNIT_PASS] })
    expect(report.blockers.map((item) => [item.code, item.fix])).toEqual([
      ['test-kind-missing', 'tenon test register demo --suite e2e'],
      ['test-kind-missing', "tenon test waive demo --kind integration --reason '<不适用的原因>'"],
    ])
  })

  it('waiver-unapproved：未批准的豁免不解除阻塞；批准后放行', () => {
    const unapproved = { ...BASE_PLAN, waivers: [{ kind: 'integration' as const, reason: '无集成面', approved_by: null }] }
    const report = evaluate({ policy: { kinds: ['integration'] }, plan: unapproved })
    expect(report.blockers).toEqual([expect.objectContaining({
      code: 'waiver-unapproved', subject: 'integration', fix: 'tenon review request demo --event build-complete',
    })])
    const approved = { ...BASE_PLAN, waivers: [{ kind: 'integration' as const, reason: '无集成面', approved_by: 'reviewer@x' }] }
    expect(codes(evaluate({ policy: { kinds: ['integration'] }, plan: approved }))).toEqual([])
  })
})

describe('evaluateTestPolicy —— 测试文件登记', () => {
  it('test-file-unregistered / test-file-orphan；宿主不给 diff 时只提示', () => {
    const report = evaluate({
      policy: { run: ['unit'], scope: 'changed', files: 'registered' },
      runs: [UNIT_PASS],
      input: { changedFiles: ['src/new.test.ts', 'tools/x.spec.js', 'src/new.ts'] },
    })
    expect(report.blockers.map((item) => [item.code, item.subject, item.fix])).toEqual([
      ['test-file-unregistered', 'src/new.test.ts', 'tenon test register demo --file src/new.test.ts --suite unit'],
      ['test-file-orphan', 'tools/x.spec.js', 'tenon test discover'],
    ])
    expect(report.files).toMatchObject({ checked: true, orphans: ['tools/x.spec.js'] })
    const unchecked = evaluate({ policy: { run: ['unit'], scope: 'changed', files: 'registered' }, runs: [UNIT_PASS] })
    expect(unchecked.pass).toBe(true)
    expect(unchecked.notices.map((item) => item.code)).toEqual(['files-unchecked'])
  })
})

describe('evaluateTestPolicy —— diff 读取失败', () => {
  it('宿主有 diff 能力但这次读取失败 → files-diff-unavailable 阻塞（失败关闭），不降级成提示', () => {
    const report = evaluate({
      policy: { run: ['unit'], scope: 'changed', files: 'registered' },
      runs: [UNIT_PASS],
      input: { changedFilesError: 'git diff 失败' },
    })
    expect(report.pass).toBe(false)
    expect(report.blockers).toEqual([expect.objectContaining({
      code: 'files-diff-unavailable', blocking: true, fix: 'tenon test sync demo',
    })])
    expect(report.blockers[0]?.message).toContain('git diff 失败')
    expect(report.notices).toEqual([])
    expect(report.files.checked).toBe(false)
  })

  it('策略不要求文件登记时，diff 读取失败与本步无关', () => {
    const report = evaluate({ runs: [UNIT_PASS], input: { changedFilesError: 'git diff 失败' } })
    expect(report.pass).toBe(true)
  })
})

describe('evaluateTestPolicy —— 运行记录', () => {
  it('test-not-run：没有记录 / 运行中 / 只跑了部分范围 / 记录属于别的 workflow run', () => {
    expect(evaluate().blockers[0]).toMatchObject({ code: 'test-not-run', fix: 'tenon test run demo --suite unit' })
    expect(evaluate({ runs: [UNIT_PASS], input: { running: new Set(['unit']) } }).blockers[0]?.message).toMatch(/运行中/)
    const partial = evaluate({ policy: { run: ['unit'], scope: 'full' }, runs: [UNIT_PASS] })
    expect(partial.blockers[0]).toMatchObject({ code: 'test-not-run' })
    expect(partial.blockers[0]?.message).toMatch(/只跑了 changed 范围/)
    const other = evaluate({ runs: [UNIT_PASS], input: { bindings: { candidate: undefined, workflowFingerprint: FIXTURE_FINGERPRINT, workflowRunId: 'run-2' } } })
    expect(codes(other)).toEqual(['test-not-run'])
  })

  it('test-stale：五项绑定任一变化，写明哪一项', () => {
    const cases: Array<[Partial<TestPolicyEvaluationInput>, RegExp]> = [
      [{ bindings: { candidate: 'wsbase:v1:' + 'a'.repeat(64), workflowFingerprint: FIXTURE_FINGERPRINT, workflowRunId: 'run-1' } }, /代码已变化/],
      [{ bindings: { candidate: null, workflowFingerprint: FIXTURE_FINGERPRINT, workflowRunId: 'run-1' } }, /代码已变化/],
      [{ bindings: { candidate: undefined, workflowFingerprint: 'e'.repeat(64), workflowRunId: 'run-1' } }, /工作流已变化/],
      [{ catalog: { state: 'ok', catalog: parsedCatalog(CATALOG_TEXT.replace('npx vitest run', 'npx vitest run --silent')) } }, /套件定义已变化/],
    ]
    for (const [input, pattern] of cases) {
      const report = evaluate({ runs: [UNIT_PASS], input })
      expect(report.blockers[0]?.code).toBe('test-stale')
      expect(report.blockers[0]?.message).toMatch(pattern)
    }
    const planChanged = evaluate({
      runs: [UNIT_PASS],
      records: (context) => [recordFor([UNIT_PASS], { ...context, planDigest: `sha256:${'1'.repeat(64)}` })],
    })
    expect(planChanged.blockers[0]?.message).toMatch(/测试计划已变化/)
    const policyChanged = evaluate({
      records: (context) => [recordFor([UNIT_PASS], { ...context, policyDigest: `sha256:${'2'.repeat(64)}` })],
    })
    expect(policyChanged.blockers[0]?.message).toMatch(/本阶段测试策略已变化/)
    expect(policyChanged.suites[0]).toMatchObject({ state: 'stale', staleBecause: ['policy'] })
  })

  it('评审确认只批准豁免：批准之前的运行仍新鲜；计划有别的变化才过期', () => {
    const waiver = { kind: 'benchmark' as const, reason: '纯文案改动' }
    const before: TestPlan = { ...BASE_PLAN, waivers: [{ ...waiver, approved_by: null }] }
    const approved: TestPlan = { ...BASE_PLAN, waivers: [{ ...waiver, approved_by: 'reviewer@x.io' }] }
    const ranBeforeApproval = (plan: TestPlan) => evaluate({
      plan,
      records: (context) => [recordFor([UNIT_PASS], { ...context, planDigest: testPlanDigest(before) })],
    })
    expect(ranBeforeApproval(approved).suites[0]).toMatchObject({ state: 'passed' })
    const changed: TestPlan = { ...approved, suites: [...approved.suites, { suite: 'types', scope: 'full' }] }
    expect(ranBeforeApproval(changed).blockers[0]?.message).toMatch(/测试计划已变化/)
  })

  it('record-chain-broken：链断则 v2 记录全部视为未运行', () => {
    const report = evaluate({
      input: { chain: { state: 'broken', reason: '记录内容与摘要不符（被改动）', files: ['x.json'] } },
    })
    expect(report.blockers).toEqual([expect.objectContaining({ code: 'record-chain-broken', fix: 'tenon test run demo --stage' })])
    expect(report.suites[0]).toMatchObject({ state: 'missing' })
  })

  it('test-failed：失败用例、进程级原因、未列出的失败', () => {
    const failing = fixtureSuiteRun({
      suite: 'unit', scope: 'changed', result: 'fail', exit_code: 1,
      cases: [fixtureCase({ file: 'src/a.test.ts', name: 'breaks', status: 'fail', failure: { message: 'boom' } })],
    })
    expect(evaluate({ runs: [failing] }).blockers[0]?.message).toMatch(/1 个用例失败：src\/a\.test\.ts › breaks/)
    const timeout = fixtureSuiteRun({ suite: 'unit', scope: 'changed', result: 'fail', reasons: [{ code: 'timeout', detail: '900s' }] })
    expect(evaluate({ runs: [timeout] }).blockers[0]?.message).toMatch(/timeout（900s）/)
    const unlisted = fixtureSuiteRun({
      suite: 'unit', scope: 'changed', result: 'fail',
      totals: { cases: 3, pass: 1, fail: 2, skip: 0, flaky: 0, known_fail: 0 },
    })
    expect(evaluate({ runs: [unlisted] }).blockers[0]?.message).toMatch(/另有 2 个未列出的失败用例/)
  })

  it('已知失败：清单内失败不挡、过期按失败挡并提示、已修好提示移出', () => {
    const known: KnownFailure[] = [
      { suite: 'unit', test: 'src/a.test.ts › breaks', reason: 'x', expires: '2026-12-31', added_by: 'a' },
      { suite: 'unit', test: 'src/b.test.ts › old', reason: 'x', expires: '2026-01-01', added_by: 'a' },
      { suite: 'unit', test: 'src/c.test.ts › fixed', reason: 'x', expires: '2026-12-31', added_by: 'a' },
    ]
    const run = fixtureSuiteRun({
      suite: 'unit', scope: 'changed', result: 'fail',
      cases: [
        fixtureCase({ file: 'src/a.test.ts', name: 'breaks', status: 'known-fail' }),
        fixtureCase({ file: 'src/c.test.ts', name: 'fixed', status: 'pass' }),
      ],
    })
    const excused = evaluate({ runs: [run], input: { knownFailures: known } })
    expect(codes(excused)).toEqual([])
    expect(excused.notices).toEqual([expect.objectContaining({ code: 'known-failure-fixed', fix: "tenon test known rm --suite unit --test 'src/c.test.ts › fixed'" })])
    const expired = fixtureSuiteRun({ suite: 'unit', scope: 'changed', result: 'fail', cases: [fixtureCase({ file: 'src/b.test.ts', name: 'old', status: 'fail' })] })
    const report = evaluate({ runs: [expired], input: { knownFailures: known } })
    expect(codes(report)).toEqual(['test-failed'])
    expect(report.notices.map((item) => item.code)).toEqual(['known-failure-expired'])
  })

  it.each([
    ['no-tests-ran（0 用例）', fixtureSuiteRun({ suite: 'unit', scope: 'changed', cases: [] }), 'no-tests-ran'],
    ['no-tests-ran（全部跳过）', fixtureSuiteRun({ suite: 'unit', scope: 'changed', cases: [fixtureCase({ file: 'src/a.test.ts', name: 'x', status: 'skip' })] }), 'no-tests-ran'],
    ['report-missing', fixtureSuiteRun({ suite: 'unit', scope: 'changed', cases: [], result: 'fail', reasons: [{ code: 'report-missing' }] }), 'report-missing'],
    ['report-unreadable', fixtureSuiteRun({ suite: 'unit', scope: 'changed', cases: [], result: 'fail', reasons: [{ code: 'report-unreadable', detail: 'xml' }] }), 'report-unreadable'],
    ['exit-report-mismatch', fixtureSuiteRun({ suite: 'unit', scope: 'changed', result: 'fail', exit_code: 1, reasons: [{ code: 'exit-report-mismatch' }] }), 'exit-report-mismatch'],
    ['service-not-ready', fixtureSuiteRun({ suite: 'unit', scope: 'changed', result: 'fail', reasons: [{ code: 'service-not-ready', detail: 'web-dev' }] }), 'service-not-ready'],
  ])('%s', (_name, run, code) => {
    const report = evaluate({ runs: [run] })
    expect(codes(report)).toContain(code)
    expect(report.suites[0]?.state).toBe('failed')
  })

  it('registered-test-not-executed：登记的文件或映射的用例不在报告里（跳过也不算执行）', () => {
    const plan: TestPlan = {
      ...BASE_PLAN,
      files: [{ path: 'src/new.test.ts', suite: 'unit' }],
      cases: [{ covers: 'task:1.1', tests: ['src/a.test.ts › missing case'] }],
    }
    const run = fixtureSuiteRun({
      suite: 'unit', scope: 'changed',
      cases: [fixtureCase({ file: 'src/a.test.ts', name: 'works' }), fixtureCase({ file: 'src/new.test.ts', name: 'skipped', status: 'skip' })],
    })
    const report = evaluate({ plan, runs: [run] })
    expect(codes(report)).toEqual(['registered-test-not-executed'])
    expect(report.blockers[0]?.message).toMatch(/src\/new\.test\.ts；src\/a\.test\.ts › missing case/)
  })

  it('coverage-below：低于门槛 / 没有数据 / 运行集里没有声明覆盖率的套件（可用 coverage 豁免）', () => {
    const policy: StepTestPolicyDef = { run: ['unit'], scope: 'changed', coverage: { lines: 80, branches: 70 } }
    const low = fixtureSuiteRun({ suite: 'unit', scope: 'changed', coverage: { lines: 75 } })
    expect(evaluate({ policy, runs: [low] }).blockers[0]?.message).toMatch(/lines 75% < 80%；branches 未报告/)
    expect(evaluate({ policy, runs: [UNIT_PASS] }).blockers[0]?.message).toMatch(/没有产出覆盖率数据/)
    expect(codes(evaluate({ policy, runs: [fixtureSuiteRun({ suite: 'unit', scope: 'changed', coverage: { lines: 90, branches: 80 } })] }))).toEqual([])
    const typesOnly: TestPlan = { ...BASE_PLAN, suites: [{ suite: 'types', scope: 'full' }] }
    const typesRun = fixtureSuiteRun({ suite: 'types', kind: 'typecheck', runner: 'tsc', scope: 'full', cases: [], report: { format: 'exit-code', path: null, digest: null } })
    const noSuite = evaluate({ policy: { run: ['typecheck'], coverage: { lines: 80 } }, plan: typesOnly, runs: [typesRun] })
    expect(codes(noSuite)).toEqual(['coverage-below'])
    const waived = { ...typesOnly, waivers: [{ kind: 'coverage' as const, reason: '纯类型改动', approved_by: 'r' }] }
    expect(codes(evaluate({ policy: { run: ['typecheck'], coverage: { lines: 80 } }, plan: waived, runs: [typesRun] }))).toEqual([])
  })

  describe('基准', () => {
    const plan: TestPlan = { ...BASE_PLAN, suites: [{ suite: 'bench', scope: 'full' }] }
    const run = (median: number): SuiteRunV2 => fixtureSuiteRun({
      suite: 'bench', kind: 'benchmark', runner: 'custom', cases: [],
      report: { format: 'benchmark-json', path: 'test-results/bench.json', digest: null },
      metrics: [{ name: 'p95_ms', better: 'lower', samples: [median, median], median, p95: median, mad: 0 }],
    })
    const baseline: TestBaselineV2 = nextBaselineV2(undefined, {
      suite: 'bench', profile: PROFILE, profile_label: 'x',
      metrics: { p95_ms: { median: 100, p95: 100, mad: 0, samples: 2, better: 'lower' } },
      source: { change: 'demo', run_id: '20260929T000000Z-abcdef', commit: null },
      actor: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' },
      updated_at: 't',
    })
    const baselines = new Map([[baselineKey('bench', PROFILE), baseline]])

    it('benchmark-regression：同画像退化超阈值、绝对上限', () => {
      expect(codes(evaluate({ policy: { run: ['benchmark'] }, plan, runs: [run(105)], input: { baselines } }))).toEqual([])
      expect(codes(evaluate({ policy: { run: ['benchmark'] }, plan, runs: [run(120)], input: { baselines } }))).toEqual(['benchmark-regression'])
      expect(codes(evaluate({ policy: { run: ['benchmark'] }, plan, runs: [run(300)], input: { baselines } }))).toEqual(['benchmark-regression'])
    })

    it('指标在报告里没有样本 → benchmark-regression（读不到不能当通过）', () => {
      const empty = fixtureSuiteRun({
        suite: 'bench', kind: 'benchmark', runner: 'custom', cases: [], metrics: [],
        report: { format: 'benchmark-json', path: 'test-results/bench.json', digest: null },
      })
      const report = evaluate({ policy: { run: ['benchmark'] }, plan, runs: [empty], input: { baselines } })
      expect(codes(report)).toEqual(['benchmark-regression'])
      expect(report.blockers[0]?.message).toContain("指标 'p95_ms' 没有读到样本")
    })

    it('benchmark-noisy：离散度超过退化阈值的一半只提示，不挡也不算通过依据', () => {
      const noisy = fixtureSuiteRun({
        suite: 'bench', kind: 'benchmark', runner: 'custom', cases: [],
        report: { format: 'benchmark-json', path: 'test-results/bench.json', digest: null },
        metrics: [{ name: 'p95_ms', better: 'lower', samples: [92, 100, 108], median: 100, p95: 108, mad: 8 }],
      })
      const report = evaluate({ policy: { run: ['benchmark'] }, plan, runs: [noisy], input: { baselines } })
      expect(report.pass).toBe(true)
      expect(report.notices).toEqual([expect.objectContaining({ code: 'benchmark-noisy', subject: 'bench' })])
      expect(report.suites[0]?.benchmark?.[0]?.noisy).toBe(true)
      expect(evaluate({ policy: { run: ['benchmark'] }, plan, runs: [run(100)], input: { baselines } }).notices).toEqual([])
    })

    it('baseline-missing：缺省只提示；require_baseline 时挡；给出建立基线命令', () => {
      const hint = evaluate({ policy: { run: ['benchmark'] }, plan, runs: [run(100)] })
      expect(hint.pass).toBe(true)
      expect(hint.blockers).toEqual([expect.objectContaining({ code: 'baseline-missing', blocking: false })])
      expect(hint.blockers[0]?.fix).toMatch(/^tenon test baseline demo --suite bench --run \d{8}T\d{6}Z-[a-f0-9]{6}$/)
      const strict = evaluate({ policy: { run: ['benchmark'], benchmark: { require_baseline: true } }, plan, runs: [run(100)] })
      expect(codes(strict)).toEqual(['baseline-missing'])
    })

    it('有则跑：计划登记了基准套件才要求', () => {
      expect(codes(evaluate({ policy: { run: ['unit'], run_if_registered: ['benchmark'], scope: 'changed' }, runs: [UNIT_PASS] }))).toEqual([])
      const registered: TestPlan = { ...BASE_PLAN, suites: [...BASE_PLAN.suites, { suite: 'bench', scope: 'full' }] }
      const report = evaluate({ policy: { run: ['unit'], run_if_registered: ['benchmark'], scope: 'changed' }, plan: registered, runs: [UNIT_PASS] })
      expect(report.suites.map((suite) => [suite.suite, suite.reason, suite.state])).toEqual([['unit', 'run', 'passed'], ['bench', 'if-registered', 'missing']])
      expect(codes(report)).toEqual(['test-not-run'])
    })
  })

  it('flaky-over-limit：总数超上限；本任务新增的用例 flaky 且 fail_on_new', () => {
    const run = fixtureSuiteRun({
      suite: 'unit', scope: 'changed',
      cases: [fixtureCase({ file: 'src/a.test.ts', name: 'x', status: 'flaky', attempts: 2 }), fixtureCase({ file: 'src/new.test.ts', name: 'y', status: 'flaky', attempts: 2 })],
    })
    expect(codes(evaluate({ policy: { run: ['unit'], scope: 'changed', flaky: { max: 1 } }, runs: [run] }))).toEqual(['flaky-over-limit'])
    expect(codes(evaluate({ policy: { run: ['unit'], scope: 'changed', flaky: { max: 5 } }, runs: [run] }))).toEqual([])
    const plan: TestPlan = { ...BASE_PLAN, files: [{ path: 'src/new.test.ts', suite: 'unit' }] }
    const report = evaluate({ policy: { run: ['unit'], scope: 'changed', flaky: { max: 5, fail_on_new: true } }, plan, runs: [run] })
    expect(report.blockers).toEqual([expect.objectContaining({ code: 'flaky-over-limit', subject: 'src/new.test.ts' })])
  })

  it('browser-project-missing：目录声明与策略要求的 project 都要出现在报告里', () => {
    const plan: TestPlan = { ...BASE_PLAN, suites: [{ suite: 'e2e', scope: 'full' }] }
    const run = fixtureSuiteRun({
      suite: 'e2e', kind: 'playwright', runner: 'playwright', projects: ['chromium'],
      report: { format: 'playwright-json', path: 'test-results/results.json', digest: null },
      cases: [fixtureCase({ file: 'e2e/a.spec.ts', name: 'x', project: 'chromium' })],
    })
    expect(codes(evaluate({ policy: { run: ['playwright'] }, plan, runs: [run] }))).toEqual([])
    const report = evaluate({ policy: { run: ['playwright'], browsers: ['chromium', 'webkit'] }, plan, runs: [run] })
    expect(report.blockers).toEqual([expect.objectContaining({ code: 'browser-project-missing' })])
    expect(report.blockers[0]?.message).toMatch(/webkit/)
  })
})

describe('evaluateTestPolicy —— 场景追溯', () => {
  const scenarios = extractScenarios('auth', '## ADDED Requirements\n### Requirement: 登录\n#### Scenario: 登录成功\n#### Scenario: 密码错误\n')
  const tasks = extractTaskItems('## 1. Build\n- [ ] 1.1 写登录页\n')

  it('scenario-uncovered：没有映射也没有已批准豁免；未批准的场景豁免报 waiver-unapproved', () => {
    const plan: TestPlan = {
      ...BASE_PLAN,
      cases: [{ covers: 'spec:auth/登录成功', tests: ['src/a.test.ts › works'] }],
      waivers: [{ covers: 'spec:auth/密码错误', reason: '沿用旧行为', approved_by: null }],
    }
    const report = evaluate({ policy: { scenarios: 'required' }, plan, input: { scenarios, tasks } })
    expect(report.blockers.map((item) => [item.code, item.subject])).toEqual([
      ['waiver-unapproved', 'spec:auth/密码错误'], ['scenario-uncovered', 'task:1.1'],
    ])
    const uncovered = evaluate({ policy: { scenarios: 'required' }, input: { scenarios, tasks } })
    expect(uncovered.blockers.map((item) => item.code)).toEqual(['scenario-uncovered', 'scenario-uncovered', 'scenario-uncovered'])
    expect(uncovered.blockers[0]?.fix).toBe("tenon test register demo --case 'spec:auth/登录成功' --test '<文件> › <用例名>'")
    expect(uncovered.blockers[2]?.message).toMatch(/^任务 /)
  })

  it('任务只有实现阶段小节里的要求映射；其余阶段的任务与骨架提示词只进矩阵，不出阻塞', () => {
    const mixed = extractTaskItems([
      '## 立项', '- [ ] 将本阶段目标拆成可验证任务。', '',
      '## 规格', '- [ ] 评审需求 (spec)', '',
      '## 实现', '- [ ] 写登录页', '- [ ] 将本阶段目标拆成可验证任务。 (build)', '',
      '## 验证', '- [ ] 手工回归 (verify)',
    ].join('\n'))
    const uncovered = evaluate({ policy: { scenarios: 'required' }, input: { scenarios: [], tasks: mixed } })
    expect(uncovered.blockers.map((item) => [item.code, item.subject])).toEqual([['scenario-uncovered', 'task:3.1']])
    expect(uncovered.trace.map((row) => [row.covers, row.required, row.state])).toEqual([
      ['task:1.1', false, 'uncovered'], ['task:2.1', false, 'uncovered'], ['task:3.1', true, 'uncovered'],
      ['task:3.2', false, 'uncovered'], ['task:4.1', false, 'uncovered'],
    ])
    const mapped: TestPlan = { ...BASE_PLAN, cases: [{ covers: 'task:3.1', tests: ['src/a.test.ts › works'] }] }
    expect(evaluate({ policy: { scenarios: 'required' }, plan: mapped, input: { scenarios: [], tasks: mixed } }).blockers).toEqual([])
    const off = evaluate({ policy: { scenarios: 'off' }, input: { scenarios: [], tasks: mixed } })
    expect(off.blockers).toEqual([])
    expect(off.trace.map((row) => row.required)).toEqual([false, false, true, false, false])
  })

  it('scenario-failing：passing 模式下映射用例本轮没有通过；追溯矩阵含 task 行与状态', () => {
    const plan: TestPlan = {
      ...BASE_PLAN,
      cases: [
        { covers: 'spec:auth/登录成功', tests: ['src/a.test.ts › works'] },
        { covers: 'spec:auth/密码错误', tests: ['src/a.test.ts › rejects'] },
        { covers: 'task:1.1', tests: ['src/a.test.ts › works'] },
        { covers: 'task:9.9', tests: ['src/a.test.ts › works'] },
      ],
    }
    const run = fixtureSuiteRun({
      suite: 'unit', scope: 'changed', result: 'fail',
      cases: [fixtureCase({ file: 'src/a.test.ts', name: 'works' }), fixtureCase({ file: 'src/a.test.ts', name: 'rejects', status: 'fail' })],
    })
    const report = evaluate({ policy: { run: ['unit'], scope: 'changed', scenarios: 'passing' }, plan, runs: [run], input: { scenarios, tasks } })
    expect(report.blockers.map((item) => item.code)).toEqual(['test-failed', 'scenario-failing'])
    expect(report.trace.map((row) => [row.covers, row.state, row.tests.map((test) => test.status)])).toEqual([
      ['spec:auth/登录成功', 'passing', ['pass']],
      ['spec:auth/密码错误', 'failing', ['fail']],
      ['task:1.1', 'passing', ['pass']],
    ])
    expect(report.notices.map((item) => [item.code, item.subject])).toEqual([['trace-mapping-stale', 'task:9.9']])
    const notRun = evaluate({ policy: { scenarios: 'passing' }, plan: { ...plan, cases: plan.cases.slice(0, 2) }, input: { scenarios } })
    expect(notRun.blockers.map((item) => item.code)).toEqual(['scenario-failing', 'scenario-failing'])
    expect(notRun.trace[0]).toMatchObject({ state: 'mapped', tests: [{ status: 'not-run' }] })
  })
})

describe('evaluateTestPolicy —— 旧步骤测试（内联套件）并入', () => {
  const test = {
    id: 'unit', direction: 'unit', command: 'npm test', cwd: '.', timeout_s: 900, required: true, keep_runs: 5,
    pass: { exit_code: 0, metrics: [] }, inputs: [], outputs: [],
  }
  const suite = inlineSuiteFromTest(test)

  it.each([
    ['missing', 'test-not-run', 'tenon test run demo unit'],
    ['running', 'test-not-run', undefined],
    ['stale', 'test-stale', 'tenon test run demo unit'],
    ['failed', 'test-failed', 'tenon test run demo unit'],
  ] as const)('v1 状态 %s → %s', (status, code, fix) => {
    const report = evaluate({ policy: {}, input: { inline: [{ suite, status }] } })
    expect(report.blockers).toEqual([expect.objectContaining({ code, subject: 'step:unit', ...(fix === undefined ? {} : { fix }) })])
    expect(report.suites).toEqual([expect.objectContaining({ suite: 'step:unit', origin: 'step', reason: 'inline' })])
  })

  it('通过或非必需不挡；同名 v2 记录优先', () => {
    expect(codes(evaluate({ policy: {}, input: { inline: [{ suite, status: 'passed' }] } }))).toEqual([])
    expect(codes(evaluate({ policy: {}, input: { inline: [{ suite: { ...suite, required: false }, status: 'failed' }] } }))).toEqual([])
    const v2 = fixtureSuiteRun({ suite: 'step:unit', result: 'pass' })
    const report = evaluate({ policy: {}, runs: [v2], input: { inline: [{ suite, status: 'missing' }] } })
    expect(report.suites[0]).toMatchObject({ suite: 'step:unit', state: 'passed' })
  })

  it('渲染成既有文案口径（只含阻塞项）', () => {
    const report = evaluate({ runs: [fixtureSuiteRun({ suite: 'bench', kind: 'benchmark', runner: 'custom' })] })
    expect(renderPolicyBlockers(report)).toEqual(['套件 unit（unit）本阶段还没有在当前代码上运行；执行 tenon test run demo --suite unit'])
  })
})
