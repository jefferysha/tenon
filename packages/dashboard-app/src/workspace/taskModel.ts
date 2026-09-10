import type { WbIoSlot, WbStepIo } from '../api/governanceTypes'
import { changeWorkflowName } from '../model/progressModel'
import { snapshotRulesKey, type WorkflowRules } from '../model/workflowModel'
import { isProjectNavigable } from '../state/projectSelectionModel'
import { isPhase, type ChangeSnapshot, type Snapshot } from '../types'

export type Tr = (key: string, vars?: Record<string, string | number>) => string

export type StageStatus = 'done' | 'current' | 'todo'

export interface StageState {
  id: string
  label: string
  status: StageStatus
}

/** 一行由数据推出的状态：缺产出 / 评审待确认 / 可进入下一阶段 / 进行中 / 已归档。 */
export type TaskSummary =
  | { kind: 'missing'; slot: WbIoSlot }
  | { kind: 'review' }
  | { kind: 'ready'; to: string }
  | { kind: 'running' }
  | { kind: 'archived' }

export interface TaskRow {
  key: string
  root: string
  change: ChangeSnapshot
  rules: WorkflowRules | undefined
  workflow: string
  archived: boolean
  stages: StageState[]
  summary: TaskSummary
}

export function rootBasename(root: string): string {
  const parts = root.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? root
}

export function fieldStr(change: ChangeSnapshot, key: string): string {
  const value = change.fields[key]
  return typeof value === 'string' ? value : ''
}

/** 字段未设：空串或老内核 heredoc 写下的字面 'null'。 */
export function isUnset(value: string): boolean {
  return value === '' || value === 'null'
}

export function stageLabel(step: string, rules: WorkflowRules | undefined, t: Tr): string {
  const custom = rules?.executionModel === 'phase-manifest' ? undefined : rules?.labelByStep?.[step]
  if (custom) return custom
  return isPhase(step) ? t(`phases.${step}`) : step
}

/** 槽位展示名：文档 kind 走 documents.*，字段走 fields.*；词典没有的动态 id 回落 id 本身。 */
export function slotLabel(slot: Pick<WbIoSlot, 'kind' | 'id'>, t: Tr): string {
  const key = slot.kind === 'document' ? `documents.${slot.id}` : `fields.${slot.id}`
  const label = t(key)
  return label === key ? slot.id : label
}

export function stagesOf(change: ChangeSnapshot, rules: WorkflowRules | undefined, t: Tr): StageState[] {
  const steps = rules?.steps ?? change.workflowRules.steps
  const projected = new Map((change.todo?.stages ?? []).map((stage) => [stage.id, stage.status]))
  const current = steps.indexOf(change.phase)
  return steps.map((id, index) => {
    const fromTodo = projected.get(id)
    const status: StageStatus = fromTodo === 'done' ? 'done'
      : fromTodo === 'pending' ? 'todo'
        : fromTodo === 'current' ? 'current'
          : current === -1 ? 'todo'
            : index < current ? 'done' : index > current ? 'todo' : 'current'
    return { id, label: stageLabel(id, rules, t), status }
  })
}

/** 当前阶段的第一个未就绪输出：文档看台账状态，值看字段是否已设。 */
export function firstMissingOutput(change: ChangeSnapshot, stepIo: WbStepIo | undefined): WbIoSlot | null {
  if (!stepIo) return null
  for (const slot of stepIo.outputs) {
    if (slot.kind === 'document') {
      const item = change.documents?.items.find((candidate) => candidate.kind === slot.id)
      if (!change.documents?.governed) continue
      if (item === undefined || item.status === 'missing' || item.status === 'stale') return slot
    } else if (isUnset(fieldStr(change, slot.id))) {
      return slot
    }
  }
  return null
}

export function summaryOf(change: ChangeSnapshot, rules: WorkflowRules | undefined, stepIo: WbStepIo | undefined): TaskSummary {
  if (change.archived === 'true') return { kind: 'archived' }
  const missing = firstMissingOutput(change, stepIo)
  if (missing !== null) return { kind: 'missing', slot: missing }
  if (change.reviewHandshake?.status === 'pending') return { kind: 'review' }
  const readiness = change.workflowExecution.readinessByTransition[change.phase] ?? {}
  const edges = rules?.transitions[change.phase] ?? change.workflowRules.transitions[change.phase] ?? []
  const steps = rules?.steps ?? change.workflowRules.steps
  const currentIndex = steps.indexOf(change.phase)
  for (const edge of edges) {
    const toIndex = steps.indexOf(edge.to)
    if (toIndex <= currentIndex) continue
    if (readiness[edge.event]?.ready === true) return { kind: 'ready', to: edge.to }
  }
  return { kind: 'running' }
}

export function summaryText(row: TaskRow, t: Tr): string {
  const stage = stageLabel(row.change.phase, row.rules, t)
  switch (row.summary.kind) {
    case 'archived': return t('workspace.summary_archived')
    case 'missing': return t('workspace.summary_missing', { stage, slot: slotLabel(row.summary.slot, t) })
    case 'review': return t('workspace.summary_review', { stage })
    case 'ready': return t('workspace.summary_ready', { stage, to: stageLabel(row.summary.to, row.rules, t) })
    case 'running': return t('workspace.summary_running', { stage })
  }
}

export interface RowsInput {
  snapshot: Snapshot | null
  currentRoot: string
  rulesByKey: ReadonlyMap<string, WorkflowRules>
  /** (root, workflow) → 物化 IO；缺失时 summary 不判缺产出。 */
  ioOf: (root: string, workflow: string) => Record<string, WbStepIo> | undefined
  t: Tr
}

export function rowKey(root: string, name: string): string {
  return `${name}@${root}`
}

export function rowsOf({ snapshot, currentRoot, rulesByKey, ioOf, t }: RowsInput): TaskRow[] {
  const rows: TaskRow[] = []
  for (const project of snapshot?.projects ?? []) {
    if (!isProjectNavigable(project)) continue
    if (currentRoot !== '' && project.root !== currentRoot) continue
    for (const change of project.changes) {
      const rules = rulesByKey.get(snapshotRulesKey(project.root, change.workflowPlanFingerprint)) ?? change.workflowRules
      const workflow = changeWorkflowName(change)
      rows.push({
        key: rowKey(project.root, change.name),
        root: project.root,
        change,
        rules,
        workflow,
        archived: change.archived === 'true',
        stages: stagesOf(change, rules, t),
        summary: summaryOf(change, rules, ioOf(project.root, workflow)?.[change.phase]),
      })
    }
  }
  rows.sort((left, right) => Number(left.archived) - Number(right.archived) || right.change.updated_at.localeCompare(left.change.updated_at))
  return rows
}

export interface TaskFilterState {
  /** 'all' 或工作流名。 */
  workflow: string
  /** 'all' 或轨道 id。 */
  track: string
  /** 'all' 或阶段 id；只有选定单一工作流时才有意义。 */
  stage: string
  includeArchived: boolean
}

export const DEFAULT_TASK_FILTER: TaskFilterState = { workflow: 'all', track: 'all', stage: 'all', includeArchived: false }

function matches(row: TaskRow, filter: TaskFilterState, ignore?: keyof TaskFilterState): boolean {
  if (!filter.includeArchived && row.archived) return false
  if (ignore !== 'workflow' && filter.workflow !== 'all' && row.workflow !== filter.workflow) return false
  if (ignore !== 'track' && filter.track !== 'all' && row.change.track !== filter.track) return false
  if (ignore !== 'stage' && filter.stage !== 'all' && row.change.phase !== filter.stage) return false
  return true
}

export function filterRows(rows: readonly TaskRow[], filter: TaskFilterState): TaskRow[] {
  return rows.filter((row) => matches(row, filter))
}

export interface FacetChip {
  id: string
  label: string
  count: number
}

export interface TaskFacets {
  workflows: FacetChip[]
  tracks: FacetChip[]
  /** 只在选定单一工作流时非 null：该工作流自己的阶段序。 */
  stages: FacetChip[] | null
}

/** 三层 facet 的候选与计数：每层计数受其它两层与归档开关约束。 */
export function taskFacets(rows: readonly TaskRow[], filter: TaskFilterState): TaskFacets {
  const workflowNames: string[] = []
  const trackIds: string[] = []
  for (const row of rows) {
    if (!workflowNames.includes(row.workflow)) workflowNames.push(row.workflow)
    if (row.change.track !== '' && !trackIds.includes(row.change.track)) trackIds.push(row.change.track)
  }
  const workflows = workflowNames.map((name) => ({
    id: name,
    label: name,
    count: rows.filter((row) => row.workflow === name && matches(row, filter, 'workflow')).length,
  }))
  const tracks = trackIds.map((id) => ({
    id,
    label: id,
    count: rows.filter((row) => row.change.track === id && matches(row, filter, 'track')).length,
  }))
  // 只有一条工作流时阶段行直接可用（不必先点它）；多条时必须先选定，阶段才可比。
  const effectiveWorkflow = filter.workflow !== 'all' ? filter.workflow : workflowNames.length === 1 ? workflowNames[0] : undefined
  if (effectiveWorkflow === undefined) return { workflows, tracks, stages: null }
  const sample = rows.find((row) => row.workflow === effectiveWorkflow)
  const stages = (sample?.stages ?? []).map((stage) => ({
    id: stage.id,
    label: stage.label,
    count: rows.filter((row) => row.change.phase === stage.id && matches(row, filter, 'stage')).length,
  }))
  return { workflows, tracks, stages }
}

/** 某层「全部」芯片的计数 = 忽略该层后命中的任务数。 */
export function facetTotal(rows: readonly TaskRow[], filter: TaskFilterState, facet: 'workflow' | 'track' | 'stage'): number {
  return rows.filter((row) => matches(row, filter, facet)).length
}
