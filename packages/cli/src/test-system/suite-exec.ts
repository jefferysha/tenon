/**
 * 执行一个目录套件并产出 SuiteRunV2：选择命令 → 清理旧报告 → 运行 → 读报告 → 解析用例 → 失败重跑（flaky）→ 覆盖率 →
 * 产物索引 → 判定。进程、报告、退出码的对账在这里落成结构性原因，其余判定交给 judgeSuite。
 *
 * 对账规则（案例级格式）：报告缺失 / 无法解析；0 个用例或全部跳过（判定层）；退出码为 0 而报告里有失败，或退出码非 0
 * 而报告里没有失败（exit-report-mismatch）。退出码非 0 不再单独记 exit-code：失败的用例已经说明了原因。
 */
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  isCaseReportFormat, planFilesOfSuite,
  type CaseResultV2, type CatalogSuite, type CoverageResult, type SuiteReason, type SuiteRunV2,
} from '@tenon/kernel'
import { looksSandboxDenied } from '../test-runner/classify.js'
import type { TestProcessOutcome } from '../test-runner/process.js'
import { collectArtifacts } from './artifacts.js'
import { executeBenchmark } from './benchmark-exec.js'
import { isRetained, recordCases, totalsOf, wantedFiles } from './case-records.js'
import type { ExecContext, RunItem, SuiteOutcome } from './exec-types.js'
import { createInvoker, type Invoker } from './invoker.js'
import { exitText, judgeSuite, processReasons } from './judge.js'
import type { ParsedCase } from './parsers/index.js'
import { parseCases, parseCoverage, prepareOutputs, readCoverageFiles, readReportFile } from './report-read.js'
import { planCommand, planRerun, type PlannedCommand } from './select.js'
import { mergeRerun } from './rerun.js'

const COMMAND_MAX = 2000

function clipCommand(command: string): string {
  return command.length <= COMMAND_MAX ? command : `${command.slice(0, COMMAND_MAX - 1)}…`
}

interface Loaded {
  readonly outcome: TestProcessOutcome
  readonly cases?: readonly ParsedCase[]
  readonly projects: readonly string[]
  readonly digest: string | null
  readonly problem?: SuiteReason
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

async function runForCases(suite: CatalogSuite, context: ExecContext, cwd: string, invoker: Invoker, command: string, label: string): Promise<Loaded> {
  await prepareOutputs(suite, cwd)
  const outcome = await invoker.invoke(command, label)
  const read = await readReportFile(suite, cwd)
  const path = suite.report.path ?? '报告'
  if (read.state === 'missing') {
    return { outcome, projects: [], digest: null, problem: { code: 'report-missing', detail: `${label}：退出码 ${exitText(outcome)}，没有生成 ${path}` } }
  }
  if (read.state === 'unreadable') return { outcome, projects: [], digest: null, problem: { code: 'report-unreadable', detail: `${label}：${read.reason}` } }
  // 工具报告的绝对路径是 realpath（macOS 的 /tmp 是 /private/tmp 的软链），换算相对路径也要用 realpath。
  const parsed = parseCases(suite, read.text, await realpath(context.repoRoot), await realpath(cwd))
  if (!parsed.ok) return { outcome, projects: [], digest: read.digest, problem: { code: 'report-unreadable', detail: `${label}：${parsed.reason}` } }
  return { outcome, cases: parsed.cases, projects: parsed.projects, digest: read.digest }
}

function nativelyRetried(item: ParsedCase, retries: number): boolean {
  return item.attempts > 1 && item.attempts >= retries + 1
}

async function retryFailures(
  suite: CatalogSuite, context: ExecContext, cwd: string, invoker: Invoker, first: readonly ParsedCase[], notes: string[],
): Promise<{ readonly cases: readonly ParsedCase[]; readonly outcomes: readonly TestProcessOutcome[] }> {
  let cases = first
  const outcomes: TestProcessOutcome[] = []
  for (let attempt = 1; attempt <= suite.retries; attempt++) {
    const failed = cases.filter((item) => item.status === 'fail' && !nativelyRetried(item, suite.retries))
    if (failed.length === 0 || context.signal.aborted) break
    const rerun = planRerun(suite, failed)
    if (rerun === undefined) {
      notes.push(`套件 ${suite.id} 配了 retries 却没有 select 模板，失败用例无法重跑`)
      break
    }
    const again = await runForCases(suite, context, cwd, invoker, rerun.command, `重跑失败用例 ${attempt}/${suite.retries}`)
    outcomes.push(again.outcome)
    if (again.cases === undefined) {
      notes.push(`重跑 ${attempt} 没有产出可解析的报告，保留上一轮结果`)
      break
    }
    cases = mergeRerun(cases, failed, again.cases)
  }
  return { cases, outcomes }
}

async function coverageOf(
  suite: CatalogSuite, context: ExecContext, cwd: string, hasFailures: boolean, reasons: SuiteReason[],
): Promise<CoverageResult | null> {
  const files = await readCoverageFiles(suite, cwd)
  if (files.summary.state !== 'ok') {
    if (!hasFailures) {
      reasons.push({ code: 'coverage-unreadable', detail: files.summary.state === 'missing' ? `没有生成 ${suite.coverage?.path ?? '覆盖率报告'}` : files.summary.reason })
    }
    return null
  }
  const wantsChanged = context.policy.coverage?.changed_lines !== undefined
  const changedLines = wantsChanged ? await context.changedLines() : undefined
  const parsed = parseCoverage(suite, files.summary.text, {
    repoRoot: await realpath(context.repoRoot), cwd: await realpath(cwd),
    ...(changedLines === undefined ? {} : { changedLines }),
    ...(files.detail === undefined ? {} : { detailText: files.detail }),
  })
  if (!parsed.ok) {
    reasons.push({ code: 'coverage-unreadable', detail: parsed.reason })
    return null
  }
  return parsed.coverage
}

function baseRun(suite: CatalogSuite, planned: PlannedCommand): SuiteRunV2 {
  return {
    suite: suite.id, origin: 'catalog', kind: suite.kind, runner: suite.runner, scope: planned.scope,
    selection: planned.selection.map((entry) => (entry.length <= COMMAND_MAX ? entry : entry.slice(0, COMMAND_MAX))).filter((entry) => entry !== ''),
    command: clipCommand(planned.command), cwd: suite.cwd, exit_code: null, signal: null, duration_ms: 0,
    result: 'pass', reasons: [], totals: totalsOf([]), cases: [], projects: [], coverage: null, metrics: [], artifacts: [],
    report: { format: suite.report.format, path: suite.report.path ?? null, digest: null },
    log: { artifact: `logs/${suite.id}.log`, bytes_total: 0, bytes_kept: 0, truncated: false, digest: `sha256:${'0'.repeat(64)}` },
  }
}

/** 套件没有真正执行（工作目录非法、依赖服务未就绪）：如实记一次失败的运行。 */
async function notExecuted(suite: CatalogSuite, item: RunItem, context: ExecContext, reason: SuiteReason): Promise<SuiteOutcome> {
  const invoker = createInvoker({ suite, cwd: context.repoRoot, env: context.env, runDir: context.runDir, signal: context.signal })
  const { log } = await invoker.finish()
  const run: SuiteRunV2 = { ...baseRun(suite, { command: suite.command, scope: item.scope, selection: [] }), result: 'fail', reasons: [reason], log }
  return { run, notices: [], notes: [], tail: '', sandboxDenied: false }
}

export async function executeSuite(context: ExecContext, item: RunItem, blocked: SuiteReason | undefined): Promise<SuiteOutcome> {
  const suite = item.suite
  if (blocked !== undefined) return notExecuted(suite, item, context, blocked)
  const cwd = resolve(context.repoRoot, suite.cwd)
  const planned = planCommand(suite, {
    scope: item.scope, ...(item.pattern === undefined ? {} : { pattern: item.pattern }), ...(item.files === undefined ? {} : { files: item.files }),
  }, context.changedFiles)
  const invoker = createInvoker({ suite, cwd, env: context.env, runDir: context.runDir, signal: context.signal })
  const notes: string[] = planned.note === undefined ? [] : [planned.note]
  const reasons: SuiteReason[] = []
  const started = Date.now()
  let outcomes: TestProcessOutcome[] = []
  let digest: string | null = null
  let parsedCases: readonly ParsedCase[] = []
  let projects: readonly string[] = []
  let metrics: SuiteRunV2['metrics'] = []
  let coverage: CoverageResult | null = null
  let rawFailed = false

  if (suite.benchmark !== undefined) {
    const result = await executeBenchmark({ suite, command: planned.command, cwd, invoker, baseline: await context.baseline(suite.id) })
    outcomes = [...result.outcomes]
    reasons.push(...result.reasons)
    metrics = result.metrics
    digest = result.digest
    if (result.noisyRerun) notes.push(`套件 ${suite.id} 的基准样本波动大，已自动多采一轮`)
  } else if (isCaseReportFormat(suite.report.format)) {
    const first = await runForCases(suite, context, cwd, invoker, planned.command, '执行')
    outcomes = [first.outcome]
    digest = first.digest
    reasons.push(...processReasons(first.outcome, suite.timeout_s))
    if (first.problem !== undefined) reasons.push(first.problem)
    if (first.cases !== undefined) {
      rawFailed = first.cases.some((item2) => item2.status === 'fail')
      const clean = reasons.length === 0
      const exit = first.outcome.exitCode
      if (clean && first.cases.length > 0 && ((exit === 0 && rawFailed) || (exit !== 0 && !rawFailed))) {
        reasons.push({ code: 'exit-report-mismatch', detail: exit === 0 ? '退出码 0，但报告里有失败的用例' : `退出码 ${exitText(first.outcome)}，但报告里没有失败的用例（覆盖率门槛、全局钩子或报告不完整）` })
      }
      const retried = suite.retries > 0 && rawFailed ? await retryFailures(suite, context, cwd, invoker, first.cases, notes) : { cases: first.cases, outcomes: [] }
      parsedCases = retried.cases
      outcomes = [first.outcome, ...retried.outcomes]
      projects = first.projects
    }
  } else {
    await prepareOutputs(suite, cwd)
    const outcome = await invoker.invoke(planned.command, '执行')
    outcomes = [outcome]
    const fatal = processReasons(outcome, suite.timeout_s)
    reasons.push(...fatal)
    if (outcome.exitCode !== 0 && fatal.every((reason) => reason.code !== 'timeout' && reason.code !== 'interrupted' && reason.code !== 'spawn-error')) {
      reasons.push({ code: 'exit-code', detail: `退出码 ${exitText(outcome)}` })
    }
  }

  if (suite.coverage !== undefined && planned.scope === 'full' && suite.benchmark === undefined) {
    coverage = await coverageOf(suite, context, cwd, parsedCases.some((entry) => entry.status === 'fail'), reasons)
  }
  const wanted = wantedFiles(context.plan, planFilesOfSuite(context.plan, suite), context.knownFailures, suite.id)
  const attachments = parsedCases.flatMap((entry) => (isRetained(entry, wanted)
    ? entry.attachments.map((attachment) => resolve(cwd, attachment.path)) : []))
  const artifacts = await collectArtifacts({
    repoRoot: context.repoRoot, cwd, suiteId: suite.id, artifactPaths: suite.artifacts, extraFiles: attachments,
    runDir: context.runDir, budget: context.budget,
  })
  if (artifacts.truncated) reasons.push({ code: 'artifact-truncated', detail: '产物超过单文件 / 单次运行 / 文件数上限，超出的没有收进索引' })
  const records = recordCases(parsedCases, {
    suiteId: suite.id, wanted, knownFailures: context.knownFailures, today: context.today,
    indexed: (absolute) => artifacts.mapped.get(absolute), resolveAttachment: (path) => real(resolve(cwd, path)),
  })
  const { log, tail } = await invoker.finish()
  if (log.truncated) reasons.push({ code: 'log-truncated' })
  const last = outcomes[0]
  const sandboxDenied = context.sandbox !== null && last !== undefined && last.exitCode !== 0 && looksSandboxDenied(tail)
  if (sandboxDenied) reasons.push({ code: 'sandbox-denied' })
  const totalMs = outcomes.reduce((sum, entry) => sum + entry.durationMs, 0) || Date.now() - started
  const run: SuiteRunV2 = {
    ...baseRun(suite, planned),
    exit_code: last?.exitCode ?? null, signal: last?.signal ?? null, duration_ms: totalMs,
    reasons, totals: totalsOf(records.all), cases: records.kept as CaseResultV2[], projects: [...projects],
    coverage, metrics, artifacts: [...artifacts.index],
    report: { format: suite.report.format, path: suite.report.path ?? null, digest },
    log,
  }
  const judged = await judgeSuite(suite, run, context)
  return { run: judged.run, notices: judged.notices, notes, tail, sandboxDenied }
}
