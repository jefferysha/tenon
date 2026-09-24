import type { Edge } from '@xyflow/react'
import type { WbSkillRef } from '../api/governanceTypes'
import { wavesOf } from '../workbench/skillWaves'
import { NODE_WIDTH } from './skillFlowNodes'

const COLUMN_GAP = 300
const PADDING = 24
const PORT_GAP = 72
/** 波次标签在节点上方占的高度（标签 y = 节点 y − 22）。 */
const WAVE_LABEL = 22
/** 只读画布内容上下各留的空白（容纳起点 / 终点的说明字与取景余量）。 */
const CANVAS_MARGIN = 48
export const CANVAS_MIN_HEIGHT = 224

/** 节点高度：名称一行 40，每多一行（评审者设置 / 运行状态）+20。节点不再放描述。 */
export function nodeHeightFor(lines: number): number {
  return 40 + 20 * Math.max(0, lines - 1)
}

/** 同一波内相邻节点的行距 = 节点高 + 24。 */
export function rowGapFor(lines: number): number {
  return nodeHeightFor(lines) + 24
}

/** 最高一波的节点数（= 画布要容纳的行数）。 */
export function lanesOf(skills: readonly WbSkillRef[]): number {
  return Math.max(0, ...wavesOf(skills).map((wave) => wave.length))
}

/**
 * 只读画布按 1:1 显示，所以高度由内容决定：波次标签 + (行数 − 1) × 行距 + 节点高 + 上下留白，至少 224。
 * 画布不缩放，字永远是设计刻度上的字号；宽度不够时横向拖动。
 */
export function canvasHeight(lanes: number, lines = 1): number {
  const content = WAVE_LABEL + Math.max(0, lanes - 1) * rowGapFor(lines) + nodeHeightFor(lines)
  return Math.max(CANVAS_MIN_HEIGHT, content + 2 * CANVAS_MARGIN)
}

/**
 * 只读画布的视口：缩放恒为 1，纵向居中；内容比画布窄就横向居中，宽了就从起点对齐（留 pad），
 * 其余靠横向拖动——居中会把起点切掉。
 */
export function readOnlyViewport(
  bounds: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  pad = PADDING,
): { x: number; y: number; zoom: 1 } {
  const y = (size.height - bounds.height) / 2 - bounds.y
  const x = bounds.width + 2 * pad <= size.width ? (size.width - bounds.width) / 2 - bounds.x : pad - bounds.x
  return { x, y, zoom: 1 }
}

export function layoutSkills(skills: readonly WbSkillRef[], lines = 1): Array<{ id: string; x: number; y: number }> {
  const out: Array<{ id: string; x: number; y: number }> = []
  const waves = wavesOf(skills)
  const tallest = Math.max(0, ...waves.map((wave) => wave.length))
  const rowGap = rowGapFor(lines)
  waves.forEach((wave, column) => {
    const offset = ((tallest - wave.length) * rowGap) / 2
    wave.forEach((id, row) => out.push({ id, x: PADDING + PORT_GAP + column * COLUMN_GAP, y: PADDING + 28 + offset + row * rowGap }))
  })
  return out
}

export function isColumnLink(previous: readonly string[], next: readonly string[], edges: readonly Pick<Edge, 'source' | 'target'>[]): boolean {
  if (previous.length === 0 || next.length === 0) return false
  const previousSet = new Set(previous)
  const nextSet = new Set(next)
  for (const id of next) {
    const deps = edges.filter((edge) => edge.target === id).map((edge) => edge.source)
    if (deps.length !== previous.length || !deps.every((dep) => previousSet.has(dep))) return false
  }
  return edges.filter((edge) => previousSet.has(edge.source)).every((edge) => nextSet.has(edge.target))
}

export function edgesOf(skills: readonly WbSkillRef[]): Edge[] {
  const ids = new Set(skills.map((skill) => skill.id))
  return skills.flatMap((skill) => (skill.depends_on ?? []).filter((dependency) => ids.has(dependency)).map((dependency) => ({ id: `${dependency}->${skill.id}`, source: dependency, target: skill.id })))
}

export function wouldCycle(edges: readonly Pick<Edge, 'source' | 'target'>[], source: string, target: string): boolean {
  if (source === target) return true
  const next = new Map<string, string[]>()
  for (const edge of edges) next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target])
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    if (current === source) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(next.get(current) ?? []))
  }
  return false
}

export function graphToSkills(nodeIds: readonly string[], edges: readonly Pick<Edge, 'source' | 'target'>[], existing: readonly WbSkillRef[]): WbSkillRef[] {
  const byId = new Map(existing.map((skill) => [skill.id, skill]))
  const ids = new Set(nodeIds)
  const rank = (id: string): number => { const index = existing.findIndex((skill) => skill.id === id); return index === -1 ? existing.length : index }
  const ordered = [...nodeIds].sort((a, b) => rank(a) - rank(b))
  const draft = ordered.map((id) => {
    const { depends_on: _dropped, ...rest } = byId.get(id) ?? { id }
    const deps = edges.filter((edge) => edge.target === id && ids.has(edge.source)).map((edge) => edge.source)
    return deps.length > 0 ? { ...rest, id, depends_on: deps } : { ...rest, id }
  })
  const order = wavesOf(draft).flat()
  return order.flatMap((id) => { const skill = draft.find((candidate) => candidate.id === id); return skill === undefined ? [] : [skill] })
}

export type DropTarget = { kind: 'join'; wave: number } | { kind: 'after' } | { kind: 'before' }
export function dropTargetFor(x: number, columnXs: readonly number[]): DropTarget {
  if (columnXs.length === 0) return { kind: 'after' }
  const first = columnXs[0]
  const last = columnXs[columnXs.length - 1]
  if (first === undefined || last === undefined) return { kind: 'after' }
  if (x > last + NODE_WIDTH + PORT_GAP / 2) return { kind: 'after' }
  if (x < first - PORT_GAP / 2) return { kind: 'before' }
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  columnXs.forEach((columnX, index) => { const distance = Math.abs(x - (columnX + NODE_WIDTH / 2)); if (distance < bestDistance) { bestDistance = distance; best = index } })
  return { kind: 'join', wave: best }
}

export function addSkillAt(skills: readonly WbSkillRef[], id: string, target: DropTarget): WbSkillRef[] {
  if (skills.some((skill) => skill.id === id)) return [...skills]
  const waves = wavesOf(skills)
  const withDeps = (deps: readonly string[]): WbSkillRef => deps.length > 0 ? { id, depends_on: [...deps] } : { id }
  const addDep = (skill: WbSkillRef, dep: string): WbSkillRef => ({ ...skill, depends_on: [...new Set([...(skill.depends_on ?? []), dep])] })
  if (target.kind === 'after' || waves.length === 0) return [...skills, withDeps(waves[waves.length - 1] ?? [])]
  if (target.kind === 'before') {
    const firstWave = new Set(waves[0] ?? [])
    return [withDeps([]), ...skills.map((skill) => firstWave.has(skill.id) ? addDep(skill, id) : skill)]
  }
  const wave = Math.max(0, Math.min(target.wave, waves.length - 1))
  const nextWave = new Set(waves[wave + 1] ?? [])
  const out = skills.map((skill) => nextWave.has(skill.id) ? addDep(skill, id) : skill)
  const waveSkills = waves[wave]
  const anchor = waveSkills?.[waveSkills.length - 1]
  if (anchor === undefined) return out
  out.splice(out.findIndex((skill) => skill.id === anchor) + 1, 0, withDeps(waves[wave - 1] ?? []))
  return out
}

export function appendSerial(skills: readonly WbSkillRef[], id: string): WbSkillRef[] { return addSkillAt(skills, id, { kind: 'after' }) }
export function skillsSignature(skills: readonly WbSkillRef[]): string { return skills.map((skill) => `${skill.id}<${[...(skill.depends_on ?? [])].sort().join(',')}`).join('|') }
