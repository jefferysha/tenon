/**
 * 任务「测试」页签的投影（纯函数）：把一个步骤的策略判定（PolicyReport）和计划概要（TestPlanBrief）
 * 变成一行汇总、按种类的策略矩阵、未被矩阵和文件表认领的阻塞。判定本身来自服务端（与转换拦截同一份），
 * 这里只做展示投影，不重新判定。
 */
import type {
  PolicyReport, SuiteState, SuiteVerdict, TestBlocker, TestNotice, TestPlanBrief, TraceRow,
} from '../api/testSystemTypes'

export interface TabSummary {
  readonly suites: number
  readonly cases: number
  readonly fail: number
  readonly flaky: number
  /** 报告了行覆盖率的套件里最低的那个；都没报告时 null。 */
  readonly coverage: number | null
}

export function summarize(report: PolicyReport): TabSummary {
  let cases = 0
  let fail = 0
  let flaky = 0
  const lines: number[] = []
  for (const suite of report.suites) {
    cases += suite.totals?.cases ?? 0
    fail += suite.totals?.fail ?? 0
    flaky += suite.totals?.flaky ?? 0
    if (suite.coverage?.lines !== undefined) lines.push(suite.coverage.lines)
  }
  return { suites: report.suites.length, cases, fail, flaky, coverage: lines.length === 0 ? null : Math.min(...lines) }
}

export type Requirement = 'register' | 'run' | 'if-registered'

export interface MatrixSuite {
  readonly suite: string
  readonly name: string
  /** 在本阶段运行集里的判定；不在运行集（只登记）时缺省。 */
  readonly verdict: SuiteVerdict | undefined
}

export interface MatrixRow {
  readonly kind: string
  readonly requirement: Requirement
  readonly suites: readonly MatrixSuite[]
  readonly waiver: { readonly approved: boolean } | null
  readonly result: SuiteState | null
  readonly met: boolean
  /** 不满足时解释缺什么的那一条阻塞（含修复命令）；满足时 null。 */
  readonly blocker: TestBlocker | null
}

const WORST: Readonly<Record<SuiteState, number>> = { passed: 0, missing: 1, running: 2, stale: 3, failed: 4 }
const GLOBAL_CODES: readonly string[] = ['test-catalog-missing', 'test-plan-missing', 'test-plan-tampered', 'record-chain-broken']
const NO_SUITES: readonly string[] = []
/** 文件表认领的阻塞码：不进矩阵行，也不进阻塞表。 */
const FILE_CODES: ReadonlySet<string> = new Set(['test-file-unregistered', 'test-file-orphan'])

function worst(states: readonly SuiteState[]): SuiteState | null {
  return states.reduce<SuiteState | null>((acc, state) => (acc === null || WORST[state] > WORST[acc] ? state : acc), null)
}

function requirementOf(report: PolicyReport, kind: string): Requirement {
  const policy = report.policy
  if (policy?.run.includes(kind) === true) return 'run'
  if (policy?.kinds.includes(kind) === true) return 'register'
  if (policy?.runIfRegistered.includes(kind) === true) return 'if-registered'
  return 'run'
}

function orderedKinds(report: PolicyReport): string[] {
  const policy = report.policy
  const declared = policy === null ? [] : [...policy.kinds, ...policy.run, ...policy.runIfRegistered]
  const inline = report.suites.filter((suite) => suite.origin === 'step').map((suite) => suite.kind)
  return [...new Set([...declared, ...inline])]
}

function blockingOnly(report: PolicyReport): TestBlocker[] {
  return report.blockers.filter((item) => item.blocking)
}

function explain(report: PolicyReport, kind: string, suites: readonly MatrixSuite[]): TestBlocker | null {
  const blocking = blockingOnly(report)
  const ids = new Set(suites.map((suite) => suite.suite))
  return blocking.find((item) => item.subject === kind && !FILE_CODES.has(item.code))
    ?? blocking.find((item) => item.subject !== undefined && ids.has(item.subject) && !FILE_CODES.has(item.code))
    ?? GLOBAL_CODES.map((code) => blocking.find((item) => item.code === code)).find((item) => item !== undefined)
    ?? null
}

export function buildMatrix(report: PolicyReport, plan: TestPlanBrief | undefined): MatrixRow[] {
  const planSuites = plan?.state === 'ok' ? plan.suites : []
  const waivers = plan?.state === 'ok' ? plan.waivers : []
  return orderedKinds(report).map((kind) => {
    const requirement = requirementOf(report, kind)
    const seen = new Set<string>()
    const suites: MatrixSuite[] = []
    for (const item of planSuites) {
      if (item.kind !== kind || seen.has(item.suite)) continue
      seen.add(item.suite)
      const verdict = report.suites.find((candidate) => candidate.suite === item.suite)
      suites.push({ suite: item.suite, name: verdict?.label ?? item.suite, verdict })
    }
    for (const verdict of report.suites) {
      if (verdict.kind !== kind || seen.has(verdict.suite)) continue
      seen.add(verdict.suite)
      suites.push({ suite: verdict.suite, name: verdict.label ?? verdict.suite.replace(/^step:/u, ''), verdict })
    }
    const own = waivers.filter((waiver) => waiver.kind === kind)
    const waiver = own.length === 0 ? null : { approved: own.some((waiver) => waiver.approved) }
    const verdicts = suites.flatMap((suite) => (suite.verdict === undefined ? [] : [suite.verdict.state]))
    const result = requirement === 'register' && verdicts.length === 0 ? null : worst(verdicts)
    const registered = suites.length > 0 || waiver?.approved === true
    const runs = requirement !== 'register' && suites.length > 0
    const met = registered && (!runs || result === 'passed')
    // 「有则跑」的种类没登记不算缺。
    const optionalAbsent = requirement === 'if-registered' && suites.length === 0 && waiver === null
    return {
      kind, requirement, suites, waiver, result,
      met: met || optionalAbsent,
      blocker: met || optionalAbsent ? null : explain(report, kind, suites),
    }
  })
}

export interface ExtraItem {
  readonly type: 'blocker' | 'notice'
  readonly item: TestBlocker | TestNotice
}

/** 矩阵行没用上、文件表也不管的阻塞，加上全部提示。 */
export function extraItems(report: PolicyReport, rows: readonly MatrixRow[]): ExtraItem[] {
  const shown = new Set(rows.flatMap((row) => (row.blocker === null ? [] : [row.blocker])))
  const blockers = blockingOnly(report)
    .filter((item) => !shown.has(item) && !FILE_CODES.has(item.code))
    .map((item): ExtraItem => ({ type: 'blocker', item }))
  const notices = report.notices.map((item): ExtraItem => ({ type: 'notice', item }))
  return [...blockers, ...notices]
}

export interface FileRow {
  readonly path: string
  readonly suites: readonly string[]
  readonly orphan: boolean
  readonly blocker: TestBlocker | undefined
}

/** 未登记文件（含没有任何套件认领的孤儿），每行带对应的阻塞（修复命令）。 */
export function fileRows(report: PolicyReport): FileRow[] {
  const byPath = (path: string, code: string): TestBlocker | undefined =>
    report.blockers.find((item) => item.code === code && item.subject === path)
  return [
    ...report.files.unregistered.map((file) => ({
      path: file.path, suites: file.suites, orphan: false, blocker: byPath(file.path, 'test-file-unregistered'),
    })),
    ...report.files.orphans.map((path) => ({
      path, suites: NO_SUITES, orphan: true, blocker: byPath(path, 'test-file-orphan'),
    })),
  ]
}

/**
 * 追溯表里没有映射的行，只有「要求映射」的（场景、实现阶段小节的任务）在策略要求场景时算缺项；
 * 其余任务可选，永远中性。
 */
export function traceNeedsMapping(report: PolicyReport, row: TraceRow): boolean {
  return row.state === 'uncovered' && row.required && report.policy !== null && report.policy.scenarios !== 'off'
}

/**
 * 追溯行的展示名：场景 = 「能力 · 场景」（服务端标题已带能力）；任务 = 「编号 · 阶段名 · 条目文字」。
 * 阶段名走工作流的名称（有名称显示名称，否则 id）；条目不在可识别的阶段小节里时省略这一段。
 */
export function traceLabel(row: TraceRow, stageLabelOf: (stage: string) => string): string {
  if (row.kind !== 'task') return row.title
  const id = row.covers.replace(/^task:/u, '')
  return [id, ...(row.stage === undefined ? [] : [stageLabelOf(row.stage)]), row.title].join(' · ')
}

/** 页签计数：满足要求的种类 / 要求的种类（与矩阵同一口径）；没有要求任何种类时不给计数。 */
export function tabCount(report: PolicyReport, plan: TestPlanBrief | undefined): string | undefined {
  const rows = buildMatrix(report, plan)
  return rows.length === 0 ? undefined : `${rows.filter((row) => row.met).length}/${rows.length}`
}
