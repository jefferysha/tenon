/**
 * `tenon test status <change> [--step <id>] [--json]` —— 当前步骤每项测试的状态、耗时、最近执行时间。
 * 判定与转换拦截同一份 evaluateTestEvidence，所以这里看到的通过就是转换会放行的通过。
 *
 * 已完结的 change（`archived=true`）没有「当前步骤」可拦：它停在终态步骤上，那一步不声明测试，
 * 按当前步骤查只会得到空的 items（真机：归档后只有 `test report` 看得到记录）。不带 `--step` 时
 * 改为按步骤列出每项测试的最后记录，并点名完整报告的命令；什么也不拦，exit 0。
 */
import { testStatusWord, type TestEvidenceItem, type TestEvidenceReport } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import { resolveTestCommand, type TestCommandContext } from './test-context.js'

interface StepItem {
  readonly stepId: string
  readonly item: TestEvidenceItem
}

function itemJson(entry: StepItem, withStep: boolean): Record<string, unknown> {
  const { item } = entry
  return {
    ...(withStep ? { step: entry.stepId } : {}),
    id: item.test.id,
    ...(item.test.label === undefined ? {} : { label: item.test.label }),
    direction: item.test.direction,
    required: item.test.required,
    status: item.status,
    ...(item.run === undefined ? {} : {
      run: {
        run_id: item.run.run_id,
        result: item.run.result,
        finished_at: item.run.finished_at,
        duration_ms: item.run.duration_ms,
        reasons: item.run.reasons.map((reason) => reason.code),
      },
    }),
  }
}

function itemLine(entry: StepItem, withStep: boolean): string {
  const { item } = entry
  const duration = item.run === undefined ? '—' : `${(item.run.duration_ms / 1000).toFixed(1)}s`
  const actor = item.run?.actor.name ?? '—'
  return `  ${withStep ? `${entry.stepId} ` : ''}${testStatusWord(item.status)} ${item.test.id} ${item.test.label ?? item.test.id}`
    + ` ${duration} ${item.run?.finished_at ?? '—'} ${actor}`
}

async function reportFor(deps: CliDeps, context: TestCommandContext, stepId: string): Promise<TestEvidenceReport> {
  return testEvidenceReaderFor(deps)({
    repoRoot: deps.cwd,
    changeDir: context.dir,
    changeName: context.name,
    plan: context.plan,
    stepId,
    context: testEvidenceContextFor(deps, context.name),
  })
}

/** 已完结：每个声明了测试的步骤各一份判定，只取它们的最后记录展示。 */
async function finishedStatus(deps: CliDeps, context: TestCommandContext, json: boolean): Promise<number> {
  const entries: StepItem[] = []
  for (const step of context.plan.workflow.steps) {
    if ((step.tests ?? []).length === 0) continue
    const report = await reportFor(deps, context, step.id)
    entries.push(...report.items.map((item) => ({ stepId: step.id, item })))
  }
  const hint = `tenon test report ${context.name}`
  if (json) {
    deps.io.out(JSON.stringify({
      change: context.name,
      step: null,
      finished: true,
      items: entries.map((entry) => itemJson(entry, true)),
      report: hint,
    }, null, 2))
    return 0
  }
  deps.io.out(`[TEST] ${context.name} 已完结：各步骤测试的最后记录（完整报告：${hint}）`)
  if (entries.length === 0) deps.io.out('  （工作流没有声明测试）')
  for (const entry of entries) deps.io.out(itemLine(entry, true))
  return 0
}

export async function cmdTestStatus(
  deps: CliDeps,
  change: string,
  opts: { readonly step?: string; readonly json?: boolean } = {},
): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: false })
  if (typeof context === 'number') return context
  try {
    if (opts.step === undefined && str(context.state.fields.archived) === 'true') {
      return await finishedStatus(deps, context, opts.json === true)
    }
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  const stepId = opts.step ?? str(context.state.fields.phase)
  if (context.plan.workflow.steps.every((step) => step.id !== stepId)) {
    deps.io.err(`ERROR: step '${stepId}' 不在 workflow '${context.plan.id}' 里`)
    return 1
  }
  let report: TestEvidenceReport
  try {
    report = await reportFor(deps, context, stepId)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  const entries = report.items.map((item) => ({ stepId, item }))
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      change,
      step: stepId,
      pass: report.pass,
      items: entries.map((entry) => itemJson(entry, false)),
      blockers: report.blockers,
    }, null, 2))
    return report.pass ? 0 : 2
  }
  deps.io.out(`[TEST] ${change} step=${stepId}`)
  for (const entry of entries) deps.io.out(itemLine(entry, false))
  for (const blocker of report.blockers) deps.io.out(`  [FAIL] test: ${blocker}`)
  return report.pass ? 0 : 2
}
