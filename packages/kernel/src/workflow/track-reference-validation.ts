import type { TrackRegistry } from '../tracks/types.js'
import type { TrackPredicate } from './predicates.js'
import type { WorkflowDef } from './types.js'
import { workflowBranches } from './validate.js'

/**
 * 校验 custom workflow 内所有 TrackPredicate 只引用当前 effective registry 中真实存在的 track。
 * 结构/值域仍由 validateWorkflow/compileWorkflow 负责；本函数只补它们无法独立知道的项目级引用事实。
 */
export function validateWorkflowTrackReferences(wf: WorkflowDef, registry: TrackRegistry): string[] {
  const errors: string[] = []
  const check = (predicate: TrackPredicate | undefined, path: string): void => {
    if (predicate === undefined) return
    predicate.values.forEach((track, index) => {
      if (!registry.byId.has(track)) errors.push(`${path}.values[${index}]: 未知 track '${track}'`)
    })
  }

  // 通用分支与每条 track 分支同样检查；分支 id 本身不要求已在 registry 登记（可只在工作流 YAML 里定义）。
  for (const branch of workflowBranches(wf)) {
    const base = branch.track === '' ? 'workflow.steps' : `workflow.tracks.${branch.track}.steps`
    branch.steps.forEach((step, stepIndex) => {
      step.guards.forEach((guard, guardIndex) => {
        check(guard.when, `${base}[${stepIndex}].guards[${guardIndex}].when`)
      })
      step.transitions.forEach((transition, transitionIndex) => {
        ;(transition.guards ?? []).forEach((guard, guardIndex) => {
          check(guard.when, `${base}[${stepIndex}].transitions[${transitionIndex}].guards[${guardIndex}].when`)
        })
      })
      ;(step.artifacts ?? []).forEach((artifact, artifactIndex) => {
        check(artifact.requiredWhen, `${base}[${stepIndex}].artifacts[${artifactIndex}].requiredWhen`)
      })
    })
  }

  return errors
}
