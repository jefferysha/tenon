import { createHash } from 'node:crypto'
import type {
  CapabilityAssessmentV2,
  CapabilityResolutionV2,
  DevelopmentRequestV2,
  PipelineSkillV2,
  PipelineSourceV2,
  PipelineStageV2,
  WorkGraphV2,
  WorkflowPipelinePlanV2,
} from '@tenon/kernel'
import type { PlannerCatalogV2 } from './planner-v2.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const RESOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u

export interface WorkflowPipelineSkillBlueprintV2 extends Omit<PipelineSkillV2, 'binding_id' | 'order'> {
  readonly binding_id?: string
  readonly order?: number
}

export interface WorkflowPipelineStageBlueprintV2 extends Omit<PipelineStageV2, 'ordinal' | 'skills'> {
  readonly ordinal?: number
  readonly skills: readonly WorkflowPipelineSkillBlueprintV2[]
}

/** User/project-owned pipeline contract. Names and Skill IDs remain open data. */
export interface WorkflowPipelineBlueprintV2 {
  readonly workflow_id: string
  readonly workflow_version: string
  readonly workflow_source: PipelineSourceV2
  readonly workflow_fingerprint?: string
  readonly track_id: string
  readonly track_revision: string
  readonly track_source: PipelineSourceV2
  readonly pipeline_id: string
  readonly pipeline_version: string
  readonly pipeline_source: PipelineSourceV2
  readonly stages: readonly WorkflowPipelineStageBlueprintV2[]
}

/** Minimal structural view of the dashboard workflow definition.  Keeping this
 * boundary structural avoids a dashboard→automation package dependency while
 * still making the workflow→pipeline identity explicit. */
export interface WorkflowDefinitionBlueprintInputV2 {
  readonly name: string
  readonly steps: readonly {
    readonly id: string
    readonly label: string
    readonly gate?: 'review' | 'auto' | null
    readonly skills?: readonly { readonly id: string }[]
    readonly transitions?: readonly { readonly to: string }[]
  }[]
}

export interface WorkflowTrackBlueprintInputV2 {
  readonly id: string
  readonly revision?: string
  readonly source?: PipelineSourceV2
}

export interface WorkflowBlueprintMappingV2 {
  /** Explicitly supplied because a workflow step may own multiple work items. */
  readonly workItemIdsByStep?: Readonly<Record<string, readonly string[]>>
  readonly skillVersions?: Readonly<Record<string, string>>
  readonly workflowVersion?: string
  readonly pipelineVersion?: string
  readonly pipelineId?: string
}

/** Resolve a step mapping after intent assessment has produced requirements.
 * Callers should use this form when work-item identities are derived by the
 * planner; constructing the mapping before assessment cannot be correct. */
export type WorkflowBlueprintMappingResolverV2 =
  (assessment: CapabilityAssessmentV2) => WorkflowBlueprintMappingV2

/** Build the explicit blueprint consumed by materializeWorkflowPipelineV2.
 * The mapping is intentionally supplied by the planner that owns assessment
 * and graph records; this helper never guesses a step↔work-item 1:1 relation. */
export function pipelineBlueprintFromWorkflowDef(
  def: WorkflowDefinitionBlueprintInputV2,
  track: WorkflowTrackBlueprintInputV2,
  mapping: WorkflowBlueprintMappingV2 = {},
): WorkflowPipelineBlueprintV2 {
  const workflowVersion = mapping.workflowVersion ?? '1'
  const pipelineVersion = mapping.pipelineVersion ?? workflowVersion
  // A workflow definition may contain terminal/gate-only steps (for example
  // `done` or `escalated`) which have no executable work items.  Only steps
  // with an explicit mapping become pipeline stages; absence of a mapping is
  // therefore a deliberate non-executable step rather than an error.
  const executableSteps = def.steps.filter((step) => {
    const workItemIds = mapping.workItemIdsByStep?.[step.id]
    // An empty mapping carries no executable work. Treat it like an omitted
    // mapping so terminal/gate-only steps cannot become invalid empty stages.
    // A gate-only step has no skills to execute; even if a stale mapping names
    // work items for it, materializing an empty skill set would fail later (or
    // worse, create a stage that cannot produce a governed result). Keep such
    // control-flow-only steps out of the executable blueprint up front.
    return workItemIds !== undefined && workItemIds.length > 0 && (step.skills?.length ?? 0) > 0
  })
  const stages = executableSteps.map((step, executableIndex) => {
    const workItemIds = mapping.workItemIdsByStep![step.id]!
    const skills = (step.skills ?? []).map((skill, skillIndex) => ({
      skill_id: skill.id,
      skill_version: mapping.skillVersions?.[skill.id] ?? 'unversioned',
      role: 'user' as const,
      source: 'user' as const,
      mode: 'serial' as const,
      depends_on: [],
      mcp_ids: [],
      validator_ids: [],
      order: skillIndex,
    }))
    // `transitions` also encode rejection/rollback edges in Tenon.  Treating
    // every incoming edge as a dependency creates cycles (e.g. verify →
    // change), so the blueprint follows the workflow's forward linear order
    // and links each executable stage to the preceding executable stage.
    const dependencies = executableIndex === 0 ? [] : [executableSteps[executableIndex - 1]!.id]
    return {
      stage_id: step.id,
      name: step.label,
      ordinal: executableIndex,
      execution_mode: 'serial' as const,
      depends_on: dependencies,
      work_item_ids: [...workItemIds],
      gate: step.gate === 'review' ? 'review' as const : 'none' as const,
      skills,
      input_refs: [],
      output_refs: workItemIds.map((id) => `result:${id}`),
    }
  })
  return {
    workflow_id: def.name,
    workflow_version: workflowVersion,
    workflow_source: 'user',
    track_id: track.id,
    track_revision: track.revision ?? '1',
    track_source: track.source ?? 'project',
    pipeline_id: mapping.pipelineId ?? `${def.name}:${track.id}:main`,
    pipeline_version: pipelineVersion,
    pipeline_source: 'user',
    stages,
  }
}

export interface PipelineIdentityV2 {
  readonly workflow_id: string
  readonly workflow_version: string
  readonly track_id: string
  readonly track_revision: string
  readonly pipeline_id: string
  readonly pipeline_version: string
}

export interface MaterializeWorkflowPipelineInputV2 {
  readonly request: DevelopmentRequestV2
  readonly assessment: CapabilityAssessmentV2
  readonly graph: WorkGraphV2
  readonly resolution: CapabilityResolutionV2
  readonly catalog: PlannerCatalogV2
  readonly now: string
  readonly identity: PipelineIdentityV2
  readonly pipeline_blueprint?: WorkflowPipelineBlueprintV2
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function stable(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash('sha256').update(stable(value), 'utf8').digest('hex')}` }

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > 8_192 || !ID.test(value)) throw new TypeError(`${label} is invalid`)
  return value
}

function source(value: unknown, label: string): PipelineSourceV2 {
  if (value === 'builtin' || value === 'project' || value === 'user' || value === 'automatic') return value
  throw new TypeError(`${label} is invalid`)
}

function descriptorFor(catalog: PlannerCatalogV2, skillId: string, version: string) { return catalog.skills.find((skill) => skill.id === skillId && skill.version === version) }

function idList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 2_048) throw new TypeError(`${label} is invalid`)
  return Object.freeze(value.map((entry, index) => text(entry, `${label}[${index}]`)))
}

function resourceClaims(value: unknown, label: string): readonly { readonly kind: 'path' | 'logical' | 'external'; readonly key: string; readonly access: 'read' | 'write' }[] {
  if (!Array.isArray(value) || value.length > 2_048) throw new TypeError(`${label} is invalid`)
  return Object.freeze(value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`${label}[${index}] is invalid`)
    const claim = entry as Record<string, unknown>
    const kind = claim.kind === 'path' || claim.kind === 'logical' || claim.kind === 'external' ? claim.kind : undefined
    const access = claim.access === 'read' || claim.access === 'write' ? claim.access : undefined
    const key = typeof claim.key === 'string' && claim.key.length > 0 && claim.key.trim() === claim.key && claim.key.length <= 512 && RESOURCE_KEY.test(claim.key) ? claim.key : undefined
    if (kind === undefined || access === undefined || key === undefined || (kind === 'path' && (key.includes('..') || key.startsWith('/')))) throw new TypeError(`${label}[${index}] is invalid`)
    return Object.freeze({ kind, access, key })
  }))
}

function materializePipelineSkill(binding: CapabilityResolutionV2['bindings'][number], catalog: PlannerCatalogV2, order: number, bySkill: ReadonlyMap<string, string>): PipelineSkillV2 {
  const descriptor = descriptorFor(catalog, binding.skill_id, binding.skill_version)
  const selectedByUser = binding.source === 'user' || binding.source === 'hybrid'
  return freeze({
    binding_id: `binding:${binding.work_item_id}:${binding.skill_id}`, skill_id: binding.skill_id, skill_version: binding.skill_version, order,
    role: selectedByUser ? 'user' : 'automatic', source: selectedByUser ? 'user' : 'automatic', mode: binding.mode,
    depends_on: binding.depends_on.map((dependency) => bySkill.get(dependency) ?? `skill:${dependency}`), mcp_ids: binding.mcp_ids,
    ...(descriptor?.input_schema_id === undefined ? {} : { input_schema_id: descriptor.input_schema_id }),
    ...(descriptor?.output_schema_id === undefined ? {} : { output_schema_id: descriptor.output_schema_id }), validator_ids: descriptor?.validators ?? [], resource_claims: descriptor?.resource_claims ?? [],
  })
}

/** Freeze the effective identities and exact stage/Skill ordering used by runtime. */
export function materializeWorkflowPipelineV2(input: MaterializeWorkflowPipelineInputV2): WorkflowPipelinePlanV2 {
  if (!UTC.test(input.now)) throw new TypeError('now is invalid')
  if (input.resolution.status !== 'resolved') throw new TypeError('pipeline requires a resolved capability selection')
  const blueprint = input.pipeline_blueprint
  const identity = blueprint === undefined ? input.identity : {
    workflow_id: text(blueprint.workflow_id, 'pipeline.workflow_id'), workflow_version: text(blueprint.workflow_version, 'pipeline.workflow_version'),
    track_id: text(blueprint.track_id, 'pipeline.track_id'), track_revision: text(blueprint.track_revision, 'pipeline.track_revision'),
    pipeline_id: text(blueprint.pipeline_id, 'pipeline.pipeline_id'), pipeline_version: text(blueprint.pipeline_version, 'pipeline.pipeline_version'),
  }
  const graphItemIds = input.graph.execution_groups.flatMap((group) => group.work_item_ids)
  const graphItemSet = new Set(graphItemIds)
  const bindingByItem = new Map(input.resolution.bindings.map((binding) => [binding.work_item_id, binding]))
  const bySkill = new Map(input.resolution.bindings.map((binding) => [binding.skill_id, `binding:${binding.work_item_id}:${binding.skill_id}`]))
  let stages: readonly PipelineStageV2[]
  let workflowSource: PipelineSourceV2 = input.request.workflow_id === undefined ? 'builtin' : 'user'
  let trackSource: PipelineSourceV2 = 'automatic'
  let pipelineSource: PipelineSourceV2 = input.request.pipeline_id === undefined ? 'automatic' : 'user'
  if (input.request.track_id !== undefined) trackSource = 'user'
  if (blueprint === undefined) {
    stages = graphItemIds.map((workItemId, ordinal) => {
      const binding = bindingByItem.get(workItemId)
      if (binding === undefined) throw new TypeError(`pipeline missing binding for ${workItemId}`)
      const group = input.graph.execution_groups.find((candidate) => candidate.work_item_ids.includes(workItemId))
      const requirement = input.assessment.requirements.find((entry) => `work-${entry.id.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')}` === workItemId)
      return freeze({ stage_id: workItemId, name: requirement?.capability ?? workItemId, ordinal, execution_mode: group?.mode ?? binding.mode, depends_on: input.graph.dependency_edges.filter((edge) => edge.to === workItemId).map((edge) => edge.from), work_item_ids: [workItemId], gate: 'none' as const, skills: [materializePipelineSkill(binding, input.catalog, 0, bySkill)], input_refs: input.graph.dependency_edges.filter((edge) => edge.to === workItemId).map((edge) => `result:${edge.from}`), output_refs: [`result:${workItemId}`] })
    })
  } else {
    workflowSource = source(blueprint.workflow_source, 'pipeline.workflow_source')
    trackSource = source(blueprint.track_source, 'pipeline.track_source')
    pipelineSource = source(blueprint.pipeline_source, 'pipeline.pipeline_source')
    const seenStageIds = new Set<string>()
    const seenItems = new Set<string>()
    stages = blueprint.stages.map((stage, index) => {
      const stageId = text(stage.stage_id, `pipeline.stages[${index}].stage_id`)
      if (seenStageIds.has(stageId)) throw new TypeError(`pipeline duplicate stage ${stageId}`)
      seenStageIds.add(stageId)
      const ordinal = stage.ordinal ?? index
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError(`pipeline.stages[${index}].ordinal is invalid`)
      const workItemIds = stage.work_item_ids.map((id, itemIndex) => text(id, `pipeline.stages[${index}].work_item_ids[${itemIndex}]`))
      for (const id of workItemIds) { if (!graphItemSet.has(id)) throw new TypeError(`pipeline stage ${stageId} references unknown work item ${id}`); if (seenItems.has(id)) throw new TypeError(`pipeline work item appears in multiple stages: ${id}`); seenItems.add(id) }
      const executionMode = stage.execution_mode === 'serial' || stage.execution_mode === 'parallel' ? stage.execution_mode : undefined
      const gate = ['none', 'input', 'review', 'verification', 'release'].includes(stage.gate) ? stage.gate : undefined
      if (executionMode === undefined || gate === undefined) throw new TypeError(`pipeline stage ${stageId} execution mode/gate is invalid`)
      const skills = stage.skills.map((skill, skillIndex) => {
        const skillId = text(skill.skill_id, `pipeline.stages[${index}].skills[${skillIndex}].skill_id`)
        const skillVersion = text(skill.skill_version, `pipeline.stages[${index}].skills[${skillIndex}].skill_version`)
        const binding = workItemIds.map((workItemId) => bindingByItem.get(workItemId)).find((candidate) => candidate?.skill_id === skillId && candidate.skill_version === skillVersion)
        if (binding === undefined) throw new TypeError(`pipeline skill ${skillId}@${skillVersion} is not selected for this stage`)
        const order = skill.order ?? skillIndex
        if (!Number.isSafeInteger(order) || order < 0) throw new TypeError(`pipeline skill order is invalid`)
        const descriptor = descriptorFor(input.catalog, skillId, skillVersion)
        if (executionMode === 'parallel' && skill.mode === 'parallel' && descriptor?.supports_parallel === false) throw new TypeError(`pipeline stage ${stageId} runs non-parallel Skill ${skillId} in parallel`)
        const claims = skill.resource_claims === undefined ? descriptor?.resource_claims ?? [] : resourceClaims(skill.resource_claims, `pipeline.stages[${index}].skills[${skillIndex}].resource_claims`)
        const bindingId = text(skill.binding_id ?? `binding:${stageId}:${skillId}`, `pipeline.stages[${index}].skills[${skillIndex}].binding_id`)
        return freeze({ ...skill, binding_id: bindingId, skill_id: skillId, skill_version: skillVersion, order, depends_on: idList(skill.depends_on, `pipeline.stages[${index}].skills[${skillIndex}].depends_on`), mcp_ids: idList(skill.mcp_ids, `pipeline.stages[${index}].skills[${skillIndex}].mcp_ids`), validator_ids: idList(skill.validator_ids, `pipeline.stages[${index}].skills[${skillIndex}].validator_ids`), resource_claims: claims })
      }).sort((left, right) => left.order - right.order)
      for (const workItemId of workItemIds) { const binding = bindingByItem.get(workItemId); if (binding !== undefined && !skills.some((skill) => skill.skill_id === binding.skill_id && skill.skill_version === binding.skill_version)) throw new TypeError(`pipeline stage ${stageId} omits selected Skill for ${workItemId}`) }
      if (new Set(skills.map((skill) => skill.order)).size !== skills.length) throw new TypeError(`pipeline stage ${stageId} has duplicate Skill order`)
      return freeze({ ...stage, stage_id: stageId, name: text(stage.name, `pipeline.stages[${index}].name`), ordinal, execution_mode: executionMode, gate, work_item_ids: workItemIds, skills })
    })
    if (seenItems.size !== graphItemSet.size) throw new TypeError('pipeline stages must cover every graph work item exactly once')
  }
  const stage_order = [...stages].sort((left, right) => left.ordinal - right.ordinal).map((stage) => stage.stage_id)
  if (new Set(stage_order).size !== stage_order.length) throw new TypeError('pipeline stage ordinals must be unique')
  const stagePositions = new Map(stage_order.map((stageId, index) => [stageId, index]))
  for (const stage of stages) for (const dependency of stage.depends_on) {
    const dependencyPosition = stagePositions.get(dependency)
    const stagePosition = stagePositions.get(stage.stage_id)
    if (dependencyPosition === undefined || stagePosition === undefined || dependencyPosition >= stagePosition) throw new TypeError(`pipeline stage dependency order is invalid: ${dependency}->${stage.stage_id}`)
  }
  const pipelineSkills = stages.flatMap((stage) => stage.skills)
  for (const skill of pipelineSkills) for (const dependency of skill.depends_on) {
    if (!pipelineSkills.some((candidate) => candidate.binding_id === dependency || candidate.skill_id === dependency || `skill:${candidate.skill_id}` === dependency)) {
      throw new TypeError(`pipeline Skill dependency is unresolved: ${dependency} -> ${skill.binding_id}`)
    }
  }
  const body = {
    schema_version: 'workflow-pipeline/v2' as const, record_id: `pipeline:${identity.pipeline_id}`, project_id: input.request.project_id, change_id: input.request.change_id,
    revision: input.graph.revision, correlation_id: input.request.correlation_id, actor: { kind: 'system' as const, id: 'planner' }, created_at: input.now,
    pipeline_id: identity.pipeline_id, pipeline_version: identity.pipeline_version, workflow_id: identity.workflow_id, workflow_version: identity.workflow_version,
    workflow_source: workflowSource, workflow_fingerprint: blueprint?.workflow_fingerprint === undefined ? digest({ id: identity.workflow_id, version: identity.workflow_version }) : text(blueprint.workflow_fingerprint, 'pipeline.workflow_fingerprint'),
    track_id: identity.track_id, track_revision: identity.track_revision, track_source: trackSource, pipeline_source: pipelineSource, graph_id: input.graph.graph_id, assessment_id: input.assessment.assessment_id,
    status: 'frozen' as const, stage_order, stages, customizations: { custom_workflow: workflowSource === 'project' || workflowSource === 'user', custom_track: trackSource === 'project' || trackSource === 'user', custom_pipeline: pipelineSource === 'project' || pipelineSource === 'user', user_skill_ids: input.request.user_skills.map((skill) => skill.id), user_mcp_ids: input.request.user_mcps.map((mcp) => mcp.id) },
  }
  return freeze({ ...body, pipeline_digest: digest(body) })
}
