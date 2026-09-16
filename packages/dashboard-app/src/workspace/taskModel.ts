import type { WbIoSlot, WbStepIo } from '../api/governanceTypes'
import { changeWorkflowName } from '../model/progressModel'
import { snapshotRulesKey, type WorkflowRules } from '../model/workflowModel'
import { isProjectNavigable } from '../state/projectSelectionModel'
import type { ArchivedChangeSnapshot, ChangeSnapshot, Snapshot, UserRefView } from '../types'

export type Tr = (key: string, vars?: Record<string, string | number>) => string

export type StageStatus = 'done' | 'current' | 'todo'

export interface StageState {
  id: string
  label: string
  status: StageStatus
}

/** 一行由数据推出的状态：缺产出 / 评审待确认 / 可进入下一阶段 / 进行中 / 已完结。 */
export type TaskSummary =
  | { kind: 'missing'; slot: WbIoSlot }
  | { kind: 'review' }
  | { kind: 'ready'; to: string }
  | { kind: 'running' }
  | { kind: 'completed' }

export interface TaskRow {
  key: string
  root: string
  change: ChangeSnapshot
  rules: WorkflowRules | undefined
  workflow: string
  archived: boolean
  /** Owner projected by the server; null for legacy values. */
  owner: UserRefView | null
  stages: StageState[]
  summary: TaskSummary
  /** 只有已归档视图的行才有：归档时的阶段、时间与归档人。 */
  archive?: ArchivedChangeSnapshot['archive']
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

/** 阶段名只显示一个：定义里的 label（服务端已投影进 labelByStep），没有就是 id；不做前端翻译。 */
export function stageLabel(step: string, rules: WorkflowRules | undefined, _t?: Tr): string {
  return rules?.labelByStep?.[step] || step
}

/** 槽位展示名 = 定义里的 id 本身（文档 kind / 字段名），不做前端翻译。 */
export function slotLabel(slot: Pick<WbIoSlot, 'kind' | 'id'>, _t?: Tr): string {
  return slot.id
}


export function stagesOf(change: ChangeSnapshot, rules: WorkflowRules | undefined, t: Tr): StageState[] {
  const steps = rules?.steps ?? change.workflowRules.steps
  const projected = new Map((change.todo?.stages ?? []).map((stage) => [stage.id, stage.status]))
  const current = steps.indexOf(change.phase)
  // A closed run keeps its last phase, but nothing is in progress: the stage it completed from is done.
  const archived = change.archived === 'true'
  return steps.map((id, index) => {
    const fromTodo = projected.get(id)
    const status: StageStatus = fromTodo === 'done' ? 'done'
      : fromTodo === 'pending' ? 'todo'
        : fromTodo === 'current' ? 'current'
          : current === -1 ? 'todo'
            : index < current ? 'done' : index > current ? 'todo' : 'current'
    return { id, label: stageLabel(id, rules, t), status: archived && status === 'current' ? 'done' : status }
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
  if (change.archived === 'true') return { kind: 'completed' }
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
    case 'completed': return t('workspace.summary_completed')
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
        owner: change.owner,
        stages: stagesOf(change, rules, t),
        summary: summaryOf(change, rules, ioOf(project.root, workflow)?.[change.phase]),
      })
    }
  }
  rows.sort((left, right) => Number(left.archived) - Number(right.archived) || right.change.updated_at.localeCompare(left.change.updated_at))
  return rows
}

/** 已归档视图的行：与活跃行同构，另带归档时的阶段 / 时间 / 归档人。 */
export function archivedRowsOf({ snapshot, currentRoot, rulesByKey, t }: Omit<RowsInput, 'ioOf'>): TaskRow[] {
  const rows: TaskRow[] = []
  for (const project of snapshot?.projects ?? []) {
    if (!isProjectNavigable(project)) continue
    if (currentRoot !== '' && project.root !== currentRoot) continue
    for (const change of project.archived ?? []) {
      const rules = rulesByKey.get(snapshotRulesKey(project.root, change.workflowPlanFingerprint)) ?? change.workflowRules
      rows.push({
        key: rowKey(project.root, change.name),
        root: project.root,
        change,
        rules,
        workflow: changeWorkflowName(change),
        archived: change.archived === 'true',
        owner: change.owner,
        stages: stagesOf(change, rules, t),
        // The archived view never judges readiness: an outputs check would need IO that is not loaded here.
        summary: change.archived === 'true' ? { kind: 'completed' } : { kind: 'running' },
        archive: change.archive,
      })
    }
  }
  rows.sort((left, right) => (right.archive?.archivedAt ?? '').localeCompare(left.archive?.archivedAt ?? ''))
  return rows
}

/** 未提交删除总数（当前项目范围内）；没有任何项目上报时为 0。 */
export function uncommittedDeletionsOf(snapshot: Snapshot | null, currentRoot: string): number {
  let total = 0
  for (const project of snapshot?.projects ?? []) {
    if (currentRoot !== '' && project.root !== currentRoot) continue
    total += project.uncommittedDeletions ?? 0
  }
  return total
}

export interface TaskFilterState {
  /** 'all' 或负责人 slug。 */
  owner: string
  /** 'all' 或工作流名。 */
  workflow: string
  /** 'all' 或轨道 id。 */
  track: string
  /** 'all' 或阶段 id；只有选定单一工作流时才有意义。 */
  stage: string
  /** 含已完结（工作流最后一步）；与归档（对我隐藏）是两回事。 */
  includeCompleted: boolean
}

export const DEFAULT_TASK_FILTER: TaskFilterState = { owner: 'all', workflow: 'all', track: 'all', stage: 'all', includeCompleted: false }

function matches(row: TaskRow, filter: TaskFilterState, ignore?: keyof TaskFilterState): boolean {
  if (!filter.includeCompleted && row.archived) return false
  if (ignore !== 'owner' && filter.owner !== 'all' && row.owner?.slug !== filter.owner) return false
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
  /** Owner chips keyed by slug, labelled by name. */
  owners: FacetChip[]
  workflows: FacetChip[]
  tracks: FacetChip[]
  /** 只在选定单一工作流时非 null：该工作流自己的阶段序。 */
  stages: FacetChip[] | null
}

/** 三层 facet 的候选与计数：每层计数受其它两层与归档开关约束。 */
export function taskFacets(rows: readonly TaskRow[], filter: TaskFilterState): TaskFacets {
  const workflowNames: string[] = []
  const trackIds: string[] = []
  const ownerRefs: UserRefView[] = []
  for (const row of rows) {
    if (row.owner !== null && !ownerRefs.some((ref) => ref.slug === row.owner?.slug)) ownerRefs.push(row.owner)
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
  const owners = ownerRefs.map((ref) => ({
    id: ref.slug,
    label: ref.name,
    count: rows.filter((row) => row.owner?.slug === ref.slug && matches(row, filter, 'owner')).length,
  }))
  // 阶段只在「单一工作流 + 单一轨道」下可比（每条轨道分支各有自己的阶段）；只有一条时直接可用，不必先点它。
  const effectiveWorkflow = filter.workflow !== 'all' ? filter.workflow : workflowNames.length === 1 ? workflowNames[0] : undefined
  if (effectiveWorkflow === undefined) return { owners, workflows, tracks, stages: null }
  const scopedTracks = [...new Set(rows.filter((row) => row.workflow === effectiveWorkflow).map((row) => row.change.track))]
  const effectiveTrack = filter.track !== 'all' ? filter.track : scopedTracks.length <= 1 ? (scopedTracks[0] ?? '') : undefined
  if (effectiveTrack === undefined) return { owners, workflows, tracks, stages: null }
  const sample = rows.find((row) => row.workflow === effectiveWorkflow && (effectiveTrack === '' || row.change.track === effectiveTrack))
  const stages = (sample?.stages ?? []).map((stage) => ({
    id: stage.id,
    label: stage.label,
    count: rows.filter((row) => row.change.phase === stage.id && matches(row, filter, 'stage')).length,
  }))
  return { owners, workflows, tracks, stages }
}

/** 某层「全部」芯片的计数 = 忽略该层后命中的任务数。 */
export function facetTotal(rows: readonly TaskRow[], filter: TaskFilterState, facet: 'owner' | 'workflow' | 'track' | 'stage'): number {
  return rows.filter((row) => matches(row, filter, facet)).length
}
