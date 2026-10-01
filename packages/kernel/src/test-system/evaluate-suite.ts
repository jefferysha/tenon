/**
 * 单个套件运行结果的判定（纯函数）：新鲜度（五项绑定）与结果（结构性原因、用例失败 × 已知失败、
 * 已登记用例未执行、覆盖率、基准、浏览器 project）。汇总与阻塞排序在 evaluate-v2.ts。
 */
import { evaluateBenchmarkMetric, type BenchmarkMetricVerdict } from './benchmark.js'
import { shellQuote, testBlocker, testNotice, type TestBlocker, type TestNotice } from './blockers.js'
import { catalogSuitesDigest, suiteFileGlobs } from './catalog.js'
import type { CatalogSuite, TestCatalog } from './catalog-types.js'
import { casesMatchingRef, fileRefMatches, formatCaseRef, parseCaseRef, type CaseRef } from './covers.js'
import { baselineKey, type StaleBinding } from './evaluate-types.js'
import type { TestBaselineV2 } from './baseline-v2.js'
import { matchesAnyGlob, repoGlob } from './globs.js'
import { KNOWN_FAILURE_MAX_DAYS, classifyAgainstKnownFailures, type KnownFailure } from './known-failures.js'
import type { TestPlan } from './plan.js'
import type { SuiteReasonCode, SuiteRunV2, TestRunRecordV2 } from './record-v2-types.js'
import { NODE_TEST_REPORTER_ENV, isCaseReportFormat, type CoverageMetric } from './vocabulary.js'
import type { StepTestPolicyIR } from '../workflow/ir.js'

export interface SuiteRunRef {
  readonly record: TestRunRecordV2
  readonly run: SuiteRunV2
}

function order(left: TestRunRecordV2, right: TestRunRecordV2): number {
  if (left.finished_at !== right.finished_at) return left.finished_at < right.finished_at ? -1 : 1
  return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0
}

/** 每个套件最新的一次运行（按记录完成时间，run-id 兜底）。 */
export function latestSuiteRuns(records: readonly TestRunRecordV2[]): ReadonlyMap<string, SuiteRunRef> {
  const out = new Map<string, SuiteRunRef>()
  for (const record of [...records].sort(order)) {
    for (const run of record.suites) out.set(run.suite, { record, run })
  }
  return out
}

export interface FreshnessContext {
  readonly candidate: string | null | undefined
  readonly workflowFingerprint: string
  readonly catalog: TestCatalog | undefined
  readonly planDigest: string | undefined
  /**
   * 计划摘要（豁免批准位全部视为空）。评审确认只是把豁免的 `approved_by` 从空写成批准人；批准之前的运行
   * 绑定的是「全部未批准」的那份计划，不该因为这次确认而过期。
   */
  readonly planDigestApprovalFree?: string
  readonly policyDigest: string
}

export function staleBindings(ref: SuiteRunRef, context: FreshnessContext): readonly StaleBinding[] {
  const bindings = ref.record.bindings
  const out: StaleBinding[] = []
  if (context.candidate !== undefined && (context.candidate === null || bindings.candidate !== context.candidate)) out.push('candidate')
  if (bindings.workflow_fingerprint !== context.workflowFingerprint) out.push('workflow')
  if (ref.run.origin === 'catalog') {
    const catalogSuites = ref.record.suites.filter((run) => run.origin === 'catalog').map((run) => run.suite)
    if (context.catalog === undefined || bindings.catalog_digest !== catalogSuitesDigest(context.catalog, catalogSuites)) out.push('catalog')
    const planFresh = bindings.plan_digest === (context.planDigest ?? null)
      || (context.planDigestApprovalFree !== undefined && bindings.plan_digest === context.planDigestApprovalFree)
    if (!planFresh) out.push('plan')
  }
  if (bindings.policy_digest !== context.policyDigest) out.push('policy')
  return out
}

export const STALE_WORDS: Readonly<Record<StaleBinding, string>> = {
  candidate: '代码已变化',
  workflow: '工作流已变化',
  catalog: '目录里的套件定义已变化',
  plan: '测试计划已变化',
  policy: '本阶段测试策略已变化',
}

type DirectReason = 'no-tests-ran' | 'report-missing' | 'report-unreadable' | 'report-untrusted' | 'exit-report-mismatch' | 'service-not-ready'
const DIRECT_REASONS: readonly DirectReason[] = [
  'no-tests-ran', 'report-missing', 'report-unreadable', 'report-untrusted', 'exit-report-mismatch', 'service-not-ready',
]

function isDirectReason(code: SuiteReasonCode): code is DirectReason {
  return (DIRECT_REASONS as readonly string[]).includes(code)
}
const RECOMPUTED_REASONS: ReadonlySet<SuiteReasonCode> = new Set<SuiteReasonCode>([
  'test-failed', 'registered-test-not-executed', 'coverage-below', 'benchmark-regression', 'baseline-missing',
  'flaky-over-limit', 'browser-project-missing',
])
const ADVISORY_REASONS: ReadonlySet<SuiteReasonCode> = new Set<SuiteReasonCode>([
  'workspace-changed', 'log-truncated', 'artifact-truncated',
])

export interface SuiteResultContext {
  readonly change: string
  readonly policy: StepTestPolicyIR
  readonly plan: TestPlan | undefined
  readonly knownFailures: readonly KnownFailure[]
  readonly baselines: ReadonlyMap<string, TestBaselineV2>
  readonly today: string
}

export interface SuiteResultEvaluation {
  readonly blockers: readonly TestBlocker[]
  readonly notices: readonly TestNotice[]
  readonly failing: readonly string[]
  readonly flaky: readonly string[]
  readonly benchmark: readonly BenchmarkMetricVerdict[]
}

/**
 * node:test 的内置 junit reporter 在 Node 22 及以前不给用例写 file：报告里的用例没有文件归属，已登记的文件对不上。
 * 这条提示只在 node-test 套件的这类阻塞里附上，指向 Tenon 随附的 reporter（`tenon test run` 提供路径）。
 */
const NODE_TEST_FILE_HINT = '（若报告里的用例没有文件归属——Node 22 及以前内置的 junit reporter 不写 file 属性——'
  + `命令里改用 --test-reporter="\${${NODE_TEST_REPORTER_ENV}:-junit}"，由 tenon test run 提供带 file 的 reporter）`

/**
 * 报告必须落在本次运行的产物目录副本里（R2）：报告文件被读走的同时复制进 `artifacts/<套件>/<仓库相对路径>` 并索引，
 * 记录里的报告摘要必须等于这份副本的摘要。副本缺失或摘要不同，说明报告在读取之后又被改写，或根本不是这次运行留下的。
 */
export function reportCopyProblem(run: SuiteRunV2): string | undefined {
  if (run.report.path === null || run.report.digest === null) return undefined
  const expected = `artifacts/${run.suite}/${repoGlob(run.cwd, run.report.path)}`
  const copy = run.artifacts.find((entry) => entry.path === expected)
  if (copy === undefined) return `运行的产物目录里没有报告 ${run.report.path} 的副本`
  return copy.digest === run.report.digest ? undefined : `报告 ${run.report.path} 在被读取之后又被改写（副本摘要与记录不符）`
}

function rerun(change: string, suite: string): string {
  return `tenon test run ${change} --suite ${shellQuote(suite)}`
}

/** 计划里归本套件的测试文件：显式指向本套件，或未指明套件但落在本套件 files glob 里。 */
export function planFilesOfSuite(plan: TestPlan | undefined, suite: CatalogSuite): readonly string[] {
  const globs = suiteFileGlobs(suite)
  return (plan?.files ?? [])
    .filter((file) => file.suite === suite.id || (file.suite === undefined && matchesAnyGlob(file.path, globs)))
    .map((file) => file.path)
}

function registeredRefs(plan: TestPlan | undefined, suite: CatalogSuite, files: readonly string[]): readonly string[] {
  const globs = suiteFileGlobs(suite)
  const refs = new Set<string>()
  for (const item of plan?.cases ?? []) {
    for (const test of item.tests) {
      const ref = parseCaseRef(test)
      if (ref === undefined) continue
      if (files.some((path) => fileRefMatches(ref.file, path)) || matchesAnyGlob(ref.file, globs)) refs.add(test)
    }
  }
  return [...refs].sort()
}

function coverageProblems(policy: StepTestPolicyIR, run: SuiteRunV2): readonly string[] {
  const thresholds = policy.coverage
  if (thresholds === undefined) return []
  if (run.coverage === null) return ['没有产出覆盖率数据']
  const problems: string[] = []
  for (const [metric, threshold] of Object.entries(thresholds) as Array<[CoverageMetric, number]>) {
    const actual = run.coverage[metric]
    if (actual === undefined) problems.push(`${metric} 未报告（门槛 ${threshold}%）`)
    else if (actual < threshold) problems.push(`${metric} ${actual}% < ${threshold}%`)
  }
  return problems
}

/** 一个新鲜的目录套件运行的结果判定。 */
export function evaluateSuiteResult(suite: CatalogSuite, ref: SuiteRunRef, context: SuiteResultContext): SuiteResultEvaluation {
  const { run, record } = ref
  const blockers: TestBlocker[] = []
  const notices: TestNotice[] = []
  const name = suite.label === undefined ? suite.id : `${suite.label}（${suite.id}）`
  const fix = rerun(context.change, suite.id)
  const direct = new Set<DirectReason>()
  const processReasons: string[] = []
  for (const reason of run.reasons) {
    if (isDirectReason(reason.code)) direct.add(reason.code)
    else if (!RECOMPUTED_REASONS.has(reason.code) && !ADVISORY_REASONS.has(reason.code)) {
      processReasons.push(reason.detail === undefined ? reason.code : `${reason.code}（${reason.detail}）`)
    }
  }
  const copyProblem = direct.has('report-missing') || direct.has('report-unreadable') ? undefined : reportCopyProblem(run)
  if (copyProblem !== undefined) direct.add('report-untrusted')
  const caseFormat = isCaseReportFormat(run.report.format)
  if (caseFormat && !direct.has('report-missing') && !direct.has('report-unreadable') && !direct.has('report-untrusted')
    && (run.totals.cases === 0 || run.totals.skip === run.totals.cases)) direct.add('no-tests-ran')
  for (const code of direct) {
    const detail = run.reasons.find((reason) => reason.code === code)?.detail ?? (code === 'report-untrusted' ? copyProblem : undefined)
    const base = code === 'no-tests-ran' ? `套件 ${name} 没有执行任何用例（0 用例或全部跳过）`
      : code === 'report-missing' ? `套件 ${name} 没有产出报告`
        : code === 'report-unreadable' ? `套件 ${name} 的报告无法解析`
          : code === 'report-untrusted' ? `套件 ${name} 的报告不可信`
            : code === 'exit-report-mismatch' ? `套件 ${name} 的退出码与报告结论不一致`
              : `套件 ${name} 依赖的服务未就绪`
    blockers.push(testBlocker(code, detail === undefined ? base : `${base}：${detail}`, { fix, subject: suite.id }))
  }
  const failing: string[] = []
  const flaky: string[] = []
  let listedFailures = 0
  for (const item of run.cases) {
    const refText = formatCaseRef(item)
    if (item.status === 'flaky') flaky.push(refText)
    if (item.status === 'fail' || item.status === 'known-fail') listedFailures++
    const verdict = classifyAgainstKnownFailures(context.knownFailures, suite.id, item, item.status, context.today)
    if (verdict.verdict === 'new-fail') failing.push(refText)
    if (verdict.verdict === 'expired') {
      failing.push(refText)
      notices.push(testNotice('known-failure-expired', `已知失败 ${refText} 已于 ${verdict.entry.expires} 过期，按普通失败处理`, {
        fix: `tenon test known add --suite ${shellQuote(suite.id)} --test ${shellQuote(verdict.entry.test)} --expires <YYYY-MM-DD> --reason ${shellQuote(verdict.entry.reason)}`,
        subject: refText,
      }))
    }
    if (verdict.verdict === 'too-long') {
      failing.push(refText)
      notices.push(testNotice('known-failure-too-long', `已知失败 ${refText} 的到期日 ${verdict.entry.expires} 超过登记后 ${KNOWN_FAILURE_MAX_DAYS} 天的上限，不被承认，按普通失败处理`, {
        fix: `tenon test known add --suite ${shellQuote(suite.id)} --test ${shellQuote(verdict.entry.test)} --expires <${KNOWN_FAILURE_MAX_DAYS} 天内的日期> --reason ${shellQuote(verdict.entry.reason)}`,
        subject: refText,
      }))
    }
    if (verdict.verdict === 'fixed') {
      notices.push(testNotice('known-failure-fixed', `已知失败 ${refText} 已通过，移出清单`, {
        fix: `tenon test known rm --suite ${shellQuote(suite.id)} --test ${shellQuote(verdict.entry.test)}`,
        subject: refText,
      }))
    }
  }
  const unlisted = run.totals.fail + run.totals.known_fail - listedFailures
  if (unlisted > 0) failing.push(`另有 ${unlisted} 个未列出的失败用例`)
  if (failing.length > 0 || processReasons.length > 0) {
    const parts = [
      ...(failing.length > 0 ? [`${failing.length} 个用例失败：${failing.slice(0, 5).join('；')}${failing.length > 5 ? ' …' : ''}`] : []),
      ...processReasons,
    ]
    blockers.push(testBlocker('test-failed', `套件 ${name} 失败：${parts.join('；')}`, { fix, subject: suite.id }))
  }
  const files = planFilesOfSuite(context.plan, suite)
  const executed = run.cases.filter((item) => item.status !== 'skip')
  const refs = registeredRefs(context.plan, suite, files).flatMap((test) => {
    const ref = parseCaseRef(test)
    return ref === undefined ? [] : [{ test, ref }]
  })
  // 引用按「文件 + 标题」对；报告没给文件的用例降级为按名字唯一对（casesMatchingRef）。唯一性要在含跳过用例的全部用例里算，
  // 命中之后再看有没有真正执行过的。
  const refRan = (ref: CaseRef): boolean => casesMatchingRef(ref, run.cases).some((item) => item.status !== 'skip')
  const missingRefs = refs.filter(({ ref }) => !refRan(ref)).map(({ test }) => test)
  // 文件级：有该文件的用例执行过；或报告没给文件，但登记在该文件下的某条用例按名字对上了。
  const fileRan = (path: string): boolean => executed.some((item) => fileRefMatches(path, item.file) || fileRefMatches(item.file, path))
    || refs.some(({ ref }) => fileRefMatches(ref.file, path) && refRan(ref))
  const missingFiles = files.filter((path) => !fileRan(path))
  if (caseFormat && (missingFiles.length > 0 || missingRefs.length > 0)) {
    const list = [...missingFiles, ...missingRefs]
    const hint = suite.runner === 'node-test' ? NODE_TEST_FILE_HINT : ''
    blockers.push(testBlocker('registered-test-not-executed', `套件 ${name} 的报告里没有已登记的测试：${list.slice(0, 5).join('；')}${list.length > 5 ? ' …' : ''}${hint}`, { fix, subject: suite.id }))
  }
  if (suite.coverage !== undefined || suite.kind === 'coverage') {
    const problems = coverageProblems(context.policy, run)
    if (problems.length > 0) blockers.push(testBlocker('coverage-below', `套件 ${name} 覆盖率不足：${problems.join('；')}`, { fix, subject: suite.id }))
  }
  const benchmark: BenchmarkMetricVerdict[] = []
  for (const spec of suite.benchmark?.metrics ?? []) {
    const result = run.metrics.find((metric) => metric.name === spec.name)
    const summary = result === undefined ? undefined : { median: result.median, p95: result.p95, mad: result.mad, samples: result.samples.length }
    const baseline = context.baselines.get(baselineKey(suite.id, record.machine_profile))
    const verdict = evaluateBenchmarkMetric(spec, summary, baseline?.metrics[spec.name]?.median)
    benchmark.push(verdict)
    if (verdict.failed) blockers.push(testBlocker('benchmark-regression', `套件 ${name}：${verdict.details.join('；')}`, { fix, subject: suite.id }))
    if (verdict.baselineMissing) {
      blockers.push(testBlocker('baseline-missing', `套件 ${name} 的指标 '${spec.name}' 在机器画像 ${record.machine_label} 上没有基线${context.policy.benchmark.require_baseline ? '' : '（只提示，不挡）'}`, {
        fix: `tenon test baseline ${context.change} --suite ${shellQuote(suite.id)} --run ${record.run_id}`,
        subject: suite.id,
        blocking: context.policy.benchmark.require_baseline,
      }))
    }
    if (verdict.noisy) notices.push(testNotice('benchmark-noisy', `套件 ${name} 的指标 '${spec.name}' 波动大于退化阈值的一半，结论不稳`, { fix, subject: suite.id }))
  }
  if (suite.runner === 'playwright') {
    // 策略里的浏览器要求针对 playwright 种类的套件；a11y / visual 等同样用 Playwright 跑的套件只受自身目录声明约束。
    const required = [...new Set([...suite.browsers, ...(suite.kind === 'playwright' ? context.policy.browsers : [])])]
    const missing = required.filter((project) => !run.projects.includes(project))
    if (missing.length > 0) {
      blockers.push(testBlocker('browser-project-missing', `套件 ${name} 的报告缺少浏览器 project：${missing.join('、')}`, { fix, subject: suite.id }))
    }
  }
  return { blockers, notices, failing, flaky, benchmark }
}
