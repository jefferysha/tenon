import type { WbIoSlot } from '../api/governanceTypes'
import { changeWorkflowName, formatReadinessBlocker } from '../model/progressModel'
import { snapshotRulesKey, type WorkflowRules } from '../model/workflowModel'
import { isProjectNavigable } from '../state/projectSelectionModel'
import type { ArchivedChangeSnapshot, ChangeSnapshot, Snapshot, TransitionReadinessBlockerSnapshot, UserRefView } from '../types'

export type Tr = (key: string, vars?: Record<string, string | number>) => string

export type StageStatus = 'done' | 'current' | 'todo'

export interface StageState {
  id: string
  label: string
  status: StageStatus
}

/**
 * 一行的状态，只由快照推出（不读工作流定义，所以定义加载前后、所有项目与单项目视图里都一样）：
 * 评审待确认 / 前进出口有阻断 / 可进入下一阶段 / 进行中 / 已完结。
 */
export type TaskSummary =
  | { kind: 'review' }
  | { kind: 'blocked'; blockers: readonly string[] }
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

/** 阶段名只显示一个：冻结计划里的 label（服务端已投影进 labelByStep），没有就是 id；不做前端翻译。 */
export function stageLabel(step: string, rules: WorkflowRules | undefined, _t?: Tr): string {
  return rules?.labelByStep?.[step] || step
}

/** 槽位展示名 = 定义里的 id 本身（文档 kind / 字段名），不做前端翻译。 */
export function slotLabel(slot: Pick<WbIoSlot, 'kind' | 'id'>, _t?: Tr): string {
  return slot.id
}

function rulesOf(change: ChangeSnapshot, rules: WorkflowRules | undefined): WorkflowRules {
  return rules ?? change.workflowRules
}

/** 声明了出边、且只通向自己（或出边为空）的步骤是终点；规则里没有这一步的出边表时不下结论。 */
function isTerminal(rules: WorkflowRules, step: string): boolean {
  const edges = rules.transitions[step]
  return edges !== undefined && edges.every((edge) => edge.to === step)
}

/**
 * 阶段轨上的步骤：声明顺序里的第一个终点是主线结尾；其余终点（如 simple 的 Escalated）是旁路出口，
 * 不作为线性阶段格。
 */
export function linearSteps(rules: WorkflowRules): readonly string[] {
  const firstTerminal = rules.steps.find((step) => isTerminal(rules, step))
  return rules.steps.filter((step) => !isTerminal(rules, step) || step === firstTerminal)
}

export function stagesOf(change: ChangeSnapshot, rules: WorkflowRules | undefined, t: Tr): StageState[] {
  const all = rulesOf(change, rules)
  const steps = linearSteps(all)
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

/** 一条阻断的展示行：step-exit 用服务端文案；agent 阻断每个 agent 一行。 */
export function blockerLines(blocker: TransitionReadinessBlockerSnapshot): string[] {
  if (blocker.kind === 'agents-incomplete') return blocker.agents.map((item) => `${item.agent} · ${item.reason}`)
  return [formatReadinessBlocker(blocker)]
}

/**
 * 当前阶段的前进出口：任一出口 ready 即可前进；都不 ready 时取阻断最少的那个出口（并列按声明顺序），
 * 绝不把互斥出口的阻断合并成并集。没有前进出口时返回 null。
 */
export function forwardExitOf(change: ChangeSnapshot, rules: WorkflowRules | undefined): { to: string; ready: boolean; blockers: string[] } | null {
  const all = rulesOf(change, rules)
  const readiness = change.workflowExecution.readinessByTransition[change.phase] ?? {}
  const steps = all.steps
  const currentIndex = steps.indexOf(change.phase)
  const forward = (all.transitions[change.phase] ?? []).filter((edge) => steps.indexOf(edge.to) > currentIndex)
  if (forward.length === 0) return null
  const ready = forward.find((edge) => readiness[edge.event]?.ready === true)
  if (ready !== undefined) return { to: ready.to, ready: true, blockers: [] }
  let best: { to: string; ready: boolean; blockers: string[] } | null = null
  for (const edge of forward) {
    const blockers = (readiness[edge.event]?.blockers ?? []).flatMap(blockerLines)
    if (best === null || blockers.length < best.blockers.length) best = { to: edge.to, ready: false, blockers }
  }
  return best
}

export function summaryOf(change: ChangeSnapshot, rules: WorkflowRules | undefined): TaskSummary {
  if (change.archived === 'true') return { kind: 'completed' }
  if (change.reviewHandshake?.status === 'pending') return { kind: 'review' }
  const exit = forwardExitOf(change, rules)
  if (exit === null) return { kind: 'running' }
  if (exit.ready) return { kind: 'ready', to: exit.to }
  return exit.blockers.length === 0 ? { kind: 'running' } : { kind: 'blocked', blockers: exit.blockers }
}

/** 状态一词：不带阶段名（详情页阶段轨已写明阶段）。 */
export function summaryShort(row: TaskRow, t: Tr): string {
  switch (row.summary.kind) {
    case 'completed': return t('workspace.summary_completed')
    case 'review': return t('workspace.summary_review')
    case 'blocked': return t('workspace.summary_blocked', { n: row.summary.blockers.length })
    case 'ready': return t('workspace.summary_ready', { to: stageLabel(row.summary.to, row.rules, t) })
    case 'running': return t('workspace.summary_running')
  }
}

/** 任务卡上的状态：阶段 · 状态（已完结不带阶段）。 */
export function summaryText(row: TaskRow, t: Tr): string {
  const short = summaryShort(row, t)
  if (row.summary.kind === 'completed') return short
  return t('workspace.summary_with_stage', { stage: stageLabel(row.change.phase, row.rules, t), status: short })
}

export interface RowsInput {
  snapshot: Snapshot | null
  currentRoot: string
  rulesByKey: ReadonlyMap<string, WorkflowRules>
  t: Tr
}

export function rowKey(root: string, name: string): string {
  return `${name}@${root}`
}

function rowOf(root: string, change: ChangeSnapshot, rulesByKey: ReadonlyMap<string, WorkflowRules>, t: Tr): TaskRow {
  const rules = rulesByKey.get(snapshotRulesKey(root, change.workflowPlanFingerprint)) ?? change.workflowRules
  return {
    key: rowKey(root, change.name),
    root,
    change,
    rules,
    workflow: changeWorkflowName(change),
    archived: change.archived === 'true',
    owner: change.owner,
    stages: stagesOf(change, rules, t),
    summary: summaryOf(change, rules),
  }
}

export function rowsOf({ snapshot, currentRoot, rulesByKey, t }: RowsInput): TaskRow[] {
  const rows: TaskRow[] = []
  for (const project of snapshot?.projects ?? []) {
    if (!isProjectNavigable(project)) continue
    if (currentRoot !== '' && project.root !== currentRoot) continue
    for (const change of project.changes) rows.push(rowOf(project.root, change, rulesByKey, t))
  }
  rows.sort((left, right) => Number(left.archived) - Number(right.archived) || right.change.updated_at.localeCompare(left.change.updated_at))
  return rows
}

/** 已归档视图的行：与活跃行同构（状态同样由数据推出），另带归档时的阶段 / 时间 / 归档人。 */
export function archivedRowsOf({ snapshot, currentRoot, rulesByKey, t }: RowsInput): TaskRow[] {
  const rows: TaskRow[] = []
  for (const project of snapshot?.projects ?? []) {
    if (!isProjectNavigable(project)) continue
    if (currentRoot !== '' && project.root !== currentRoot) continue
    for (const change of project.archived ?? []) {
      // 归档只是对我隐藏：状态与归档前的活跃行同一推导，不另编一个「进行中」。
      rows.push({ ...rowOf(project.root, change, rulesByKey, t), archive: change.archive })
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

/** 状态筛选：由 summary.kind 映射，不另起判定。 */
export type TaskStatus = 'all' | 'needs-you' | 'running' | 'done'
// 'needs-you' 与 shell/views.NEEDS_YOU_STATUS（顶部徽标跳转）是同一个值。
export const TASK_STATUSES: readonly TaskStatus[] = ['all', 'needs-you', 'running', 'done']

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

/**
 * 需要你 = 等人确认的评审。阻断（缺技能 / 文档 / 测试 / 未勾任务 …）都由执行中的智能体照
 * `tenon status` 的下一步去补，不算「需要你」；可前进的任务同样由智能体推进。
 */
export function statusOf(summary: TaskSummary): Exclude<TaskStatus, 'all'> {
  switch (summary.kind) {
    case 'review': return 'needs-you'
    case 'completed': return 'done'
    case 'blocked':
    case 'ready':
    case 'running': return 'running'
  }
}

/**
 * 「需要你」的唯一计数：工作台的「需要你」与顶部条待决策徽标都用它（同一份行、同一个 statusOf），
 * 数字不会各算各的，也不随定义加载而变。
 */
export function needsYouCount(input: RowsInput): number {
  return rowsOf(input).filter((row) => statusOf(row.summary) === 'needs-you').length
}

export interface TaskFilterState {
  /** 状态芯片；已完结只在「已完成」与「全部」里出现。 */
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

function matches(row: TaskRow, filter: TaskFilterState, ignore?: keyof TaskFilterState): boolean {
  if (ignore !== 'status' && filter.status !== 'all' && statusOf(row.summary) !== filter.status) return false
  if (ignore !== 'owner' && filter.owner !== 'all' && row.owner?.slug !== filter.owner) return false
  if (ignore !== 'workflow' && filter.workflow !== 'all' && row.workflow !== filter.workflow) return false
  if (ignore !== 'track' && filter.track !== 'all' && row.change.track !== filter.track) return false
  if (ignore !== 'stage' && filter.stage !== 'all' && row.change.phase !== filter.stage) return false
  return true
}

/** 各状态芯片的计数：受其它维度约束，忽略状态本身。 */
export function statusCounts(rows: readonly TaskRow[], filter: TaskFilterState): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { all: 0, 'needs-you': 0, running: 0, done: 0 }
  for (const row of rows) {
    if (!matches(row, filter, 'status')) continue
    counts.all += 1
    counts[statusOf(row.summary)] += 1
  }
  return counts
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

/** 各维度的候选与计数：每个维度的计数受其它维度约束。 */
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
export function facetTotal(rows: readonly TaskRow[], filter: TaskFilterState, facet: keyof TaskFilterState): number {
  return rows.filter((row) => matches(row, filter, facet)).length
}
