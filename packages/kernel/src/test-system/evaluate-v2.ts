/**
 * 一个步骤的测试策略判定（纯函数）：目录 × 计划 × 策略 × 运行记录 × diff × OpenSpec 场景 → 阻塞码。
 *
 * 顺序即阻塞的展示顺序：目录 → 计划 → 种类登记 → 文件登记 → 记录链 → 运行集里的每个套件 →
 * 旧步骤内联测试 → 覆盖率 / flaky 汇总 → 场景追溯。前一项缺失时只跳过依赖它的检查，其余照查，
 * 一次列全要做的事。旧步骤测试（内联套件）的 v1 判定结果由调用方传入，这里只并入阻塞。
 */
import {
  renderTestBlocker, shellQuote, testBlocker, testNotice, type TestBlocker, type TestNotice,
} from './blockers.js'
import { catalogSuite } from './catalog.js'
import { catalogNotApplicable } from './catalog-na.js'
import type { CatalogSuite } from './catalog-types.js'
import { formatCaseRef, fileRefMatches } from './covers.js'
import {
  STALE_WORDS, evaluateSuiteResult, latestSuiteRuns, staleBindings, type FreshnessContext, type SuiteRunRef,
} from './evaluate-suite.js'
import { evaluateTrace } from './evaluate-trace.js'
import type {
  SuiteVerdict, TestPolicyEvaluationInput, TestPolicyReport, TraceRow,
} from './evaluate-types.js'
import { planCatalogProblems, type TestPlan } from './plan.js'
import { testPlanApprovalFreeDigest } from './plan-waivers.js'
import { planKindsSatisfy, policyRequiredKinds, policyRunReason, testPolicyDigest } from './policy.js'
import { testFileRegistration, type UnregisteredTestFile } from './test-files.js'
import type { TestKind } from './vocabulary.js'

interface Collector {
  readonly blockers: TestBlocker[]
  readonly notices: TestNotice[]
}

function describeSuite(suite: Pick<CatalogSuite, 'id' | 'label'>): string {
  return suite.label === undefined ? suite.id : `${suite.label}（${suite.id}）`
}

function checkCatalogAndPlan(input: TestPolicyEvaluationInput, out: Collector): void {
  const change = input.change
  if (input.catalog.state === 'missing') {
    out.blockers.push(testBlocker('test-catalog-missing', '项目还没有测试目录（.tenon/tests/catalog.yaml）', { fix: 'tenon test discover --write' }))
  } else if (input.catalog.state === 'invalid') {
    const issues = input.catalog.issues
    out.blockers.push(testBlocker('test-catalog-missing', `测试目录无效：${issues.slice(0, 3).join('；')}${issues.length > 3 ? ` 等 ${issues.length} 处` : ''}`, {
      fix: 'tenon test catalog validate',
    }))
  }
  if (input.plan.state === 'missing' && input.policy.plan === 'required') {
    out.blockers.push(testBlocker('test-plan-missing', `任务 ${change} 还没有登记测试计划`, { fix: `tenon test plan ${change} --seed` }))
  } else if (input.plan.state === 'tampered') {
    out.blockers.push(testBlocker('test-plan-tampered', `测试计划不可信：${input.plan.reason}；只能经 tenon test 命令重新登记`, {
      fix: `tenon test plan ${change} --seed`,
    }))
  }
  if (input.plan.state === 'ok' && input.catalog.state === 'ok') {
    for (const problem of planCatalogProblems(input.plan.plan, input.catalog.catalog)) {
      out.blockers.push(testBlocker('test-catalog-missing', problem.message, {
        fix: `tenon test unregister ${change} --suite ${shellQuote(problem.subject)}`, subject: problem.subject,
      }))
    }
  }
}

/** 计划里登记的目录套件的种类（目录里已不存在的套件另由 planCatalogProblems 报）。 */
function plannedKinds(plan: TestPlan, input: TestPolicyEvaluationInput): readonly TestKind[] {
  if (input.catalog.state !== 'ok') return []
  const catalog = input.catalog.catalog
  return plan.suites.flatMap((item) => catalogSuite(catalog, item.suite)?.kind ?? [])
}

function kindWaiver(plan: TestPlan, kind: TestKind): { readonly approved: boolean } | undefined {
  const waiver = plan.waivers.find((item) => item.kind === kind)
  return waiver === undefined ? undefined : { approved: waiver.approved_by !== null }
}

/**
 * 策略要求的每个种类，计划里要有该种类的套件（regression 可由全量跑的 unit 套件顶上），或有已批准的豁免，
 * 或目录里有已批准的项目级「不适用」声明（catalog.yaml 的 not_applicable）。豁免 / 声明未批准时给 waiver-unapproved，
 * 由评审确认一并批准；都没有才是 test-kind-missing。
 */
function checkKinds(input: TestPolicyEvaluationInput, plan: TestPlan, reviewFix: string, out: Collector): void {
  if (input.catalog.state !== 'ok') return
  const catalog = input.catalog.catalog
  const kinds = plannedKinds(plan, input)
  for (const kind of policyRequiredKinds(input.policy)) {
    if (planKindsSatisfy(input.policy, kinds, kind)) continue
    const waiver = kindWaiver(plan, kind)
    if (waiver?.approved === true) continue
    const projectWide = catalogNotApplicable(catalog, kind)
    if (projectWide !== undefined && projectWide.approved_by !== null) continue
    if (waiver !== undefined) {
      out.blockers.push(testBlocker('waiver-unapproved', `测试种类 ${kind} 的豁免尚未经评审批准`, { fix: reviewFix, subject: kind }))
      continue
    }
    if (projectWide !== undefined) {
      out.blockers.push(testBlocker('waiver-unapproved', `测试种类 ${kind} 在 catalog.yaml 里声明了「本项目不适用」，但尚未经评审批准`, { fix: reviewFix, subject: kind }))
      continue
    }
    const candidate = catalog.suites.find((suite) => suite.kind === kind)
    out.blockers.push(testBlocker('test-kind-missing', `本阶段要求 ${kind} 测试，计划里既没有该种类的套件也没有已批准的豁免${candidate === undefined ? '（目录里也没有这类套件；只有这个任务不适用用 tenon test waive，整个项目都不适用就在目录里声明 not_applicable）' : ''}`, {
      fix: candidate === undefined
        ? `tenon test catalog not-applicable ${kind} --reason ${shellQuote('<本项目为什么不适用>')}`
        : `tenon test register ${input.change} --suite ${shellQuote(candidate.id)}`,
      subject: kind,
    }))
  }
}

function checkFiles(input: TestPolicyEvaluationInput, plan: TestPlan | undefined, out: Collector): TestPolicyReport['files'] {
  const none: TestPolicyReport['files'] = { checked: false, unregistered: [], orphans: [] }
  if (input.policy.files !== 'registered') return none
  if (input.changedFilesError !== undefined) {
    out.blockers.push(testBlocker('files-diff-unavailable', `无法读取本任务的改动文件列表（${input.changedFilesError}），不能确认测试文件都已登记`, {
      fix: `tenon test sync ${input.change}`,
    }))
    return none
  }
  if (input.changedFiles === undefined) {
    out.notices.push(testNotice('files-unchecked', '宿主没有提供本任务的 diff 文件列表，未检查未登记的测试文件'))
    return none
  }
  if (input.catalog.state !== 'ok') return none
  const registration = testFileRegistration({ changedFiles: input.changedFiles, catalog: input.catalog.catalog, plan })
  const register = (file: UnregisteredTestFile): string =>
    `tenon test register ${input.change} --file ${shellQuote(file.path)}${file.suites.length === 1 ? ` --suite ${shellQuote(file.suites[0] ?? '')}` : ''}`
  for (const file of registration.unregistered) {
    out.blockers.push(testBlocker('test-file-unregistered', `测试文件 ${file.path} 在本任务里新增或修改，但没有登记进测试计划`, { fix: register(file), subject: file.path }))
  }
  for (const path of registration.orphans) {
    out.blockers.push(testBlocker('test-file-orphan', `测试文件 ${path} 没有任何目录套件认领；把它并进对应套件的文件 glob 再登记（没有可用的套件就先在目录里加）`, {
      fix: `tenon test register ${input.change} --auto`, subject: path,
    }))
  }
  return { checked: true, unregistered: registration.unregistered, orphans: registration.orphans }
}

interface RunEntry {
  readonly suite: CatalogSuite
  readonly reason: 'run' | 'if-registered'
}

function runSet(input: TestPolicyEvaluationInput, plan: TestPlan | undefined): readonly RunEntry[] {
  if (plan === undefined || input.catalog.state !== 'ok') return []
  const catalog = input.catalog.catalog
  const out: RunEntry[] = []
  for (const item of plan.suites) {
    const suite = catalogSuite(catalog, item.suite)
    if (suite === undefined) continue
    const reason = policyRunReason(input.policy, suite.kind)
    if (reason !== undefined) out.push({ suite, reason })
  }
  return out
}

function evaluateRunSet(
  input: TestPolicyEvaluationInput,
  entries: readonly RunEntry[],
  latest: ReadonlyMap<string, SuiteRunRef>,
  freshness: FreshnessContext,
  plan: TestPlan | undefined,
  chainBroken: boolean,
  out: Collector,
): { readonly verdicts: SuiteVerdict[]; readonly fresh: SuiteRunRef[] } {
  const verdicts: SuiteVerdict[] = []
  const fresh: SuiteRunRef[] = []
  for (const { suite, reason } of entries) {
    const base = { suite: suite.id, origin: 'catalog' as const, kind: suite.kind, ...(suite.label === undefined ? {} : { label: suite.label }), reason }
    const name = describeSuite(suite)
    const fix = `tenon test run ${input.change} --suite ${shellQuote(suite.id)}`
    if (input.running?.has(suite.id) === true) {
      verdicts.push({ ...base, state: 'running' })
      out.blockers.push(testBlocker('test-not-run', `套件 ${name} 运行中`, { subject: suite.id }))
      continue
    }
    const ref = latest.get(suite.id)
    if (ref === undefined) {
      verdicts.push({ ...base, state: 'missing' })
      if (!chainBroken) out.blockers.push(testBlocker('test-not-run', `套件 ${name}（${suite.kind}）本阶段还没有在当前代码上运行`, { fix, subject: suite.id }))
      continue
    }
    const run = { run_id: ref.record.run_id, finished_at: ref.record.finished_at }
    const stale = staleBindings(ref, freshness)
    if (stale.length > 0) {
      verdicts.push({ ...base, ...run, state: 'stale', staleBecause: stale })
      out.blockers.push(testBlocker('test-stale', `套件 ${name} 的运行已过期：${stale.map((item) => STALE_WORDS[item]).join('、')}`, { fix, subject: suite.id }))
      continue
    }
    if (input.policy.scope === 'full' && ref.run.scope !== 'full') {
      verdicts.push({ ...base, ...run, state: 'missing', detail: `只跑了 ${ref.run.scope} 范围` })
      out.blockers.push(testBlocker('test-not-run', `套件 ${name} 本阶段要求全量运行，最近一次只跑了 ${ref.run.scope} 范围`, { fix, subject: suite.id }))
      continue
    }
    fresh.push(ref)
    const result = evaluateSuiteResult(suite, ref, {
      change: input.change, policy: input.policy, plan, knownFailures: input.knownFailures, baselines: input.baselines, today: input.today,
    })
    out.blockers.push(...result.blockers)
    out.notices.push(...result.notices)
    verdicts.push({
      ...base, ...run,
      state: result.blockers.some((item) => item.blocking) ? 'failed' : 'passed',
      totals: ref.run.totals,
      failing: result.failing,
      flaky: result.flaky,
      coverage: ref.run.coverage,
      ...(result.benchmark.length === 0 ? {} : { benchmark: result.benchmark }),
    })
  }
  return { verdicts, fresh }
}

function evaluateInline(
  input: TestPolicyEvaluationInput,
  latest: ReadonlyMap<string, SuiteRunRef>,
  freshness: FreshnessContext,
  out: Collector,
): SuiteVerdict[] {
  const verdicts: SuiteVerdict[] = []
  for (const item of input.inline) {
    const suite = item.suite
    const base = { suite: suite.id, origin: 'step' as const, kind: suite.kind, ...(suite.label === undefined ? {} : { label: suite.label }), reason: 'inline' as const }
    const name = suite.label === undefined ? suite.testId : `${suite.label}（${suite.testId}）`
    const fix = `tenon test run ${input.change} ${suite.testId}`
    const ref = latest.get(suite.id)
    let state = item.status
    let detail = item.detail
    if (ref !== undefined && state !== 'running') {
      const stale = staleBindings(ref, freshness)
      state = stale.length > 0 ? 'stale' : ref.run.result === 'pass' ? 'passed' : 'failed'
      detail = stale.length > 0 ? stale.map((binding) => STALE_WORDS[binding]).join('、') : ref.run.reasons.map((reason) => reason.code).join(', ')
    }
    verdicts.push({ ...base, state, ...(detail === undefined || detail === '' ? {} : { detail }) })
    if (!suite.required || state === 'passed') continue
    const suffix = detail === undefined || detail === '' ? '' : `：${detail}`
    if (state === 'running') out.blockers.push(testBlocker('test-not-run', `测试 ${name} 运行中`, { subject: suite.id }))
    else if (state === 'missing') out.blockers.push(testBlocker('test-not-run', `测试 ${name} 未运行`, { fix, subject: suite.id }))
    else if (state === 'stale') out.blockers.push(testBlocker('test-stale', `测试 ${name} 过期${suffix}`, { fix, subject: suite.id }))
    else out.blockers.push(testBlocker('test-failed', `测试 ${name} 失败${suffix}`, { fix, subject: suite.id }))
  }
  return verdicts
}

function checkAggregates(
  input: TestPolicyEvaluationInput,
  plan: TestPlan | undefined,
  fresh: readonly SuiteRunRef[],
  out: Collector,
): void {
  const stageFix = `tenon test run ${input.change} --stage`
  const flaky = input.policy.flaky
  if (flaky === undefined) return
  const total = fresh.reduce((sum, ref) => sum + ref.run.totals.flaky, 0)
  if (total > flaky.max) {
    out.blockers.push(testBlocker('flaky-over-limit', `本阶段 flaky 用例 ${total} 个，超过上限 ${flaky.max}`, { fix: stageFix }))
  }
  if (flaky.fail_on_new) {
    const registered = (plan?.files ?? []).map((file) => file.path)
    for (const ref of fresh) {
      for (const item of ref.run.cases) {
        if (item.status !== 'flaky' || !registered.some((path) => fileRefMatches(path, item.file) || fileRefMatches(item.file, path))) continue
        out.blockers.push(testBlocker('flaky-over-limit', `本任务新增的用例 ${formatCaseRef(item)} 不稳定（重试后才通过）`, { fix: stageFix, subject: item.file }))
      }
    }
  }
}

export function evaluateTestPolicy(input: TestPolicyEvaluationInput): TestPolicyReport {
  const out: Collector = { blockers: [], notices: [] }
  const reviewFix = `tenon review request ${input.change}${input.exitEvent === undefined ? '' : ` --event ${input.exitEvent}`}`
  checkCatalogAndPlan(input, out)
  const plan = input.plan.state === 'ok' ? input.plan.plan : undefined
  if (plan !== undefined) checkKinds(input, plan, reviewFix, out)
  const files = checkFiles(input, plan, out)
  const chainBroken = input.chain.state === 'broken'
  if (input.chain.state === 'broken') {
    out.blockers.push(testBlocker('record-chain-broken', `测试记录被改动（${input.chain.reason}：${input.chain.files.slice(0, 3).join('、')}），本任务的 v2 记录全部视为未运行`, {
      fix: `tenon test run ${input.change} --stage`,
    }))
  }
  const runId = input.bindings.workflowRunId
  const records = input.chain.state === 'intact' && runId !== undefined
    ? input.chain.active.filter((record) => record.workflow_run_id === runId)
    : []
  const latest = latestSuiteRuns(records)
  const freshness: FreshnessContext = {
    candidate: input.bindings.candidate,
    workflowFingerprint: input.bindings.workflowFingerprint,
    catalog: input.catalog.state === 'ok' ? input.catalog.catalog : undefined,
    planDigest: input.plan.state === 'ok' ? input.plan.digest : undefined,
    ...(input.plan.state === 'ok' ? { planDigestApprovalFree: testPlanApprovalFreeDigest(input.plan.plan) } : {}),
    policyDigest: testPolicyDigest(input.policy),
  }
  const entries = runSet(input, plan)
  const evaluated = evaluateRunSet(input, entries, latest, freshness, plan, chainBroken, out)
  const inline = evaluateInline(input, latest, freshness, out)
  checkAggregates(input, plan, evaluated.fresh, out)
  let trace: readonly TraceRow[] = []
  if (plan !== undefined) {
    const fresh = [...latest.values()].filter((ref) => staleBindings(ref, freshness).length === 0)
    const result = evaluateTrace({
      change: input.change, policy: input.policy, plan, scenarios: input.scenarios, tasks: input.tasks, fresh, reviewFix,
    })
    trace = result.rows
    out.blockers.push(...result.blockers)
    out.notices.push(...result.notices)
  }
  return {
    stepId: input.stepId,
    pass: !out.blockers.some((item) => item.blocking),
    blockers: out.blockers,
    notices: out.notices,
    suites: [...evaluated.verdicts, ...inline],
    trace,
    files,
    chain: input.chain.state,
  }
}

/** 阻塞渲染成既有测试证据口径的一行文案（transition 拒绝、status 文本输出用）。 */
export function renderPolicyBlockers(report: TestPolicyReport): readonly string[] {
  return report.blockers.filter((item) => item.blocking).map(renderTestBlocker)
}
