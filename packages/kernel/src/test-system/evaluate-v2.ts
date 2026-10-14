/**
 * 一个步骤的测试策略判定（纯函数）：目录 × 计划 × 策略 × 运行记录 × diff × OpenSpec 场景 → 阻塞码。
 *
 * 顺序即阻塞的展示顺序：目录 → 计划 → 种类 / 类 → 测试文件认领与孤儿 → 记录链 → 运行集里的每个套件（含认领文件的执行检查）→
 * 旧步骤内联测试 → 覆盖率 / flaky 汇总 → 场景追溯。前一项缺失时只跳过依赖它的检查，其余照查，
 * 一次列全要做的事。旧步骤测试（内联套件）的 v1 判定结果由调用方传入，这里只并入阻塞。
 * 运行集由 stageRunSet 算（`tenon test run --stage` 用同一份）；档位策略与旧 `files: registered` 都按认领处理改动的测试文件。
 */
import {
  renderTestBlocker, shellQuote, testBlocker, testNotice,
} from './blockers.js'
import type { CatalogSuite } from './catalog-types.js'
import { formatCaseRef, fileRefMatches } from './covers.js'
import { checkFiles, claimedNotExecuted, type ClaimedCheck, type ClaimedFiles } from './evaluate-files.js'
import { checkKinds } from './evaluate-kinds.js'
import {
  STALE_WORDS, evaluateSuiteResult, latestSuiteRuns, staleBindings, type FreshnessContext, type SuiteRunRef,
} from './evaluate-suite.js'
import { evaluateInline } from './evaluate-inline.js'
import { evaluateTrace } from './evaluate-trace.js'
import type {
  Collector, NotApplicableStatus, SuiteVerdict, TestPolicyEvaluationInput, TestPolicyReport, TraceRow,
} from './evaluate-types.js'
import {
  evaluateIntegrity, integrityRunSamples, integritySummary, unavailableIntegrity, type TestIntegrityReport,
} from './integrity.js'
import { planCatalogProblems, type TestPlan } from './plan.js'
import { testPlanApprovalFreeDigest } from './plan-waivers.js'
import { testPolicyDigest } from './policy.js'
import { protectedFileBlockers } from './protected-files.js'
import { policyChecksChangedFiles } from './resolve-policy.js'
import { stageRunSet, suitesWithoutCoversNotice, type StageRunItem, type StageRunSet } from './stage-run-set.js'
import type { TestRunRecordV2 } from './record-v2-types.js'

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

/** 目录里声明的不适用种类及其批准状态；目录不可用时没有声明可展示。 */
function notApplicableStatuses(input: TestPolicyEvaluationInput): readonly NotApplicableStatus[] {
  if (input.catalog.state !== 'ok') return []
  return (input.catalog.catalog.not_applicable ?? []).map((entry) => ({
    kind: entry.kind, reason: entry.reason, approved: entry.approved_by !== null,
  }))
}

/** 读不到改动列表按 undefined 处理（另出 files-diff-unavailable）。 */
function changedFilesOf(input: TestPolicyEvaluationInput): readonly string[] | undefined {
  return input.changedFilesError === undefined ? input.changedFiles : undefined
}

/** 阶段运行集：计划与目录都可用才算（计划缺失另有 test-plan-missing）。 */
function stageOf(input: TestPolicyEvaluationInput, plan: TestPlan | undefined): StageRunSet {
  if (plan === undefined || input.catalog.state !== 'ok') return { items: [], missingClasses: [] }
  return stageRunSet({ policy: input.policy, catalog: input.catalog.catalog, plan, changedFiles: changedFilesOf(input) })
}

/** 运行集真的算出来了（计划、目录都可用）才提示：算不出来时「没进运行集」不是套件自己的原因。 */
function checkCoversNotice(input: TestPolicyEvaluationInput, plan: TestPlan | undefined, stage: StageRunSet, out: Collector): void {
  if (plan === undefined || input.catalog.state !== 'ok') return
  const notice = suitesWithoutCoversNotice({ policy: input.policy, catalog: input.catalog.catalog, changedFiles: changedFilesOf(input), runSet: stage })
  if (notice !== undefined) out.notices.push(notice)
}

interface RunSetEvaluation {
  readonly verdicts: SuiteVerdict[]
  readonly fresh: SuiteRunRef[]
  /** 认领文件的核对结果（只含这次判过结果的套件）。 */
  readonly claimedChecks: ClaimedCheck[]
}

function evaluateRunSet(
  input: TestPolicyEvaluationInput,
  items: readonly StageRunItem[],
  latest: ReadonlyMap<string, SuiteRunRef>,
  freshness: FreshnessContext,
  plan: TestPlan | undefined,
  chainBroken: boolean,
  claims: ClaimedFiles,
  out: Collector,
): RunSetEvaluation {
  const verdicts: SuiteVerdict[] = []
  const fresh: SuiteRunRef[] = []
  const claimedChecks: ClaimedCheck[] = []
  for (const { suite, reason, scope } of items) {
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
    // 档位策略按运行集给出的范围要求（计划里显式登记的套件在 changed 档可以登记 full）；旧策略沿用策略自己的范围。
    const wantsFull = input.policy.level === undefined ? input.policy.scope === 'full' : scope === 'full'
    if (wantsFull && ref.run.scope !== 'full') {
      verdicts.push({ ...base, ...run, state: 'missing', detail: `只跑了 ${ref.run.scope} 范围` })
      out.blockers.push(testBlocker('test-not-run', `套件 ${name} 本阶段要求全量运行，最近一次只跑了 ${ref.run.scope} 范围`, { fix, subject: suite.id }))
      continue
    }
    fresh.push(ref)
    const claimed = claims.bySuite.get(suite.id) ?? []
    const result = evaluateSuiteResult(suite, ref, {
      change: input.change, policy: input.policy, plan, knownFailures: input.knownFailures, baselines: input.baselines, today: input.today,
      claimed,
    })
    if (result.claimedChecked.length > 0) claimedChecks.push({ suite, checked: result.claimedChecked, missing: result.claimedMissing })
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
  return { verdicts, fresh, claimedChecks }
}

function checkAggregates(
  input: TestPolicyEvaluationInput,
  plan: TestPlan | undefined,
  claims: ClaimedFiles,
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
    // 「本任务新增的用例」= 计划里登记的测试文件 + 本任务改动过、被套件认领的测试文件。
    const registered = [...(plan?.files ?? []).map((file) => file.path), ...claims.byPath.map((file) => file.path)]
    for (const ref of fresh) {
      for (const item of ref.run.cases) {
        if (item.status !== 'flaky' || !registered.some((path) => fileRefMatches(path, item.file) || fileRefMatches(item.file, path))) continue
        out.blockers.push(testBlocker('flaky-over-limit', `本任务新增的用例 ${formatCaseRef(item)} 不稳定（重试后才通过）`, { fix: stageFix, subject: item.file }))
      }
    }
  }
}

/**
 * 记录链头必须是 Tenon 命令写出的那个（封存文件里的链头）。不等 = 有人绕开 `tenon test run` 写了或重写了记录：
 * 这些记录一律不算证据，也没有人工批准的出口——重跑 `tenon test run` 生成带封存的记录。
 */
function recordsUnsealed(input: TestPolicyEvaluationInput): boolean {
  const evidence = input.protected
  return evidence !== undefined && input.chain.state === 'intact' && evidence.seal.heads[input.change] !== input.chain.head
}

function checkProtected(input: TestPolicyEvaluationInput, reviewFix: string, out: Collector): void {
  const evidence = input.protected
  if (evidence === undefined) return
  if (recordsUnsealed(input)) {
    const why = evidence.sealState === 'invalid'
      ? '本机封存文件损坏或被改动'
      : '这些记录的链头不是本机 tenon test run 写下的（记录被绕开命令写入，或来自别的机器）'
    out.blockers.push(testBlocker('record-unsealed', `测试记录来源不明：${why}，本任务的 v2 记录全部视为未运行`, { fix: `tenon test run ${input.change} --stage` }))
  }
  if (!evidence.reviewGated) return
  if (evidence.changesError !== undefined) {
    // 与认领检查同口径：策略要求 diff（旧 `files: registered`、档位 changed / full）的步骤读不出就失败关闭；不要求 diff 的步骤
    // （例如 spec）只提示，否则不是版本库的项目连规格步骤都过不了。
    const message = `无法读取本任务对测试配置（目录、基线、已知失败清单、工作流）的改动（${evidence.changesError}），不能确认它们已经过人工确认`
    if (policyChecksChangedFiles(input.policy)) out.blockers.push(testBlocker('files-diff-unavailable', message, { fix: reviewFix }))
    else out.notices.push(testNotice('files-unchecked', message))
    return
  }
  if (evidence.changes === undefined) return
  out.blockers.push(...protectedFileBlockers({ change: input.change, changes: evidence.changes, seal: evidence.seal, reviewFix }))
}

/**
 * 测试完整性（integrity.ts）：信号一律进报告；`notice` 只给一条汇总提示，`block` 让汇总成为阻塞。
 * 读不出 diff：`block` 失败关闭，`notice` 只提示未检查。运行记录类信号用本 workflow run 里的有效记录。
 */
function checkIntegrity(
  input: TestPolicyEvaluationInput,
  records: readonly TestRunRecordV2[],
  out: Collector,
): TestIntegrityReport | undefined {
  const evidence = input.integrity
  if (evidence === undefined) return undefined
  const mode = input.policy.integrity === 'block' ? 'block' : 'notice'
  const runs = integrityRunSamples(records)
  const fix = `tenon test integrity ${input.change}`
  if (evidence.diff === undefined) {
    const reason = evidence.error ?? '宿主没有提供改动行'
    const message = `无法读取本任务的改动行（${reason}），不能确认测试没有被削弱`
    if (mode === 'block') out.blockers.push(testBlocker('files-diff-unavailable', message, { fix }))
    else out.notices.push(testNotice('files-unchecked', `${message}；测试完整性只检查了运行记录`))
    const report = unavailableIntegrity(mode, reason, runs)
    if (report.signals.length > 0) pushIntegritySignals(report, fix, mode, out)
    return report
  }
  const report = evaluateIntegrity({ diff: evidence.diff, runs, suiteOf: evidence.suiteOf }, mode)
  if (report.truncated !== undefined) {
    out.notices.push(testNotice('files-truncated', `相关测试文件有 ${report.truncated.found} 个，完整性只检查了前 ${report.truncated.limit} 个`))
  }
  pushIntegritySignals(report, fix, mode, out)
  return report
}

function pushIntegritySignals(report: TestIntegrityReport, fix: string, mode: 'notice' | 'block', out: Collector): void {
  if (report.signals.length === 0) return
  const summary = `测试完整性${mode === 'block' ? '未通过' : '提示'}：${integritySummary(report.signals)}`
  if (mode === 'block') out.blockers.push(testBlocker('test-integrity', summary, { fix }))
  else out.notices.push(testNotice('test-integrity', summary, { fix }))
}

export function evaluateTestPolicy(input: TestPolicyEvaluationInput): TestPolicyReport {
  const out: Collector = { blockers: [], notices: [] }
  const reviewFix = `tenon review request ${input.change}${input.exitEvent === undefined ? '' : ` --event ${input.exitEvent}`}`
  checkCatalogAndPlan(input, out)
  const plan = input.plan.state === 'ok' ? input.plan.plan : undefined
  const stage = stageOf(input, plan)
  checkCoversNotice(input, plan, stage, out)
  if (plan !== undefined) checkKinds(input, plan, stage.missingClasses, reviewFix, out)
  const { files, claims } = checkFiles(input, plan, out)
  checkProtected(input, reviewFix, out)
  const unsealed = recordsUnsealed(input)
  const chainBroken = input.chain.state === 'broken' || unsealed
  if (input.chain.state === 'broken') {
    out.blockers.push(testBlocker('record-chain-broken', `测试记录被改动（${input.chain.reason}：${input.chain.files.slice(0, 3).join('、')}），本任务的 v2 记录全部视为未运行`, {
      fix: `tenon test run ${input.change} --stage`,
    }))
  }
  const runId = input.bindings.workflowRunId
  const records = input.chain.state === 'intact' && !unsealed && runId !== undefined
    ? input.chain.active.filter((record) => record.workflow_run_id === runId)
    : []
  const latest = latestSuiteRuns(records)
  const freshness: FreshnessContext = {
    candidate: input.bindings.candidate,
    ...(input.bindings.candidateAlt === undefined ? {} : { candidateAlt: input.bindings.candidateAlt }),
    workflowFingerprint: input.bindings.workflowFingerprint,
    catalog: input.catalog.state === 'ok' ? input.catalog.catalog : undefined,
    planDigest: input.plan.state === 'ok' ? input.plan.digest : undefined,
    ...(input.plan.state === 'ok' ? { planDigestApprovalFree: testPlanApprovalFreeDigest(input.plan.plan) } : {}),
    policyDigest: testPolicyDigest(input.policy),
  }
  const evaluated = evaluateRunSet(input, stage.items, latest, freshness, plan, chainBroken, claims, out)
  const unexecuted = claimedNotExecuted(input.change, evaluated.claimedChecks, out)
  const verdicts = evaluated.verdicts.map((verdict) => (unexecuted.has(verdict.suite) ? { ...verdict, state: 'failed' as const } : verdict))
  const inline = evaluateInline(input, plan, latest, freshness, reviewFix, out)
  checkAggregates(input, plan, claims, evaluated.fresh, out)
  const integrity = checkIntegrity(input, records, out)
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
    suites: [...verdicts, ...inline],
    trace,
    scenarios: input.policy.scenarios,
    files,
    chain: input.chain.state,
    notApplicable: notApplicableStatuses(input),
    ...(integrity === undefined ? {} : { integrity }),
  }
}

/** 阻塞渲染成既有测试证据口径的一行文案（transition 拒绝、status 文本输出用）。 */
export function renderPolicyBlockers(report: TestPolicyReport): readonly string[] {
  return report.blockers.filter((item) => item.blocking).map(renderTestBlocker)
}
