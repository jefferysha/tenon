import type { UserRefView } from '../types'
import type { EndedRow } from './endedModel'
import { statusOf, type TaskRow } from './taskModel'

/** 状态筛选：由 summary.kind 映射，不另起判定；「已结束」= 已归档的任务 + 已完结但还没移走的活跃任务。 */
export type TaskStatus = 'all' | 'needs-you' | 'running' | 'ended'
// 'needs-you' 与 shell/views.NEEDS_YOU_STATUS（顶部徽标跳转）是同一个值。
export const TASK_STATUSES: readonly TaskStatus[] = ['all', 'needs-you', 'running', 'ended']

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

export interface TaskFilterState {
  /** 状态芯片；已结束只在「已结束」与「全部」里出现。 */
  status: TaskStatus
  /** 'all' 或负责人 slug。 */
  owner: string
  /** 'all' 或工作流名。 */
  workflow: string
  /** 'all' 或轨道 id。 */
  track: string
  /** 'all' 或阶段 id；只有选定单一工作流时才有意义。 */
  stage: string
}

export const DEFAULT_TASK_FILTER: TaskFilterState = { status: 'all', owner: 'all', workflow: 'all', track: 'all', stage: 'all' }

/** 活跃行与已结束行在各筛选维度上的共同视图；已结束的任务没有阶段，负责人只有显示名，所以这两维选了就不命中。 */
interface Facettable {
  readonly status: Exclude<TaskStatus, 'all'>
  readonly ownerSlug: string | null
  readonly workflow: string
  readonly track: string
  readonly phase: string | null
}

function viewOfRow(row: TaskRow): Facettable {
  return { status: statusOf(row.summary), ownerSlug: row.owner?.slug ?? null, workflow: row.workflow, track: row.change.track, phase: row.change.phase }
}

function viewOfEnded(row: EndedRow): Facettable {
  return { status: 'ended', ownerSlug: null, workflow: row.task.workflow, track: row.task.track, phase: null }
}

function matches(view: Facettable, filter: TaskFilterState, ignore?: keyof TaskFilterState): boolean {
  if (ignore !== 'status' && filter.status !== 'all' && view.status !== filter.status) return false
  if (ignore !== 'owner' && filter.owner !== 'all' && view.ownerSlug !== filter.owner) return false
  if (ignore !== 'workflow' && filter.workflow !== 'all' && view.workflow !== filter.workflow) return false
  if (ignore !== 'track' && filter.track !== 'all' && view.track !== filter.track) return false
  if (ignore !== 'stage' && filter.stage !== 'all' && view.phase !== filter.stage) return false
  return true
}

/** 各状态芯片的计数：受其它维度约束，忽略状态本身。 */
export function statusCounts(rows: readonly TaskRow[], filter: TaskFilterState, ended: readonly EndedRow[] = []): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { all: 0, 'needs-you': 0, running: 0, ended: 0 }
  for (const view of [...rows.map(viewOfRow), ...ended.map(viewOfEnded)]) {
    if (!matches(view, filter, 'status')) continue
    counts.all += 1
    counts[view.status] += 1
  }
  return counts
}

export function filterRows(rows: readonly TaskRow[], filter: TaskFilterState): TaskRow[] {
  return rows.filter((row) => matches(viewOfRow(row), filter))
}

export function filterEnded(ended: readonly EndedRow[], filter: TaskFilterState): EndedRow[] {
  return ended.filter((row) => matches(viewOfEnded(row), filter))
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

/** 各维度的候选与计数：每个维度的计数受其它维度约束。 */
export function taskFacets(rows: readonly TaskRow[], filter: TaskFilterState, ended: readonly EndedRow[] = []): TaskFacets {
  const views = [...rows.map(viewOfRow), ...ended.map(viewOfEnded)]
  const workflowNames: string[] = []
  const trackIds: string[] = []
  const ownerRefs: UserRefView[] = []
  for (const row of rows) {
    if (row.owner !== null && !ownerRefs.some((ref) => ref.slug === row.owner?.slug)) ownerRefs.push(row.owner)
  }
  for (const view of views) {
    if (!workflowNames.includes(view.workflow)) workflowNames.push(view.workflow)
    if (view.track !== '' && !trackIds.includes(view.track)) trackIds.push(view.track)
  }
  const workflows = workflowNames.map((name) => ({
    id: name,
    label: name,
    count: views.filter((view) => view.workflow === name && matches(view, filter, 'workflow')).length,
  }))
  const tracks = trackIds.map((id) => ({
    id,
    label: id,
    count: views.filter((view) => view.track === id && matches(view, filter, 'track')).length,
  }))
  const owners = ownerRefs.map((ref) => ({
    id: ref.slug,
    label: ref.name,
    count: views.filter((view) => view.ownerSlug === ref.slug && matches(view, filter, 'owner')).length,
  }))
  // 阶段只在「单一工作流 + 单一轨道」下可比（每条轨道分支各有自己的阶段）；只有一条时直接可用，不必先点它。
  const effectiveWorkflow = filter.workflow !== 'all' ? filter.workflow : workflowNames.length === 1 ? workflowNames[0] : undefined
  if (effectiveWorkflow === undefined) return { owners, workflows, tracks, stages: null }
  const scopedTracks = [...new Set(views.filter((view) => view.workflow === effectiveWorkflow).map((view) => view.track))]
  const effectiveTrack = filter.track !== 'all' ? filter.track : scopedTracks.length <= 1 ? (scopedTracks[0] ?? '') : undefined
  if (effectiveTrack === undefined) return { owners, workflows, tracks, stages: null }
  const sample = rows.find((row) => row.workflow === effectiveWorkflow && (effectiveTrack === '' || row.change.track === effectiveTrack))
  const stages = (sample?.stages ?? []).map((stage) => ({
    id: stage.id,
    label: stage.label,
    count: views.filter((view) => view.phase === stage.id && matches(view, filter, 'stage')).length,
  }))
  return { owners, workflows, tracks, stages }
}

/** 某层「全部」芯片的计数 = 忽略该层后命中的任务数。 */
export function facetTotal(rows: readonly TaskRow[], filter: TaskFilterState, facet: keyof TaskFilterState, ended: readonly EndedRow[] = []): number {
  return [...rows.map(viewOfRow), ...ended.map(viewOfEnded)].filter((view) => matches(view, filter, facet)).length
}
