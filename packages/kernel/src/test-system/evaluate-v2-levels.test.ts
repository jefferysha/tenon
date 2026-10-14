/**
 * 策略判定 × 档位与认领：档位策略的运行集 / 缺必需类 / 读不到改动，改动过的测试文件按套件 glob 认领
 * （不再出 test-file-unregistered）、认领文件的执行检查，以及旧策略 `files: registered` 改按认领后的行为。
 */
import { describe, expect, it } from 'vitest'
import { compileStepTestPolicy } from '../workflow/compile-test-policy.js'
import type { StepIR, StepTestPolicyIR } from '../workflow/ir.js'
import type { TestLevel } from '../workflow/test-level.js'
import type { TestBlockerCode } from './blockers.js'
import { catalogSuitesDigest, parseTestCatalog } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import { evaluateTestPolicy } from './evaluate-v2.js'
import type { ProtectedEvidenceInput, TestPolicyEvaluationInput, TestPolicyReport } from './evaluate-types.js'
import { extractScenarios } from './openspec-trace.js'
import { emptyTestPlan, testPlanDigest, type TestPlan } from './plan.js'
import { testPolicyDigest } from './policy.js'
import { verifyRecordChain, type ChainReport } from './record-chain.js'
import type { SuiteRunV2 } from './record-v2-types.js'
import { resolveStepTestPolicy } from './resolve-policy.js'
import { EMPTY_TEST_SEAL } from './seal.js'
import { FIXTURE_FINGERPRINT, fixtureCase, fixtureChain, fixtureRecordDraft, fixtureSuiteRun } from './test-support.js'

const SHAPE: Readonly<Record<string, string>> = {
  playwright: 'runner: playwright, report: { format: playwright-json, path: test-results/results.json }',
  typecheck: 'runner: tsc, report: { format: exit-code }',
}

const suite = (id: string, kind: string, files: string, covers: string, extra = ''): string =>
  `  - { id: ${id}, kind: ${kind}, ${SHAPE[kind] ?? `runner: vitest, report: { format: junit, path: test-results/${id}.xml }`}, command: run, files: ["${files}"], covers: ["${covers}"]${extra} }\n`

function catalogOf(suites: string, tail = ''): TestCatalog {
  const result = parseTestCatalog(`schema: tenon-test-catalog/v1\nsuites:\n${suites}${tail}`)
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('\n'))
  return result.catalog
}

const CATALOG = catalogOf(
  suite('unit', 'unit', 'src/**/*.test.ts', 'src/**')
  + suite('hooks', 'integration', 'hooks/**/*.test.sh', 'hooks/**')
  + suite('e2e', 'playwright', 'e2e/**/*.spec.ts', 'ui/**'),
)

const PLAN: TestPlan = { ...emptyTestPlan('demo'), suites: [] }

interface Scenario {
  readonly policy?: StepTestPolicyIR
  readonly level?: TestLevel
  readonly catalog?: TestCatalog
  readonly plan?: TestPlan
  readonly changedFiles?: readonly string[] | undefined
  readonly runs?: readonly SuiteRunV2[]
  readonly input?: Partial<TestPolicyEvaluationInput>
}

function evaluate(scenario: Scenario = {}): TestPolicyReport {
  const catalog = scenario.catalog ?? CATALOG
  const policy = scenario.policy ?? resolveStepTestPolicy({ test: scenario.level ?? 'changed' }, catalog)
  if (policy === undefined) throw new Error('policy')
  const plan = scenario.plan ?? PLAN
  const planDigest = testPlanDigest(plan)
  const runs = scenario.runs ?? []
  const drafts = runs.length === 0 ? [] : [fixtureRecordDraft({
    suites: [...runs],
    machine_profile: 'darwin-arm64-m3max-node22-1a2b3c4d',
    bindings: {
      candidate: null, workflow_fingerprint: FIXTURE_FINGERPRINT,
      catalog_digest: catalogSuitesDigest(catalog, runs.map((run) => run.suite)),
      plan_digest: planDigest, policy_digest: testPolicyDigest(policy),
    },
  })]
  const chain: ChainReport = verifyRecordChain({
    records: fixtureChain(drafts).map((record) => ({ file: `${record.run_id}.json`, record })),
    problems: [],
  })
  return evaluateTestPolicy({
    change: 'demo', stepId: 'build', policy, inline: [],
    catalog: { state: 'ok', catalog }, plan: { state: 'ok', plan, digest: planDigest }, chain,
    knownFailures: [], baselines: new Map(),
    changedFiles: 'changedFiles' in scenario ? scenario.changedFiles : [],
    scenarios: [], tasks: [],
    bindings: { candidate: undefined, workflowFingerprint: FIXTURE_FINGERPRINT, workflowRunId: 'run-1' },
    today: '2026-10-12', exitEvent: 'build-complete',
    ...scenario.input,
  })
}

const codes = (report: TestPolicyReport): TestBlockerCode[] => report.blockers.filter((item) => item.blocking).map((item) => item.code)

const caseIn = (file: string, name = 'works') => fixtureCase({ file, name })

const UNIT_CHANGED = (selection: readonly string[], files: readonly string[] = selection): SuiteRunV2 =>
  fixtureSuiteRun({ suite: 'unit', scope: 'changed', selection, cases: files.map((file) => caseIn(file)) })

describe('档位策略 —— 运行集', () => {
  it('跑改动：改动没碰到任何套件 → 零运行即通过', () => {
    const report = evaluate({ level: 'changed', changedFiles: ['README.md'] })
    expect(report.blockers).toEqual([])
    expect(report.pass).toBe(true)
    expect(report.suites).toEqual([])
  })

  it('跑改动：改了 src/a.ts → unit 必须在当前代码上运行；运行过且通过 → 放行', () => {
    const missing = evaluate({ level: 'changed', changedFiles: ['src/a.ts'] })
    expect(missing.blockers).toEqual([expect.objectContaining({ code: 'test-not-run', fix: 'tenon test run demo --suite unit', subject: 'unit' })])
    const ran = evaluate({
      level: 'changed', changedFiles: ['src/a.ts'],
      runs: [fixtureSuiteRun({ suite: 'unit', scope: 'changed' })],
    })
    expect(ran.blockers).toEqual([])
    expect(ran.suites).toEqual([expect.objectContaining({ suite: 'unit', state: 'passed', reason: 'run' })])
  })

  it('全量档：必需类全量；只跑了 changed 范围 → test-not-run（要求全量）', () => {
    const report = evaluate({ level: 'full', changedFiles: ['README.md'], runs: [fixtureSuiteRun({ suite: 'unit', scope: 'changed' })] })
    expect(report.blockers).toEqual([expect.objectContaining({ code: 'test-not-run', message: expect.stringContaining('全量') })])
    const ok = evaluate({ level: 'full', changedFiles: ['README.md'], runs: [fixtureSuiteRun({ suite: 'unit', scope: 'full' })] })
    expect(ok.blockers).toEqual([])
  })

  it('全量档：被碰到的集成类套件也进运行集（if-registered）', () => {
    const report = evaluate({ level: 'full', changedFiles: ['hooks/gate.sh'], runs: [fixtureSuiteRun({ suite: 'unit', scope: 'full' })] })
    expect(report.blockers).toEqual([expect.objectContaining({ code: 'test-not-run', subject: 'hooks' })])
  })

  it('档位策略不要求计划里有该类套件：计划为空也不出 test-kind-missing', () => {
    expect(codes(evaluate({ level: 'changed', changedFiles: ['README.md'], plan: emptyTestPlan('demo') }))).toEqual([])
  })

  it('plan 档：计划存在、必需类在目录里有套件就满足，不要求运行', () => {
    const report = evaluate({ level: 'plan', changedFiles: ['src/a.ts'] })
    expect(report.blockers).toEqual([])
    expect(report.suites).toEqual([])
    expect(report.files.checked).toBe(false)
  })

  it('计划缺失仍是 test-plan-missing（档位策略要求计划）', () => {
    const report = evaluate({ level: 'changed', changedFiles: [], input: { plan: { state: 'missing' } } })
    expect(codes(report)).toEqual(['test-plan-missing'])
  })
})

describe('档位策略 —— 没写 covers 的套件提示 suites-without-covers', () => {
  const NO_COVERS = catalogOf('  - { id: unit, kind: unit, runner: vitest, report: { format: junit, path: test-results/unit.xml }, command: run, files: ["test/**/*.test.js"] }\n')
  const noticeCodes = (report: TestPolicyReport): string[] => report.notices.map((item) => item.code)

  it('只改源码 src/a.js，unit 没写 covers 没进运行集 → 不阻断，出提示并点名 unit', () => {
    const report = evaluate({ level: 'changed', catalog: NO_COVERS, changedFiles: ['src/a.js'] })
    expect(report.blockers).toEqual([])
    expect(report.pass).toBe(true)
    expect(report.suites).toEqual([])
    expect(report.notices).toEqual([expect.objectContaining({
      code: 'suites-without-covers',
      message: expect.stringContaining('unit'),
      fix: 'tenon test catalog set unit --cover-glob "<glob>"',
    })])
  })

  it('只改 README.md（不是源码文件）→ 没有这条提示', () => {
    const report = evaluate({ level: 'changed', catalog: NO_COVERS, changedFiles: ['README.md'] })
    expect(noticeCodes(report)).toEqual([])
    expect(report.pass).toBe(true)
  })

  it('unit 写了 covers、被源码改动碰到 → 它进运行集（要求先运行），不出这条提示', () => {
    const report = evaluate({ level: 'changed', changedFiles: ['src/a.js'] })
    expect(noticeCodes(report)).toEqual([])
    expect(report.blockers).toEqual([expect.objectContaining({ code: 'test-not-run', subject: 'unit' })])
  })

  it('full 档：必需类的 unit 总在运行集里不报；被源码改动漏掉的 touched 类套件报', () => {
    const catalog = catalogOf(
      '  - { id: unit, kind: unit, runner: vitest, report: { format: junit, path: test-results/unit.xml }, command: run, files: ["test/**/*.test.js"] }\n'
      + '  - { id: hooks, kind: integration, runner: vitest, report: { format: junit, path: test-results/hooks.xml }, command: run, files: ["hooks/**/*.test.sh"] }\n',
    )
    const report = evaluate({ level: 'full', catalog, changedFiles: ['src/a.js'], runs: [fixtureSuiteRun({ suite: 'unit', scope: 'full' })] })
    expect(report.blockers).toEqual([])
    expect(report.notices.map((item) => [item.code, item.message])).toEqual([
      ['suites-without-covers', expect.stringContaining('套件 hooks 没写 covers')],
    ])
  })

  it('plan 档、读不到改动列表（宿主没有 diff 能力）、计划缺失 → 不出这条提示', () => {
    expect(noticeCodes(evaluate({ level: 'plan', catalog: NO_COVERS, changedFiles: ['src/a.js'] }))).toEqual([])
    expect(noticeCodes(evaluate({ level: 'changed', catalog: NO_COVERS, changedFiles: undefined }))).toEqual(['files-unchecked'])
    const noPlan = evaluate({ level: 'changed', catalog: NO_COVERS, changedFiles: ['src/a.js'], input: { plan: { state: 'missing' } } })
    expect(noticeCodes(noPlan)).toEqual([])
  })
})

describe('档位策略 —— 缺必需类', () => {
  const noUnit = catalogOf(suite('hooks', 'integration', 'hooks/**/*.test.sh', 'hooks/**'))

  it('目录里没有 unit 类套件 → test-kind-missing，修复命令是项目级不适用声明', () => {
    const report = evaluate({ level: 'changed', catalog: noUnit, changedFiles: [] })
    expect(report.blockers).toEqual([expect.objectContaining({
      code: 'test-kind-missing', subject: 'unit',
      fix: "tenon test catalog not-applicable unit --reason '<本项目为什么不适用>'",
      message: expect.stringContaining('tenon test waive'),
    })])
  })

  it('kind: coverage 的套件满足 unit 类', () => {
    const covered = catalogOf(suite('cov', 'coverage', 'src/**/*.test.ts', 'src/**', ', coverage: { format: istanbul-summary, path: coverage/coverage-summary.json }'))
    expect(codes(evaluate({ level: 'changed', catalog: covered, changedFiles: [] }))).toEqual([])
  })

  it('计划里该类的已批准种类豁免满足；未批准给 waiver-unapproved', () => {
    const approved: TestPlan = { ...PLAN, waivers: [{ kind: 'unit', reason: '没有单测', approved_by: 'reviewer@x' }] }
    expect(codes(evaluate({ level: 'changed', catalog: noUnit, plan: approved, changedFiles: [] }))).toEqual([])
    const pending: TestPlan = { ...PLAN, waivers: [{ kind: 'unit', reason: '没有单测', approved_by: null }] }
    expect(evaluate({ level: 'changed', catalog: noUnit, plan: pending, changedFiles: [] }).blockers).toEqual([
      expect.objectContaining({ code: 'waiver-unapproved', subject: 'unit', fix: 'tenon review request demo --event build-complete' }),
    ])
  })

  it('目录里已批准的项目级不适用声明满足；未批准给 waiver-unapproved', () => {
    const na = (approved: string): TestCatalog => catalogOf(
      suite('hooks', 'integration', 'hooks/**/*.test.sh', 'hooks/**'),
      `not_applicable:\n  - { kind: unit, reason: 本项目没有单测, approved_by: ${approved} }\n`,
    )
    expect(codes(evaluate({ level: 'changed', catalog: na('reviewer@x'), changedFiles: [] }))).toEqual([])
    expect(evaluate({ level: 'changed', catalog: na('null'), changedFiles: [] }).blockers).toEqual([
      expect.objectContaining({ code: 'waiver-unapproved', subject: 'unit', message: expect.stringContaining('catalog.yaml') }),
    ])
  })

  it('目录 levels 改必需类：full 要求 e2e 类，没有就出 test-kind-missing', () => {
    const catalog = catalogOf(suite('unit', 'unit', 'src/**/*.test.ts', 'src/**'), 'levels:\n  full: { required: [unit, e2e] }\n')
    const report = evaluate({ level: 'full', catalog, changedFiles: [], runs: [fixtureSuiteRun({ suite: 'unit', scope: 'full' })] })
    expect(report.blockers.map((item) => [item.code, item.subject])).toEqual([['test-kind-missing', 'e2e']])
  })
})

describe('档位策略 —— 只改目录就能改档位含义', () => {
  const COVERAGE_REPORT = ', coverage: { format: istanbul-summary, path: coverage/coverage-summary.json }'
  const UNIT = suite('unit', 'unit', 'src/**/*.test.ts', 'src/**', COVERAGE_REPORT)
  // 工作流步骤只记档位名；两次求值都拿这同一个对象，变的只有目录。
  const STEP: Pick<StepIR, 'test' | 'test_policy'> = Object.freeze({ test: 'full' })
  const FULL_RUN = fixtureSuiteRun({ suite: 'unit', scope: 'full', coverage: { lines: 70 } })

  function evaluateStep(catalog: TestCatalog): TestPolicyReport {
    const policy = resolveStepTestPolicy(STEP, catalog)
    if (policy === undefined) throw new Error('policy')
    return evaluate({ catalog, policy, changedFiles: [], runs: [FULL_RUN] })
  }

  it('目录写 levels.full.coverage.lines: 80，行覆盖率 70% → 出 coverage-below；目录不写 levels → 同样的步骤与运行不出', () => {
    const strict = evaluateStep(catalogOf(UNIT, 'levels:\n  full: { coverage: { lines: 80 } }\n'))
    expect(strict.blockers).toEqual([expect.objectContaining({
      code: 'coverage-below', subject: 'unit', message: expect.stringContaining('lines 70% < 80%'),
    })])
    expect(strict.pass).toBe(false)

    const loose = evaluateStep(catalogOf(UNIT))
    expect(loose.blockers).toEqual([])
    expect(loose.pass).toBe(true)
    expect(STEP).toEqual({ test: 'full' })
  })

  it('同一目录把门槛调到 60 → 70% 达标；调回 80 又不达标（结论只随目录里的数字变）', () => {
    const at = (lines: number): TestCatalog => catalogOf(UNIT, `levels:\n  full: { coverage: { lines: ${lines} } }\n`)
    expect(codes(evaluateStep(at(60)))).toEqual([])
    expect(codes(evaluateStep(at(80)))).toEqual(['coverage-below'])
  })
})

describe('档位策略 —— 场景映射只在目录的档位要求时出现', () => {
  const UNIT = suite('unit', 'unit', 'src/**/*.test.ts', 'src/**')
  const SCENARIOS = extractScenarios('auth', '## ADDED Requirements\n### Requirement: 登录\n#### Scenario: 登录成功\n')
  // 工作流步骤只记档位名；两次求值都拿这同一个对象，变的只有目录里有没有 `scenarios: required`。
  const STEP: Pick<StepIR, 'test' | 'test_policy'> = Object.freeze({ test: 'changed' })

  function evaluateStep(catalog: TestCatalog): TestPolicyReport {
    const policy = resolveStepTestPolicy(STEP, catalog)
    if (policy === undefined) throw new Error('policy')
    return evaluate({ catalog, policy, changedFiles: [], input: { scenarios: SCENARIOS } })
  }

  it('目录写 levels.changed.scenarios: required，有场景未映射 → 出 scenario-uncovered；目录不写 levels → 同样的步骤与规格不出', () => {
    const required = evaluateStep(catalogOf(UNIT, 'levels:\n  changed: { scenarios: required }\n'))
    expect(required.blockers).toEqual([expect.objectContaining({
      code: 'scenario-uncovered', subject: 'spec:auth/登录成功',
      fix: "tenon test register demo --case 'spec:auth/登录成功' --test '<文件> › <用例名>'",
    })])
    expect(required.pass).toBe(false)
    expect(required.scenarios).toBe('required')

    const byDefault = evaluateStep(catalogOf(UNIT))
    expect(byDefault.blockers).toEqual([])
    expect(byDefault.pass).toBe(true)
    expect(byDefault.scenarios).toBe('off')
    expect(byDefault.trace).toEqual([expect.objectContaining({ covers: 'spec:auth/登录成功', required: false, state: 'uncovered' })])
    expect(STEP).toEqual({ test: 'changed' })
  })
})

describe('档位策略 —— 目录无效与读不到改动', () => {
  it('目录无效时档位用缺省求值，照旧出 test-catalog-missing，不放行（Review Focus 4）', () => {
    const policy = resolveStepTestPolicy({ test: 'changed' }, undefined)
    const report = evaluate({
      policy, changedFiles: ['src/a.ts'],
      input: { catalog: { state: 'invalid', issues: ['catalog.yaml:3: 未知键'] } },
    })
    expect(report.pass).toBe(false)
    expect(report.blockers[0]).toMatchObject({ code: 'test-catalog-missing', fix: 'tenon test catalog validate' })
    const missing = evaluate({ policy, input: { catalog: { state: 'missing' } } })
    expect(codes(missing)).toEqual(['test-catalog-missing'])
  })

  it('读不到改动列表：changed / full 档都出 files-diff-unavailable 阻断（失败关闭）', () => {
    for (const level of ['changed', 'full'] as const) {
      const report = evaluate({
        level, runs: [fixtureSuiteRun({ suite: 'unit', scope: 'full' })], changedFiles: undefined, input: { changedFilesError: 'git diff 失败' },
      })
      expect(codes(report), level).toEqual(['files-diff-unavailable'])
      expect(report.files.checked, level).toBe(false)
    }
  })

  it('宿主没有 diff 能力（既没列表也没报错）：只提示 files-unchecked，不阻断', () => {
    const report = evaluate({ level: 'changed', changedFiles: undefined })
    expect(report.pass).toBe(true)
    expect(report.notices.map((item) => item.code)).toEqual(['files-unchecked'])
  })

  it('plan 档读不到改动列表与本步无关', () => {
    expect(evaluate({ level: 'plan', changedFiles: undefined, input: { changedFilesError: 'x' } }).pass).toBe(true)
  })

  it('受保护配置的改动读不出（评审门）：档位 changed / full 按阻断处理，plan 档只提示', () => {
    const sealed: ProtectedEvidenceInput = { reviewGated: true, changes: undefined, changesError: '读不出', seal: EMPTY_TEST_SEAL, sealState: 'ok' }
    const changed = evaluate({ level: 'changed', changedFiles: [], input: { protected: sealed } })
    expect(codes(changed)).toEqual(['files-diff-unavailable'])
    const plan = evaluate({ level: 'plan', changedFiles: [], input: { protected: sealed } })
    expect(codes(plan)).toEqual([])
    expect(plan.notices.map((item) => item.code)).toEqual(['files-unchecked'])
  })
})

describe('改动过的测试文件认领', () => {
  it('新增测试文件被 unit 认领 → 不出 test-file-unregistered，报告的 files 里带认领清单，unregistered 恒空', () => {
    const report = evaluate({
      level: 'changed', changedFiles: ['src/new.test.ts', 'src/new.ts'],
      runs: [UNIT_CHANGED(['src/new.test.ts'])],
    })
    expect(report.blockers).toEqual([])
    expect(report.files).toEqual({ checked: true, unregistered: [], orphans: [], claimed: [{ path: 'src/new.test.ts', suites: ['unit'] }] })
  })

  it('孤儿测试文件 → test-file-orphan，一条 --auto 认领；计划里按 kind 登记的资源文件不是孤儿', () => {
    const report = evaluate({ level: 'changed', changedFiles: ['tools/x.spec.js', 'snap/login.test.ts', 'README.md'] })
    expect(report.blockers.map((item) => [item.code, item.subject, item.fix])).toEqual([
      ['test-file-orphan', 'snap/login.test.ts', 'tenon test register demo --auto'],
      ['test-file-orphan', 'tools/x.spec.js', 'tenon test register demo --auto'],
    ])
    const registered: TestPlan = { ...PLAN, files: [{ path: 'snap/login.test.ts', kind: 'visual' }] }
    const withResource = evaluate({ level: 'changed', plan: registered, changedFiles: ['snap/login.test.ts'] })
    expect(withResource.files.orphans).toEqual([])
  })

  it('控制目录与非源码扩展名的改动既不认领也不是孤儿', () => {
    const report = evaluate({
      level: 'changed',
      changedFiles: ['openspec/changes/archive/x/a.spec.report', 'openspec/changes/c/notes.spec.md', '.tenon/tests/x.test.json', 'fixtures/data.spec.json'],
    })
    expect(report.blockers).toEqual([])
    expect(report.files).toMatchObject({ checked: true, orphans: [], claimed: [] })
  })

  it('认领了却没执行 → registered-test-not-executed，点名该文件', () => {
    const report = evaluate({
      level: 'changed', changedFiles: ['src/b.test.ts'],
      runs: [UNIT_CHANGED(['src/b.test.ts'], ['src/other.test.ts'])],
    })
    expect(report.blockers).toEqual([expect.objectContaining({
      code: 'registered-test-not-executed', subject: 'unit', message: expect.stringContaining('src/b.test.ts'),
    })])
  })

  it('跑的是 changed 范围时只核对 selection 里的认领文件；没有 selection（退回全量）时全查', () => {
    const narrowed = evaluate({
      level: 'changed', changedFiles: ['src/a.test.ts', 'src/b.test.ts'],
      runs: [UNIT_CHANGED(['src/a.test.ts'])],
    })
    expect(narrowed.blockers).toEqual([])
    const fallback = evaluate({
      level: 'changed', changedFiles: ['src/a.test.ts', 'src/b.test.ts'],
      runs: [fixtureSuiteRun({ suite: 'unit', scope: 'full', cases: [caseIn('src/a.test.ts')] })],
    })
    expect(fallback.blockers).toEqual([expect.objectContaining({ code: 'registered-test-not-executed', message: expect.stringContaining('src/b.test.ts') })])
  })

  describe('一个文件被两个套件认领', () => {
    const twin = catalogOf(suite('unit', 'unit', 'src/**/*.test.ts', 'src/**') + suite('unit-b', 'unit', 'src/**/*.test.ts', 'src/**'))
    const run = (id: string, file: string): SuiteRunV2 => fixtureSuiteRun({ suite: id, scope: 'changed', selection: ['src/a.test.ts'], cases: [caseIn(file)] })

    it('其中一个跑过它就够', () => {
      const report = evaluate({
        level: 'changed', catalog: twin, changedFiles: ['src/a.test.ts'],
        runs: [run('unit', 'src/a.test.ts'), run('unit-b', 'src/zzz.test.ts')],
      })
      expect(report.blockers).toEqual([])
    })

    it('两个都没执行它 → 只出一条，归在第一个认领套件下', () => {
      const report = evaluate({
        level: 'changed', catalog: twin, changedFiles: ['src/a.test.ts'],
        runs: [run('unit', 'src/zzz.test.ts'), run('unit-b', 'src/zzz.test.ts')],
      })
      expect(report.blockers.map((item) => [item.code, item.subject])).toEqual([['registered-test-not-executed', 'unit']])
    })

    it('没跑过的认领套件不参与核对（它本身另出 test-not-run）', () => {
      const report = evaluate({
        level: 'changed', catalog: twin, changedFiles: ['src/a.test.ts'],
        runs: [run('unit', 'src/a.test.ts')],
      })
      expect(report.blockers.map((item) => [item.code, item.subject])).toEqual([['test-not-run', 'unit-b']])
    })
  })

  it('认领不看计划：认领文件所属套件不在计划里也进档位运行集', () => {
    const report = evaluate({ level: 'changed', plan: emptyTestPlan('demo'), changedFiles: ['hooks/a.test.sh'] })
    // hooks 是集成类，changed 档的 touched 只有 static：改动不会让它进运行集，认领文件也不触发别的阻断。
    expect(report.blockers).toEqual([])
    expect(report.files.claimed).toEqual([{ path: 'hooks/a.test.sh', suites: ['hooks'] }])
  })

  it('flaky 的 fail_on_new 把认领文件当作本任务新增的测试', () => {
    const catalog = CATALOG
    const policy = resolveStepTestPolicy({ test: 'changed' }, catalogOf(
      suite('unit', 'unit', 'src/**/*.test.ts', 'src/**'),
      'levels:\n  changed: { flaky: { max: 5, fail_on_new: true } }\n',
    ))
    const flakyRun = fixtureSuiteRun({
      suite: 'unit', scope: 'changed', selection: ['src/a.test.ts'],
      cases: [fixtureCase({ file: 'src/a.test.ts', name: 'x', status: 'flaky', attempts: 2 })],
      totals: { cases: 1, pass: 0, fail: 0, skip: 0, flaky: 1, known_fail: 0 },
    })
    const report = evaluate({ policy, catalog, changedFiles: ['src/a.test.ts'], runs: [flakyRun] })
    expect(codes(report)).toEqual(['flaky-over-limit'])
  })
})

describe('旧策略 files: registered 改按认领', () => {
  const legacy = (raw: Parameters<typeof compileStepTestPolicy>[0]): StepTestPolicyIR => {
    const policy = compileStepTestPolicy(raw, 'test')
    if (policy === undefined) throw new Error('policy')
    return policy
  }
  const POLICY = legacy({ run: ['unit'], scope: 'changed', files: 'registered' })
  const planned: TestPlan = { ...PLAN, suites: [{ suite: 'unit', scope: 'changed' }] }

  it('新增被认领的测试文件不再要求登记（不出 test-file-unregistered）', () => {
    const report = evaluate({
      policy: POLICY, plan: planned, changedFiles: ['src/new.test.ts'],
      runs: [UNIT_CHANGED(['src/new.test.ts'])],
    })
    expect(report.blockers).toEqual([])
    expect(report.files).toMatchObject({ checked: true, unregistered: [], claimed: [{ path: 'src/new.test.ts', suites: ['unit'] }] })
  })

  it('认领文件所属、种类在 run / run_if_registered 里的套件进入运行集；计划里没有它也一样', () => {
    const policy = legacy({ run: ['unit'], run_if_registered: ['integration'], scope: 'changed', files: 'registered' })
    const report = evaluate({
      policy, plan: planned, changedFiles: ['src/a.test.ts', 'hooks/a.test.sh'],
      runs: [UNIT_CHANGED(['src/a.test.ts'])],
    })
    expect(report.blockers).toEqual([expect.objectContaining({ code: 'test-not-run', subject: 'hooks' })])
    expect(report.suites.map((item) => [item.suite, item.reason, item.state])).toEqual([
      ['unit', 'run', 'passed'], ['hooks', 'if-registered', 'missing'],
    ])
  })

  it('孤儿仍是阻断；读不到改动列表仍是 files-diff-unavailable', () => {
    expect(codes(evaluate({ policy: POLICY, plan: planned, runs: [UNIT_CHANGED(['src/a.test.ts'])], changedFiles: ['tools/x.spec.js'] }))).toEqual(['test-file-orphan'])
    const unavailable = evaluate({ policy: POLICY, plan: planned, runs: [UNIT_CHANGED(['src/a.test.ts'])], changedFiles: undefined, input: { changedFilesError: 'boom' } })
    expect(codes(unavailable)).toEqual(['files-diff-unavailable'])
  })

  it('files: any 的旧策略不读改动列表：files.checked 为 false，也没有认领', () => {
    const report = evaluate({ policy: legacy({ run: ['unit'], scope: 'changed' }), plan: planned, runs: [UNIT_CHANGED(['src/a.test.ts'])], changedFiles: ['src/new.test.ts'] })
    expect(report.files).toEqual({ checked: false, unregistered: [], orphans: [], claimed: [] })
  })

  it('旧策略的其余阻断码与修改前一致：缺种类、未运行', () => {
    const policy = legacy({ kinds: ['playwright'], run: ['unit'], scope: 'changed', files: 'registered' })
    const report = evaluate({ policy, plan: planned, changedFiles: [] })
    expect(report.blockers.map((item) => [item.code, item.subject])).toEqual([
      ['test-kind-missing', 'playwright'], ['test-not-run', 'unit'],
    ])
  })
})
