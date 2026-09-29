import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'

/** 只改一个阶段：没有变化时原样返回同一个定义对象（引用不变，编辑器据此判断草稿是否改动）。 */
export function mapStep(def: WbWorkflowDef, stepId: string, update: (step: WbStepDef) => WbStepDef): WbWorkflowDef {
  let changed = false
  const steps = def.steps.map((step) => {
    if (step.id !== stepId) return step
    const next = update(step)
    if (next !== step) changed = true
    return next
  })
  return changed ? { ...def, steps } : def
}
