import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { definitionForWrite } from './workbenchDefinition'

type Branch = { label?: string; spec?: string; route?: unknown; steps: readonly WbStepDef[] }

/** 与键顺序无关的比较：服务端读回与草稿重建的对象键序可能不同，不能因此多算一处。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function same(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

/**
 * 一条分支里被改动的单位（加进 units）：每个增 / 删 / 改过的阶段一处，阶段换了顺序一处，分支名称、规范、路由各一处。
 * 增删与排序会顺带改写相邻阶段的转移（接上流程），这些连带改动不另算；
 * 结构没变时，某阶段的转移变化（退回目标）照常算在该阶段上。
 */
function collectBranch(units: Set<string>, prefix: string, before: Branch, after: Branch): void {
  if ((before.label ?? '') !== (after.label ?? '')) units.add(`${prefix}label`)
  if ((before.spec ?? '') !== (after.spec ?? '')) units.add(`${prefix}spec`)
  if (!same(before.route, after.route)) units.add(`${prefix}route`)
  const previous = new Map(before.steps.map((step) => [step.id, step]))
  const next = new Map(after.steps.map((step) => [step.id, step]))
  const added = after.steps.some((step) => !previous.has(step.id))
  const removed = before.steps.some((step) => !next.has(step.id))
  const kept = (steps: readonly WbStepDef[], other: Map<string, WbStepDef>): string[] => steps.filter((step) => other.has(step.id)).map((step) => step.id)
  const reordered = !same(kept(before.steps, next), kept(after.steps, previous))
  if (reordered) units.add(`${prefix}order`)
  const structural = added || removed || reordered
  for (const [id, step] of next) {
    const old = previous.get(id)
    if (old === undefined) { units.add(`${prefix}step:${id}`); continue }
    const { transitions: oldTransitions, ...oldRest } = old
    const { transitions: newTransitions, ...newRest } = step
    if (!same(oldRest, newRest) || (!structural && !same(oldTransitions, newTransitions))) units.add(`${prefix}step:${id}`)
  }
  for (const id of previous.keys()) if (!next.has(id)) units.add(`${prefix}step:${id}`)
}

/**
 * 草稿相对上次保存的「未保存 N 处」：按阶段 / 轨道 / 工作流级字段计数，而不是按 JSON 字节。
 * 读接口附带的 source / branches 不算（写回前本来就剔除）。OpenSpec 开关本身算一处。
 */
export function countDraftChanges(baseline: WbWorkflowDef | null, draft: WbWorkflowDef | null): number {
  if (baseline === null || draft === null) return 0
  const before = definitionForWrite(baseline)
  const after = definitionForWrite(draft)
  const units = new Set<string>()
  const { steps: beforeSteps, tracks: beforeTracks, ...beforeRest } = before
  const { steps: afterSteps, tracks: afterTracks, ...afterRest } = after
  for (const key of new Set([...Object.keys(beforeRest), ...Object.keys(afterRest)])) {
    if (!same((beforeRest as Record<string, unknown>)[key], (afterRest as Record<string, unknown>)[key])) units.add(`wf:${key}`)
  }
  collectBranch(units, '', { steps: beforeSteps }, { steps: afterSteps })
  const previousTracks = beforeTracks ?? {}
  const nextTracks = afterTracks ?? {}
  for (const id of new Set([...Object.keys(previousTracks), ...Object.keys(nextTracks)])) {
    const old = previousTracks[id]
    const now = nextTracks[id]
    if (old === undefined || now === undefined) units.add(`track:${id}`)
    else collectBranch(units, `track:${id}:`, old, now)
  }
  return units.size
}
