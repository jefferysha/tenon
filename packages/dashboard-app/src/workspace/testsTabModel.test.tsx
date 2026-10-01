import { describe, expect, it } from 'vitest'
import { buildMatrix, extraItems, fileRows, summarize, tabCount, traceNeedsMapping } from './testsTabModel'
import { planBrief, totals, verdict, verifyReport } from '../api/testSystemFixtures'
import type { PolicyReport, TestPlanBrief } from '../api/testSystemTypes'

function report(over: Partial<PolicyReport> = {}): PolicyReport {
  return { ...verifyReport(), ...over }
}

describe('summarize', () => {
  it('套件数、用例合计、失败、flaky，覆盖率取最低的行覆盖率', () => {
    expect(summarize(verifyReport())).toEqual({ suites: 3, cases: 120, fail: 0, flaky: 2, coverage: 91.2 })
    const two = report({
      suites: [
        verdict({ suite: 'a', totals: totals({ cases: 10, pass: 8, fail: 2 }), coverage: { lines: 90 } }),
        verdict({ suite: 'b', totals: totals({ cases: 5, pass: 4, flaky: 1 }), coverage: { lines: 72.5 } }),
        verdict({ suite: 'c', state: 'stale' }),
      ],
    })
    expect(summarize(two)).toEqual({ suites: 3, cases: 15, fail: 2, flaky: 1, coverage: 72.5 })
  })

  it('没有套件或没有覆盖率：覆盖率为 null，其余为 0', () => {
    expect(summarize(report({ suites: [] }))).toEqual({ suites: 0, cases: 0, fail: 0, flaky: 0, coverage: null })
    expect(summarize(report({ suites: [verdict({ suite: 'a', totals: totals() })] })).coverage).toBeNull()
  })

  it('页签计数是满足要求的种类 / 要求的种类（与矩阵同口径）；没有任何要求时不给计数', () => {
    expect(tabCount(verifyReport(), planBrief())).toBe('1/4')
    expect(tabCount(report({ suites: [], blockers: [] }), { state: 'missing' })).toBe('0/4')
    expect(tabCount(report({ policy: { ...verifyReport().policy!, kinds: [], run: [], runIfRegistered: [] }, suites: [] }), planBrief())).toBeUndefined()
  })
})

describe('buildMatrix', () => {
  const plan = planBrief()

  it('行 = 登记 ∪ 运行 ∪ 有则跑，按声明顺序去重；要求词：运行优先，其次登记，其次有则跑', () => {
    const rows = buildMatrix(verifyReport(), plan)
    expect(rows.map((row) => [row.kind, row.requirement])).toEqual([
      ['unit', 'run'], ['playwright', 'run'], ['a11y', 'register'], ['benchmark', 'run'],
    ])
  })

  it('登记的套件与它们的判定挂在对应种类下；结果取最差的判定', () => {
    const rows = buildMatrix(verifyReport(), plan)
    const unit = rows.find((row) => row.kind === 'unit')
    expect(unit?.suites.map((suite) => [suite.suite, suite.name, suite.verdict?.state])).toEqual([['web-unit', '前端单测', 'passed']])
    expect(unit?.result).toBe('passed')
    expect(unit?.met).toBe(true)
    expect(unit?.blocker).toBeNull()
    const e2e = rows.find((row) => row.kind === 'playwright')
    expect(e2e?.result).toBe('stale')
    expect(e2e?.met).toBe(false)
    expect(e2e?.blocker?.code).toBe('test-stale')
    expect(e2e?.blocker?.fix).toContain('--suite web-e2e')
  })

  it('没登记也没豁免：缺项行用种类阻塞；有则登记的种类跑不到（无套件无判定）结果为空', () => {
    const rows = buildMatrix(verifyReport(), plan)
    const a11y = rows.find((row) => row.kind === 'a11y')
    expect(a11y).toMatchObject({ suites: [], waiver: null, result: null, met: false })
    expect(a11y?.blocker?.code).toBe('test-kind-missing')
    const bench = rows.find((row) => row.kind === 'benchmark')
    expect(bench?.waiver).toEqual({ approved: false })
    expect(bench?.met).toBe(false)
  })

  it('已批准的豁免满足登记要求；待批准的不满足', () => {
    const approved: TestPlanBrief = { state: 'ok', suites: [], waivers: [{ kind: 'a11y', approved: true }], files: 0, cases: 0 }
    const only = report({ suites: [], blockers: [], policy: { ...verifyReport().policy!, kinds: ['a11y'], run: [] } })
    expect(buildMatrix(only, approved)[0]).toMatchObject({ kind: 'a11y', met: true, blocker: null, waiver: { approved: true } })
    const pending: TestPlanBrief = { state: 'ok', suites: [], waivers: [{ kind: 'a11y', approved: false }], files: 0, cases: 0 }
    const blocked = report({
      suites: [], policy: { ...verifyReport().policy!, kinds: ['a11y'], run: [] },
      blockers: [{ code: 'waiver-unapproved', blocking: true, message: 'm', fix: 'tenon review request add-login', subject: 'a11y' }],
    })
    expect(buildMatrix(blocked, pending)[0]).toMatchObject({ met: false, blocker: { code: 'waiver-unapproved' } })
  })

  describe('目录声明的项目级不适用（服务端给出，不在这里重新判定）', () => {
    const only = (notApplicable: PolicyReport['notApplicable'], blockers: PolicyReport['blockers'] = []): PolicyReport =>
      report({ suites: [], blockers, notApplicable, policy: { ...verifyReport().policy!, kinds: ['a11y'], run: [] } })
    const noPlan: TestPlanBrief = { state: 'ok', suites: [], waivers: [], files: 0, cases: 0 }

    it('已批准：满足要求，不是缺，也不挂缺项阻塞；原因带在行上', () => {
      const [row] = buildMatrix(only([{ kind: 'a11y', reason: '本项目没有界面', approved: true }]), noPlan)
      expect(row).toMatchObject({ kind: 'a11y', met: true, blocker: null, notApplicable: { reason: '本项目没有界面', approved: true } })
      expect(tabCount(only([{ kind: 'a11y', reason: '本项目没有界面', approved: true }]), noPlan)).toBe('1/1')
    })

    it('未批准：仍不满足，原因照带；阻塞是服务端的 waiver-unapproved', () => {
      const blockers = [{ code: 'waiver-unapproved', blocking: true, message: 'm', fix: 'tenon review request add-login', subject: 'a11y' }]
      const [row] = buildMatrix(only([{ kind: 'a11y', reason: '本项目没有界面', approved: false }], blockers), noPlan)
      expect(row).toMatchObject({ met: false, notApplicable: { approved: false }, blocker: { code: 'waiver-unapproved' } })
    })

    it('只对声明的种类生效；该种类已登记套件时以套件为准，不显示不适用', () => {
      const rows = buildMatrix(
        report({ notApplicable: [{ kind: 'unit', reason: 'x', approved: true }, { kind: 'a11y', reason: '本项目没有界面', approved: true }] }),
        planBrief(),
      )
      expect(rows.find((row) => row.kind === 'unit')).toMatchObject({ notApplicable: null, met: true })
      expect(rows.find((row) => row.kind === 'a11y')).toMatchObject({ notApplicable: { approved: true }, met: true, blocker: null })
      expect(rows.find((row) => row.kind === 'playwright')?.notApplicable).toBeNull()
      expect(rows.find((row) => row.kind === 'benchmark')).toMatchObject({ notApplicable: null, met: false })
    })

    it('没有声明：与之前一样是缺项', () => {
      const [row] = buildMatrix(only([], [{ code: 'test-kind-missing', blocking: true, message: 'm', subject: 'a11y' }]), noPlan)
      expect(row).toMatchObject({ met: false, notApplicable: null, blocker: { code: 'test-kind-missing' } })
    })
  })

  it('没有计划：全部缺项，退到全局阻塞（计划缺失 / 被改动 / 目录缺失 / 记录被改动）', () => {
    for (const code of ['test-plan-missing', 'test-plan-tampered', 'test-catalog-missing', 'record-chain-broken']) {
      const rows = buildMatrix(report({ suites: [], blockers: [{ code, blocking: true, message: 'm', fix: 'tenon test x' }] }), { state: 'missing' })
      expect(rows.every((row) => !row.met && row.blocker?.code === code)).toBe(true)
    }
  })

  it('全局阻塞按优先级挑第一条；非阻塞的提示型阻塞不做缺项说明', () => {
    const blockers = [
      { code: 'record-chain-broken', blocking: true, message: 'a' },
      { code: 'test-plan-missing', blocking: true, message: 'b', fix: 'tenon test plan add-login --seed' },
      { code: 'baseline-missing', blocking: false, message: 'c', subject: 'unit' },
    ]
    const rows = buildMatrix(report({ suites: [], blockers }), { state: 'missing' })
    expect(rows[0]?.blocker?.code).toBe('test-plan-missing')
  })

  it('有则跑的种类没登记不算缺；旧步骤内联套件按种类进矩阵并算运行要求', () => {
    const policy = { ...verifyReport().policy!, kinds: [], run: [], runIfRegistered: ['visual'] }
    const rows = buildMatrix(report({
      policy,
      suites: [verdict({ suite: 'step:smoke-old', origin: 'step', kind: 'smoke', reason: 'inline', label: '旧冒烟', state: 'failed', runId: 'r1' })],
      blockers: [{ code: 'test-failed', blocking: true, message: 'x', fix: 'tenon test run add-login smoke-old', subject: 'step:smoke-old' }],
    }), { state: 'ok', suites: [], waivers: [], files: 0, cases: 0 })
    expect(rows.map((row) => [row.kind, row.requirement, row.met])).toEqual([['visual', 'if-registered', true], ['smoke', 'run', false]])
    expect(rows[1]?.suites).toMatchObject([{ suite: 'step:smoke-old', name: '旧冒烟' }])
    expect(rows[1]?.blocker?.code).toBe('test-failed')
  })

  it('没有策略（只有旧步骤测试）：只出内联套件的种类行', () => {
    const rows = buildMatrix(report({
      policy: null,
      suites: [verdict({ suite: 'step:u', origin: 'step', kind: 'unit', reason: 'inline', state: 'passed' })],
      blockers: [],
    }), undefined)
    expect(rows).toMatchObject([{ kind: 'unit', requirement: 'run', met: true, result: 'passed' }])
    expect(rows[0]?.suites[0]?.name).toBe('u')
  })

  it('结果取最差：失败 > 过期 > 运行中 > 未运行 > 通过', () => {
    const suites = ['passed', 'missing', 'running', 'stale', 'failed'] as const
    const multi: TestPlanBrief = { state: 'ok', suites: suites.map((state) => ({ suite: `s-${state}`, kind: 'unit', scope: 'full' })), waivers: [], files: 0, cases: 0 }
    const verdicts = suites.map((state) => verdict({ suite: `s-${state}`, state }))
    expect(buildMatrix(report({ suites: verdicts.slice(0, 2) }), multi)[0]?.result).toBe('missing')
    expect(buildMatrix(report({ suites: verdicts.slice(0, 3) }), multi)[0]?.result).toBe('running')
    expect(buildMatrix(report({ suites: verdicts.slice(0, 4) }), multi)[0]?.result).toBe('stale')
    expect(buildMatrix(report({ suites: verdicts }), multi)[0]?.result).toBe('failed')
  })
})

describe('extraItems / fileRows / traceNeedsMapping', () => {
  it('阻塞表：没被矩阵行用上、也不属于文件表的阻塞，加上全部提示', () => {
    const current = verifyReport()
    const rows = buildMatrix(current, planBrief())
    const extra = extraItems(current, rows)
    expect(rows.find((row) => row.kind === 'benchmark')?.blocker?.code).toBe('benchmark-regression')
    expect(extra.filter((entry) => entry.type === 'blocker').map((entry) => entry.item.code)).toEqual(['flaky-over-limit'])
    expect(extra.some((entry) => entry.item.code === 'test-file-unregistered')).toBe(false)
    expect(extra.some((entry) => entry.item.code === 'test-stale')).toBe(false)
    expect(extra.find((entry) => entry.type === 'notice')?.item.code).toBe('known-failure-fixed')
  })

  it('非阻塞的阻塞（只提示）不进阻塞表', () => {
    const current = report({ blockers: [{ code: 'baseline-missing', blocking: false, message: 'm', subject: 'api-bench' }], notices: [] })
    expect(extraItems(current, [])).toEqual([])
  })

  it('未登记文件在前，孤儿在后；各带对应阻塞的修复命令', () => {
    const rows = fileRows(verifyReport())
    expect(rows.map((row) => [row.path, row.orphan, row.suites])).toEqual([['e2e/new.spec.ts', false, ['web-e2e']], ['scripts/tmp.test.mjs', true, []]])
    expect(rows[0]?.blocker?.fix).toContain('--file e2e/new.spec.ts')
    expect(rows[1]?.blocker).toBeUndefined()
  })

  it('追溯：未覆盖只在策略要求场景时算缺项', () => {
    const current = verifyReport()
    const uncovered = current.trace.find((row) => row.state === 'uncovered')!
    expect(traceNeedsMapping(current, uncovered)).toBe(true)
    expect(traceNeedsMapping({ ...current, policy: { ...current.policy!, scenarios: 'off' } }, uncovered)).toBe(false)
    expect(traceNeedsMapping({ ...current, policy: null }, uncovered)).toBe(false)
    expect(traceNeedsMapping(current, current.trace[0]!)).toBe(false)
  })

  it('追溯：可选的任务（非实现阶段小节）未覆盖永远中性，不算缺项', () => {
    const current = verifyReport()
    const optional = { ...current.trace.find((row) => row.state === 'uncovered')!, covers: 'task:1.1', kind: 'task' as const, required: false }
    expect(traceNeedsMapping(current, optional)).toBe(false)
    expect(traceNeedsMapping(current, { ...optional, required: true })).toBe(true)
  })
})
