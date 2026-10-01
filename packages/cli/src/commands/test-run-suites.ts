/**
 * `tenon test run <change> [--suite <id>…] [--kind <k>…] [--stage [<step>]] [--all] [--changed] [--json]`
 * —— 批量执行目录套件并写一份运行记录 v2（哈希链）。没有任何选择参数时缺省就是 --stage。
 *
 * 只跑目录套件：旧的步骤内联测试（`tests[]`，套件 id 以 `step:` 开头）仍走 `tenon test run <change> <test-id>`
 * （v1 记录、按用户），--stage 不碰它们，只在摘要里提醒还有哪些没跑。
 *
 * 本文件只做命令层的事：解析参数、规划运行集、交给 executeRun 编排、打印摘要与出口检查、映射退出码。
 * 退出码：0 全部通过（或本阶段没有目录套件要跑），2 有失败（记录已写），1 用法 / 环境错误（没有记录）。
 */
import { relative } from 'node:path'
import { readTestPlanState, type TestCatalog } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import type { RunItem } from '../test-system/exec-types.js'
import { readCatalogFile, readKnownFailuresFile } from '../test-system/project-files.js'
import { RunBusyError, executeRun, type RunResult } from '../test-system/run-orchestrator.js'
import { planRunSet } from '../test-system/run-set.js'
import { noticeLines, serviceLines, suiteLines } from '../test-system/run-summary.js'
import { resolveTestCommand, type TestCommandContext } from './test-context.js'
import { catalogTrustTarget, ensureTrusted } from './test-trust.js'

export interface RunSuitesOptions {
  readonly suite?: readonly string[]
  readonly kind?: readonly string[]
  readonly stage?: string | boolean
  readonly all?: boolean
  readonly changed?: boolean
  readonly json?: boolean
}

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

interface Gate {
  readonly pass: boolean
  readonly lines: readonly string[]
  readonly blockers: readonly unknown[]
}

/** 运行后重算一次本步骤的出口检查，告诉调用方「还差什么」（与 transition 同一份判定）。 */
async function gateAfter(deps: CliDeps, context: TestCommandContext, change: string, stepId: string): Promise<Gate> {
  try {
    const report = await testEvidenceReaderFor(deps)({
      repoRoot: deps.cwd, changeDir: context.dir, changeName: change, plan: context.plan, stepId,
      context: testEvidenceContextFor(deps, change),
    })
    const blocking = (report.policy?.blockers ?? []).filter((item) => item.blocking)
    if (report.pass) return { pass: true, lines: [`  出口检查（${stepId}）：通过`], blockers: [] }
    const listed = blocking.slice(0, 8).flatMap((item) => [`    [${item.code}] ${item.message}`, ...(item.fix === undefined ? [] : [`      → ${item.fix}`])])
    return { pass: false, lines: [`  出口检查（${stepId}）：还差 ${report.blockers.length} 项`, ...listed], blockers: blocking }
  } catch (error) {
    return { pass: false, lines: [`  出口检查无法计算：${errMsg(error)}`], blockers: [] }
  }
}

function printResult(deps: CliDeps, change: string, result: RunResult, gate: Gate, recordPath: string): void {
  const { record } = result.appended
  deps.io.out(`[TEST] ${change} 结果：${record.result === 'pass' ? '通过' : '失败'}（${(record.duration_ms / 1000).toFixed(1)}s，机器画像 ${result.profile.label}）`)
  for (const outcome of result.outcomes) {
    for (const line of suiteLines(record.suites.find((run) => run.suite === outcome.run.suite) ?? outcome.run)) deps.io.out(line)
    for (const note of outcome.notes) deps.io.out(`         注：${note}`)
  }
  for (const line of serviceLines(result.services)) deps.io.out(line)
  for (const line of noticeLines(result.outcomes.flatMap((outcome) => outcome.notices))) deps.io.out(line)
  if (result.appended.chain === 'reset') deps.io.out('  注意：旧记录链已断或来源不明（记录被改动、损坏，或不是本机 tenon test run 写下的），已另起新链，旧记录视为未运行')
  deps.io.out(`  记录：${recordPath}`)
  deps.io.out(`  产物：${relative(deps.cwd, result.runDir)}/`)
  for (const line of gate.lines) deps.io.out(line)
}

export async function cmdTestRunSuites(deps: CliDeps, change: string, opts: RunSuitesOptions): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: true })
  if (typeof context === 'number') return context
  if (context.state.runMetadata === undefined) return fail(deps, `任务 ${change} 还没有 workflow run（老任务），不能写测试记录 v2；先执行任意 tenon transition 或 tenon status`)
  const stepId = typeof opts.stage === 'string' ? opts.stage : str(context.state.fields.phase)
  const step = context.plan.workflow.steps.find((entry) => entry.id === stepId)
  if (step === undefined) return fail(deps, `step '${stepId}' 不在 workflow '${context.plan.id}' 里`)
  const catalogFile = await readCatalogFile(deps.cwd)
  if (catalogFile.state !== 'ok') return fail(deps, catalogFile.state === 'missing' ? '还没有测试目录；先 tenon test discover --write' : `catalog.yaml 无效：${catalogFile.issues.slice(0, 3).join('；')}`)
  const catalog: TestCatalog = catalogFile.catalog
  const planState = await readTestPlanState(context.dir, change)
  const flags = {
    suites: opts.suite ?? [], kinds: opts.kind ?? [], stage: opts.stage !== undefined && opts.stage !== false,
    all: opts.all === true, changed: opts.changed === true,
  }
  const stageMode = flags.stage || (flags.suites.length === 0 && flags.kinds.length === 0 && !flags.all)
  if ((stageMode || flags.kinds.length > 0 || flags.all) && planState.state === 'tampered') {
    return fail(deps, `测试计划不可信：${planState.reason}；执行 tenon test plan ${change} --seed`)
  }
  const known = await readKnownFailuresFile(deps.cwd)
  if (known.state === 'invalid') deps.io.err(`WARN: known-failures.yaml 无效，按空清单处理（失败不会被豁免）：${known.issues[0] ?? ''}`)

  const legacy = step.tests ?? []
  const legacyHint = legacy.length === 0 ? '' : `旧的步骤测试不在 --stage 里，逐个执行：${legacy.map((test) => `tenon test run ${change} ${test.id}`).join('；')}`
  if (stageMode && step.test_policy === undefined) {
    return fail(deps, `步骤 ${stepId} 没有 test_policy，没有目录套件的阶段运行集；用 --suite / --kind / --all 指定要跑的套件${legacyHint === '' ? '' : `。${legacyHint}`}`)
  }
  const set = planRunSet({ catalog, plan: planState.state === 'ok' ? planState.plan : undefined, policy: step.test_policy, flags, stepId, change })
  if ('error' in set) return fail(deps, set.error)
  if (set.items.length === 0) {
    const note = `${stepId} 阶段的策略没有要运行的目录套件${legacyHint === '' ? '' : `；${legacyHint}`}`
    if (opts.json === true) deps.io.out(JSON.stringify({ change, step: stepId, result: 'nothing-to-run', legacy: legacy.map((test) => test.id) }, null, 2))
    else deps.io.out(`[TEST] ${change} ${note}`)
    return 0
  }

  // 目录里的命令来自仓库：首次执行前需要用户在本机确认（R6）。未信任不执行任何命令、不写记录。
  if (!(await ensureTrusted(deps, context.slug, catalogTrustTarget(catalog), change))) return 1

  let result: RunResult
  try {
    result = await executeRun({
      deps, context, change, step, catalog, planState, knownFailures: known.state === 'ok' ? known.entries : [], items: set.items,
      announce: (runId) => {
        if (opts.json === true) return
        deps.io.out(`[TEST] ${change} run=${runId} step=${stepId}  ${set.items.length} 个套件`)
        for (const item of set.items) deps.io.out(`  · ${item.suite.id}  ${item.suite.kind}  scope=${item.scope}  $ ${item.suite.command}`)
      },
    })
  } catch (error) {
    return fail(deps, error instanceof RunBusyError ? error.message : `运行测试失败: ${errMsg(error)}`)
  }
  const gate = await gateAfter(deps, context, change, stepId)
  const recordPath = relative(deps.cwd, result.appended.path)
  const exitCode = result.appended.record.result === 'pass' ? 0 : 2
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      run_id: result.runId, change, step: stepId, result: result.appended.record.result, chain: result.appended.chain,
      record_path: recordPath, artifacts_dir: relative(deps.cwd, result.runDir), legacy: legacy.map((test) => test.id),
      gate: { pass: gate.pass, blockers: gate.blockers }, record: result.appended.record,
    }, null, 2))
    return exitCode
  }
  printResult(deps, change, result, gate, recordPath)
  if (stageMode && legacyHint !== '') deps.io.out(`  ${legacyHint}`)
  const denied = result.outcomes.find((outcome) => outcome.sandboxDenied)
  if (denied !== undefined) deps.io.err(`可能被宿主沙箱拦截：Codex 中用 sandbox_permissions=require_escalated 重新执行 tenon test run ${change}`)
  return exitCode
}
