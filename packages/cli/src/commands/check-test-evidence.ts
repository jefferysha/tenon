/**
 * `tenon check` 的测试证据预览：与转换拦截同一份判定，只渲染、不写盘。
 */
import { evaluateTestEvidence, type EffectiveWorkflowPlan, type PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'
import { testEvidenceContextFor } from '../testEvidenceContext.js'

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
): Promise<readonly string[]> {
  const stepId = str(state.fields.phase)
  const report = await evaluateTestEvidence({
    repoRoot: deps.cwd,
    changeDir: dir,
    changeName: name,
    plan,
    stepId,
    context: testEvidenceContextFor(deps, name),
  })
  return report.blockers
}
