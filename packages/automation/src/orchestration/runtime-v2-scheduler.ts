import type { BoardSnapshotV2, CapabilityResolutionV2, WorkItemV2 } from '@tenon/kernel'
import type { NormalizedPolicyV2 } from './runtime-v2-boundary.js'

export function bindingFor(snapshot: BoardSnapshotV2, item: WorkItemV2): CapabilityResolutionV2['bindings'][number] | undefined {
  return snapshot.resolution?.bindings.find((binding) => binding.work_item_id === item.work_item_id)
}

export function resultInputRefs(snapshot: BoardSnapshotV2, item: WorkItemV2): readonly string[] {
  const refs: string[] = []
  for (const dependency of item.depends_on) {
    const depItem = snapshot.work_items.find((candidate) => candidate.work_item_id === dependency)
    const run = depItem?.active_run_id === undefined
      ? snapshot.runs.filter((candidate) => candidate.work_item_id === dependency && candidate.status === 'completed').at(-1)
      : snapshot.runs.find((candidate) => candidate.run_id === depItem.active_run_id)
    const result = run?.result_id === undefined ? undefined : snapshot.results.find((candidate) => candidate.result_id === run.result_id)
    if (result !== undefined) {
      refs.push(`skill-result:${result.result_id}`)
      if (result.raw_output !== undefined) refs.push(result.raw_output.ref)
      refs.push(...result.artifacts.map((artifact) => artifact.ref))
    }
  }
  return Object.freeze(refs)
}

function activeOrQueued(item: WorkItemV2): boolean { return item.status === 'ready' || item.status === 'queued' }
function groupFor(snapshot: BoardSnapshotV2, item: WorkItemV2): { readonly mode: 'serial' | 'parallel'; readonly ids: readonly string[] } | undefined {
  const group = snapshot.graph?.execution_groups.find((candidate) => candidate.work_item_ids.includes(item.work_item_id))
  return group === undefined ? undefined : { mode: group.mode, ids: group.work_item_ids }
}
export function pipelineStageFor(snapshot: BoardSnapshotV2, item: WorkItemV2) { return snapshot.pipeline?.stages.find((stage) => stage.work_item_ids.includes(item.work_item_id)) }

/** Stable pipeline identity used by artifact lineage; work_item_id remains ledger identity. */
export function pipelineStageIdFor(snapshot: BoardSnapshotV2, item: WorkItemV2): string {
  return pipelineStageFor(snapshot, item)?.stage_id ?? item.work_item_id
}

/** Artifact visibility is keyed by stage ids, with legacy work-item fallback. */
export function pipelineDependencyStageIds(snapshot: BoardSnapshotV2, item: WorkItemV2): readonly string[] {
  const stage = pipelineStageFor(snapshot, item)
  const ids = new Set(stage?.depends_on ?? [])
  for (const dependency of item.depends_on) {
    const dependencyItem = snapshot.work_items.find((candidate) => candidate.work_item_id === dependency)
    ids.add(dependencyItem === undefined ? dependency : pipelineStageIdFor(snapshot, dependencyItem))
  }
  for (const dependency of pipelineSkillFor(snapshot, item)?.depends_on ?? []) {
    const dependencyStage = snapshot.pipeline?.stages.find((candidate) => candidate.skills.some((skill) => skill.binding_id === dependency || skill.skill_id === dependency || `skill:${skill.skill_id}` === dependency))
    if (dependencyStage !== undefined) ids.add(dependencyStage.stage_id)
  }
  // Preserve the full declared upstream chain for progressive discovery.
  for (const id of ids) {
    const dependencyStage = snapshot.pipeline?.stages.find((candidate) => candidate.stage_id === id)
    for (const upstream of dependencyStage?.depends_on ?? []) ids.add(upstream)
  }
  return Object.freeze([...ids])
}
export function pipelineSkillFor(snapshot: BoardSnapshotV2, item: WorkItemV2) {
  const stage = pipelineStageFor(snapshot, item)
  const binding = bindingFor(snapshot, item)
  return stage?.skills.find((skill) => skill.skill_id === binding?.skill_id && skill.skill_version === binding?.skill_version)
}
function pipelineRank(snapshot: BoardSnapshotV2, item: WorkItemV2): readonly number[] {
  const pipeline = snapshot.pipeline
  if (pipeline === undefined) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  const stage = pipelineStageFor(snapshot, item)
  const stageIndex = stage === undefined ? -1 : pipeline.stage_order.indexOf(stage.stage_id)
  const skill = pipelineSkillFor(snapshot, item)
  return [stageIndex < 0 ? Number.MAX_SAFE_INTEGER : stageIndex, skill?.order ?? Number.MAX_SAFE_INTEGER]
}
function pipelineDependencyDone(snapshot: BoardSnapshotV2, stage: NonNullable<BoardSnapshotV2['pipeline']>['stages'][number], item: WorkItemV2): boolean {
  const stageById = new Map((snapshot.pipeline?.stages ?? []).map((candidate) => [candidate.stage_id, candidate]))
  for (const dependency of stage.depends_on) {
    const dependencyStage = stageById.get(dependency)
    if (dependencyStage === undefined || dependencyStage.work_item_ids.some((id) => snapshot.work_items.find((candidate) => candidate.work_item_id === id)?.status !== 'completed')) return false
  }
  const skills = snapshot.pipeline?.stages.flatMap((candidate) => candidate.skills) ?? []
  const currentSkill = pipelineSkillFor(snapshot, item)
  if (currentSkill === undefined) return false
  for (const dependency of currentSkill.depends_on) {
    const dependencySkill = skills.find((skill) => skill.binding_id === dependency || skill.skill_id === dependency || `skill:${skill.skill_id}` === dependency)
    if (dependencySkill === undefined) return false
    const dependencyStage = snapshot.pipeline?.stages.find((candidate) => candidate.skills.some((skill) => skill.binding_id === dependencySkill.binding_id))
    const dependencyItem = dependencyStage?.work_item_ids.find((workItemId) => {
      const candidate = snapshot.work_items.find((candidateItem) => candidateItem.work_item_id === workItemId)
      return candidate !== undefined && pipelineSkillFor(snapshot, candidate)?.binding_id === dependencySkill.binding_id
    })
    if (dependencyItem === undefined || snapshot.work_items.find((candidate) => candidate.work_item_id === dependencyItem)?.status !== 'completed') return false
  }
  return true
}
function claimKeysOverlap(left: { readonly kind: string; readonly key: string }, right: { readonly kind: string; readonly key: string }): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind !== 'path') return left.key === right.key
  return left.key === right.key || left.key.startsWith(`${right.key}/`) || right.key.startsWith(`${left.key}/`)
}

function claimsConflict(left: WorkItemV2, right: WorkItemV2, snapshot: BoardSnapshotV2): boolean {
  const leftClaims = pipelineSkillFor(snapshot, left)?.resource_claims ?? []
  const rightClaims = pipelineSkillFor(snapshot, right)?.resource_claims ?? []
  for (const l of leftClaims) for (const r of rightClaims) if (claimKeysOverlap(l, r) && (l.access === 'write' || r.access === 'write')) return true
  return false
}

export function chooseWave(snapshot: BoardSnapshotV2, policy: NormalizedPolicyV2): readonly WorkItemV2[] {
  const candidates = snapshot.work_items.filter(activeOrQueued).sort((left, right) => {
    const leftRank = pipelineRank(snapshot, left); const rightRank = pipelineRank(snapshot, right)
    return (leftRank[0] ?? Number.MAX_SAFE_INTEGER) - (rightRank[0] ?? Number.MAX_SAFE_INTEGER) || (leftRank[1] ?? Number.MAX_SAFE_INTEGER) - (rightRank[1] ?? Number.MAX_SAFE_INTEGER) || left.work_item_id.localeCompare(right.work_item_id)
  })
  const first = candidates[0]
  if (first === undefined) return []
  if (snapshot.pipeline !== undefined) {
    for (const stageId of snapshot.pipeline.stage_order) {
      const stage = snapshot.pipeline.stages.find((candidate) => candidate.stage_id === stageId)
      if (stage === undefined) continue
      const stageItems = candidates.filter((item) => stage.work_item_ids.includes(item.work_item_id))
      const stageHasIncomplete = stage.work_item_ids.some((id) => snapshot.work_items.find((item) => item.work_item_id === id)?.status !== 'completed')
      if (stageHasIncomplete && stageItems.length === 0) return []
      if (stageItems.length === 0) continue
      const ready = stageItems.filter((item) => pipelineDependencyDone(snapshot, stage, item))
      if (ready.length === 0) return []
      const firstReady = ready[0]
      if (firstReady === undefined) return []
      if (stage.execution_mode === 'serial' || pipelineSkillFor(snapshot, firstReady)?.mode === 'serial') return [firstReady]
      const selected: WorkItemV2[] = []
      const active = snapshot.work_items.filter((item) => item.status === 'claimed' || item.status === 'running')
      for (const item of ready) {
        if (selected.length >= policy.max_parallel) break
        if (pipelineSkillFor(snapshot, item)?.mode === 'serial' && selected.length > 0) continue
        if (active.some((candidate) => claimsConflict(candidate, item, snapshot))) continue
        if (selected.some((candidate) => claimsConflict(candidate, item, snapshot))) continue
        selected.push(item)
      }
      return selected.length === 0 ? [firstReady] : selected
    }
    return []
  }
  const group = groupFor(snapshot, first)
  if (group === undefined || group.mode === 'serial') return [first]
  const members = candidates.filter((item) => group.ids.includes(item.work_item_id)).slice(0, policy.max_parallel)
  return members.length === 0 ? [first] : members
}
