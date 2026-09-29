/**
 * 编排画布的纯布局：每个阶段一列（总览）或单独一列带泳道标签（阶段），列内按执行位次自上而下；
 * 同一位次的并行条目在列内纵向堆叠（列宽恒为一个条目宽，验证这类并行很多的阶段也不会撑宽）。
 * 只算坐标、连线与脉冲段序，不碰 React Flow。
 *
 * 连线：同身份的直接前置照画；位次之间 / 身份之间（执行者 → 技能 → 测试 → 评审者）上一组的末端接下一组的起点，
 * 一对一直连，一对多 / 多对一 / 多对多经列外左右两条轨道上的汇合点（见 orchestrationRouting），不穿过条目。
 * 总览里阶段标题连成一条主线（起点 → 阶段 1 → … → 终点），每列从标题往下走；阶段模式没有标题，起点在列顶、
 * 终点在列底。脉冲按段序依次传递：进一列、走完这一列、再去下一列。
 */
import type { OrchestrationKind, OrchestrationReturn } from '@tenon/kernel/workflow/orchestration'
import type { FlowEntry, FlowStage } from '../api/workflowOrchestrationClient'
import { RAIL, connect, type Anchor, type LaidEdge, type LaidPoint } from './orchestrationRouting'

export type { LaidEdge, LaidPoint } from './orchestrationRouting'
export type FlowMode = 'overview' | 'stage'

export const KIND_ORDER: readonly OrchestrationKind[] = ['executor', 'skill', 'test', 'reviewer']
export const PORT = 12
export const HEADER_H = 40
const PORT_GAP = 56
const COLUMN_GAP = 64
const FRAME_PAD = 16
/** 同身份相邻位次之间（汇合点落在这段空隙里）。 */
const ROW_GAP = 28
/** 同一位次的并行条目之间。 */
const SIB_GAP = 8
/** 身份与身份之间。 */
const LANE_GAP = 36
/** 阶段标题到第一组条目。 */
const HEAD_GAP = 24
export const LANE_LABEL_W = 112
const END_GAP = 40
/** 回流弧最高拱出阶段标题上方多少（长弧封顶，不让它把画布顶得太高）。 */
const RETURN_LIFT_MAX = 90

export function entrySize(mode: FlowMode, withStatus: boolean): { width: number; height: number } {
  return mode === 'overview' ? { width: 176, height: 32 } : { width: 220, height: withStatus ? 52 : 36 }
}

/** 回流弧的拱高：跨得越远拱得越高，封顶 RETURN_LIFT_MAX。 */
export function returnLift(distance: number): number {
  return Math.min(RETURN_LIFT_MAX, 28 + Math.abs(distance) * 0.12)
}

export interface LaidEntry { readonly id: string; readonly stage: string; readonly entry: FlowEntry; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface LaidStage { readonly id: string; readonly index: number; readonly stage: FlowStage; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface LaidLane { readonly id: string; readonly kind: OrchestrationKind; readonly count: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }

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

/** 回流弧要在阶段框上方留多少空间（没有回流 = 0）。 */
export function returnHeadroom(layout: OrchestrationLayout, returns: readonly OrchestrationReturn[]): number {
  const center = new Map(layout.stages.map((stage) => [stage.stage.id, stage.x + stage.width / 2]))
  return Math.max(0, ...returns.flatMap((item) => {
    const from = center.get(item.from)
    const to = center.get(item.to)
    return from === undefined || to === undefined ? [] : [returnLift(from - to)]
  }))
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

function groupHeight(group: Group, height: number): number {
  if (group.rows.length === 0) return height
  const cells = group.rows.reduce((sum, row) => sum + row.length * height + (row.length - 1) * SIB_GAP, 0)
  return cells + (group.rows.length - 1) * ROW_GAP
}

function columnHeight(groups: readonly Group[], height: number): number {
  return groups.reduce((sum, group, index) => sum + (index > 0 ? LANE_GAP : 0) + groupHeight(group, height), 0)
}

interface ColumnInput {
  readonly stage: FlowStage
  readonly groups: readonly Group[]
  readonly x: number
  readonly y: number
  readonly head: Anchor
  readonly order: number
}

interface ColumnOutput {
  readonly entries: LaidEntry[]
  readonly lanes: LaidLane[]
  readonly junctions: LaidPoint[]
  readonly edges: LaidEdge[]
  /** 列内最后一组的末端（没有条目时为列头）。 */
  readonly tail: readonly Anchor[]
  readonly nextOrder: number
}

function anchorOf(item: LaidEntry): Anchor {
  return { id: item.id, x: item.x, y: item.y, width: item.width, height: item.height, out: 'bottom', into: 'top' }
}

interface Dependency { readonly from: LaidEntry; readonly to: LaidEntry }

function layoutColumn(input: ColumnInput, size: { width: number; height: number }, lanes: boolean): ColumnOutput {
  const out = { entries: [] as LaidEntry[], lanes: [] as LaidLane[], junctions: [] as LaidPoint[], edges: [] as LaidEdge[] }
  const leftRail = input.x - RAIL
  const rightRail = input.x + size.width + RAIL
  let tail: readonly Anchor[] = [input.head]
  let y = input.y
  let seq = input.order
  const join = (connection: ReturnType<typeof connect>): void => {
    out.edges.push(...connection.edges)
    out.junctions.push(...connection.junctions)
    seq += connection.hops
  }
  input.groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) y += LANE_GAP
    const laneY = y
    const rows: LaidEntry[][] = group.rows.map((row, rowIndex) => {
      if (rowIndex > 0) y += ROW_GAP
      return row.map((entry, position) => {
        if (position > 0) y += SIB_GAP
        const placed: LaidEntry = { id: entryNodeId(input.stage.id, entry), stage: input.stage.id, entry, x: input.x, y, width: size.width, height: size.height }
        y += size.height
        return placed
      })
    })
    if (rows.length === 0) y += size.height
    const placed = rows.flat()
    if (lanes) out.lanes.push({ id: `l:${group.kind}`, kind: group.kind, count: placed.length, x: 0, y: laneY, width: LANE_LABEL_W, height: size.height })
    out.entries.push(...placed)
    if (placed.length === 0) return

    const byEntry = new Map(placed.map((item) => [item.entry.id, item]))
    const deps: Dependency[] = placed.flatMap((item) => item.entry.dependsOn.flatMap((id) => {
      const from = byEntry.get(id)
      return from === undefined ? [] : [{ from, to: item }]
    }))
    const dependedOn = new Set(deps.map((dep) => dep.from.id))
    const dependent = new Set(deps.map((dep) => dep.to.id))
    const prefix = `j:${input.stage.id}:${group.kind}`
    join(connect({
      from: tail, to: placed.filter((item) => !dependent.has(item.id)).map(anchorOf), junction: `${prefix}:0`, order: seq, leftRail, rightRail,
    }))

    // 相邻位次：前置相同的目标归成一组，一组一次连线（一对一直连，一对多 / 多对一 / 多对多经轨道上的汇合点）；
    // 同一次转移里的几组同时出发。
    const rowOf = new Map(rows.flatMap((row, index) => row.map((item): [string, number] => [item.id, index])))
    const drawn = new Set<string>()
    rows.forEach((row, index) => {
      const between = deps.filter((dep) => rowOf.get(dep.from.id) === index - 1 && rowOf.get(dep.to.id) === index)
      if (between.length === 0) return
      const groups = new Map<string, { from: LaidEntry[]; to: LaidEntry[] }>()
      for (const target of row) {
        const sources = between.filter((dep) => dep.to.id === target.id).map((dep) => dep.from)
        if (sources.length === 0) continue
        const key = sources.map((source) => source.id).sort().join('|')
        const group = groups.get(key) ?? { from: sources, to: [] }
        group.to.push(target)
        groups.set(key, group)
      }
      const start = seq
      let end = start
      let number = 0
      for (const group of groups.values()) {
        const junction = groups.size === 1 ? `${prefix}:${index}` : `${prefix}:${index}.${number}`
        const connection = connect({ from: group.from.map(anchorOf), to: group.to.map(anchorOf), junction, order: start, leftRail, rightRail })
        out.edges.push(...connection.edges)
        out.junctions.push(...connection.junctions)
        end = Math.max(end, start + connection.hops)
        number += 1
      }
      seq = end
      for (const dep of between) drawn.add(`${dep.from.id}->${dep.to.id}`)
    })
    // 跨位次的依赖（少见）：直连，排在这组其余连线之后。
    const skipping = deps.filter((dep) => !drawn.has(`${dep.from.id}->${dep.to.id}`))
    for (const dep of skipping) out.edges.push(directEdge(dep, seq))
    if (skipping.length > 0) seq += 1

    tail = placed.filter((item) => !dependedOn.has(item.id)).map(anchorOf)
  })
  return { ...out, tail, nextOrder: seq }
}

function directEdge(dep: Dependency, order: number): LaidEdge {
  return { id: `${dep.from.id}->${dep.to.id}`, source: dep.from.id, target: dep.to.id, sourceHandle: 'bottom', targetHandle: 'top', order, arrow: true }
}

/** `showEmpty` 只对阶段模式有意义：可编辑时四条泳道都在，空泳道也留一行给动作。 */
export function layoutOrchestration(
  stages: readonly FlowStage[],
  mode: FlowMode,
  options: { readonly withStatus?: boolean; readonly showEmpty?: boolean } = {},
): OrchestrationLayout {
  const size = entrySize(mode, options.withStatus === true)
  const lanes = mode === 'stage'
  const grouped = stages.map((stage) => ({ stage, groups: groupsOf(stage, lanes && options.showEmpty === true) }))
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
    const start: LaidPoint = { id: 'start', x: originX + size.width / 2 - PORT / 2, y: 0 }
    const startAnchor: Anchor = { id: 'start', x: start.x, y: 0, width: PORT, height: PORT, out: 'out', into: 'in' }
    const column = single === undefined
      ? null
      : layoutColumn({ ...single, x: originX, y: PORT + END_GAP, head: startAnchor, order: 0 }, size, true)
    if (column !== null) merge(column)
    const bottom = Math.max(PORT + END_GAP, ...out.entries.map((entry) => entry.y + entry.height), ...out.lanes.map((lane) => lane.y + lane.height))
    const end: LaidPoint = { id: 'end', x: start.x, y: bottom + END_GAP }
    const endAnchor: Anchor = { id: 'end', x: end.x, y: end.y, width: PORT, height: PORT, out: 'out', into: 'in' }
    const closing = connect({
      from: column?.tail ?? [startAnchor], to: [endAnchor], junction: 'j:end', order: column?.nextOrder ?? 0,
      leftRail: originX - RAIL, rightRail: originX + size.width + RAIL,
    })
    out.edges.push(...closing.edges.map((item) => (item.target === 'end' ? { ...item, arrow: false } : item)))
    out.junctions.push(...closing.junctions)
    return { ...out, ports: { start, end }, width: originX + size.width + RAIL + 4, height: end.y + PORT }
  }

  const frameHeight = Math.max(0, ...grouped.map((column) => columnHeight(column.groups, size.height))) + HEADER_H + HEAD_GAP + FRAME_PAD
  const start: LaidPoint = { id: 'start', x: 0, y: HEADER_H / 2 - PORT / 2 }
  let x = PORT + PORT_GAP
  let order = 0
  let previous = 'start'
  grouped.forEach((column, index) => {
    const head = stageNodeId(column.stage.id)
    const frameWidth = size.width + 2 * FRAME_PAD
    out.stages.push({ id: head, index, stage: column.stage, x, y: 0, width: frameWidth, height: frameHeight })
    out.edges.push({ id: `${previous}->${head}`, source: previous, target: head, sourceHandle: previous === 'start' ? 'out' : 'right', targetHandle: 'left', order, arrow: true })
    const headAnchor: Anchor = { id: head, x, y: 0, width: frameWidth, height: HEADER_H, out: 'down', into: 'left' }
    const laid = layoutColumn({ ...column, x: x + FRAME_PAD, y: HEADER_H + HEAD_GAP, head: headAnchor, order: order + 1 }, size, false)
    merge(laid)
    order = laid.nextOrder + 1
    previous = head
    x += frameWidth + COLUMN_GAP
  })
  const end: LaidPoint = { id: 'end', x: x - COLUMN_GAP + PORT_GAP - PORT, y: HEADER_H / 2 - PORT / 2 }
  out.edges.push({ id: `${previous}->end`, source: previous, target: 'end', sourceHandle: previous === 'start' ? 'out' : 'right', targetHandle: 'in', order, arrow: false })
  return { ...out, ports: { start, end }, width: end.x + PORT, height: frameHeight }
}
