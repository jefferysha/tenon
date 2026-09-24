import type { WbDocumentContract, WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { definitionForWrite } from './workbenchDefinition'

type Branch = { label?: string; documentContract?: WbDocumentContract; steps: readonly WbStepDef[] }

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

/** 文档契约里归属某阶段的那部分（产出槽位 + 读取声明）。 */
function contractOf(contract: WbDocumentContract | undefined, stepId: string): unknown {
  return {
    slots: (contract?.slots ?? []).filter((slot) => slot.ownerStep === stepId).map(stableJson).sort(),
    reads: (contract?.reads ?? []).filter((read) => read.step === stepId).map(stableJson).sort(),
  }
}

/**
 * 一条分支里被改动的单位（加进 units）：每个增 / 删 / 改过的阶段一处，阶段换了顺序一处，分支名称一处。
 * 文档契约的改动记到它所属的阶段上。增删与排序会顺带改写相邻阶段的转移（接上流程），这些连带改动不另算；
 * 结构没变时，某阶段的转移变化（退回目标）照常算在该阶段上。
 */
function collectBranch(units: Set<string>, prefix: string, before: Branch, after: Branch, contractFollowsToggle: boolean): void {
  if ((before.label ?? '') !== (after.label ?? '')) units.add(`${prefix}label`)
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
    if (!contractFollowsToggle && !same(contractOf(before.documentContract, id), contractOf(after.documentContract, id))) units.add(`${prefix}step:${id}`)
  }
  for (const id of previous.keys()) if (!next.has(id)) units.add(`${prefix}step:${id}`)
}

/**
 * 草稿相对上次保存的「未保存 N 处」：按阶段 / 轨道 / 工作流级字段计数，而不是按 JSON 字节。
 * 读接口附带的 source / effectiveIo / branches 不算（写回前本来就剔除）。OpenSpec 开关本身算一处，
 * 它顺带清空或补上的文档契约不再逐阶段重复计数。
 */
export function countDraftChanges(baseline: WbWorkflowDef | null, draft: WbWorkflowDef | null): number {
  if (baseline === null || draft === null) return 0
  const before = definitionForWrite(baseline)
  const after = definitionForWrite(draft)
  const units = new Set<string>()
  const { steps: beforeSteps, tracks: beforeTracks, documentContract: beforeContract, ...beforeRest } = before
  const { steps: afterSteps, tracks: afterTracks, documentContract: afterContract, ...afterRest } = after
  for (const key of new Set([...Object.keys(beforeRest), ...Object.keys(afterRest)])) {
    if (!same((beforeRest as Record<string, unknown>)[key], (afterRest as Record<string, unknown>)[key])) units.add(`wf:${key}`)
  }
  const toggled = units.has('wf:openspec')
  collectBranch(units, '', { documentContract: beforeContract, steps: beforeSteps }, { documentContract: afterContract, steps: afterSteps }, toggled)
  const previousTracks = beforeTracks ?? {}
  const nextTracks = afterTracks ?? {}
  for (const id of new Set([...Object.keys(previousTracks), ...Object.keys(nextTracks)])) {
    const old = previousTracks[id]
    const now = nextTracks[id]
    if (old === undefined || now === undefined) units.add(`track:${id}`)
    else collectBranch(units, `track:${id}:`, old, now, toggled)
  }
  return units.size
}
