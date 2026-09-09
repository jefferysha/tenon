import type { WbLoopRow } from '../api/client'
import {
  executionProvenance,
  selectProgress,
  type ProgressRow,
  type ProgressRules,
  type ProgressState,
} from '../model/progressModel'
import type { WorkflowRules } from '../model/workflowModel'
import type { PillTone } from '../shell/ThreeColumns'
import type { ChangeSnapshot, Snapshot } from '../types'
import { fieldStr, stepLabel, type Tr } from '../workspace/taskRows'
import { nextStepLabel } from '../workspace/workspaceModel'

/** 自动化页的一行 = 一个由调度器推进的 change（自动化三桶之一：running / queued / failed）。 */
export interface AutomationRow {
  row: ProgressRow
  rules: ProgressRules
  workflow: string
}

/** 沙箱谓词：行处于自动化三桶之一（与 progressModel.schedulerHealth 同折叠口径）。 */
function inSandbox(state: ProgressState): boolean {
  return state === 'running' || state === 'queued' || state === 'failed'
}

const STATE_PRIORITY: Record<ProgressState, number> = { failed: 0, running: 1, queued: 2, gate: 3, agent: 4 }

/**
 * 只取 executionProvenance === 'automation' 且在沙箱三桶里的行；失败优先、其次运行中、再排队，
 * 同态按名称——列表顶部永远是最需要人处置的运行。
 */
export function automationRowsOf(
  snapshot: Snapshot | null,
  currentRoot: string,
  rulesByKey: ReadonlyMap<string, WorkflowRules>,
): AutomationRow[] {
  const out: AutomationRow[] = []
  for (const group of selectProgress(snapshot, currentRoot, rulesByKey).groups) {
    for (const row of group.rows) {
      if (executionProvenance(row.change) === 'automation' && inSandbox(row.state)) {
        out.push({ row, rules: group.rules, workflow: group.workflow })
      }
    }
  }
  return out.sort((a, b) => STATE_PRIORITY[a.row.state] - STATE_PRIORITY[b.row.state] || a.row.change.name.localeCompare(b.row.change.name))
}

/** 中列状态页签：全部 / 需要你（失败）/ 运行中 / 排队 / 等待中（gate + agent）。 */
export const RUN_FILTERS = ['all', 'need', 'running', 'queued', 'waiting'] as const
export type RunFilter = (typeof RUN_FILTERS)[number]

export function runFilterMatch(row: AutomationRow, filter: RunFilter): boolean {
  const state = row.row.state
  if (filter === 'all') return true
  if (filter === 'need') return state === 'failed'
  if (filter === 'running') return state === 'running'
  if (filter === 'queued') return state === 'queued'
  return state === 'gate' || state === 'agent'
}

/** 左列范围：'all' = 全部运行；其余 = 某个循环的 id。 */
export type AutomationScope = 'all' | { loopId: string }

/**
 * 一行是否归属某个循环：change 显式带 loop_id，或名字命中循环声明的 change_prefix。
 * 两者都没有时不归属任何循环——不按状态或时间猜。
 */
export function rowInLoop(row: AutomationRow, loop: Pick<WbLoopRow, 'id' | 'change_prefix'>): boolean {
  const change = row.row.change
  if (fieldStr(change, 'loop_id') === loop.id) return true
  const prefix = loop.change_prefix
  return typeof prefix === 'string' && prefix !== '' && change.name.startsWith(prefix)
}

export function rowInScope(row: AutomationRow, scope: AutomationScope, loops: readonly WbLoopRow[]): boolean {
  if (scope === 'all') return true
  const loop = loops.find((candidate) => candidate.id === scope.loopId)
  return loop !== undefined && rowInLoop(row, loop)
}

export function runTone(state: ProgressState): PillTone {
  switch (state) {
    case 'failed': return 'blocked'
    case 'running': return 'running'
    case 'queued': return 'neutral'
    case 'gate': return 'pending'
    case 'agent': return 'neutral'
  }
}

export function runStateLabel(state: ProgressState, t: Tr): string {
  switch (state) {
    case 'failed': return t('automation.state_failed')
    case 'running': return t('automation.state_running')
    case 'queued': return t('automation.state_queued')
    case 'gate': return t('automation.state_gate')
    case 'agent': return t('automation.state_agent')
  }
}

/** 运行卡的 slug：快照里没有独立的 run 标识，用 workflow · track 定位。 */
export function runSlug(row: AutomationRow): string {
  return [row.workflow, row.row.change.track].filter((part) => part !== '').join(' · ')
}

/** 「下一步 · …」：失败 = 处置或重试；排队 = 等槽位；运行中 = 工作流的下一阶段。 */
export function runNextLabel(row: AutomationRow, t: Tr): string {
  const state = row.row.state
  if (state === 'failed') return t('automation.next_failed')
  if (state === 'queued') return t('automation.next_queued')
  return nextStepLabel(row.row.change, row.rules, t)
}

export function runPhaseLabel(row: AutomationRow, t: Tr): string {
  return stepLabel(row.row.change.phase, row.rules, t)
}

/** 有 worktree 的失败运行才提供终端接管：失败态只能走 retry 端点，enqueue 会被后端拒绝。 */
export function takeoverCommand(change: ChangeSnapshot, quote: (value: string) => string): string | null {
  const worktree = fieldStr(change, 'automation_worktree')
  return worktree === '' ? null : `cd ${quote(worktree)}`
}
