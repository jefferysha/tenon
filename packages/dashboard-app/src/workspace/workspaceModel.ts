import type { ChangeSnapshot, PipelineTodoItem, Snapshot } from '../types'
import { plannedTransition } from '../model/events'
import { stageArtifacts, type EvidenceChip } from '../model/evidence'
import { selectProgress, type ProgressRules, type ProgressState } from '../model/progressModel'
import type { WorkflowRules } from '../model/workflowModel'
import { stepLabel, toFlatRow, type FlatRow, type Tr } from './taskRows'

/** 中列状态页签：全部 / 需要你（待决定 + 受阻）/ 进行中 / 等待中（排队 + 等产出）/ 已归档。 */
export const TASK_FILTERS = ['all', 'need', 'running', 'waiting', 'archived'] as const
export type TaskFilter = (typeof TASK_FILTERS)[number]

export function taskFilterMatch(row: FlatRow, filter: TaskFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'archived') return row.archived
  if (row.archived) return false
  if (filter === 'need') return row.need
  if (filter === 'running') return row.row.state === 'running'
  return row.row.state === 'queued' || row.row.state === 'agent'
}

export function flatRowsOf(
  snapshot: Snapshot | null,
  currentRoot: string,
  rulesByKey: ReadonlyMap<string, WorkflowRules>,
): FlatRow[] {
  const out: FlatRow[] = []
  for (const group of selectProgress(snapshot, currentRoot, rulesByKey).groups) {
    for (const row of group.rows) out.push(toFlatRow(row, group.rules, group.workflow))
  }
  // 归档行排在全部活跃行之后：模板的「已完成」= 已归档留档，只读。
  for (const group of selectProgress(snapshot, currentRoot, rulesByKey).groups) {
    for (const row of group.archived) out.push(toFlatRow(row, group.rules, group.workflow, true))
  }
  return out
}

export type StageExecStatus = 'done' | 'current' | 'failed' | 'pending'

/**
 * 一枚产出 chip 是否「已产出」：路径型字段未设时带 unset 占位；三轨判定字段（*_result）未设时
 * 没有 unset 标记但 value 为空——两种情况都不算已产出，否则新建 change 会被数出 3 个「文件」。
 */
export function chipProduced(chip: EvidenceChip): boolean {
  return chip.unset !== true && chip.value !== ''
}

export interface StageExec {
  step: string
  label: string
  status: StageExecStatus
  gate: 'review' | 'confirm' | null
  /** 该阶段的产出字段（含未产出的占位 chip，unset=true）。 */
  outputs: EvidenceChip[]
  tasks: PipelineTodoItem[]
}

/**
 * 逐 stage 的执行状态：优先取 server 投影 `todo.stages[].status`，缺省按 phase 索引推；
 * failed 只落在当前阶段。产出走 stageArtifacts（与右列「产出」sheet 同源）。
 */
export function stageExecution(change: ChangeSnapshot, rules: ProgressRules | undefined, state: ProgressState, t: Tr): StageExec[] {
  if (!rules) return []
  const artifacts = stageArtifacts(rules, change)
  const todoByStage = new Map((change.todo?.stages ?? []).map((stage) => [stage.id, stage]))
  const curIdx = rules.steps.indexOf(change.phase)
  return rules.steps.map((step, index) => {
    const projected = todoByStage.get(step)?.status
    let status: StageExecStatus
    if (projected === 'done') status = 'done'
    else if (projected === 'pending') status = 'pending'
    else if (projected === 'current') status = state === 'failed' ? 'failed' : 'current'
    else if (curIdx === -1) status = 'pending'
    else if (index < curIdx) status = 'done'
    else if (index > curIdx) status = 'pending'
    else status = state === 'failed' ? 'failed' : 'current'
    return {
      step,
      label: stepLabel(step, rules, t),
      status,
      gate: rules.gateByStep[step] ?? null,
      outputs: artifacts[index]?.chips ?? [],
      tasks: todoByStage.get(step)?.tasks ?? [],
    }
  })
}

/** 阶段轨只画主流程段：末端 archive 是归档动作不是工作阶段，有别的段时不占一格。 */
export function railStages(stages: readonly StageExec[]): StageExec[] {
  const main = stages.filter((stage) => stage.step !== 'archive')
  return main.length > 0 ? main : [...stages]
}

/** 「下一步 · …」文案：首个前进边的目标阶段名；无前进边 = 已到末端。 */
export function nextStepLabel(change: ChangeSnapshot, rules: ProgressRules | undefined, t: Tr): string {
  if (!rules) return t('navigation.no_next_step')
  const forward = (rules.transitions[change.phase] ?? [])
    .map((edge) => plannedTransition(rules, change.phase, edge.to))
    .find((planned) => planned !== null && !planned.backward)
  return forward ? t('navigation.next_step', { step: stepLabel(forward.to, rules, t) }) : t('navigation.no_next_step')
}

/** 已登记产出数（documents 契约优先，否则数已产出的阶段字段）。 */
export function producedCount(change: ChangeSnapshot, rules: ProgressRules | undefined): number {
  if (change.documents?.governed) return change.documents.items.filter((item) => item.status !== 'missing').length
  if (!rules) return 0
  return stageArtifacts(rules, change).reduce((n, stage) => n + stage.chips.filter(chipProduced).length, 0)
}
