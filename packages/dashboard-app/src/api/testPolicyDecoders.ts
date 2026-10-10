/** 步骤策略判定与计划概要的严格解码（快照 `testPolicy[]` / `testPlan`）。 */
import type {
  BenchmarkVerdict, IntegrityReport, NotApplicableKind, PolicyReport, StaleBinding, SuiteVerdict, TestBlocker, TestCoverage, TestNotice, TestPlanBrief,
  TestPolicyView, TestTotals, TraceCaseStatus, TraceRow,
} from './testSystemTypes'
import { arr, bad, bool, guard, int, maybe, nnum, num, oneOf, opt, rec, str, strs } from './strictReader'

export function readCoverage(value: unknown): TestCoverage {
  const item = rec(value)
  const read = (key: string): number | undefined => opt(item[key], num)
  return {
    ...maybe('lines', read('lines')),
    ...maybe('branches', read('branches')),
    ...maybe('functions', read('functions')),
    ...maybe('statements', read('statements')),
    ...maybe('changedLines', read('changedLines')),
  }
}

export function readTotals(value: unknown): TestTotals {
  const item = rec(value)
  return {
    cases: int(item.cases), pass: int(item.pass), fail: int(item.fail), skip: int(item.skip),
    flaky: int(item.flaky), knownFail: int(item.knownFail),
  }
}

function readPolicy(value: unknown): TestPolicyView {
  const item = rec(value)
  const flaky = opt(item.flaky, (raw) => {
    const f = rec(raw)
    return { max: int(f.max), failOnNew: bool(f.failOnNew) }
  })
  return {
    plan: oneOf(item.plan, ['required', 'optional']),
    kinds: strs(item.kinds),
    run: strs(item.run),
    runIfRegistered: strs(item.runIfRegistered),
    scope: oneOf(item.scope, ['changed', 'full']),
    files: oneOf(item.files, ['registered', 'any']),
    scenarios: oneOf(item.scenarios, ['off', 'required', 'passing']),
    // 缺省 = notice（兼容不带这个字段的旧服务端）。
    integrity: opt(item.integrity, (raw) => oneOf(raw, ['notice', 'block'])) ?? 'notice',
    ...maybe('coverage', opt(item.coverage, readCoverage)),
    ...maybe('flaky', flaky),
    requireBaseline: bool(item.requireBaseline),
    browsers: strs(item.browsers),
  }
}

function readBlocker(value: unknown): TestBlocker {
  const item = rec(value)
  return {
    code: str(item.code), blocking: bool(item.blocking), message: str(item.message),
    ...maybe('fix', opt(item.fix, str)), ...maybe('subject', opt(item.subject, str)),
  }
}

function readNotice(value: unknown): TestNotice {
  const item = rec(value)
  return {
    code: str(item.code), message: str(item.message),
    ...maybe('fix', opt(item.fix, str)), ...maybe('subject', opt(item.subject, str)),
  }
}

function readBenchmark(value: unknown): BenchmarkVerdict {
  const item = rec(value)
  return {
    name: str(item.name),
    ...maybe('unit', opt(item.unit, str)),
    better: oneOf(item.better, ['lower', 'higher']),
    median: nnum(item.median), p95: nnum(item.p95), baseline: nnum(item.baseline), deltaPct: nnum(item.deltaPct),
    failed: bool(item.failed), baselineMissing: bool(item.baselineMissing), noisy: bool(item.noisy),
    details: strs(item.details),
  }
}

const STALE: readonly StaleBinding[] = ['candidate', 'workflow', 'catalog', 'plan', 'policy']

function readVerdict(value: unknown): SuiteVerdict {
  const item = rec(value)
  return {
    suite: str(item.suite),
    origin: oneOf(item.origin, ['catalog', 'step']),
    kind: str(item.kind),
    ...maybe('label', opt(item.label, str)),
    reason: oneOf(item.reason, ['run', 'if-registered', 'inline']),
    state: oneOf(item.state, ['passed', 'failed', 'stale', 'missing', 'running', 'waived', 'waiver-pending']),
    ...maybe('runId', opt(item.runId, str)),
    ...maybe('finishedAt', opt(item.finishedAt, str)),
    ...maybe('staleBecause', opt(item.staleBecause, (raw) => arr(raw, (entry) => oneOf(entry, STALE)))),
    ...maybe('totals', opt(item.totals, readTotals)),
    ...maybe('failing', opt(item.failing, strs)),
    ...maybe('flaky', opt(item.flaky, strs)),
    ...maybe('coverage', opt(item.coverage, readCoverage)),
    ...maybe('benchmark', opt(item.benchmark, (raw) => arr(raw, readBenchmark))),
    ...maybe('detail', opt(item.detail, str)),
  }
}

const TRACE_STATUS: readonly TraceCaseStatus[] = ['pass', 'fail', 'skip', 'flaky', 'known-fail', 'not-run']

function readTrace(value: unknown): TraceRow {
  const item = rec(value)
  return {
    covers: str(item.covers),
    kind: oneOf(item.kind, ['spec', 'task']),
    title: str(item.title),
    ...maybe('stage', opt(item.stage, str)),
    required: bool(item.required),
    tests: arr(item.tests, (raw) => {
      const test = rec(raw)
      return {
        ref: str(test.ref), status: oneOf(test.status, TRACE_STATUS),
        ...maybe('suite', opt(test.suite, str)), ...maybe('runId', opt(test.runId, str)),
      }
    }),
    ...maybe('waiver', opt(item.waiver, (raw) => {
      const waiver = rec(raw)
      return { approved: bool(waiver.approved), reason: str(waiver.reason) }
    })),
    state: oneOf(item.state, ['uncovered', 'mapped', 'passing', 'failing', 'waived']),
  }
}

function readNotApplicable(value: unknown): NotApplicableKind {
  const item = rec(value)
  return { kind: str(item.kind), reason: str(item.reason), approved: bool(item.approved) }
}

function readIntegrity(value: unknown): IntegrityReport {
  const item = rec(value)
  return {
    mode: oneOf(item.mode, ['notice', 'block']),
    state: oneOf(item.state, ['ok', 'unavailable']),
    ...maybe('reason', opt(item.reason, str)),
    signals: arr(item.signals, (raw) => {
      const signal = rec(raw)
      return {
        code: str(signal.code), subject: str(signal.subject), detail: str(signal.detail),
        ...maybe('suite', opt(signal.suite, str)),
      }
    }),
    ...maybe('truncated', opt(item.truncated, (raw) => {
      const found = rec(raw)
      return { found: int(found.found), limit: int(found.limit) }
    })),
  }
}

function readReport(value: unknown): PolicyReport {
  const item = rec(value)
  const files = rec(item.files)
  return {
    stepId: str(item.stepId),
    pass: bool(item.pass),
    chain: oneOf(item.chain, ['empty', 'intact', 'broken']),
    policy: item.policy === null ? null : readPolicy(item.policy),
    blockers: arr(item.blockers, readBlocker),
    notices: arr(item.notices, readNotice),
    suites: arr(item.suites, readVerdict),
    trace: arr(item.trace, readTrace),
    files: {
      checked: bool(files.checked),
      unregistered: arr(files.unregistered, (raw) => {
        const file = rec(raw)
        return { path: str(file.path), suites: strs(file.suites) }
      }),
      orphans: strs(files.orphans),
    },
    // 缺省 = 没有声明（兼容不带这个字段的旧服务端）；出现则每一项都必须合形。
    notApplicable: opt(item.notApplicable, (raw) => arr(raw, readNotApplicable)) ?? [],
    ...maybe('integrity', opt(item.integrity, readIntegrity)),
  }
}

export function readPlanBrief(value: unknown): TestPlanBrief {
  const item = rec(value)
  const state = oneOf(item.state, ['missing', 'tampered', 'ok'])
  if (state === 'missing') return { state }
  if (state === 'tampered') return { state, reason: str(item.reason) }
  return {
    state,
    suites: arr(item.suites, (raw) => {
      const suite = rec(raw)
      return { suite: str(suite.suite), kind: suite.kind === null ? null : str(suite.kind), scope: str(suite.scope) }
    }),
    waivers: arr(item.waivers, (raw) => {
      const waiver = rec(raw)
      return {
        ...maybe('kind', opt(waiver.kind, str)), ...maybe('covers', opt(waiver.covers, str)), ...maybe('test', opt(waiver.test, str)),
        approved: bool(waiver.approved),
      }
    }),
    files: int(item.files),
    cases: int(item.cases),
  }
}

export const decodePolicyReports = guard((value: unknown): PolicyReport[] => {
  const reports = arr(value, readReport)
  if (new Set(reports.map((report) => report.stepId)).size !== reports.length) bad()
  return reports
})

export const decodePlanBrief = guard(readPlanBrief)
