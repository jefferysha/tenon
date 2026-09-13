import type { Edge } from '@xyflow/react'
import type { WbSkillRef } from '../api/governanceTypes'
import { wavesOf } from '../workbench/skillWaves'
import { NODE_WIDTH } from './skillFlowNodes'

const COLUMN_GAP = 300
const ROW_GAP = 92
const PADDING = 24
const PORT_GAP = 72

export function layoutSkills(skills: readonly WbSkillRef[]): Array<{ id: string; x: number; y: number }> {
  const out: Array<{ id: string; x: number; y: number }> = []
  const waves = wavesOf(skills)
  const tallest = Math.max(0, ...waves.map((wave) => wave.length))
  waves.forEach((wave, column) => {
    const offset = ((tallest - wave.length) * ROW_GAP) / 2
    wave.forEach((id, row) => out.push({ id, x: PADDING + PORT_GAP + column * COLUMN_GAP, y: PADDING + 28 + offset + row * ROW_GAP }))
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
