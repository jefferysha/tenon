import type { FlowStage } from '../api/workflowOrchestrationClient'
import type { BuiltinLabels } from '../i18n/builtinLabels'

/**
 * 画布上的名字：内置工作流里没被改过的阶段名、出厂测试项名按界面语言显示（i18n builtin.*），其余原样。
 * 只换 label：id、顺序、状态都不动；没有任何名字需要换时返回原数组（不让布局白白重算）。
 */
export function localizeStages(stages: readonly FlowStage[], workflow: string | null | undefined, builtin: BuiltinLabels): readonly FlowStage[] {
  let changed = false
  const next = stages.map((stage): FlowStage => {
    const label = builtin.step(workflow, stage.id, stage.label)
    let entriesChanged = false
    const entries = stage.entries.map((entry) => {
      if (entry.kind !== 'test' || entry.testKind !== undefined) return entry
      const shown = builtin.direction(entry.id, entry.label)
      if (shown === entry.label) return entry
      entriesChanged = true
      return { ...entry, label: shown }
    })
    if (label === stage.label && !entriesChanged) return stage
    changed = true
    return { ...stage, label, entries: entriesChanged ? entries : stage.entries }
  })
  return changed ? next : stages
}
