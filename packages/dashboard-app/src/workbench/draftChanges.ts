import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { definitionForWrite } from './workbenchDefinition'

type Branch = { label?: string; documentContract?: unknown; steps: readonly WbStepDef[] }

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** 一条分支里的改动数：每个增 / 删 / 改过的阶段 1 处，阶段换了顺序 1 处，名称、文档契约各 1 处。 */
function branchChanges(before: Branch, after: Branch): number {
  let count = 0
  if (before.label !== after.label) count += 1
  if (!same(before.documentContract, after.documentContract)) count += 1
  const previous = new Map(before.steps.map((step) => [step.id, step]))
  const next = new Map(after.steps.map((step) => [step.id, step]))
  for (const [id, step] of next) {
    const old = previous.get(id)
    if (old === undefined || !same(old, step)) count += 1
  }
  for (const id of previous.keys()) if (!next.has(id)) count += 1
  const kept = (steps: readonly WbStepDef[], other: Map<string, WbStepDef>): string[] => steps.filter((step) => other.has(step.id)).map((step) => step.id)
  if (!same(kept(before.steps, next), kept(after.steps, previous))) count += 1
  return count
}

/**
 * 草稿相对上次保存的「未保存 N 处」：按阶段 / 轨道 / 工作流级字段计数，而不是按 JSON 字节。
 * 读接口附带的 source / effectiveIo / branches 不算（写回前本来就剔除）。
 */
export function countDraftChanges(baseline: WbWorkflowDef | null, draft: WbWorkflowDef | null): number {
  if (baseline === null || draft === null) return 0
  const before = definitionForWrite(baseline)
  const after = definitionForWrite(draft)
  let count = 0
  const { steps: beforeSteps, tracks: beforeTracks, documentContract: beforeContract, ...beforeRest } = before
  const { steps: afterSteps, tracks: afterTracks, documentContract: afterContract, ...afterRest } = after
  for (const key of new Set([...Object.keys(beforeRest), ...Object.keys(afterRest)])) {
    if (!same((beforeRest as Record<string, unknown>)[key], (afterRest as Record<string, unknown>)[key])) count += 1
  }
  count += branchChanges({ documentContract: beforeContract, steps: beforeSteps }, { documentContract: afterContract, steps: afterSteps })
  const previousTracks = beforeTracks ?? {}
  const nextTracks = afterTracks ?? {}
  for (const id of new Set([...Object.keys(previousTracks), ...Object.keys(nextTracks)])) {
    const old = previousTracks[id]
    const now = nextTracks[id]
    if (old === undefined || now === undefined) count += 1
    else count += branchChanges(old, now)
  }
  return count
}
