/**
 * `tenon test integrity <change> [--step <id>] [--json]` —— 测试完整性报告：相对任务起点，证据有没有变弱。
 *
 * 十种信号（kernel integrity.ts）：全量运行的用例数下降 / 跳过数上升，测试文件被删、用例变少、新增跳过标记、断言变少，
 * 快照改写，基线改动，已知失败新增，覆盖率门槛降低。策略 `integrity: notice`（缺省）只提示，`block` 让信号挡住出口
 * （exit 2，与 `test status` 同口径）；没有策略的步骤按 notice 展示。读不出改动行时运行记录类信号照常给出，其余标 unavailable。
 */
import {
  INTEGRITY_SIGNAL_LABELS, loadIntegrityReport, type IntegrityMode, type TestIntegrityReport,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { localeOf, msg } from '../i18n/messages.js'
import { str } from '../render.js'
import { integrityDiffFor } from '../testEvidenceContext.js'
import { resolveTestCommand } from './test-context.js'

function lines(deps: CliDeps, change: string, stepId: string, report: TestIntegrityReport): readonly string[] {
  const locale = localeOf(deps)
  const out = [`[INTEGRITY] ${change} step=${stepId} mode=${report.mode} signals=${report.signals.length}`]
  for (const signal of report.signals) {
    out.push(`  ${INTEGRITY_SIGNAL_LABELS[signal.code][locale]} ${signal.subject} ${signal.detail}${signal.suite === undefined ? '' : ` [${signal.suite}]`}`)
  }
  if (report.state === 'unavailable') {
    out.push(`  [WARN] ${msg(deps, 'integrity.unavailable', { reason: report.reason ?? msg(deps, 'integrity.reasonUnknown') })}`)
  }
  if (report.truncated !== undefined) {
    out.push(`  [WARN] ${msg(deps, 'integrity.truncated', { found: report.truncated.found, limit: report.truncated.limit })}`)
  }
  return out
}

export async function cmdTestIntegrity(
  deps: CliDeps,
  change: string,
  opts: { readonly step?: string; readonly json?: boolean } = {},
): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: false })
  if (typeof context === 'number') return context
  const stepId = opts.step ?? str(context.state.fields.phase)
  const step = context.plan.workflow.steps.find((item) => item.id === stepId)
  if (step === undefined) {
    deps.io.err(`ERROR: ${msg(deps, 'integrity.stepNotInWorkflow', { step: stepId, workflow: context.plan.id })}`)
    return 1
  }
  const mode: IntegrityMode = step.test_policy?.integrity === 'block' ? 'block' : 'notice'
  let report: TestIntegrityReport
  try {
    report = await loadIntegrityReport({
      repoRoot: deps.cwd,
      changeDir: context.dir,
      changeName: change,
      slug: context.slug,
      mode,
      integrityDiff: integrityDiffFor(deps, change),
    })
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  const blocked = mode === 'block' && (report.signals.length > 0 || report.state === 'unavailable')
  if (opts.json === true) {
    deps.io.out(JSON.stringify({ change, step: stepId, pass: !blocked, ...report }, null, 2))
  } else {
    for (const line of lines(deps, change, stepId, report)) deps.io.out(line)
  }
  return blocked ? 2 : 0
}
