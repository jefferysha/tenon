import { renderTestBlocker, testBlocker, type TestBlocker, type TestBlockerCode, type TestPolicyReport } from '@tenon/kernel'
import { describe, expect, test } from 'vitest'
import { stepNextActions, type StepNextInput } from './statusStep.js'
import { classifyTestPolicy, freshRunIds, reportCarriesRuns, type StepTestFlow } from './statusStepTests.js'
import type { StepExit } from './stepExitReport.js'

const CHANGE = 'demo'

function report(blockers: readonly TestBlocker[], suites: TestPolicyReport['suites'] = []): TestPolicyReport {
  return {
    stepId: 'verify', pass: !blockers.some((item) => item.blocking), blockers, notices: [], suites, trace: [],
    files: { checked: false, unregistered: [], orphans: [] }, chain: 'empty',
  }
}

function flow(blockers: readonly TestBlocker[], over: Partial<StepTestFlow> = {}): StepTestFlow {
  return { ...classifyTestPolicy(report(blockers)), report: null, ...over }
}

function blocker(code: TestBlockerCode, subject?: string, fix?: string): TestBlocker {
  return testBlocker(code, `${code} ${subject ?? ''}`.trim(), { ...(subject === undefined ? {} : { subject }), ...(fix === undefined ? {} : { fix }) })
}

function input(overrides: Partial<StepNextInput> = {}): StepNextInput {
  return {
    change: CHANGE,
    loaded: true,
    skills: [],
    executors: [],
    reviewers: [],
    tests: [],
    documents: { reads: [], records: [], updates: [] },
    fields: [],
    review: { status: 'none', event: null },
    gate: null,
    mode: 'interactive',
    runArchived: false,
    governedOpenspec: true,
    exits: [],
    specRehearsalPending: false,
    specApplicationPending: false,
    ownsDeltaSpec: false,
    ownsAppliedSpec: false,
    artifactProducers: [],
    finish: { git: null, verified: true },
    testConfigGaps: [],
    delivery: null,
    settle: null,
    reviewBar: [],
    ...overrides,
  }
}

const next = (overrides: Partial<StepNextInput>) => stepNextActions(input(overrides))
const names = (overrides: Partial<StepNextInput>) => next(overrides).map((action) => action.action)

const exit = (event: string, direction: 'forward' | 'back', blockers: readonly StepExit['blockers'][number][] = []): StepExit =>
  ({ event, to: 'next', direction, ready: blockers.length === 0, blockers })

const reviewer = { agent: 'security', role: 'reviewer' as const, required: true, block_at: 'high', reads_tests: [], wave: 0,
  wave_ready: true, status: 'pending' as const, run_id: null, report_path: null, blocking_findings: 0 }

describe('策略阻塞归档', () => {
  test('每个阻塞码落在唯一的一类；内联套件与提示性阻塞不进来', () => {
    const classified = classifyTestPolicy(report([
      blocker('test-catalog-missing', undefined, 'tenon test discover --write'),
      blocker('test-catalog-missing', 'gone'),
      blocker('test-plan-missing', undefined, 'tenon test plan demo --seed'),
      blocker('test-plan-tampered'),
      blocker('test-kind-missing', 'integration'),
      blocker('scenario-uncovered', 'spec:auth/登录'),
      blocker('test-file-unregistered', 'src/a.test.ts'),
      blocker('test-file-orphan', 'e2e/x.spec.ts'),
      blocker('test-not-run', 'unit'),
      blocker('test-stale', 'e2e'),
      blocker('record-chain-broken'),
      blocker('test-failed', 'unit'),
      blocker('coverage-below'),
      blocker('waiver-unapproved', 'benchmark'),
      blocker('test-not-run', 'step:old'),
      testBlocker('baseline-missing', '只提示', { blocking: false }),
    ]))
    expect(classified.discover.map((item) => item.code)).toEqual(['test-catalog-missing'])
    expect(classified.seed.map((item) => item.code)).toEqual(['test-plan-missing', 'test-plan-tampered'])
    expect(classified.map.map((item) => item.subject)).toEqual(['gone', 'integration', 'spec:auth/登录'])
    expect(classified.files.map((item) => item.subject)).toEqual(['src/a.test.ts', 'e2e/x.spec.ts'])
    expect(classified.run.map((item) => item.code)).toEqual(['test-not-run', 'test-stale', 'record-chain-broken'])
    expect(classified.failed.map((item) => item.code)).toEqual(['test-failed', 'coverage-below'])
    expect(classified.waivers).toEqual([{ subject: 'benchmark', message: renderTestBlocker(blocker('waiver-unapproved', 'benchmark')) }])
  })

  test('没有策略判定 = 什么动作都没有', () => {
    expect(classifyTestPolicy(undefined)).toEqual({ discover: [], seed: [], map: [], files: [], run: [], failed: [], waivers: [] })
  })

  test('新鲜运行 id 只取目录套件里已判出通过 / 失败的，报告是否带上它们逐个核对', () => {
    const suites: TestPolicyReport['suites'] = [
      { suite: 'unit', origin: 'catalog', kind: 'unit', reason: 'run', state: 'passed', run_id: 'r-1' },
      { suite: 'e2e', origin: 'catalog', kind: 'playwright', reason: 'run', state: 'failed', run_id: 'r-2' },
      { suite: 'old', origin: 'catalog', kind: 'unit', reason: 'run', state: 'stale', run_id: 'r-0' },
      { suite: 'step:x', origin: 'step', kind: 'unit', reason: 'inline', state: 'passed', run_id: 'r-9' },
      { suite: 'never', origin: 'catalog', kind: 'unit', reason: 'run', state: 'missing' },
    ]
    expect(freshRunIds(report([], suites))).toEqual(['r-1', 'r-2'])
    expect(reportCarriesRuns('run r-1\nrun r-2', ['r-1', 'r-2'])).toBe(true)
    expect(reportCarriesRuns('run r-1', ['r-1', 'r-2'])).toBe(false)
  })
})

describe('step.next 里的测试体系动作', () => {
  test('登记按 discover → seed → map → register-files 逐类下发，一次只发最靠前的一类', () => {
    const all = [
      blocker('test-catalog-missing', undefined, 'tenon test discover --write'),
      blocker('test-plan-missing'),
      blocker('scenario-uncovered', 'spec:auth/登录', "tenon test register demo --case 'spec:auth/登录' --test '<文件> › <用例名>'"),
      blocker('test-file-unregistered', 'src/a.test.ts', 'tenon test register demo --file src/a.test.ts --suite unit'),
      blocker('test-not-run', 'unit', 'tenon test run demo --suite unit'),
    ]
    const step = (kinds: readonly TestBlockerCode[]) => next({ testFlow: flow(all.filter((item) => kinds.includes(item.code))) })
    expect(step(['test-catalog-missing', 'test-plan-missing', 'scenario-uncovered', 'test-file-unregistered', 'test-not-run']))
      .toEqual([{ action: 'test-discover', command: 'tenon test discover --write', blockers: expect.any(Array) }])
    expect(step(['test-plan-missing', 'scenario-uncovered', 'test-file-unregistered', 'test-not-run'])[0])
      .toMatchObject({ action: 'test-plan-seed', command: 'tenon test plan demo --seed' })
    expect(step(['scenario-uncovered', 'test-file-unregistered', 'test-not-run'])[0])
      .toMatchObject({ action: 'test-plan-map', show: 'tenon test plan demo --json' })
    expect(step(['test-file-unregistered', 'test-not-run'])[0]).toMatchObject({ action: 'test-register-files' })
    expect(step(['test-not-run'])).toEqual([{
      action: 'run-tests', command: 'tenon test run demo --stage', suites: [expect.objectContaining({ subject: 'unit' })],
    }])
  })

  test('测试排在文档与规格彩排之后、评审者之前；旧的 run-test 在 run-tests 之后', () => {
    const pending = flow([blocker('test-plan-missing')])
    const documents = { reads: [], records: [{ kind: 'adr', path: 'x.md', path_template: 'x.md', producers: [], status: 'missing' }], updates: [] }
    expect(names({ testFlow: pending, documents })).toEqual(['scaffold-document', 'record-document'])
    expect(names({ testFlow: pending, ownsDeltaSpec: true, specRehearsalPending: true })).toEqual(['validate-spec'])
    expect(names({ testFlow: pending, reviewers: [reviewer] })).toEqual(['test-plan-seed'])
    const both = { testFlow: flow([blocker('test-not-run', 'unit')]), tests: [{ id: 'old', direction: 'unit', required: true, status: 'missing', run_id: null }] }
    expect(names(both)).toEqual(['run-tests'])
    expect(names({ ...both, testFlow: flow([]) })).toEqual(['run-test'])
  })

  test('执行者与本步技能仍先于测试', () => {
    const agent = { ...reviewer, role: 'executor' as const }
    expect(names({ testFlow: flow([blocker('test-plan-missing')]), executors: [agent] })).toEqual(['run-agent'])
    expect(names({ testFlow: flow([blocker('test-plan-missing')]), skills: [{ id: 'writing-plans', depends_on: [], wave: 0, status: 'ready', pending_documents: [] }] }))
      .toEqual(['load-skill'])
  })

  test('运行完了：先把追溯矩阵写进验证报告，再谈失败与评审者', () => {
    const written = flow([blocker('test-failed', 'unit', 'tenon test run demo --suite unit')], {
      report: { command: 'tenon test report demo --write docs/report.md', path: 'docs/report.md' },
    })
    expect(next({ testFlow: written, reviewers: [reviewer] })).toEqual([
      { action: 'test-report', command: 'tenon test report demo --write docs/report.md', path: 'docs/report.md' },
    ])
    const passing = flow([], { report: written.report })
    expect(names({ testFlow: passing, reviewers: [reviewer] })).toEqual(['test-report'])
    expect(names({ testFlow: flow([]), reviewers: [reviewer] })).toEqual(['run-agent'])
  })

  test('已运行却不满足策略：非评审门是 fix（带修复命令）；评审门有回退边就走回退边', () => {
    const failed = flow([blocker('test-failed', 'unit', 'tenon test run demo --suite unit'), blocker('coverage-below')])
    const fix = next({ testFlow: failed, reviewers: [reviewer] })
    expect(fix).toEqual([{
      action: 'fix',
      blockers: [
        { source: 'test', code: 'test-failed', message: 'test-failed unit；执行 tenon test run demo --suite unit' },
        { source: 'test', code: 'coverage-below', message: 'coverage-below' },
      ],
    }])
    const exits = [exit('verify-pass', 'forward', [{ source: 'test', code: 'test-evidence', message: 'x' }]), exit('verify-fail', 'back')]
    expect(next({ testFlow: failed, gate: 'review', exits })).toEqual([{ action: 'request-review', event: 'verify-fail' }])
    // 没有回退边、或不是评审门：仍是 fix。
    expect(names({ testFlow: failed, gate: 'review', exits: [exits[0] as StepExit] })).toEqual(['fix'])
    expect(names({ testFlow: failed, gate: null, exits })).toEqual(['fix'])
    // 就地能解开的（补基线）不是退回实现的理由。
    expect(names({ testFlow: flow([blocker('baseline-missing', 'bench', 'tenon test baseline demo --suite bench --run r')]), gate: 'review', exits }))
      .toEqual(['fix'])
  })

  test('没有 testFlow（步骤未声明策略）：行为与没有测试体系时相同', () => {
    expect(names({ reviewers: [reviewer] })).toEqual(['run-agent'])
  })
})

describe('评审门上的待批准豁免', () => {
  const waiver = blocker('waiver-unapproved', 'benchmark', 'tenon review request demo --event verify-pass')
  const waiting = flow([waiver])
  const blocked = exit('verify-pass', 'forward', [{ source: 'test', code: 'test-evidence', message: renderTestBlocker(waiver) }])

  test('只剩豁免挡着：可以 request-review，并把豁免连同请求一起下发', () => {
    expect(next({ testFlow: waiting, gate: 'review', exits: [blocked] })).toEqual([
      { action: 'request-review', event: 'verify-pass', waivers: ['benchmark'] },
    ])
  })

  test('还有别的阻塞：豁免不掩盖它们', () => {
    const other = exit('verify-pass', 'forward', [
      { source: 'test', code: 'test-evidence', message: renderTestBlocker(waiver) },
      { source: 'guard', code: 'phase-exit', message: '要求 verification_report 非空' },
    ])
    const actions = next({ testFlow: waiting, gate: 'review', exits: [other] })
    expect(actions.map((action) => action.action)).toEqual(['fix'])
    expect(JSON.stringify(actions)).not.toContain('waiver-unapproved')
  })

  test('不是评审门，或评审已批准：豁免仍挡出口（没有别的批准途径）', () => {
    expect(names({ testFlow: waiting, gate: null, exits: [blocked] })).toEqual(['fix'])
    // 确认之后才加的豁免没被这次确认批准：前进边的 transition 必被拒，所以不发 transition。
    expect(names({ testFlow: waiting, gate: 'review', exits: [blocked], review: { status: 'approved', event: 'verify-pass' } }))
      .toEqual(['fix'])
    // 回退边不看测试证据。
    expect(names({
      testFlow: waiting, gate: 'review', exits: [blocked, exit('verify-fail', 'back')],
      review: { status: 'approved', event: 'verify-fail' },
    })).toEqual(['transition'])
  })
})
