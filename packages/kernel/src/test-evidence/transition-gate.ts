/**
 * 转换上的测试证据闸：离开一个声明了测试的步骤时，必需测试必须已通过且绑定当前候选版本。
 * 回退边（verify-fail、requirements-changed 一类）永不要求测试；隐式完结边的目标不在步骤序里，
 * 所以仍然要求。与文档证据同一条评估链，编排层只有一个调用点。
 */
import type { EffectiveWorkflowPlan } from '../workflow/effective-plan-types.js'
import { evaluateTestEvidence, type TestEvidenceContext } from './evaluate.js'

export interface TestEvidenceRejection {
  readonly kind: 'test-evidence-failed'
  readonly stepId: string
  readonly blockers: readonly string[]
}

function isBackwardStepEdge(plan: EffectiveWorkflowPlan, from: string, to: string): boolean {
  const ids = plan.workflow.steps.map((step) => step.id)
  const fromIndex = ids.indexOf(from)
  const toIndex = ids.indexOf(to)
  return fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex
}

export async function rejectOnTestEvidence(input: {
  readonly repoRoot: string
  readonly changeDir: string
  readonly changeName: string
  readonly plan: EffectiveWorkflowPlan
  readonly from: string
  readonly to: string
  readonly context: TestEvidenceContext | undefined
}): Promise<TestEvidenceRejection | undefined> {
  if (isBackwardStepEdge(input.plan, input.from, input.to)) return undefined
  const report = await evaluateTestEvidence({
    repoRoot: input.repoRoot,
    changeDir: input.changeDir,
    changeName: input.changeName,
    plan: input.plan,
    stepId: input.from,
    context: input.context,
  })
  return report.pass ? undefined : { kind: 'test-evidence-failed', stepId: input.from, blockers: report.blockers }
}
