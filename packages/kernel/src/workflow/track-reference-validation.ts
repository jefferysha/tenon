import type { TrackPredicate } from './predicates.js'
import type { WorkflowDef } from './types.js'
import { workflowBranches } from './validate.js'

/**
 * 校验工作流里所有 TrackPredicate 只引用本工作流真实存在的轨道（`tracks.<id>` 分支）。轨道只是工作流的分支，
 * 没有独立的登记表，所以「真实存在」就是这份定义自己的分支 id。
 * 结构/值域仍由 validateWorkflow/compileWorkflow 负责；本函数只补它们无法独立知道的引用事实。
 * 平铺工作流（没有 `tracks:`）没有轨道可引用，谓词无从核对，不查。
 */
export function validateWorkflowTrackReferences(wf: WorkflowDef): string[] {
  const errors: string[] = []
  const branches = workflowBranches(wf)
  if (branches.every((branch) => branch.implicit)) return errors
  const known = new Set(branches.map((branch) => branch.track))
  const check = (predicate: TrackPredicate | undefined, path: string): void => {
    if (predicate === undefined) return
    predicate.values.forEach((track, index) => {
      if (!known.has(track)) errors.push(`${path}.values[${index}]: 未知 track '${track}'`)
    })
  }

  for (const branch of branches) {
    const base = `workflow.tracks.${branch.track}.steps`
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
