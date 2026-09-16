/**
 * `tenon test status <change> [--step <id>] [--json]` —— 当前步骤每项测试的状态、耗时、最近执行时间。
 * 判定与转换拦截同一份 evaluateTestEvidence，所以这里看到的通过就是转换会放行的通过。
 */
import { evaluateTestEvidence, testStatusWord, type TestEvidenceReport } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'
import { testEvidenceContextFor } from '../testEvidenceContext.js'
import { resolveTestCommand } from './test-context.js'

export async function cmdTestStatus(
  deps: CliDeps,
  change: string,
  opts: { readonly step?: string; readonly json?: boolean } = {},
): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: false })
  if (typeof context === 'number') return context
  const stepId = opts.step ?? str(context.state.fields.phase)
  if (context.plan.workflow.steps.every((step) => step.id !== stepId)) {
    deps.io.err(`ERROR: step '${stepId}' 不在 workflow '${context.plan.id}' 里`)
    return 1
  }
  let report: TestEvidenceReport
  try {
    report = await evaluateTestEvidence({
      repoRoot: deps.cwd,
      changeDir: context.dir,
      changeName: change,
      plan: context.plan,
      stepId,
      context: testEvidenceContextFor(deps, change),
    })
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      change,
      step: stepId,
      pass: report.pass,
      items: report.items.map((item) => ({
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
      })),
      blockers: report.blockers,
    }, null, 2))
    return report.pass ? 0 : 2
  }
  deps.io.out(`[TEST] ${change} step=${stepId}`)
  for (const item of report.items) {
    const duration = item.run === undefined ? '—' : `${(item.run.duration_ms / 1000).toFixed(1)}s`
    const actor = item.run?.actor.name ?? '—'
    deps.io.out(`  ${testStatusWord(item.status)} ${item.test.id} ${item.test.label ?? item.test.id}`
      + ` ${duration} ${item.run?.finished_at ?? '—'} ${actor}`)
  }
  for (const blocker of report.blockers) deps.io.out(`  [FAIL] test: ${blocker}`)
  return report.pass ? 0 : 2
}
