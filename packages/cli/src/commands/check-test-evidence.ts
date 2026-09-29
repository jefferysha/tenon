/**
 * `tenon check` 的测试证据预览：与转换拦截同一份判定，只渲染、不写盘。
 */
import { renderTestBlocker, type EffectiveWorkflowPlan, type PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'

/**
 * The same test evidence the transition enforces. Previewing it in `check` keeps a missing or stale
 * record visible before a gated transition turns it into the first explanation of the problem.
 */
export async function stepTestBlockers(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  options: { readonly releasePendingWaivers?: boolean } = {},
): Promise<readonly string[]> {
  const stepId = str(state.fields.phase)
  const report = await testEvidenceReaderFor(deps)({
    repoRoot: deps.cwd,
    changeDir: dir,
    changeName: name,
    plan,
    stepId,
    context: testEvidenceContextFor(deps, name),
  })
  // 策略判定存在时 report.blockers 就是它的阻塞项逐条渲染；豁免待批准的那些在 review request 里放行。
  if (options.releasePendingWaivers === true && report.policy !== undefined) {
    return report.policy.blockers
      .filter((item) => item.blocking && item.code !== 'waiver-unapproved')
      .map(renderTestBlocker)
  }
  return report.blockers
}
