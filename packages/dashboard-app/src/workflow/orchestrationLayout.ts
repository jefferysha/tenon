/**
 * 编排画布的纯布局：每个阶段一列（总览）或单独一列带泳道标签（阶段），列内按执行位次自上而下，
 * 同一位次的并行条目横排。只算坐标、连线与脉冲段序，不碰 React Flow。
 *
 * 连线：同身份的直接前置照画；身份之间（执行者 → 技能 → 测试 → 评审者）上一组的末端接下一组的起点，
 * 两边都多于一个时经一个汇合点。总览里阶段标题连成一条主线（起点 → 阶段 1 → … → 终点），每列从标题
 * 往下走；阶段模式没有标题，起点在列顶、终点在列底。脉冲按段序依次传递：进一列、走完这一列、再去下一列。
 */
import type { OrchestrationKind } from '@tenon/kernel/workflow/orchestration'
import type { FlowEntry, FlowStage } from '../api/workflowOrchestrationClient'

export type FlowMode = 'overview' | 'stage'

export const KIND_ORDER: readonly OrchestrationKind[] = ['executor', 'skill', 'test', 'reviewer']
export const PORT = 12
export const HEADER_H = 40
const PORT_GAP = 56
const COLUMN_GAP = 64
const FRAME_PAD = 16
const ROW_GAP = 20
const LANE_GAP = 32
const SIB_GAP = 12
export const LANE_LABEL_W = 112
const END_GAP = 40

export function entrySize(mode: FlowMode, withStatus: boolean): { width: number; height: number } {
  return mode === 'overview' ? { width: 176, height: 32 } : { width: 220, height: withStatus ? 52 : 36 }
}

export interface LaidEntry { readonly id: string; readonly stage: string; readonly entry: FlowEntry; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface LaidStage { readonly id: string; readonly index: number; readonly stage: FlowStage; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface LaidLane { readonly id: string; readonly kind: OrchestrationKind; readonly count: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface LaidPoint { readonly id: string; readonly x: number; readonly y: number }
export interface LaidEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sourceHandle: string
  readonly targetHandle: string
  /** 脉冲段序：同段序同时出发，下一段等本段走完。 */
  readonly order: number
  readonly arrow: boolean
}

export interface OrchestrationLayout {
  readonly stages: readonly LaidStage[]
  readonly entries: readonly LaidEntry[]
  readonly lanes: readonly LaidLane[]
  readonly junctions: readonly LaidPoint[]
  readonly ports: { readonly start: LaidPoint; readonly end: LaidPoint }
  readonly edges: readonly LaidEdge[]
  readonly width: number
  readonly height: number
}

export function entryNodeId(stage: string, entry: Pick<FlowEntry, 'kind' | 'id'>): string {
  return `e:${stage}:${entry.kind}:${entry.id}`
}
export function stageNodeId(stage: string): string {
  return `s:${stage}`
}

interface Group { readonly kind: OrchestrationKind; readonly rows: readonly (readonly FlowEntry[])[] }

/** 列内分组：按身份顺序，每组内按位次成行。`showEmpty` = 空身份也留一条泳道（可编辑的阶段画布放动作用）。 */
function groupsOf(stage: FlowStage, showEmpty: boolean): Group[] {
  return KIND_ORDER.map((kind) => {
    const entries = stage.entries.filter((entry) => entry.kind === kind)
    const waves = [...new Set(entries.map((entry) => entry.wave))].sort((a, b) => a - b)
    return { kind, rows: waves.map((wave) => entries.filter((entry) => entry.wave === wave)) }
  }).filter((group) => showEmpty || group.rows.length > 0)
}

function rowWidth(count: number, width: number): number {
  return count * width + Math.max(0, count - 1) * SIB_GAP
}

function columnHeight(groups: readonly Group[], height: number): number {
  return groups.reduce((sum, group, index) => {
    const rows = Math.max(group.rows.length, 1)
    return sum + (index > 0 ? LANE_GAP : 0) + rows * height + (rows - 1) * ROW_GAP
  }, 0)
}

/** 连线从哪个把手出：标题朝下、起点朝外、条目与汇合点朝下。 */
function sourceHandleOf(id: string): string {
  if (id.startsWith('s:')) return 'down'
  if (id === 'start') return 'out'
  return 'bottom'
}

interface ColumnInput {
  readonly stage: FlowStage
  readonly groups: readonly Group[]
  readonly width: number
  readonly x: number
  readonly y: number
  readonly head: string
  readonly headBottom: number
  readonly order: number
}

interface ColumnOutput {
  readonly entries: LaidEntry[]
  readonly lanes: LaidLane[]
  readonly junctions: LaidPoint[]
  readonly edges: LaidEdge[]
  /** 列内最后一组的末端（没有条目时为列头）。 */
  readonly tail: readonly string[]
  readonly nextOrder: number
}

function layoutColumn(input: ColumnInput, size: { width: number; height: number }, lanes: boolean): ColumnOutput {
  const out: ColumnOutput = { entries: [], lanes: [], junctions: [], edges: [], tail: [input.head], nextOrder: input.order }
  let tail: { ids: readonly string[]; bottom: number } = { ids: [input.head], bottom: input.headBottom }
  let y = input.y
  let rowIndex = 0
  input.groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) y += LANE_GAP
    const laneY = y
    const byId = new Map<string, string>()
    const placed: LaidEntry[] = []
    group.rows.forEach((row, index) => {
      if (index > 0) y += ROW_GAP
      const offset = (input.width - rowWidth(row.length, size.width)) / 2
      row.forEach((entry, position) => {
        const id = entryNodeId(input.stage.id, entry)
        byId.set(entry.id, id)
        placed.push({ id, stage: input.stage.id, entry, x: input.x + offset + position * (size.width + SIB_GAP), y, width: size.width, height: size.height })
      })
      y += size.height
    })
    if (group.rows.length === 0) y += size.height
    if (lanes) out.lanes.push({ id: `l:${group.kind}`, kind: group.kind, count: placed.length, x: 0, y: laneY, width: LANE_LABEL_W, height: size.height })
    out.entries.push(...placed)
    if (placed.length === 0) return
    const inOrder = input.order + rowIndex
    const rowOf = (item: LaidEntry): number => group.rows.findIndex((row) => row.includes(item.entry))
    for (const item of placed) {
      for (const dependency of item.entry.dependsOn) {
        const source = byId.get(dependency)
        if (source !== undefined) out.edges.push({ id: `${source}->${item.id}`, source, target: item.id, sourceHandle: 'bottom', targetHandle: 'top', order: inOrder + rowOf(item), arrow: true })
      }
    }
    const dependents = new Set(placed.flatMap((item) => item.entry.dependsOn.flatMap((dependency) => byId.get(dependency) ?? [])))
    const sources = placed.filter((item) => item.entry.dependsOn.every((dependency) => !byId.has(dependency)))
    const sinks = placed.filter((item) => !dependents.has(item.id))
    if (tail.ids.length > 1 && sources.length > 1) {
      const junction = `j:${input.stage.id}:${group.kind}`
      const left = Math.min(...sources.map((item) => item.x))
      const right = Math.max(...sources.map((item) => item.x + item.width))
      out.junctions.push({ id: junction, x: (left + right) / 2 - 1, y: (tail.bottom + laneY) / 2 - 1 })
      for (const from of tail.ids) out.edges.push({ id: `${from}->${junction}`, source: from, target: junction, sourceHandle: sourceHandleOf(from), targetHandle: 'top', order: inOrder - 0.5, arrow: false })
      for (const to of sources) out.edges.push({ id: `${junction}->${to.id}`, source: junction, target: to.id, sourceHandle: 'bottom', targetHandle: 'top', order: inOrder - 0.25, arrow: true })
    } else {
      for (const from of tail.ids) {
        for (const to of sources) out.edges.push({ id: `${from}->${to.id}`, source: from, target: to.id, sourceHandle: sourceHandleOf(from), targetHandle: 'top', order: inOrder - 0.5, arrow: true })
      }
    }
    tail = { ids: sinks.map((item) => item.id), bottom: Math.max(...sinks.map((item) => item.y + item.height)) }
    rowIndex += group.rows.length + 1
  })
  return { ...out, tail: tail.ids, nextOrder: input.order + rowIndex }
}

/** `showEmpty` 只对阶段模式有意义：可编辑时四条泳道都在，空泳道也留一行给动作。 */
export function layoutOrchestration(
  stages: readonly FlowStage[],
  mode: FlowMode,
  options: { readonly withStatus?: boolean; readonly showEmpty?: boolean } = {},
): OrchestrationLayout {
  const size = entrySize(mode, options.withStatus === true)
  const lanes = mode === 'stage'
  const grouped = stages.map((stage) => {
    const groups = groupsOf(stage, lanes && options.showEmpty === true)
    return { stage, groups, width: Math.max(size.width, ...groups.flatMap((group) => group.rows.map((row) => rowWidth(row.length, size.width)))) }
  })
  const laidStages: LaidStage[] = []
  const entries: LaidEntry[] = []
  const laneNodes: LaidLane[] = []
  const junctions: LaidPoint[] = []
  const edges: LaidEdge[] = []
  const out = { stages: laidStages, entries, lanes: laneNodes, junctions, edges }
  const merge = (column: ColumnOutput): void => {
    out.entries.push(...column.entries)
    out.lanes.push(...column.lanes)
    out.junctions.push(...column.junctions)
    out.edges.push(...column.edges)
  }

  if (mode === 'stage') {
    const single = grouped[0]
    const originX = LANE_LABEL_W + 16
    const width = single?.width ?? size.width
    const start: LaidPoint = { id: 'start', x: originX + width / 2 - PORT / 2, y: 0 }
    const column = single === undefined
      ? null
      : layoutColumn({ ...single, x: originX, y: PORT + END_GAP, head: 'start', headBottom: PORT, order: 0 }, size, true)
    if (column !== null) merge(column)
    const bottom = Math.max(PORT + END_GAP, ...out.entries.map((entry) => entry.y + entry.height), ...out.lanes.map((lane) => lane.y + lane.height))
    const end: LaidPoint = { id: 'end', x: start.x, y: bottom + END_GAP }
    for (const from of column?.tail ?? ['start']) {
      out.edges.push({ id: `${from}->end`, source: from, target: 'end', sourceHandle: sourceHandleOf(from), targetHandle: 'in', order: column?.nextOrder ?? 0, arrow: false })
    }
    return { ...out, ports: { start, end }, width: originX + width, height: end.y + PORT }
  }

  const frameHeight = Math.max(0, ...grouped.map((column) => columnHeight(column.groups, size.height))) + HEADER_H + 12 + FRAME_PAD
  const start: LaidPoint = { id: 'start', x: 0, y: HEADER_H / 2 - PORT / 2 }
  let x = PORT + PORT_GAP
  let order = 0
  let previous = 'start'
  grouped.forEach((column, index) => {
    const head = stageNodeId(column.stage.id)
    out.stages.push({ id: head, index, stage: column.stage, x, y: 0, width: column.width + 2 * FRAME_PAD, height: frameHeight })
    out.edges.push({ id: `${previous}->${head}`, source: previous, target: head, sourceHandle: previous === 'start' ? 'out' : 'right', targetHandle: 'left', order, arrow: true })
    const laid = layoutColumn({ ...column, x: x + FRAME_PAD, y: HEADER_H + 12, head, headBottom: HEADER_H, order: order + 1 }, size, false)
    merge(laid)
    order = laid.nextOrder + 1
    previous = head
    x += column.width + 2 * FRAME_PAD + COLUMN_GAP
  })
  const end: LaidPoint = { id: 'end', x: x - COLUMN_GAP + PORT_GAP - PORT, y: HEADER_H / 2 - PORT / 2 }
  out.edges.push({ id: `${previous}->end`, source: previous, target: 'end', sourceHandle: previous === 'start' ? 'out' : 'right', targetHandle: 'in', order, arrow: false })
  return { ...out, ports: { start, end }, width: end.x + PORT, height: frameHeight }
}
