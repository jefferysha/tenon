/**
 * progressModel —— v5 进度视图的模型层（纯函数，零 IO 零 React；plan T6）。
 * 回答三个问题并收敛成同源谓词，供进度视图（T10/T11）与收件箱准入修订（T7）共用：
 *   ① 单个 change 此刻处于五态中的哪一态（等你确认 gate / 等 agent agent / 执行中 running /
 *      排队 queued / 失败 failed）——态字符串对齐 demo v5 的 data-f-state；
 *   ② 项目×workflow 怎么分组（rulesKey(root,wf) 组合键，禁手拼 NUL 分隔串）；
 *   ③ 调度器健康灯怎么聚合（判据对齐 server afk.ts computeSchedulerHealth）。
 *
 * 五态判定优先级（automation 态压过阶段判定，枚举以 packages/automation types.ts
 * AUTOMATION_STATES 真实字符串为准，server afk.ts laneOf 同一折叠口径）：
 *   running‖scheduled → running；queued → queued；failed‖conflict → failed；
 *   paused → gate（L1/L2 report-only 跑完停住，等人复核放行——demo「等你确认 · 跑完停住」）；
 *   off / merged / 空 / 未知值 → 若有新鲜且显式绑定的 terminalActivity 则 running；否则回到 host 阶段判定：
 *     review 门阶段 → 产出/证据齐可拍板 = gate，欠产出 = agent（「等 agent 补产出」）；
 *     其余（含 confirm 门与 rules 缺失）→ agent（活在终端里由 agent 推进）。
 *
 * 口径备注：
 *   · confirm 门不是 dashboard 拍板点——kernel types.ts 注释明确它是终端会话内 AskUserQuestion
 *     秒级即清的安全网门，只认 review（T7 起 inbox.ts isAwaitingDecision 直接消费本模块的
 *     changeProgressState，「收件箱只收能拍板的」与进度五态同源不漂移）。
 *   · rules 缺失（自定义 workflow 定义拉取失败）：G17 底线是卡不消失——行仍出现在进度里，
 *     判不了门就归 agent（不误报「等你确认」）；automation 活跃态不依赖 rules，照常判定。
 */
import type { ChangeSnapshot, Snapshot } from '../types'
import type { TransitionReadinessBlockerSnapshot, TransitionReadinessSnapshot } from '../types'
import { isProjectNavigable } from '../state/projectSelectionModel'
import {
  rulesKey,
  snapshotRulesKey,
  type StepOutputRules,
  type WorkflowRules,
} from './workflowModel'

/** 五态字典（顺序即筛选条 chips 顺序，键对齐 demo v5 的 data-f-state）。 */
export const PROGRESS_STATES = ['gate', 'agent', 'running', 'queued', 'failed'] as const
export type ProgressState = (typeof PROGRESS_STATES)[number]
export type ExecutionProvenance = 'automation' | 'terminal' | 'none'

const AUTOMATION_PROVENANCE_STATES = new Set([
  'running',
  'scheduled',
  'queued',
  'failed',
  'conflict',
  'paused',
])

/**
 * WorkflowRules 的可选产出扩展面——「自定义 workflow 的 nonempty-output guard」判定所需的
 * 每 step 产出声明。不可变 plan 结构由 rules 承载；按 Change/Track 求值后的必需输出只从
 * Change.workflowExecution 读取，避免同 fingerprint 的合法 Track 差异被组内第一条规则覆盖。
 */
export type { StepOutputRules } from './workflowModel'
export type ProgressRules = WorkflowRules & StepOutputRules

export type ReadinessBlocker = TransitionReadinessBlockerSnapshot

/** Readiness for one exact event; callers must not infer it from a sibling edge. */
export function readinessForTransition(
  c: ChangeSnapshot,
  event: string,
): TransitionReadinessSnapshot | undefined {
  return c.workflowExecution.readinessByTransition[c.phase]?.[event]
}

export function isBackwardTransition(rules: WorkflowRules, from: string, to: string): boolean {
  const fromIndex = rules.steps.indexOf(from)
  const toIndex = rules.steps.indexOf(to)
  return fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex
}

/** Stable, privacy-safe blocker rendering for the action/note surfaces. */
export function formatReadinessBlocker(blocker: ReadinessBlocker): string {
  if (blocker.kind === 'verify-build-revision-untrusted') {
    return `${blocker.code} reason=${blocker.reason} remediation=${blocker.remediation}`
  }
  if (blocker.kind === 'capability-unavailable') return `capability:${blocker.capability}`
  if (blocker.kind === 'evaluation-error') {
    return blocker.capability === undefined ? `guard:${blocker.guardType}` : `capability:${blocker.capability}`
  }
  if (blocker.kind === 'agents-incomplete') {
    return blocker.agents.map((item) => `agent:${item.agent}:${item.reason}`).join(' ')
  }
  return blocker.field ?? `guard:${blocker.guardType}`
}

/** fields 值可能是 string[]；非字符串一律当未设（同 evidence.ts fieldStr 口径）。 */
function fieldStr(c: ChangeSnapshot, key: string): string {
  const v = c.fields[key]
  return typeof v === 'string' ? v : ''
}

/** 该 change 声明的 workflow 名（未设/空 → 'default'；同 inbox.ts changeWorkflow 口径，
 *  本模块不 import inbox 以保持依赖单向——T7 让 inbox 反向复用本模块时不成环）。 */
export function changeWorkflowName(c: ChangeSnapshot): string {
  const wf = c.fields['workflow']
  return typeof wf === 'string' && wf ? wf : 'default'
}

/**
 * A display state such as `running` does not identify who is doing the work.
 * Keep execution ownership separate so a live normal-chat terminal session
 * cannot leak into the unattended automation workspace.
 */
export function executionProvenance(c: ChangeSnapshot): ExecutionProvenance {
  if (AUTOMATION_PROVENANCE_STATES.has(fieldStr(c, 'automation'))) return 'automation'
  if (c.terminalActivity !== undefined) return 'terminal'
  return 'none'
}

/**
 * 该阶段是不是 dashboard 上的拍板门（T7 收件箱准入的同源判据）。
 * 只认 review：confirm 是终端会话门（见文件头口径备注），rules 缺失不误报。
 */
export function isDashboardGate(rules: WorkflowRules | undefined, phase: string): boolean {
  return rules !== undefined && rules.gateByStep[phase] === 'review'
}

/**
 * 「等 agent 补产出」的欠账清单——gate 阶段下 agent 还欠哪些证据/产出字段（badge 文案数据源，
 * demo「等 agent · 补产出 plan」）。空数组 = 证据/产出齐，人现在能拍板。
 * 服务端已经用 kernel canonical guard evaluator 生成逐 Change/step/event 的结构化 readiness；
 * 前端不解释字段值或 guard 谓词，只负责选择可达出口并把 blocker 转成 badge 标识。
 *
 * 多出口必须分别判断：任一出口 ready 即可交给人决策；全部未齐时，只展示 blocker 数最少
 * 的可达出口，数量并列时按冻结 transition 声明顺序选择，绝不把互斥出口合并成并集。
 */
export function missingGateArtifacts(c: ChangeSnapshot, rules: ProgressRules | undefined): string[] {
  if (!rules) return []
  if (!isDashboardGate(rules, c.phase)) return []
  const transitions = rules.transitions[c.phase] ?? []
  if (transitions.length === 0) return []
  // A ready rollback is not a ready success. Evaluate only forward exits for the gate's
  // readiness state; keep rollback edges available to the action surface independently.
  const forward = transitions.filter(({ to }) => !isBackwardTransition(rules, c.phase, to))
  const candidates = forward.length > 0 ? forward : transitions
  const byTransition = candidates.map(({ event }) => readinessForTransition(c, event))
  if (byTransition.some((result) => result?.ready === true)) return []
  const blockers = byTransition.map((result) => result?.blockers ?? [{
    kind: 'capability-unavailable' as const,
    guardType: 'readiness',
    capability: 'readiness',
  }])
  const selected = blockers.reduce((best, current) =>
    current.length < best.length ? current : best,
  )
  return selected.map((blocker) => {
    return formatReadinessBlocker(blocker)
  })
}

/** 单 change 五态判定（优先级见文件头）。archived 排除是 selectProgress 的事，本函数不管。 */
export function changeProgressState(c: ChangeSnapshot, rules: ProgressRules | undefined): ProgressState {
  const automation = fieldStr(c, 'automation')
  if (automation === 'running' || automation === 'scheduled') return 'running'
  if (automation === 'queued') return 'queued'
  if (automation === 'failed' || automation === 'conflict') return 'failed'
  if (automation === 'paused') return 'gate'
  // A terminal heartbeat is emitted only after the pipeline root bound this exact host session to
  // this exact Change. It is a liveness overlay, never a replacement for canonical phase state.
  if (c.terminalActivity !== undefined) return 'running'
  // off / merged / 空 / 未知值 → host 阶段判定
  if (isDashboardGate(rules, c.phase)) {
    return missingGateArtifacts(c, rules).length > 0 ? 'agent' : 'gate'
  }
  return 'agent'
}

export interface ProgressRow {
  root: string
  change: ChangeSnapshot
  state: ProgressState
}

/** 项目×冻结 workflow plan 一组（进度视图一张卡）。 */
export interface ProgressGroup {
  key: string
  root: string
  workflow: string
  workflowPlanFingerprint: string
  rules: ProgressRules
  /** 未归档行，updated_at 倒序（并列 name 升序，同收件箱时间轴口径）。 */
  rows: ProgressRow[]
  /** 决议 #5：archived 排除出行，组头尾缀「· N 已归档」的计数来源。 */
  archivedCount: number
  /** #2 归档折叠行「展开」真交互：归档行的完整投影（state 判定同 changeProgressState），
   *  updated_at 倒序同 rows 口径——供视图层展开时只读渲染消费。不进 counts/total（archivedCount
   *  与本数组长度恒等，但 counts 仍只统计未归档行，不变式不变，见文件头「archived 排除」备注）。 */
  archived: ProgressRow[]
}

export type ProgressCounts = Record<ProgressState, number>

export interface ProgressSelection {
  /** 组序：root 升序；同 root 下 default 在前，其余 workflow 名升序——纯归档组（零活跃行、
   *  archived 非空）现在同样出现，供归档折叠区渲染；真正不出现的只有 rows 与 archived 皆空的
   *  组，byKey 构造保证不会有这种组（组一旦创建就紧接着被推入其一，见下方构造逻辑）。 */
  groups: ProgressGroup[]
  /** 五态计数（筛选条 chips 数据源）。不变式：各态之和 === total === 各组行数之和。 */
  counts: ProgressCounts
  total: number
}

function emptyCounts(): ProgressCounts {
  return { gate: 0, agent: 0, running: 0, queued: 0, failed: 0 }
}

/** Recount an already-filtered row set so list ownership and summary badges cannot diverge. */
export function progressCountsForRows(rows: readonly ProgressRow[]): ProgressCounts {
  const counts = emptyCounts()
  for (const row of rows) counts[row.state] += 1
  return counts
}

/** 行序比较：updated_at 倒序，并列 name 升序（同 inbox selectInbox 的时间轴口径）。 */
function compareRows(a: ProgressRow, b: ProgressRow): number {
  const ua = a.change.updated_at
  const ub = b.change.updated_at
  if (ua !== ub) return ua < ub ? 1 : -1
  return a.change.name < b.change.name ? -1 : a.change.name > b.change.name ? 1 : 0
}

/** 组序比较：root 升序；同 root 下 default 恒在前（主流程），其余按 workflow 名升序。 */
function compareGroups(a: ProgressGroup, b: ProgressGroup): number {
  if (a.root !== b.root) return a.root < b.root ? -1 : 1
  if (a.workflow === b.workflow) return 0
  if (a.workflow === 'default') return -1
  if (b.workflow === 'default') return 1
  return a.workflow < b.workflow ? -1 : 1
}

/**
 * 从 snapshot 摘出进度视图的全部分组与计数。currentRoot 语境同 selectInbox（D5）：
 * 非空 → 只看该项目；空串 → 全部项目聚合，每行仍各自带 root。
 * rulesByKey 按 rulesKey(root,wf) 索引（useWorkflowRulesMulti 的返回契约）。
 * counts 与 groups 出自同一次遍历——「计数与分组行数恒等」由构造保证，测试再钉不变式。
 */
export function selectProgress(
  snapshot: Snapshot | null,
  currentRoot: string,
  rulesByKey: ReadonlyMap<string, WorkflowRules>,
): ProgressSelection {
  const counts = emptyCounts()
  if (!snapshot) return { groups: [], counts, total: 0 }

  const byKey = new Map<string, ProgressGroup>()
  for (const p of snapshot.projects) {
    if (!isProjectNavigable(p)) continue
    if (currentRoot !== '' && p.root !== currentRoot) continue
    for (const c of p.changes) {
      const workflow = changeWorkflowName(c)
      const key = snapshotRulesKey(p.root, c.workflowPlanFingerprint)
      const rules = rulesByKey.get(key) ?? rulesByKey.get(rulesKey(p.root, workflow)) ?? c.workflowRules
      let group = byKey.get(key)
      if (!group) {
        group = {
          key,
          root: p.root,
          workflow,
          workflowPlanFingerprint: c.workflowPlanFingerprint,
          rules,
          rows: [],
          archivedCount: 0,
          archived: [],
        }
        byKey.set(key, group)
      }
      if (c.archived === 'true') {
        group.archivedCount += 1
        // #2：archived 行仍算出 state（同 changeProgressState 判定，不进 counts）——展开时只读
        // 渲染消费；counts 不变式（各态之和 === total === 各组行数之和）只认 group.rows，本行不入。
        group.archived.push({ root: p.root, change: c, state: changeProgressState(c, rules) })
        continue
      }
      const state = changeProgressState(c, rules)
      group.rows.push({ root: p.root, change: c, state })
      counts[state] += 1
    }
  }

  const groups = [...byKey.values()].filter((g) => g.rows.length > 0 || g.archived.length > 0)
  for (const g of groups) {
    g.rows.sort(compareRows)
    g.archived.sort(compareRows)
  }
  groups.sort(compareGroups)
  const total = PROGRESS_STATES.reduce((n, s) => n + counts[s], 0)
  return { groups, counts, total }
}

/** 调度器健康灯三色（对位 server afk.ts SchedulerHealth.status）。 */
export type SchedulerLight = 'ok' | 'busy' | 'attention'

export interface SchedulerHealthSummary {
  status: SchedulerLight
  running: number
  queued: number
  failed: number
}

/**
 * 健康灯聚合：attention（有 failed/conflict 待人工）压过 busy（有排队或在跑），否则 ok。
 * 判据逐字对齐 server afk.ts computeSchedulerHealth；输入就是 selectProgress 的 counts
 * （running 已含 scheduled 折叠、failed 已含 conflict 折叠），文案由视图层 i18n 负责。
 */
export function schedulerHealth(counts: ProgressCounts): SchedulerHealthSummary {
  const { running, queued, failed } = counts
  const status: SchedulerLight = failed > 0 ? 'attention' : running + queued > 0 ? 'busy' : 'ok'
  return { status, running, queued, failed }
}
