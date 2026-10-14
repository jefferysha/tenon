/**
 * 任务「测试」页签的投影（纯函数）：把一个步骤的策略判定（PolicyReport）和计划概要（TestPlanBrief）
 * 变成一行汇总、按类的策略矩阵（档位策略按测试类，旧策略按种类）、未被矩阵和文件表认领的阻塞。
 * 判定本身来自服务端（与转换拦截同一份），这里只做展示投影，不重新判定。
 */
import type {
  NotApplicableKind, PolicyReport, SuiteState, SuiteVerdict, TestBlocker, TestNotice, TestPlanBrief, TraceRow,
} from '../api/testSystemTypes'
import { classOf } from '../tests/testLabels'

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

/**
 * 一行的要求词。档位策略按测试类：required = 档位的必需类，touched = 碰到才跑的类；
 * 旧策略按种类：register = 登记、run = 运行、if-registered = 有则跑（在途任务冻结的旧设置，只读）。
 * 档位策略里计划显式加跑的、不在档位两类里的套件所属类算 run。
 */
export type Requirement = 'required' | 'touched' | 'register' | 'run' | 'if-registered'

export interface MatrixSuite {
  readonly suite: string
  readonly name: string
  /** 在本阶段运行集里的判定；不在运行集（只登记）时缺省。 */
  readonly verdict: SuiteVerdict | undefined
}

export interface MatrixRow {
  /** 档位策略是测试类（unit、integration…），旧策略是种类。 */
  readonly kind: string
  readonly requirement: Requirement
  readonly suites: readonly MatrixSuite[]
  readonly waiver: { readonly approved: boolean } | null
  /**
   * 目录声明本项目不适用这个种类（服务端给出；没有登记任何套件时才算）。已批准 = 满足要求，不是缺；
   * 未批准 = 待批准，阻塞由服务端的 waiver-unapproved 解释。
   */
  readonly notApplicable: { readonly reason: string; readonly approved: boolean } | null
  readonly result: SuiteState | null
  readonly met: boolean
  /** 不满足时解释缺什么的那一条阻塞（含修复命令）；满足时 null。 */
  readonly blocker: TestBlocker | null
}

const WORST: Readonly<Record<SuiteState, number>> = { passed: 0, waived: 0, missing: 1, 'waiver-pending': 1, running: 2, stale: 3, failed: 4 }
const GLOBAL_CODES: readonly string[] = ['test-catalog-missing', 'test-plan-missing', 'test-plan-tampered', 'record-chain-broken', 'record-unsealed']
const NO_SUITES: readonly string[] = []
/** 文件表认领的阻塞码：不进矩阵行，也不进阻塞表。 */
const FILE_CODES: ReadonlySet<string> = new Set(['test-file-orphan'])

function worst(states: readonly SuiteState[]): SuiteState | null {
  return states.reduce<SuiteState | null>((acc, state) => (acc === null || WORST[state] > WORST[acc] ? state : acc), null)
}

function blockingOnly(report: PolicyReport): TestBlocker[] {
  return report.blockers.filter((item) => item.blocking)
}

/** 指向这一行（对象是它的类 / 种类 / 不适用声明的种类，或它的某个套件）的阻塞；没有就是 null。 */
function ownBlocker(report: PolicyReport, subjects: readonly string[], suites: readonly MatrixSuite[]): TestBlocker | null {
  const blocking = blockingOnly(report)
  const ids = new Set(suites.map((suite) => suite.suite))
  return blocking.find((item) => item.subject !== undefined && subjects.includes(item.subject) && !FILE_CODES.has(item.code))
    ?? blocking.find((item) => item.subject !== undefined && ids.has(item.subject) && !FILE_CODES.has(item.code))
    ?? null
}

/** 全局阻塞（目录缺失、计划缺失 / 被改动、记录被改动…）按优先级挑第一条。 */
function globalBlocker(report: PolicyReport): TestBlocker | null {
  const blocking = blockingOnly(report)
  return GLOBAL_CODES.map((code) => blocking.find((item) => item.code === code)).find((item) => item !== undefined) ?? null
}

/** 解释一行缺什么：先看指向它的阻塞，再退到全局阻塞。 */
function explain(report: PolicyReport, subjects: readonly string[], suites: readonly MatrixSuite[]): TestBlocker | null {
  return ownBlocker(report, subjects, suites) ?? globalBlocker(report)
}

/** 一行的套件：计划里登记的（含显式加跑的）在前，再加本阶段判定里出现的；`matches` 判定套件的种类属于这一行。 */
function rowSuites(report: PolicyReport, planSuites: readonly { readonly suite: string; readonly kind: string | null }[], matches: (kind: string) => boolean): MatrixSuite[] {
  const seen = new Set<string>()
  const suites: MatrixSuite[] = []
  for (const item of planSuites) {
    if (item.kind === null || !matches(item.kind) || seen.has(item.suite)) continue
    seen.add(item.suite)
    const verdict = report.suites.find((candidate) => candidate.suite === item.suite)
    suites.push({ suite: item.suite, name: verdict?.label ?? item.suite, verdict })
  }
  for (const verdict of report.suites) {
    if (!matches(verdict.kind) || seen.has(verdict.suite)) continue
    seen.add(verdict.suite)
    suites.push({ suite: verdict.suite, name: verdict.label ?? verdict.suite.replace(/^step:/u, ''), verdict })
  }
  return suites
}

/** `declared` = 目录对这一行的不适用声明（行里已有套件时不看，缺省）。 */
type RowBasis = Pick<MatrixRow, 'suites' | 'waiver' | 'notApplicable'> & { readonly declared: NotApplicableKind | undefined; readonly verdicts: readonly SuiteState[] }

/** 两种策略的行共用的起头：套件、计划豁免、不适用声明与套件判定状态。`key` 是计划豁免登记的种类 / 类名；`matches` 判定套件和不适用声明的种类属于这一行。 */
function rowBasis(report: PolicyReport, plan: TestPlanBrief | undefined, key: string, matches: (kind: string) => boolean): RowBasis {
  const suites = rowSuites(report, plan?.state === 'ok' ? plan.suites : [], matches)
  const declared = suites.length > 0 ? undefined : report.notApplicable.find((entry) => matches(entry.kind))
  const ownWaivers = (plan?.state === 'ok' ? plan.waivers : []).filter((waiver) => waiver.kind === key)
  return {
    suites,
    declared,
    waiver: ownWaivers.length === 0 ? null : { approved: ownWaivers.some((waiver) => waiver.approved) },
    notApplicable: declared === undefined ? null : { reason: declared.reason, approved: declared.approved },
    verdicts: suites.flatMap((suite) => (suite.verdict === undefined ? [] : [suite.verdict.state])),
  }
}

function legacyRequirement(report: PolicyReport, kind: string): Requirement {
  const policy = report.policy
  if (policy?.run.includes(kind) === true) return 'run'
  if (policy?.kinds.includes(kind) === true) return 'register'
  if (policy?.runIfRegistered.includes(kind) === true) return 'if-registered'
  return 'run'
}

function legacyKinds(report: PolicyReport): string[] {
  const policy = report.policy
  const declared = policy === null ? [] : [...policy.kinds, ...policy.run, ...policy.runIfRegistered]
  const inline = report.suites.filter((suite) => suite.origin === 'step').map((suite) => suite.kind)
  return [...new Set([...declared, ...inline])]
}

/** 旧策略（冻结的 test_policy）：一行一个种类，登记 / 运行 / 有则跑。 */
function legacyRows(report: PolicyReport, plan: TestPlanBrief | undefined): MatrixRow[] {
  return legacyKinds(report).map((kind) => {
    const requirement = legacyRequirement(report, kind)
    const { suites, waiver, notApplicable, verdicts } = rowBasis(report, plan, kind, (itemKind) => itemKind === kind)
    const result = requirement === 'register' && verdicts.length === 0 ? null : worst(verdicts)
    const registered = suites.length > 0 || waiver?.approved === true || notApplicable?.approved === true
    const runs = requirement !== 'register' && suites.length > 0
    const met = registered && (!runs || result === 'passed')
    // 「有则跑」的种类没登记不算缺。
    const optionalAbsent = requirement === 'if-registered' && suites.length === 0 && waiver === null
    return {
      kind, requirement, suites, waiver, notApplicable, result,
      met: met || optionalAbsent,
      blocker: met || optionalAbsent ? null : explain(report, [kind], suites),
    }
  })
}

/** 档位策略的行：必需类 → 碰到才跑的类 → 计划显式加跑 / 旧步骤内联的套件所属的其他类；套件按所属类归并（coverage 属于单测类）。 */
function levelClasses(report: PolicyReport): string[] {
  const level = report.policy?.level
  const declared = level === undefined ? [] : [...level.required, ...level.touched]
  return [...new Set([...declared, ...report.suites.map((suite) => classOf(suite.kind))])]
}

function levelRequirement(report: PolicyReport, cls: string): Requirement {
  const level = report.policy?.level
  if (level?.required.some((item) => item === cls) === true) return 'required'
  if (level?.touched.some((item) => item === cls) === true) return 'touched'
  return 'run'
}

/**
 * 档位策略：一行一个测试类。必需类目录里没有套件、也没有豁免 / 不适用声明时，服务端出 test-kind-missing（对象是类名）；
 * 本阶段没有被改动碰到的套件时这一类没有运行，不算缺（零运行即满足）。
 */
function levelRows(report: PolicyReport, plan: TestPlanBrief | undefined): MatrixRow[] {
  return levelClasses(report).map((cls) => {
    const { suites, waiver, declared, notApplicable, verdicts } = rowBasis(report, plan, cls, (itemKind) => classOf(itemKind) === cls)
    const result = worst(verdicts)
    const subjects = declared === undefined ? [cls] : [cls, declared.kind]
    const own = ownBlocker(report, subjects, suites)
    const bare = suites.length === 0 && waiver === null && notApplicable === null
    const global = bare ? globalBlocker(report) : null
    const settled = result === null || result === 'passed' || result === 'waived'
    const met = own === null && global === null && settled && (notApplicable === null || notApplicable.approved)
    return {
      kind: cls, requirement: levelRequirement(report, cls), suites, waiver, notApplicable, result,
      met,
      blocker: met ? null : explain(report, subjects, suites),
    }
  })
}

/** 策略矩阵：档位策略按测试类一行，旧策略按种类一行；判定都来自服务端。 */
export function buildMatrix(report: PolicyReport, plan: TestPlanBrief | undefined): MatrixRow[] {
  return report.policy?.level === undefined ? legacyRows(report, plan) : levelRows(report, plan)
}

/** 矩阵行没用上、文件表也不管的真阻塞（`blocking: true`）。提示不是阻塞，不在这里（见 {@link reportNotices}）。 */
export function extraBlockers(report: PolicyReport, rows: readonly MatrixRow[]): TestBlocker[] {
  const shown = new Set(rows.flatMap((row) => (row.blocker === null ? [] : [row.blocker])))
  return blockingOnly(report).filter((item) => !shown.has(item) && !FILE_CODES.has(item.code))
}

/** 完整性段自己列出的提示码：信号逐条在「完整性」表里，这里不再重复一行。 */
const INTEGRITY_NOTICE_CODES: ReadonlySet<string> = new Set(['test-integrity'])

/**
 * 提示（已修好的已知失败、基准波动、映射失效、未检查文件…）：中性信息，不是阻塞，不进阻塞表也不计入阻塞数。
 * 完整性的汇总提示由「完整性」段按信号逐条展示，不在这里重复。
 */
export function reportNotices(report: PolicyReport): TestNotice[] {
  return report.notices.filter((item) => !INTEGRITY_NOTICE_CODES.has(item.code))
}

export interface FileRow {
  readonly path: string
  /** 认领它的套件；孤儿没有。 */
  readonly suites: readonly string[]
  /** true = 没有任何套件认领（阻塞）；false = 套件的 files glob 自动认领。 */
  readonly orphan: boolean
  /** 孤儿的阻塞（修复命令 `tenon test register <c> --auto`）；自动认领的文件没有。 */
  readonly blocker: TestBlocker | undefined
}

/** 本任务改动的测试文件：没有套件认领的孤儿在前（带阻塞与修复命令），自动认领的在后（只有套件）。 */
export function fileRows(report: PolicyReport): FileRow[] {
  const orphanBlocker = (path: string): TestBlocker | undefined =>
    report.blockers.find((item) => item.code === 'test-file-orphan' && item.subject === path)
  return [
    ...report.files.orphans.map((path) => ({ path, suites: NO_SUITES, orphan: true, blocker: orphanBlocker(path) })),
    ...report.files.claimed.map((file) => ({ path: file.path, suites: file.suites, orphan: false, blocker: undefined })),
  ]
}

/**
 * 档位不要求映射（`scenarios: off`）：追溯矩阵只列已映射的行，没映射的场景 / 任务合并成一行统计，不逐条写未覆盖。
 * 没有策略（只有旧步骤测试）与要求映射（required / passing）时行为不变。
 */
export function mappingNotRequired(report: PolicyReport): boolean {
  return report.policy !== null && report.policy.scenarios === 'off'
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

/** 追溯里「可选」的行：没有映射、也不要求映射的任务条目（骨架任务）——它们合并成一行，不各占一行。 */
export function isOptionalTrace(row: TraceRow): boolean {
  return row.state === 'uncovered' && !row.required
}

/** 展示顺序权重：失败 → 缺映射 → 已映射未跑 → 待批准的豁免 → 通过 → 其余中性。 */
function traceRank(report: PolicyReport, row: TraceRow): number {
  switch (row.state) {
    case 'failing': return 0
    case 'uncovered': return traceNeedsMapping(report, row) ? 1 : 5
    case 'mapped': return 2
    case 'waived': return row.waiver?.approved === false ? 3 : 5
    case 'passing': return 4
  }
}

/**
 * 追溯表的投影：`shown` = 需要看的行（失败排最前，同权重保持服务端顺序）；`optional` = 合并成一行「N 可选」的行；
 * `unmapped` = 档位不要求映射时合并成一行统计的没映射的行数（此时它们既不在 shown 也不在 optional）。
 */
export function traceRows(report: PolicyReport): { shown: TraceRow[]; optional: TraceRow[]; unmapped: number } {
  const collapse = mappingNotRequired(report)
  const unmapped = collapse ? report.trace.filter((row) => row.state === 'uncovered').length : 0
  const optional = collapse ? [] : report.trace.filter(isOptionalTrace)
  const shown = report.trace
    .map((row, index) => ({ row, index, rank: traceRank(report, row) }))
    .filter((item) => (collapse ? item.row.state !== 'uncovered' : !isOptionalTrace(item.row)))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.row)
  return { shown, optional, unmapped }
}

