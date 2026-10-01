/**
 * 编排画布的纯布局：总览 = 每个阶段一条列带（标题行 + 4% 色带，高度贴内容），阶段 = 单列、左对齐、泳道标签是节点上方的分组标题；
 * 列内按执行位次自上而下，同一位次的并行条目在列内纵向堆叠（列宽恒为一个条目宽，验证这类并行很多的阶段也不会撑宽）。
 * 只算坐标与连线，不碰 React Flow。
 *
 * 连线（阶段画布）：同身份的直接前置照画；位次之间 / 身份之间（执行者 → 技能 → 测试 → 评审者）上一组的末端接下一组的起点，
 * 一对一直连，一对多 / 多对一 / 多对多经列外左右两条轨道上的汇合点（见 orchestrationRouting），不穿过条目；起点在列顶、终点在列底。
 * 连线（总览）：每列一根竖脊柱，过所有条目的左端口 x，向每个条目伸一根 8px 短线；并行的一波在脊柱侧画一根 2px 括号条，
 * 各组顺着脊柱相连；阶段标题连成一条主线（起点 → 阶段 1 → … → 终点），每列的脊柱从标题往下走，入口一个箭头。
 * 信号沿这些边流动，先后由到达距离决定（见 flowSignal）：总览里主线的下一跳标着 after（上一列的末端），
 * 信号按真实执行顺序一列一列过——进一列、走完这一列、再去下一列；总览里彗星只沿脊柱走，短线不带彗星。
 */
import type { OrchestrationKind, OrchestrationReturn } from '@tenon/kernel/workflow/orchestration'
import type { FlowEntry, FlowStage } from '../api/workflowOrchestrationClient'
import { RAIL, connect, type Anchor, type LaidEdge, type LaidPoint } from './orchestrationRouting'

export type { LaidEdge, LaidPoint } from './orchestrationRouting'
export type FlowMode = 'overview' | 'stage'

export const KIND_ORDER: readonly OrchestrationKind[] = ['executor', 'skill', 'test', 'reviewer']
export const PORT = 12
export const HEADER_H = 40
/** 起点到第一列、最后一列到终点之间的主线长度。 */
const PORT_GAP = 32
/** 列带与列带之间：主线在这里露出来。 */
const COLUMN_GAP = 28
/** 总览列带的左右内边距；脊柱在条目左侧 SPINE_OFFSET 处，离带边缘还有 4px。 */
export const BAND_PAD = 12
/** 脊柱到条目左缘的距离，也是短线的长度。 */
export const SPINE_OFFSET = 8
/** 列带底部留白。 */
const BAND_FOOT = 12
/** 阶段标题到第一组条目。 */
const HEAD_GAP: Record<FlowMode, number> = { overview: 12, stage: 20 }
/** 同身份相邻位次之间：阶段里汇合点轨道落在这段空隙里；总览里只是行距。 */
const ROW_GAP: Record<FlowMode, number> = { overview: 12, stage: 24 }
/** 同一位次的并行条目之间。 */
const SIB_GAP = 8
/** 并行一波的括号条：宽 2px，比条目的上下沿各缩进 4px。 */
const BRACKET_W = 2
const BRACKET_INSET = 4
/** 身份与身份之间：总览里紧凑，阶段里要给分组标题留出呼吸。 */
const LANE_GAP: Record<FlowMode, number> = { overview: 20, stage: 32 }
/** 阶段画布：分组标题的高度，以及它与第一个条目之间的间隙。 */
export const LANE_HEAD_H = 24
const LANE_HEAD_GAP = 8
/** 起点到第一组、最后一组到终点之间（阶段画布）。 */
const END_GAP = 28
/** 回流弧最高拱出阶段标题上方多少（长弧封顶，不让它把画布顶得太高）。 */
const RETURN_LIFT_MAX = 90

/** 总览节点视觉 32px、宽 168（点击热区由样式补到 40px）；阶段画布节点 40px、宽 320。 */
export function entrySize(mode: FlowMode): { width: number; height: number } {
  return mode === 'overview' ? { width: 168, height: 32 } : { width: 320, height: 40 }
}

/** 回流弧的拱高：跨得越远拱得越高，封顶 RETURN_LIFT_MAX。 */
export function returnLift(distance: number): number {
  return Math.min(RETURN_LIFT_MAX, 28 + Math.abs(distance) * 0.12)
}

export interface LaidEntry { readonly id: string; readonly stage: string; readonly entry: FlowEntry; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface LaidStage { readonly id: string; readonly index: number; readonly stage: FlowStage; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface LaidLane { readonly id: string; readonly kind: OrchestrationKind; readonly count: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** 总览里并行一波的括号条：2px 宽，贴在脊柱位置，从这一波第一个条目铺到最后一个。 */
export interface LaidBracket { readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** 可编辑的阶段画布里，空泳道留一个幽灵「＋」占位。 */
export interface LaidGhost { readonly id: string; readonly kind: OrchestrationKind; readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface OrchestrationLayout {
  readonly stages: readonly LaidStage[]
  readonly entries: readonly LaidEntry[]
  readonly lanes: readonly LaidLane[]
  readonly ghosts: readonly LaidGhost[]
  readonly junctions: readonly LaidPoint[]
  readonly brackets: readonly LaidBracket[]
  readonly ports: { readonly start: LaidPoint; readonly end: LaidPoint }
  readonly edges: readonly LaidEdge[]
  readonly width: number
  readonly height: number
}

/** 回流弧要在阶段框上方留多少空间（没有回流 = 0）。三次贝塞尔的最高点是控制点高度的 75%，按实际峰值留，顶部留白才是整 24px。 */
export function returnHeadroom(layout: OrchestrationLayout, returns: readonly OrchestrationReturn[]): number {
  const center = new Map(layout.stages.map((stage) => [stage.stage.id, stage.x + stage.width / 2]))
  return Math.max(0, ...returns.flatMap((item) => {
    const from = center.get(item.from)
    const to = center.get(item.to)
    return from === undefined || to === undefined ? [] : [returnLift(from - to) * 0.75]
  }))
}

export function entryNodeId(stage: string, entry: Pick<FlowEntry, 'kind' | 'id'>): string {
  return `e:${stage}:${entry.kind}:${entry.id}`
}
export function stageNodeId(stage: string): string {
  return `s:${stage}`
}

interface Group { readonly kind: OrchestrationKind; readonly rows: readonly (readonly FlowEntry[])[] }

/** 列内分组：按身份顺序，每组内按位次成行。空身份只在 `keepEmpty` 里才留（可编辑的阶段画布放「＋」占位）。 */
function groupsOf(stage: FlowStage, keepEmpty: ReadonlySet<OrchestrationKind>): Group[] {
  return KIND_ORDER.map((kind) => {
    const entries = stage.entries.filter((entry) => entry.kind === kind)
    const waves = [...new Set(entries.map((entry) => entry.wave))].sort((a, b) => a - b)
    return { kind, rows: waves.map((wave) => entries.filter((entry) => entry.wave === wave)) }
  }).filter((group) => group.rows.length > 0 || keepEmpty.has(group.kind))
}

function groupHeight(group: Group, height: number, mode: FlowMode): number {
  const head = mode === 'stage' ? LANE_HEAD_H + LANE_HEAD_GAP : 0
  if (group.rows.length === 0) return head + height
  const cells = group.rows.reduce((sum, row) => sum + row.length * height + (row.length - 1) * SIB_GAP, 0)
  return head + cells + (group.rows.length - 1) * ROW_GAP[mode]
}

function columnHeight(groups: readonly Group[], height: number, mode: FlowMode): number {
  return groups.reduce((sum, group, index) => sum + (index > 0 ? LANE_GAP[mode] : 0) + groupHeight(group, height, mode), 0)
}

interface ColumnInput {
  readonly stage: FlowStage
  readonly groups: readonly Group[]
  readonly x: number
  readonly y: number
  readonly head: Anchor
}

interface ColumnOutput {
  readonly entries: LaidEntry[]
  readonly lanes: LaidLane[]
  readonly ghosts: LaidGhost[]
  readonly junctions: LaidPoint[]
  readonly edges: LaidEdge[]
  /** 列内最后一组的末端（没有条目时为列头）。 */
  readonly tail: readonly Anchor[]
}

function anchorOf(item: LaidEntry): Anchor {
  return { id: item.id, x: item.x, y: item.y, width: item.width, height: item.height, out: 'bottom', into: 'top' }
}

interface Dependency { readonly from: LaidEntry; readonly to: LaidEntry }

function layoutColumn(input: ColumnInput, mode: FlowMode): ColumnOutput {
  const size = entrySize(mode)
  const lanes = mode === 'stage'
  const out = { entries: [] as LaidEntry[], lanes: [] as LaidLane[], ghosts: [] as LaidGhost[], junctions: [] as LaidPoint[], edges: [] as LaidEdge[] }
  const leftRail = input.x - RAIL
  const rightRail = input.x + size.width + RAIL
  let tail: readonly Anchor[] = [input.head]
  let y = input.y
  input.groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) y += LANE_GAP[mode]
    const laneY = y
    if (lanes) y += LANE_HEAD_H + LANE_HEAD_GAP
    const rows: LaidEntry[][] = group.rows.map((row, rowIndex) => {
      if (rowIndex > 0) y += ROW_GAP[mode]
      return row.map((entry, position) => {
        if (position > 0) y += SIB_GAP
        const placed: LaidEntry = { id: entryNodeId(input.stage.id, entry), stage: input.stage.id, entry, x: input.x, y, width: size.width, height: size.height }
        y += size.height
        return placed
      })
    })
    if (rows.length === 0) {
      if (lanes) out.ghosts.push({ id: `g:${group.kind}`, kind: group.kind, x: input.x, y, width: size.width, height: size.height })
      y += size.height
    }
    const placed = rows.flat()
    if (lanes) out.lanes.push({ id: `l:${group.kind}`, kind: group.kind, count: placed.length, x: input.x, y: laneY, width: size.width, height: LANE_HEAD_H })
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
    const entering = connect({ from: tail, to: placed.filter((item) => !dependent.has(item.id)).map(anchorOf), junction: `${prefix}:0`, leftRail, rightRail })
    out.edges.push(...entering.edges)
    out.junctions.push(...entering.junctions)

    // 相邻位次：前置相同的目标归成一组，一组一次连线（一对一直连，一对多 / 多对一 / 多对多经轨道上的汇合点）。
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
      let number = 0
      for (const group of groups.values()) {
        const junction = groups.size === 1 ? `${prefix}:${index}` : `${prefix}:${index}.${number}`
        const connection = connect({ from: group.from.map(anchorOf), to: group.to.map(anchorOf), junction, leftRail, rightRail })
        out.edges.push(...connection.edges)
        out.junctions.push(...connection.junctions)
        number += 1
      }
      for (const dep of between) drawn.add(`${dep.from.id}->${dep.to.id}`)
    })
    // 跨位次的依赖（少见）：直连。
    for (const dep of deps) if (!drawn.has(`${dep.from.id}->${dep.to.id}`)) out.edges.push(directEdge(dep))

    tail = placed.filter((item) => !dependedOn.has(item.id)).map(anchorOf)
  })
  return { ...out, tail }
}

interface SpineInput { readonly stage: FlowStage; readonly groups: readonly Group[]; readonly x: number; readonly y: number; readonly head: string }
interface SpineOutput {
  readonly entries: LaidEntry[]
  readonly junctions: LaidPoint[]
  readonly brackets: LaidBracket[]
  readonly edges: LaidEdge[]
  /** 这一列走完的末端（最后一行的条目 id）。 */
  readonly tail: string[]
}

/**
 * 总览的一列：一根竖脊柱（列头 → 各条目中心高度的汇合点 → …）过所有条目的左端口 x 的左侧 SPINE_OFFSET，
 * 每个条目一根 8px 短线；并行的一波（同一行多个条目）在脊柱位置画一根 2px 括号条；各组顺着脊柱相连，不再有扇出 / 汇入的轨道。
 * 列头到脊柱的入口是这一列唯一的箭头。
 */
function layoutSpineColumn(input: SpineInput): SpineOutput {
  const size = entrySize('overview')
  const nodeX = input.x + BAND_PAD
  const spineX = nodeX - SPINE_OFFSET
  const out: SpineOutput = { entries: [], junctions: [], brackets: [], edges: [], tail: [] }
  let last = input.head
  let y = input.y
  input.groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) y += LANE_GAP.overview
    group.rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) y += ROW_GAP.overview
      const wave: LaidEntry[] = []
      row.forEach((entry, position) => {
        if (position > 0) y += SIB_GAP
        const item: LaidEntry = { id: entryNodeId(input.stage.id, entry), stage: input.stage.id, entry, x: nodeX, y, width: size.width, height: size.height }
        y += size.height
        wave.push(item)
        const junction = `sp:${input.stage.id}:${out.junctions.length}`
        out.junctions.push({ id: junction, x: spineX - 1, y: item.y + item.height / 2 - 1, spine: true, owner: item.id })
        const entering = last === input.head
        out.edges.push({ id: `${last}->${junction}`, source: last, target: junction, sourceHandle: entering ? 'spine' : 'bottom', targetHandle: 'top', arrow: entering, ...(entering ? { lead: HEADER_H } : {}) })
        out.edges.push({ id: `${junction}->${item.id}`, source: junction, target: item.id, sourceHandle: 'right', targetHandle: 'left', arrow: false, stub: true })
        last = junction
      })
      out.entries.push(...wave)
      const first = wave[0]
      const final = wave[wave.length - 1]
      if (wave.length > 1 && first !== undefined && final !== undefined) {
        const top = first.y + BRACKET_INSET
        out.brackets.push({ id: `br:${input.stage.id}:${out.brackets.length}`, x: spineX - BRACKET_W / 2, y: top, width: BRACKET_W, height: final.y + final.height - BRACKET_INSET - top })
      }
      out.tail.splice(0, out.tail.length, ...wave.map((item) => item.id))
    })
  })
  return out
}

function directEdge(dep: Dependency): LaidEdge {
  return { id: `${dep.from.id}->${dep.to.id}`, source: dep.from.id, target: dep.to.id, sourceHandle: 'bottom', targetHandle: 'top', arrow: false }
}

/** `showEmpty` 只对阶段模式有意义：列出要留「＋」占位的空泳道（可编辑且该泳道有动作）。 */
export function layoutOrchestration(
  stages: readonly FlowStage[],
  mode: FlowMode,
  options: { readonly showEmpty?: readonly OrchestrationKind[] } = {},
): OrchestrationLayout {
  const size = entrySize(mode)
  const keepEmpty = new Set(mode === 'stage' ? options.showEmpty ?? [] : [])
  const grouped = stages.map((stage) => ({ stage, groups: groupsOf(stage, keepEmpty) }))
  const out = { stages: [] as LaidStage[], entries: [] as LaidEntry[], lanes: [] as LaidLane[], ghosts: [] as LaidGhost[], junctions: [] as LaidPoint[], brackets: [] as LaidBracket[], edges: [] as LaidEdge[] }
  const merge = (column: ColumnOutput): void => {
    out.entries.push(...column.entries)
    out.lanes.push(...column.lanes)
    out.ghosts.push(...column.ghosts)
    out.junctions.push(...column.junctions)
    out.edges.push(...column.edges)
  }

  if (mode === 'stage') {
    const single = grouped[0]
    const start: LaidPoint = { id: 'start', x: size.width / 2 - PORT / 2, y: 0 }
    const startAnchor: Anchor = { id: 'start', x: start.x, y: 0, width: PORT, height: PORT, out: 'out', into: 'in' }
    const column = single === undefined ? null : layoutColumn({ ...single, x: 0, y: PORT + END_GAP, head: startAnchor }, mode)
    if (column !== null) merge(column)
    const bottom = Math.max(PORT + END_GAP, ...out.entries.map((entry) => entry.y + entry.height), ...out.lanes.map((lane) => lane.y + lane.height), ...out.ghosts.map((ghost) => ghost.y + ghost.height))
    const end: LaidPoint = { id: 'end', x: start.x, y: bottom + END_GAP }
    const endAnchor: Anchor = { id: 'end', x: end.x, y: end.y, width: PORT, height: PORT, out: 'out', into: 'in' }
    const closing = connect({ from: column?.tail ?? [startAnchor], to: [endAnchor], junction: 'j:end', leftRail: -RAIL, rightRail: size.width + RAIL })
    // 终点是整条线唯一的方向提示：箭头只放在汇入终点的那一跳。
    out.edges.push(...closing.edges.map((item) => (item.target === 'end' ? { ...item, arrow: true } : item)))
    out.junctions.push(...closing.junctions)
    return { ...out, ports: { start, end }, width: size.width, height: end.y + PORT }
  }

  const bandWidth = size.width + 2 * BAND_PAD
  const start: LaidPoint = { id: 'start', x: 0, y: HEADER_H / 2 - PORT / 2 }
  let x = PORT + PORT_GAP
  let previous = 'start'
  /** 上一列走完的末端：主线的下一跳要等它们。 */
  let previousTail: string[] = []
  let height = HEADER_H
  grouped.forEach((column, index) => {
    const head = stageNodeId(column.stage.id)
    const bandHeight = HEADER_H + HEAD_GAP.overview + columnHeight(column.groups, size.height, mode) + BAND_FOOT
    height = Math.max(height, bandHeight)
    out.stages.push({ id: head, index, stage: column.stage, x, y: 0, width: bandWidth, height: bandHeight })
    out.edges.push({ id: `${previous}->${head}`, source: previous, target: head, sourceHandle: previous === 'start' ? 'out' : 'right', targetHandle: 'left', arrow: false, after: previousTail })
    const laid = layoutSpineColumn({ stage: column.stage, groups: column.groups, x, y: HEADER_H + HEAD_GAP.overview, head })
    out.entries.push(...laid.entries)
    out.junctions.push(...laid.junctions)
    out.brackets.push(...laid.brackets)
    out.edges.push(...laid.edges)
    previousTail = laid.tail
    previous = head
    x += bandWidth + COLUMN_GAP
  })
  const end: LaidPoint = { id: 'end', x: x - COLUMN_GAP + PORT_GAP, y: HEADER_H / 2 - PORT / 2 }
  out.edges.push({ id: `${previous}->end`, source: previous, target: 'end', sourceHandle: previous === 'start' ? 'out' : 'right', targetHandle: 'in', arrow: true, after: previousTail })
  return { ...out, ports: { start, end }, width: end.x + PORT, height }
}
