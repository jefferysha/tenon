/**
 * 测试完整性：十种信号各有一条夹具（命中）与相邻放行用例（不误报），再经 evaluateTestPolicy 验证
 * notice / block 两种策略下的去向。夹具是 `git diff -U0` 的新增 / 删除行，不起版本库。
 */
import { describe, expect, it } from 'vitest'
import { compileStepTestPolicy } from '../workflow/compile-test-policy.js'
import type { StepTestPolicyDef } from '../workflow/types.js'
import { catalogSuitesDigest, parseTestCatalog } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import { evaluateTestPolicy } from './evaluate-v2.js'
import type { IntegrityEvidenceInput, TestPolicyEvaluationInput, TestPolicyReport } from './evaluate-types.js'
import {
  INTEGRITY_SIGNAL_CODES, INTEGRITY_SIGNAL_LABELS, evaluateIntegrity, integritySummary,
  type IntegrityFileDiff, type IntegrityRunSample, type IntegritySignal,
} from './integrity.js'
import { integrityPathFilter, integritySuiteOf } from './integrity-diff.js'
import { emptyTestPlan, testPlanDigest } from './plan.js'
import { testPolicyDigest } from './policy.js'
import { verifyRecordChain } from './record-chain.js'
import { FIXTURE_FINGERPRINT, fixtureChain, fixtureRecordDraft, fixtureSuiteRun } from './test-support.js'

function file(path: string, status: IntegrityFileDiff['status'], removed: readonly string[] = [], added: readonly string[] = []): IntegrityFileDiff {
  return { path, status, removed, added }
}

function signalsOf(files: readonly IntegrityFileDiff[], runs: readonly IntegrityRunSample[] = [], suiteOf: (path: string) => string | undefined = () => undefined): readonly IntegritySignal[] {
  return evaluateIntegrity({ diff: { files }, runs, suiteOf }, 'notice').signals
}

const codesOf = (signals: readonly IntegritySignal[]): string[] => signals.map((signal) => signal.code)

describe('运行记录类信号', () => {
  const run = (cases: number, skip: number, scope: IntegrityRunSample['scope'] = 'full'): IntegrityRunSample => ({ suite: 'unit', scope, cases, skip })

  it('case-count-drop：全量运行的用例数低于本任务里更早的全量运行（取最高值比较）', () => {
    expect(signalsOf([], [run(120, 0), run(130, 0), run(100, 0)])).toEqual([
      { code: 'case-count-drop', subject: 'unit', detail: '130 → 100', suite: 'unit' },
    ])
  })

  it('用例数持平或增加、只有一次运行、改动范围的运行都不报', () => {
    expect(signalsOf([], [run(120, 0), run(120, 0)])).toEqual([])
    expect(signalsOf([], [run(120, 0), run(140, 0)])).toEqual([])
    expect(signalsOf([], [run(120, 0)])).toEqual([])
    expect(signalsOf([], [run(120, 0), run(12, 0, 'changed')])).toEqual([])
  })

  it('skip-count-rise：最新全量运行的跳过数高于该任务第一次全量运行', () => {
    expect(signalsOf([], [run(10, 1), run(10, 2), run(10, 4)])).toEqual([
      { code: 'skip-count-rise', subject: 'unit', detail: '1 → 4', suite: 'unit' },
    ])
    expect(signalsOf([], [run(10, 3), run(10, 3)])).toEqual([])
  })
})

describe('测试文件类信号', () => {
  it('test-file-deleted：删掉测试文件，明细是被删的用例数', () => {
    const removed = ["it('a', () => {})", "  it('b', () => {})", "test('c', () => {})", 'const helper = 1']
    expect(signalsOf([file('src/a.test.ts', 'deleted', removed)])).toEqual([
      { code: 'test-file-deleted', subject: 'src/a.test.ts', detail: '-3' },
    ])
  })

  it('搬家（删一个、别处新增同名文件）不报被删；搬完用例变少仍报 tests-removed', () => {
    const moved = signalsOf([
      file('src/old/a.test.ts', 'deleted', ["it('a', () => {})", "it('b', () => {})"]),
      file('src/new/a.test.ts', 'added', [], ["it('a', () => {})", "it('b', () => {})"]),
    ])
    expect(moved).toEqual([])
    const shrunk = signalsOf([
      file('src/old/a.test.ts', 'deleted', ["it('a', () => {})", "it('b', () => {})"]),
      file('src/new/a.test.ts', 'added', [], ["it('a', () => {})"]),
    ])
    expect(shrunk).toEqual([{ code: 'tests-removed', subject: 'src/new/a.test.ts', detail: '-2 +1' }])
  })

  it('不是测试的文件被删不报；被目录套件认领的文件算测试，并带出套件', () => {
    expect(signalsOf([file('src/util.ts', 'deleted', ["it('x', () => {})"])])).toEqual([])
    const owned = signalsOf([file('checks/a.js', 'deleted', ["it('x', () => {})"])], [], () => 'unit')
    expect(owned).toEqual([{ code: 'test-file-deleted', subject: 'checks/a.js', detail: '-1', suite: 'unit' }])
  })

  it('tests-removed：改动的测试文件里声明的用例净减少；改名（删一个加一个）不算', () => {
    const removed = ["it('a', () => {})", "it('b', () => {})", "it('c', () => {})"]
    expect(signalsOf([file('src/a.test.ts', 'modified', removed, ["it('a', () => {})"])])).toEqual([
      { code: 'tests-removed', subject: 'src/a.test.ts', detail: '-3 +1' },
    ])
    expect(signalsOf([file('src/a.test.ts', 'modified', ["it('old name', () => {})"], ["it('new name', () => {})"])])).toEqual([])
  })

  it.each([
    ['jest .skip', "it.skip('a', () => {})"],
    ['xit', "xit('a', () => {})"],
    ['describe.skip', "describe.skip('suite', () => {})"],
    ['test.todo', "test.todo('later')"],
    ['pytest skip', '@pytest.mark.skip(reason="flaky")'],
    ['pytest xfail', 'pytest.xfail("later")'],
    ['unittest skip', '@unittest.skip("later")'],
    ['go t.Skip', '\tt.Skip("later")'],
    ['junit @Disabled', '    @Disabled'],
    ['rust ignore', '#[ignore]'],
  ])('test-skipped：新增 %s', (_name, line) => {
    expect(codesOf(signalsOf([file('src/a.test.ts', 'modified', [], [line])]))).toEqual(['test-skipped'])
  })

  it('新增的整份测试文件里带跳过标记也报；把跳过标记删掉（或原样搬动）不报', () => {
    expect(codesOf(signalsOf([file('src/new.test.ts', 'added', [], ["it('a', () => {})", "it.skip('b', () => {})"])]))).toEqual(['test-skipped'])
    expect(signalsOf([file('src/a.test.ts', 'modified', ["it.skip('a', () => {})"], ["it('a', () => {})"])])).toEqual([])
    expect(signalsOf([file('src/a.test.ts', 'modified', ["it.skip('a', () => {})"], ["it.skip('a', () => {})"])])).toEqual([])
  })

  it('assertion-weakened：用例还在、断言少了；用例也删了时只报 tests-removed', () => {
    const removed = ['expect(a).toBe(1)', 'expect(b).toBe(2)', 'assert.equal(c, 3)']
    expect(signalsOf([file('src/a.test.ts', 'modified', removed, ['expect(a).toBe(1)'])])).toEqual([
      { code: 'assertion-weakened', subject: 'src/a.test.ts', detail: '-3 +1' },
    ])
    expect(codesOf(signalsOf([file('src/a.test.ts', 'modified', ["it('x', () => {", ...removed], [])]))).toEqual(['tests-removed'])
  })

  it('断言数不减（换断言库、加断言）不报', () => {
    expect(signalsOf([file('src/a.test.ts', 'modified', ['expect(a).toBe(1)'], ['assert.equal(a, 1)', 'expect(b).toBe(2)'])])).toEqual([])
  })

  it('python / go / rust 的断言写法也数', () => {
    expect(codesOf(signalsOf([file('tests/test_a.py', 'modified', ['    assert a == 1', '    self.assertEqual(b, 2)'], [])]))).toEqual(['assertion-weakened'])
    expect(codesOf(signalsOf([file('pkg/a_test.go', 'modified', ['\tt.Errorf("bad")'], [])]))).toEqual(['assertion-weakened'])
    expect(codesOf(signalsOf([file('tests/a.test.rs', 'modified', ['    assert_eq!(a, 1);'], [])]))).toEqual(['assertion-weakened'])
  })
})

describe('快照、基线、已知失败、覆盖率门槛', () => {
  it('snapshot-rewritten：快照文件被改写（删了或换了行）或整个删除；只新增快照不算', () => {
    expect(signalsOf([file('src/__snapshots__/a.test.ts.snap', 'modified', ['exports[`a 1`] = `old`;'], ['exports[`a 1`] = `new`;'])])).toEqual([
      { code: 'snapshot-rewritten', subject: 'src/__snapshots__/a.test.ts.snap', detail: '-1 +1' },
    ])
    expect(signalsOf([file('src/__snapshots__/a.test.ts.snap', 'deleted', ['x'])])).toEqual([
      { code: 'snapshot-rewritten', subject: 'src/__snapshots__/a.test.ts.snap', detail: '-' },
    ])
    expect(signalsOf([file('src/__snapshots__/a.test.ts.snap', 'modified', [], ['exports[`b 1`] = `fresh`;'])])).toEqual([])
    expect(signalsOf([file('src/__snapshots__/b.test.ts.snap', 'added', [], ['exports[`b 1`] = `fresh`;'])])).toEqual([])
  })

  it('二进制快照（git 不给文本行）改了就算改写', () => {
    expect(codesOf(signalsOf([file('e2e/home.spec.ts-snapshots/chromium/home.png', 'modified')]))).toEqual(['snapshot-rewritten'])
  })

  it('baseline-changed：任何对共享基线文件的新增 / 修改 / 删除', () => {
    expect(signalsOf([
      file('.tenon/tests/baselines/bench.json', 'modified', ['"median": 10'], ['"median": 90']),
      file('.tenon/tests/baselines/other.json', 'deleted'),
    ])).toEqual([
      { code: 'baseline-changed', subject: '.tenon/tests/baselines/bench.json', detail: 'modified' },
      { code: 'baseline-changed', subject: '.tenon/tests/baselines/other.json', detail: 'deleted' },
    ])
  })

  it('known-failure-added：已知失败清单里新增的用例引用；只改过期日、删条目、原样搬动都不算', () => {
    const path = '.tenon/tests/known-failures.yaml'
    const added = ['  - suite: unit', '    test: src/a.test.ts › flaky one', '    reason: later', '    expires: 2026-10-20']
    expect(signalsOf([file(path, 'modified', [], added)])).toEqual([
      { code: 'known-failure-added', subject: 'src/a.test.ts › flaky one', detail: '+1' },
    ])
    expect(signalsOf([file(path, 'modified', ['    expires: 2026-10-01'], ['    expires: 2026-10-20'])])).toEqual([])
    expect(signalsOf([file(path, 'modified', ['    test: src/a.test.ts › flaky one'], [])])).toEqual([])
    expect(signalsOf([file(path, 'modified', ['    test: src/a.test.ts › flaky one'], ['    test: src/a.test.ts › flaky one'])])).toEqual([])
    expect(signalsOf([file(path, 'modified', [], ['    test: "src/b.test.ts › quoted"'])])).toEqual([
      { code: 'known-failure-added', subject: 'src/b.test.ts › quoted', detail: '+1' },
    ])
  })

  it.each([
    ['vitest', 'vitest.config.ts', ['      lines: 80,'], ['      lines: 70,'], 'lines 80 → 70'],
    ['jest', 'package.json', ['    "branches": 75,'], ['    "branches": 60,'], 'branches 75 → 60'],
    ['coverage.py', 'pyproject.toml', ['fail_under = 90'], ['fail_under = 85'], 'failunder 90 → 85'],
    ['pytest-cov', 'pytest.ini', ['addopts = --cov-fail-under=90'], ['addopts = --cov-fail-under=50'], 'failunder 90 → 50'],
    ['Tenon 工作流', '.pipeline/workflows/default.yaml', ['        coverage: { lines: 80 }'], ['        coverage: { lines: 60 }'], 'lines 80 → 60'],
  ])('coverage-threshold-lowered：%s 的门槛调低', (_name, path, removed, added, detail) => {
    expect(signalsOf([file(path, 'modified', removed, added)])).toEqual([{ code: 'coverage-threshold-lowered', subject: path, detail }])
  })

  it('门槛被整行删掉算降低（after 记 -）；调高与无关改动不报', () => {
    expect(signalsOf([file('vitest.config.ts', 'modified', ['      lines: 80,'], [])])).toEqual([
      { code: 'coverage-threshold-lowered', subject: 'vitest.config.ts', detail: 'lines 80 → -' },
    ])
    expect(signalsOf([file('vitest.config.ts', 'modified', ['      lines: 80,'], ['      lines: 90,'])])).toEqual([])
    expect(signalsOf([file('vitest.config.ts', 'modified', ["  include: ['src']"], ["  include: ['lib']"])])).toEqual([])
  })

  it('没有相关改动 → 没有信号；信号按种类序、再按对象排序', () => {
    expect(signalsOf([file('src/util.ts', 'modified', ['a'], ['b'])])).toEqual([])
    const sorted = signalsOf([
      file('src/z.test.ts', 'modified', [], ["it.skip('z', () => {})"]),
      file('src/a.test.ts', 'modified', [], ["it.skip('a', () => {})"]),
      file('.tenon/tests/baselines/b.json', 'modified'),
    ], [{ suite: 'unit', scope: 'full', cases: 10, skip: 0 }, { suite: 'unit', scope: 'full', cases: 8, skip: 0 }])
    expect(sorted.map((signal) => `${signal.code}:${signal.subject}`)).toEqual([
      'case-count-drop:unit', 'test-skipped:src/a.test.ts', 'test-skipped:src/z.test.ts',
      'baseline-changed:.tenon/tests/baselines/b.json',
    ])
  })

  it('每个信号码有中英标签；汇总按种类计数', () => {
    for (const code of INTEGRITY_SIGNAL_CODES) {
      expect(INTEGRITY_SIGNAL_LABELS[code].zh.length).toBeGreaterThan(0)
      expect(INTEGRITY_SIGNAL_LABELS[code].en.length).toBeGreaterThan(0)
    }
    const signals = signalsOf([file('src/a.test.ts', 'modified', [], ["it.skip('a', () => {})", "xit('b', () => {})"]), file('src/b.test.ts', 'modified', [], ["it.skip('c', () => {})"])])
    expect(integritySummary(signals)).toBe('用例被跳过 2')
    expect(integritySummary(signals, 'en')).toBe('Tests skipped 2')
  })
})

describe('路径过滤', () => {
  const catalog = ((): TestCatalog => {
    const result = parseTestCatalog('schema: tenon-test-catalog/v1\nsuites:\n  - id: unit\n    kind: unit\n    runner: vitest\n    command: npx vitest run\n    files: ["checks/**/*.js"]\n    report: { format: junit, path: test-results/unit.xml }\n')
    if (!result.ok) throw new Error('catalog')
    return result.catalog
  })()

  it('套件认领的文件、测试 / 快照 / 基线 / 已知失败 / 覆盖率配置 / 工作流都读；普通源码不读', () => {
    const accept = integrityPathFilter(catalog)
    for (const path of ['checks/a.js', 'src/a.test.ts', 'src/__snapshots__/a.snap', '.tenon/tests/baselines/x.json', '.tenon/tests/known-failures.yaml', 'vitest.config.ts', 'pyproject.toml', '.pipeline/workflows/default.yaml']) {
      expect(accept(path), path).toBe(true)
    }
    for (const path of ['src/util.ts', 'README.md', '.tenon/tests/catalog.yaml']) expect(accept(path), path).toBe(false)
    expect(integrityPathFilter(undefined)('checks/a.js')).toBe(false)
    expect(integritySuiteOf(catalog)('checks/a.js')).toBe('unit')
    expect(integritySuiteOf(undefined)('checks/a.js')).toBeUndefined()
  })
})

describe('evaluateTestPolicy —— notice / block', () => {
  const CATALOG = ((): TestCatalog => {
    const result = parseTestCatalog('schema: tenon-test-catalog/v1\nsuites:\n  - id: unit\n    kind: unit\n    runner: vitest\n    command: npx vitest run\n    files: ["src/**/*.test.ts"]\n    report: { format: junit, path: test-results/unit.xml }\n')
    if (!result.ok) throw new Error('catalog')
    return result.catalog
  })()
  const PLAN = { ...emptyTestPlan('demo'), suites: [{ suite: 'unit', scope: 'full' as const }] }
  const SKIPPED: IntegrityEvidenceInput = {
    diff: { files: [file('src/a.test.ts', 'modified', [], ["it.skip('a', () => {})"])] },
    suiteOf: () => 'unit',
  }

  function evaluate(policy: StepTestPolicyDef, integrity: IntegrityEvidenceInput | undefined, totals: readonly number[] = [3]): TestPolicyReport {
    const compiled = compileStepTestPolicy({ run: ['unit'], ...policy }, 'test')
    if (compiled === undefined) throw new Error('policy')
    const planDigest = testPlanDigest(PLAN)
    const drafts = totals.map((cases) => fixtureRecordDraft({
      suites: [fixtureSuiteRun({ suite: 'unit', scope: 'full', totals: { cases, pass: cases, fail: 0, skip: 0, flaky: 0, known_fail: 0 } })],
      bindings: {
        candidate: null, workflow_fingerprint: FIXTURE_FINGERPRINT, catalog_digest: catalogSuitesDigest(CATALOG, ['unit']), plan_digest: planDigest,
        policy_digest: testPolicyDigest(compiled),
      },
    }))
    const chain = verifyRecordChain({ records: fixtureChain(drafts).map((record) => ({ file: `${record.run_id}.json`, record })), problems: [] })
    const input: TestPolicyEvaluationInput = {
      change: 'demo', stepId: 'verify', policy: compiled, inline: [],
      catalog: { state: 'ok', catalog: CATALOG }, plan: { state: 'ok', plan: PLAN, digest: planDigest }, chain,
      knownFailures: [], baselines: new Map(), changedFiles: undefined, scenarios: [], tasks: [],
      bindings: { candidate: undefined, workflowFingerprint: FIXTURE_FINGERPRINT, workflowRunId: 'run-1' },
      today: '2026-09-30', exitEvent: 'verify-pass',
      ...(integrity === undefined ? {} : { integrity }),
    }
    return evaluateTestPolicy(input)
  }

  it('缺省（notice）：信号只进一条提示，不挡；报告带出明细', () => {
    const report = evaluate({}, SKIPPED)
    expect(report.pass).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.notices).toEqual([expect.objectContaining({ code: 'test-integrity', message: '测试完整性提示：用例被跳过 1', fix: 'tenon test integrity demo' })])
    expect(report.integrity).toMatchObject({
      mode: 'notice', state: 'ok', signals: [{ code: 'test-skipped', subject: 'src/a.test.ts', detail: '+1', suite: 'unit' }],
    })
  })

  it('integrity: block：同样的信号变成阻塞，pass 为 false', () => {
    const report = evaluate({ integrity: 'block' }, SKIPPED)
    expect(report.pass).toBe(false)
    expect(report.blockers).toEqual([expect.objectContaining({ code: 'test-integrity', blocking: true, message: '测试完整性未通过：用例被跳过 1', fix: 'tenon test integrity demo' })])
    expect(report.notices).toEqual([])
    expect(report.integrity?.mode).toBe('block')
  })

  it('运行记录类信号同样走策略：两次全量运行用例数 12 → 9', () => {
    const report = evaluate({ integrity: 'block' }, { diff: { files: [] }, suiteOf: () => undefined }, [12, 9])
    expect(report.blockers.map((item) => item.code)).toEqual(['test-integrity'])
    expect(report.integrity?.signals).toEqual([{ code: 'case-count-drop', subject: 'unit', detail: '12 → 9', suite: 'unit' }])
  })

  it('没有信号：既不提示也不挡，报告仍带出空明细', () => {
    const report = evaluate({ integrity: 'block' }, { diff: { files: [file('src/util.ts', 'modified', ['a'], ['b'])] }, suiteOf: () => undefined })
    expect(report.pass).toBe(true)
    expect(report.notices).toEqual([])
    expect(report.integrity).toMatchObject({ mode: 'block', state: 'ok', signals: [] })
  })

  it('读不出 diff：block 失败关闭（files-diff-unavailable），notice 只提示未检查', () => {
    const unreadable: IntegrityEvidenceInput = { diff: undefined, error: '不是 git 仓库', suiteOf: () => undefined }
    const blocked = evaluate({ integrity: 'block' }, unreadable)
    expect(blocked.blockers).toEqual([expect.objectContaining({ code: 'files-diff-unavailable', fix: 'tenon test integrity demo' })])
    expect(blocked.integrity).toMatchObject({ state: 'unavailable', reason: '不是 git 仓库' })
    const noticed = evaluate({}, unreadable)
    expect(noticed.pass).toBe(true)
    expect(noticed.notices).toEqual([expect.objectContaining({ code: 'files-unchecked' })])
  })

  it('diff 被截断：提示只检查了前 N 个', () => {
    const report = evaluate({}, { diff: { files: [], truncated: { found: 500, limit: 400 } }, suiteOf: () => undefined })
    expect(report.notices).toEqual([expect.objectContaining({ code: 'files-truncated', message: expect.stringContaining('500') })])
    expect(report.integrity?.truncated).toEqual({ found: 500, limit: 400 })
  })

  it('宿主没有提供 diff 能力：不检查完整性，报告里没有 integrity', () => {
    const report = evaluate({ integrity: 'block' }, undefined)
    expect(report.integrity).toBeUndefined()
    expect(report.pass).toBe(true)
  })

  it('显式写 notice 与缺省完全相同：编译后的策略里没有 integrity 键，策略摘要不变', () => {
    const plain = compileStepTestPolicy({ run: ['unit'] }, 'test')
    const explicit = compileStepTestPolicy({ run: ['unit'], integrity: 'notice' }, 'test')
    const blocked = compileStepTestPolicy({ run: ['unit'], integrity: 'block' }, 'test')
    expect(explicit).toEqual(plain)
    expect(plain).not.toHaveProperty('integrity')
    expect(blocked).toHaveProperty('integrity', 'block')
    expect(() => compileStepTestPolicy({ integrity: 'maybe' }, 'test')).toThrow(/integrity/)
  })
})
