/**
 * `tenon test run <change> [--suite <id>…] [--kind <k>…] [--stage [<step>]] [--all] [--changed] [--json]`
 * —— 批量执行目录套件并写一份运行记录 v2（哈希链）。没有任何选择参数时缺省就是 --stage。
 *
 * 流程：规划运行集 → 启动依赖服务并等就绪 → 并发跑 parallel 套件、再依次跑其余套件（重试、基准、覆盖率、产物索引都在
 * 套件执行里）→ 回收服务 → 补上整次运行才知道的原因 → 追加记录 → 打印摘要与出口检查。
 * 退出码：0 全部通过，2 有失败（记录已写），1 用法 / 环境错误（没有记录）。
 */
import { relative } from 'node:path'
import {
  appendTestRunRecordV2, ensureTestEvidenceDirs, claimRunningMarker, listRecordDirectory, pruneTestArtifacts,
  readTestBaselineV2, readTestPlanState, releaseRunningMarker, baselineV2Path, testRunArtifactsDir, testRunRecordsDir,
  testRunningMarkerPath, type ServiceRunV2, type SuiteReason, type SuiteRunV2, type TestBaselineV2, type TestCatalog,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { detectHostEnvironment } from '../hostKind.js'
import { str } from '../render.js'
import { testEvidenceContextFor, testEvidenceReaderFor, changedFilesFor } from '../testEvidenceContext.js'
import { changedLinesSinceChangeStart, changeStartOfFields } from '@tenon/kernel'
import type { ExecContext, RunItem, SuiteOutcome } from '../test-system/exec-types.js'
import { planRunSet } from '../test-system/run-set.js'
import { applyRunLevelReasons, draftOf, evaluationShell, machineOf } from '../test-system/run-record.js'
import { readCatalogFile, readKnownFailuresFile } from '../test-system/project-files.js'
import { noticeLines, serviceLines, suiteLines } from '../test-system/run-summary.js'
import { executeSuite } from '../test-system/suite-exec.js'
import { serviceRecord, startService, stopService, type RunningService } from '../test-system/services.js'
import { candidateOf, newRunId, cmdTestRun } from './test-run.js'
import { resolveTestCommand } from './test-context.js'

export interface RunSuitesOptions {
  readonly suite?: readonly string[]
  readonly kind?: readonly string[]
  readonly stage?: string | boolean
  readonly all?: boolean
  readonly changed?: boolean
  readonly json?: boolean
}

const KEEP_RUNS = 10

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

async function runGate(deps: CliDeps, change: string, stepId: string, context: Awaited<ReturnType<typeof resolveTestCommand>>): Promise<{ pass: boolean; lines: string[]; blockers: readonly unknown[] }> {
  if (typeof context === 'number') return { pass: true, lines: [], blockers: [] }
  try {
    const report = await testEvidenceReaderFor(deps)({
      repoRoot: deps.cwd, changeDir: context.dir, changeName: change, plan: context.plan, stepId,
      context: testEvidenceContextFor(deps, change),
    })
    const blocking = (report.policy?.blockers ?? []).filter((item) => item.blocking)
    const lines = report.pass ? [`  出口检查（${stepId}）：通过`] : [`  出口检查（${stepId}）：还差 ${report.blockers.length} 项`, ...blocking.slice(0, 8).flatMap((item) => [`    [${item.code}] ${item.message}`, ...(item.fix === undefined ? [] : [`      → ${item.fix}`])])]
    return { pass: report.pass, lines, blockers: blocking }
  } catch (error) {
    return { pass: false, lines: [`  出口检查无法计算：${errMsg(error)}`], blockers: [] }
  }
}

export async function cmdTestRunSuites(deps: CliDeps, change: string, opts: RunSuitesOptions): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: true })
  if (typeof context === 'number') return context
  const workflowRunId = context.state.runMetadata?.runId
  if (workflowRunId === undefined) return fail(deps, `任务 ${change} 还没有 workflow run（老任务），不能写测试记录 v2；先执行任意 tenon transition 或 tenon status`)
  const stepId = typeof opts.stage === 'string' ? opts.stage : str(context.state.fields.phase)
  const step = context.plan.workflow.steps.find((entry) => entry.id === stepId)
  if (step === undefined) return fail(deps, `step '${stepId}' 不在 workflow '${context.plan.id}' 里`)
  const catalogFile = await readCatalogFile(deps.cwd)
  if (catalogFile.state !== 'ok') return fail(deps, catalogFile.state === 'missing' ? '还没有测试目录；先 tenon test discover --write' : `catalog.yaml 无效：${catalogFile.issues.slice(0, 3).join('；')}`)
  const catalog: TestCatalog = catalogFile.catalog
  const planState = await readTestPlanState(context.dir, change)
  const flags = { suites: opts.suite ?? [], kinds: opts.kind ?? [], stage: opts.stage !== undefined && opts.stage !== false, all: opts.all === true, changed: opts.changed === true }
  const stageMode = flags.stage || (flags.suites.length === 0 && flags.kinds.length === 0 && !flags.all)
  const needsPlan = stageMode || flags.kinds.length > 0 || flags.all
  if (needsPlan && planState.state === 'tampered') return fail(deps, `测试计划不可信：${planState.reason}；执行 tenon test plan ${change} --seed`)
  const plan = planState.state === 'ok' ? planState.plan : undefined
  const known = await readKnownFailuresFile(deps.cwd)
  if (known.state === 'invalid') deps.io.err(`WARN: known-failures.yaml 无效，按空清单处理（失败不会被豁免）：${known.issues[0] ?? ''}`)
  const knownFailures = known.state === 'ok' ? known.entries : []

  const inline = stageMode ? (step.tests ?? []) : []
  const set = stageMode && step.test_policy === undefined && inline.length > 0
    ? { items: [] as readonly RunItem[] }
    : planRunSet({ catalog, plan, policy: step.test_policy, flags, stepId, change })
  if ('error' in set) return fail(deps, set.error)

  const startedAt = deps.clock()
  const startedMs = Date.now()
  const runId = newRunId(startedAt)
  const paths = await ensureTestEvidenceDirs(deps.cwd, context.slug, change, runId)
  const runDir = testRunArtifactsDir(deps.cwd, context.slug, change, runId)
  const claimed: string[] = []
  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const running: RunningService[] = []
  const inlineExits: Array<{ test_id: string; exit: number }> = []
  try {
    for (const item of set.items) {
      const marker = testRunningMarkerPath(deps.cwd, context.slug, change, `suite-${item.suite.id}`)
      const attempts = item.suite.retries + (item.suite.benchmark === undefined ? 1 : 2 * (item.suite.benchmark.runs + item.suite.benchmark.warmup) + 1)
      const claim = await claimRunningMarker(marker, paths.runningDir, {
        run_id: runId, pid: process.pid, started_at: startedAt,
        deadline_at: new Date(startedMs + item.suite.timeout_s * 1000 * attempts).toISOString(),
      }, Date.now())
      if (!claim.claimed) return fail(deps, `套件 '${item.suite.id}' 正在运行（run ${claim.held.run_id}，开始于 ${claim.held.started_at}）`)
      claimed.push(marker)
    }
    if (opts.json !== true) {
      deps.io.out(`[TEST] ${change} run=${runId} step=${stepId}${set.items.length === 0 ? '' : `  ${set.items.length} 个套件`}`)
      for (const item of set.items) deps.io.out(`  · ${item.suite.id}  ${item.suite.kind}  scope=${item.scope}  $ ${item.suite.command}`)
    }
    for (const test of inline) {
      const quiet: CliDeps = opts.json === true ? { ...deps, io: { out: () => undefined, err: deps.io.err } } : deps
      inlineExits.push({ test_id: test.id, exit: await cmdTestRun(quiet, change, test.id, {}) })
    }
    if (set.items.length === 0) return inlineExits.some((entry) => entry.exit !== 0) ? 2 : 0

    const profile = machineOf(catalog, process.env)
    const host = detectHostEnvironment(process.env)
    const gitHead = deps.gitHeadSha === undefined ? null : await deps.gitHeadSha().catch(() => null)
    const candidateBefore = await candidateOf(deps, change)
    const skeleton = draftOf({
      runId, change, workflowRunId, workflow: context.plan.id, track: str(context.state.fields.track), step: stepId,
      workflowFingerprint: context.plan.workflowFingerprint, candidate: candidateBefore, catalog,
      planDigest: planState.state === 'ok' ? planState.digest : null, policy: step.test_policy, profile, services: [], suites: [],
      actor: context.actor, host, gitHead: gitHead === null || gitHead === '' ? null : gitHead, startedAt, finishedAt: startedAt, durationMs: 0,
    })
    const policy = step.test_policy ?? {
      plan: 'optional' as const, kinds: [], run: [], run_if_registered: [], scope: 'changed' as const, files: 'any' as const,
      scenarios: 'off' as const, benchmark: { require_baseline: false }, browsers: [],
    }
    let changedFiles: readonly string[] | undefined
    try {
      changedFiles = await changedFilesFor(deps, change)()
    } catch {
      changedFiles = undefined
    }
    const baselines = new Map<string, TestBaselineV2 | undefined>()
    let lines: ReadonlyMap<string, ReadonlySet<number>> | undefined
    let linesRead = false
    const exec: ExecContext = {
      repoRoot: deps.cwd, runId, runDir, change,
      env: { ...process.env, TENON_CHANGE_NAME: change, TENON_TEST_RUN_ID: runId, TENON_TEST_ARTIFACTS: runDir, TENON_BASE_BRANCH: str(context.state.fields.base_branch) },
      plan, policy, knownFailures, today: startedAt.slice(0, 10), changedFiles,
      changedLines: async () => {
        if (!linesRead) {
          linesRead = true
          lines = await changedLinesSinceChangeStart(deps.cwd, changeStartOfFields(context.state.fields)).catch(() => undefined)
        }
        return lines
      },
      baseline: async (suiteId) => {
        if (!baselines.has(suiteId)) {
          const read = await readTestBaselineV2(baselineV2Path(deps.cwd, suiteId, profile.id))
          baselines.set(suiteId, read.state === 'ok' ? read.baseline : undefined)
        }
        return baselines.get(suiteId)
      },
      evalRecord: evaluationShell(skeleton), budget: { used: 0 }, signal: controller.signal, sandbox: host.sandbox,
    }

    const failures = new Map<string, SuiteReason>()
    const needed = [...new Set(set.items.flatMap((item) => item.suite.services))]
    for (const id of needed) {
      const service = catalog.services.find((entry) => entry.id === id)
      if (service === undefined) continue
      const started = await startService(service, { repoRoot: deps.cwd, logPath: `${runDir}/services/${id}.log`, env: exec.env })
      running.push(started.running)
      if (!started.start.ok) failures.set(id, { code: 'service-not-ready', detail: `服务 ${id}：${started.start.failure ?? '未就绪'}`.slice(0, 1900) })
    }
    const outcomes = new Map<string, SuiteOutcome>()
    const one = async (item: RunItem): Promise<void> => {
      const blocked: SuiteReason | undefined = controller.signal.aborted
        ? { code: 'interrupted', detail: '未开始：运行被中断' }
        : item.suite.services.map((id) => failures.get(id)).find((reason) => reason !== undefined)
      outcomes.set(item.suite.id, await executeSuite(exec, item, blocked))
    }
    await Promise.all(set.items.filter((item) => item.suite.parallel).map(one))
    for (const item of set.items.filter((entry) => !entry.suite.parallel)) await one(item)
    await Promise.all(running.map((service) => stopService(service)))

    const candidateAfter = await candidateOf(deps, change)
    const ordered: SuiteOutcome[] = set.items.flatMap((item) => outcomes.get(item.suite.id) ?? [])
    const runs: SuiteRunV2[] = applyRunLevelReasons(ordered.map((outcome) => outcome.run), { candidateBefore, candidateAfter, policy, plan })
    const services: ServiceRunV2[] = running.map((service) => serviceRecord(service, service.exited || service.readyMs !== null || service.child.pid !== undefined ? `services/${service.service.id}.log` : null))
    const finishedAt = deps.clock()
    const draft = draftOf({
      ...{ runId, change, workflowRunId, workflow: context.plan.id, track: str(context.state.fields.track), step: stepId,
        workflowFingerprint: context.plan.workflowFingerprint, catalog, policy: step.test_policy, profile, actor: context.actor, host,
        gitHead: gitHead === null || gitHead === '' ? null : gitHead, startedAt, finishedAt, durationMs: Date.now() - startedMs },
      candidate: candidateAfter, planDigest: planState.state === 'ok' ? planState.digest : null, services, suites: runs,
    })
    const appended = await appendTestRunRecordV2(deps.cwd, context.slug, draft)
    const listing = await listRecordDirectory(testRunRecordsDir(deps.cwd, context.slug, change))
    await pruneTestArtifacts(paths.artifactsDir, listing.records.map((entry) => entry.record.run_id).sort(), KEEP_RUNS)

    const gate = await runGate(deps, change, stepId, context)
    const recordPath = relative(deps.cwd, appended.path)
    const exitCode = appended.record.result === 'pass' && inlineExits.every((entry) => entry.exit === 0) ? 0 : 2
    if (opts.json === true) {
      deps.io.out(JSON.stringify({
        run_id: runId, change, step: stepId, result: appended.record.result, chain: appended.chain,
        record_path: recordPath, artifacts_dir: relative(deps.cwd, runDir), inline: inlineExits,
        gate: { pass: gate.pass, blockers: gate.blockers }, record: appended.record,
      }, null, 2))
      return exitCode
    }
    deps.io.out(`[TEST] ${change} 结果：${appended.record.result === 'pass' ? '通过' : '失败'}（${(appended.record.duration_ms / 1000).toFixed(1)}s，机器画像 ${profile.label}）`)
    for (const outcome of ordered) {
      for (const line of suiteLines(appended.record.suites.find((run) => run.suite === outcome.run.suite) ?? outcome.run)) deps.io.out(line)
      for (const note of outcome.notes) deps.io.out(`         注：${note}`)
    }
    for (const line of serviceLines(services)) deps.io.out(line)
    for (const line of noticeLines(ordered.flatMap((outcome) => outcome.notices))) deps.io.out(line)
    if (appended.chain === 'reset') deps.io.out('  注意：旧记录链已断（记录被改动或损坏），已另起新链，旧记录视为未运行')
    deps.io.out(`  记录：${recordPath}`)
    deps.io.out(`  产物：${relative(deps.cwd, runDir)}/`)
    for (const line of gate.lines) deps.io.out(line)
    const denied = ordered.find((outcome) => outcome.sandboxDenied)
    if (denied !== undefined) deps.io.err(`可能被宿主沙箱拦截：Codex 中用 sandbox_permissions=require_escalated 重新执行 tenon test run ${change}`)
    return exitCode
  } catch (error) {
    await Promise.all(running.map((service) => stopService(service).catch(() => undefined)))
    return fail(deps, `测试记录写入失败: ${errMsg(error)}`)
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    for (const marker of claimed) await releaseRunningMarker(marker)
  }
}
