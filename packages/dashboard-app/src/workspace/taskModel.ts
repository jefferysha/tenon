import type { WbIoSlot } from '../api/governanceTypes'
import { changeWorkflowName } from '../model/progressModel'
import { snapshotRulesKey, type WorkflowRules } from '../model/workflowModel'
import { isProjectNavigable } from '../state/projectSelectionModel'
import type { ChangeSnapshot, Snapshot, TaskResult, UserRefView } from '../types'
import { blockerLines, type BlockerLine } from './blockerLabel'

export type Tr = (key: string, vars?: Record<string, string | number>) => string

export type StageStatus = 'done' | 'current' | 'todo'

export interface StageState {
  id: string
  label: string
  status: StageStatus
}

/**
 * 一行的状态，只由快照推出（不读工作流定义，所以定义加载前后、所有项目与单项目视图里都一样）：
 * 评审待确认 / 前进出口有阻断 / 可进入下一阶段 / 进行中 / 已结束（带任务结果）。
 */
export type TaskSummary =
  | { kind: 'review' }
  | { kind: 'blocked'; blockers: readonly string[] }
  | { kind: 'ready'; to: string }
  | { kind: 'running' }
  | { kind: 'ended'; result: TaskResult }

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

/** 阶段名只显示一个：冻结计划里的 label（服务端已投影进 labelByStep），没有就是 id；内置工作流没被改过的出厂名已在 rowOf 里按界面语言换好。 */
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

/**
 * 当前阶段的前进出口：任一出口 ready 即可前进；都不 ready 时取阻断最少的那个出口（并列按声明顺序），
 * 绝不把互斥出口的阻断合并成并集。没有前进出口时返回 null。
 */
export interface ForwardExit {
  to: string
  ready: boolean
  /** 完整文案（与 CLI 同一份），用于计数与 title。 */
  blockers: string[]
  /** 同序的展示行：按 code 的短标签 + 完整文案。 */
  lines: BlockerLine[]
}

export function forwardExitOf(change: ChangeSnapshot, rules: WorkflowRules | undefined): ForwardExit | null {
  const all = rulesOf(change, rules)
  const readiness = change.workflowExecution.readinessByTransition[change.phase] ?? {}
  const steps = all.steps
  const currentIndex = steps.indexOf(change.phase)
  const forward = (all.transitions[change.phase] ?? []).filter((edge) => steps.indexOf(edge.to) > currentIndex)
  if (forward.length === 0) return null
  const ready = forward.find((edge) => readiness[edge.event]?.ready === true)
  if (ready !== undefined) return { to: ready.to, ready: true, blockers: [], lines: [] }
  let best: ForwardExit | null = null
  for (const edge of forward) {
    const lines = (readiness[edge.event]?.blockers ?? []).flatMap(blockerLines)
    if (best === null || lines.length < best.lines.length) best = { to: edge.to, ready: false, blockers: lines.map((line) => line.text), lines }
  }
  return best
}

/**
 * 活跃目录里状态机已走完的任务的结果，与内核 `terminalTaskResult` 同一规则：停在 escalated 是已升级，其余是完结。
 * 不读 `task_result`：它在活跃任务上只可能是被打断的归档留下的残留，不表示任务已结束；已结束的任务（archive/ 下）
 * 的结果由列表摘要给出（见 `taskRowOf` 的 `ended`）。
 */
export function taskResultOf(change: ChangeSnapshot): TaskResult {
  return change.phase === 'escalated' ? 'escalated' : 'finished'
}

export function summaryOf(change: ChangeSnapshot, rules: WorkflowRules | undefined): TaskSummary {
  if (change.archived === 'true') return { kind: 'ended', result: taskResultOf(change) }
  if (change.reviewHandshake?.status === 'pending') return { kind: 'review' }
  const exit = forwardExitOf(change, rules)
  if (exit === null) return { kind: 'running' }
  if (exit.ready) return { kind: 'ready', to: exit.to }
  return exit.blockers.length === 0 ? { kind: 'running' } : { kind: 'blocked', blockers: exit.blockers }
}

/** 状态一词：不带阶段名（详情页阶段轨已写明阶段）。 */
export function summaryShort(row: TaskRow, t: Tr): string {
  switch (row.summary.kind) {
    case 'ended': return t(`workspace.result_${row.summary.result}`)
    case 'review': return t('workspace.summary_review')
    case 'blocked': return t('workspace.summary_blocked', { n: row.summary.blockers.length })
    case 'ready': return t('workspace.summary_ready', { to: stageLabel(row.summary.to, row.rules, t) })
    case 'running': return t('workspace.summary_running')
  }
}

/** 任务卡上的状态：阶段 · 状态（已结束的只写任务结果）。 */
export function summaryText(row: TaskRow, t: Tr): string {
  const short = summaryShort(row, t)
  if (row.summary.kind === 'ended') return short
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

/** `ended` 给定时是一个已归档任务的详情行：任务结果取列表里的摘要（旧归档的状态里没有结果字段）。 */
export function taskRowOf(root: string, change: ChangeSnapshot, rulesByKey: ReadonlyMap<string, WorkflowRules>, t: Tr, ended?: TaskResult): TaskRow {
  const workflow = changeWorkflowName(change)
  const rules = rulesByKey.get(snapshotRulesKey(root, change.workflowPlanFingerprint)) ?? change.workflowRules
  return {
    key: rowKey(root, change.name),
    root,
    change,
    rules,
    workflow,
    archived: ended !== undefined || change.archived === 'true',
    owner: change.owner,
    stages: stagesOf(change, rules, t),
    summary: ended === undefined ? summaryOf(change, rules) : { kind: 'ended', result: ended },
  }
}

export function rowsOf({ snapshot, currentRoot, rulesByKey, t }: RowsInput): TaskRow[] {
  const rows: TaskRow[] = []
  for (const project of snapshot?.projects ?? []) {
    if (!isProjectNavigable(project)) continue
    if (currentRoot !== '' && project.root !== currentRoot) continue
    for (const change of project.changes) rows.push(taskRowOf(project.root, change, rulesByKey, t))
  }
  rows.sort((left, right) => Number(left.archived) - Number(right.archived) || right.change.updated_at.localeCompare(left.change.updated_at))
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

/**
 * 需要你 = 等人确认的评审。阻断（缺技能 / 文档 / 测试 / 未勾任务 …）都由执行中的智能体照
 * `tenon status` 的下一步去补，不算「需要你」；可前进的任务同样由智能体推进。
 * 已完结但目录还没移进 archive/ 的任务算「已结束」。
 */
export function statusOf(summary: TaskSummary): 'needs-you' | 'running' | 'ended' {
  switch (summary.kind) {
    case 'review': return 'needs-you'
    case 'ended': return 'ended'
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
