import { createHash } from 'node:crypto'
import { decodeCapabilityAssessmentV2, type CapabilityAssessmentV2, type CapabilityResolutionV2, type DevelopmentRequestV2, type RepositoryContextV2, type WorkGraphV2, type WorkflowPipelinePlanV2 } from '@tenon/kernel'
import { validateTaskPlanRevisionV1, type TaskPlanRevisionV1 } from '@tenon/kernel'
import { JsonBoundaryError, snapshotJsonBoundary } from './jsonBoundary.js'
import { materializeWorkflowPipelineV2, type WorkflowPipelineBlueprintV2 } from './workflow-pipeline-v2.js'
import { PLANNER_CATALOG_SCHEMA_V2, PLANNER_ASSESSMENT_EVIDENCE_V2, type PlannerCatalogV2, type PlannerCatalogInputV2, type PlannerSkillDescriptorV2, type PlannerResourceClaimV2, type CatalogNormalizationOutcome, type AssessIntentInputV2, type BuildWorkGraphInputV2, type PlannerPlanInputV2, type PlannerPlanOutcomeV2, type AssessmentNormalizationHostV2, type AssessmentNormalizationOutcomeV2, normalizeCapabilityCatalogV2, catalogOrThrow, freeze, digest, taskIdentifier, text, workItemIdentifierV2, acceptanceIdentifier, UTC, MAX_INTENT_BYTES, workIdentifier, type ResolvePlannerCapabilitiesInputV2 } from './planner-v2-catalog.js'
export * from './planner-v2-catalog.js'
export type { WorkflowPipelineBlueprintV2, WorkflowPipelineSkillBlueprintV2, WorkflowPipelineStageBlueprintV2 } from './workflow-pipeline-v2.js'
function requirement(id: string, capability: string, necessity: 'required' | 'recommended' | 'optional' = 'required', risk: 'low' | 'medium' | 'high' = 'medium'): CapabilityAssessmentV2['requirements'][number] {
  const slug = capability.replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase()
  // TaskPlan's identifier grammar is intentionally narrower than the board
  // codec (no colon), so use one cross-layer-safe identity vocabulary.
  return { id: `req-${slug}`, capability, necessity, acceptance_refs: [`acceptance-${slug}`], evidence_refs: [], constraints: [], risk }
}
/** Deterministic scene inference: only capability signals are emitted, never a closed scene enum. */
export function assessDevelopmentIntentV2(input: AssessIntentInputV2): CapabilityAssessmentV2 {
  if (input.request.project_id !== input.context.project_id || input.request.change_id !== input.context.change_id || input.context.request_id !== input.request.request_id) throw new TypeError('request/context identity mismatch')
  text(input.assessment_id, 'assessment_id'); text(input.assessed_at, 'assessed_at', UTC, 24)
  const intent = input.request.intent.trim()
  if (new TextEncoder().encode(intent).byteLength > MAX_INTENT_BYTES) throw new TypeError('intent exceeds planner limit')
  const lower = intent.toLocaleLowerCase()
  const requirements: CapabilityAssessmentV2['requirements'][number][] = []
  const add = (capability: string, risk: 'low' | 'medium' | 'high' = 'medium') => { if (!requirements.some((entry) => entry.capability === capability)) requirements.push(requirement(capability, capability, 'required', risk)) }
  if (/(frontend|front-end|react|vue|\bui\b|页面|界面|web app|网页)/u.test(lower)) add('frontend.ui')
  if (/(backend|back-end|api|server|服务端|接口|数据库|database)/u.test(lower)) add('backend.api')
  if (/(full[- ]?stack|全栈)/u.test(lower)) { add('frontend.ui'); add('backend.api') }
  if (/(test|测试|验证|quality|质量)/u.test(lower)) add('test.run', 'low')
  if (/(research|研究|调研|compare|竞品|文档|分析)/u.test(lower)) add('research', 'low')
  if (/(deploy|release|发布|部署)/u.test(lower)) add('release.deploy', 'high')
  if (requirements.length === 0 && intent.length > 2) add('code.edit')
  const questions = requirements.length === 0
    ? [{ id: 'question:intent', prompt: '请补充希望交付的能力、验收标准或目标文件。', blocking: true }]
    : []
  const normalization: CapabilityAssessmentV2['normalization'] = questions.some((question) => question.blocking) ? 'needs-input' : 'complete'
  return freeze({ schema_version: 'capability-assessment/v2', record_id: `assessment:${input.assessment_id}`, project_id: input.request.project_id, change_id: input.request.change_id, revision: input.context.revision, correlation_id: input.request.correlation_id, actor: { kind: 'system', id: 'planner' }, created_at: input.assessed_at, assessment_id: input.assessment_id, request_id: input.request.request_id, context_record_id: input.context.record_id, normalization, requirements, questions, risks: requirements.some((entry) => entry.risk === 'high') ? ['high-effect capability requires explicit policy review'] : [], proposal_evidence_ref: `${PLANNER_ASSESSMENT_EVIDENCE_V2}:${digest({ request: input.request.request_id, intent })}` })
}
/** Decode an untrusted provider assessment exactly once and replace host-owned identity/time. */
export function normalizeCapabilityAssessmentV2(raw: unknown, host: AssessmentNormalizationHostV2): AssessmentNormalizationOutcomeV2 {
  let snapshot
  try { snapshot = snapshotJsonBoundary(raw, { maxBytes: 256 * 1_024, maxDepth: 20, maxNodes: 8_192 }) } catch (error) {
    return { ok: false, code: error instanceof JsonBoundaryError && error.code === 'json-byte-budget-exceeded' ? 'assessment-too-large' : 'assessment-invalid', issues: [error instanceof JsonBoundaryError ? error.path : '$'] }
  }
  const decoded = decodeCapabilityAssessmentV2(snapshot.value)
  if (!decoded.ok) return { ok: false, code: 'assessment-invalid', issues: decoded.errors.map((entry) => entry.path) }
  try {
    text(host.assessment_id, 'assessment_id'); text(host.assessed_at, 'assessed_at', UTC, 24)
    if (host.request_id !== undefined && decoded.value.request_id !== host.request_id) throw new TypeError('assessment request binding mismatch')
    if (host.context_record_id !== undefined && decoded.value.context_record_id !== host.context_record_id) throw new TypeError('assessment context binding mismatch')
    if (host.project_id !== undefined && decoded.value.project_id !== host.project_id) throw new TypeError('assessment project binding mismatch')
    if (host.change_id !== undefined && decoded.value.change_id !== host.change_id) throw new TypeError('assessment change binding mismatch')
    return { ok: true, assessment: freeze({ ...decoded.value, assessment_id: host.assessment_id, record_id: host.record_id ?? `assessment:${host.assessment_id}`, created_at: host.assessed_at, proposal_evidence_ref: decoded.value.proposal_evidence_ref }) }
  } catch (error) { return { ok: false, code: 'assessment-invalid', issues: [error instanceof Error ? error.message : '$'] } }
}
interface BuiltPlan {
  readonly task_plan: TaskPlanRevisionV1
  readonly workItems: readonly { readonly id: string; readonly requirement_id: string; readonly mode: 'serial' | 'parallel'; readonly skill_id?: string; readonly resources: readonly PlannerResourceClaimV2[] }[]
  readonly graph: WorkGraphV2
}
function descriptorFor(catalog: PlannerCatalogV2, selectionId: string, version?: string): PlannerSkillDescriptorV2 | undefined {
  return catalog.skills.find((skill) => skill.id === selectionId && (version === undefined || skill.version === version))
}
function descriptorForRequirement(catalog: PlannerCatalogV2, req: CapabilityAssessmentV2['requirements'][number]): PlannerSkillDescriptorV2 | undefined {
  return catalog.skills.find((skill) => skill.availability === 'available' && skill.capabilities.includes(req.capability) && skill.permissions.every((permission) => catalog.allowed_permissions.includes(permission)))
}
function buildPlan(input: BuildWorkGraphInputV2, catalog: PlannerCatalogV2): BuiltPlan {
  if (input.request.project_id !== input.context.project_id || input.assessment.request_id !== input.request.request_id || input.assessment.context_record_id !== input.context.record_id) throw new TypeError('planner identity mismatch')
  text(input.graph_id, 'graph_id'); text(input.plan_revision_id, 'plan_revision_id'); text(input.now, 'now', UTC, 24)
  const explicitByCapability = new Map<string, { readonly skill_id: string; readonly mode: 'serial' | 'parallel' }>()
  for (const selection of input.request.user_skills) {
    const descriptor = descriptorFor(catalog, selection.id, selection.version)
    if (descriptor !== undefined) for (const capability of descriptor.capabilities) if (!explicitByCapability.has(capability)) explicitByCapability.set(capability, { skill_id: descriptor.id, mode: selection.mode })
  }
  const requirements = input.assessment.requirements
  const acceptanceIds = [...new Set(requirements.flatMap((entry) => entry.acceptance_refs))]
  const items = requirements.map((entry) => {
    const id = workIdentifier(entry.id)
    const selected = explicitByCapability.get(entry.capability)
    const descriptor = selected === undefined ? descriptorForRequirement(catalog, entry) : descriptorFor(catalog, selected.skill_id)
    return { id, requirement_id: entry.id, mode: selected?.mode ?? 'serial' as const, skill_id: selected?.skill_id, resources: descriptor?.resource_claims ?? [] }
  })
  const itemBySkill = new Map<string, string>()
  for (const item of items) if (item.skill_id !== undefined) itemBySkill.set(item.skill_id, item.id)
  const edgeMap = new Map<string, { readonly from: string; readonly to: string; readonly reason: 'data' | 'resource' | 'ordering' | 'gate' }>()
  for (const selection of input.request.user_skills) {
    const to = itemBySkill.get(selection.id)
    if (to === undefined) continue
    for (const dep of selection.depends_on) {
      const from = itemBySkill.get(dep)
      if (from !== undefined && from !== to) edgeMap.set(`${from}\0${to}`, { from, to, reason: 'ordering' })
    }
  }
  // A shared write/read resource is serialized deterministically instead of allowing unsafe parallel work.
  for (let index = 0; index < items.length; index += 1) for (let next = index + 1; next < items.length; next += 1) {
    const left = items[index]; const right = items[next]
    if (left === undefined || right === undefined) continue
    if (left.mode !== 'parallel' || right.mode !== 'parallel') continue
    const conflict = left.resources.some((a) => right.resources.some((b) => a.key === b.key && (a.access === 'write' || b.access === 'write')))
    if (conflict) edgeMap.set(`${left.id}\0${right.id}`, { from: left.id, to: right.id, reason: 'resource' })
  }
  const edges = [...edgeMap.values()].sort((a, b) => `${a.from}\0${a.to}`.localeCompare(`${b.from}\0${b.to}`))
  const groupsByMode = new Map<'serial' | 'parallel', string[]>()
  for (const item of items) {
    const mode = edges.some((edge) => edge.reason === 'resource' && (edge.from === item.id || edge.to === item.id)) ? 'serial' : item.mode
    const listForMode = groupsByMode.get(mode) ?? []; listForMode.push(item.id); groupsByMode.set(mode, listForMode)
  }
  const groups = [...groupsByMode.entries()].map(([mode, workItemIds]) => ({ id: `group-${mode}`, title: mode === 'parallel' ? 'Independent work' : 'Ordered work', parent_id: null, mode, work_item_ids: workItemIds }))
  const planItems = items.map((item) => {
    const req = requirements.find((entry) => entry.id === item.requirement_id)
    if (req === undefined) throw new TypeError(`missing requirement ${item.requirement_id}`)
    const descriptor = item.skill_id === undefined ? undefined : descriptorFor(catalog, item.skill_id)
    const outputId = taskIdentifier(item.requirement_id)
    const outputs = descriptor?.output_schema_id === undefined ? [] : [{ id: `output-${outputId}`, kind: 'value' as const, ref: `skill-output-${outputId}` }]
    const validators = descriptor?.validators.map((validator) => ({ id: `validator-${outputId}-${taskIdentifier(validator)}`, kind: 'test-report' as const, version: 1 as const, output_ids: outputs.map((output) => output.id) })) ?? []
    const group = groups.find((candidate) => candidate.work_item_ids.includes(item.id))
    if (group === undefined) throw new TypeError(`missing execution group for ${item.id}`)
    return { id: item.id, title: req.capability, group_id: group.id, requirement_refs: [taskIdentifier(req.id)], acceptance_refs: req.acceptance_refs.map(acceptanceIdentifier), depends_on: edges.filter((edge) => edge.to === item.id).map((edge) => edge.from), resource_claims: item.resources, expected_outputs: outputs, validators }
  })
  const task_plan: TaskPlanRevisionV1 = freeze({ schema_version: 'task-plan/v1', plan_id: taskIdentifier(`plan-${input.request.change_id}`), revision_id: taskIdentifier(input.plan_revision_id), revision_number: 1, status: 'frozen', created_at: input.now, requirements: requirements.map((entry) => ({ id: taskIdentifier(entry.id), title: entry.capability })), acceptance_criteria: acceptanceIds.map((id) => ({ id: acceptanceIdentifier(id), title: id })), groups, work_items: planItems })
  const validation = validateTaskPlanRevisionV1(task_plan)
  if (!validation.freezable) throw new TypeError(`generated task plan is not freezable: ${validation.issues.map((entry) => entry.code).join(',')}`)
  // Task-plan groups are intentionally mode-agnostic for V1 compatibility;
  // the V2 graph carries the execution mode explicitly and must not infer it
  // from an absent property on the legacy group shape.
  const execution_groups = [...groupsByMode.entries()].map(([mode, work_item_ids]) => ({
    id: `group-${mode}`,
    mode,
    work_item_ids: Object.freeze([...work_item_ids]),
  }))
  const graph: WorkGraphV2 = freeze({ schema_version: 'work-graph/v2', record_id: `graph:${input.graph_id}`, project_id: input.request.project_id, change_id: input.request.change_id, revision: input.context.revision, correlation_id: input.request.correlation_id, actor: { kind: 'system', id: 'planner' }, created_at: input.now, graph_id: input.graph_id, graph_revision: 1, assessment_id: input.assessment.assessment_id, task_plan_revision_id: input.plan_revision_id, task_plan_digest: digest(task_plan), ...(input.pipeline_id === undefined ? {} : { pipeline_id: input.pipeline_id }), dependency_edges: edges, execution_groups, acceptance_coverage: requirements.map((entry) => ({ acceptance_id: acceptanceIdentifier(entry.acceptance_refs[0] ?? `acceptance-${entry.id}`), work_item_ids: [workIdentifier(entry.id)] })), status: 'frozen' })
  return { task_plan, workItems: items, graph }
}
function inferredTrackId(assessment: CapabilityAssessmentV2): string {
  const capabilities = assessment.requirements.map((entry) => entry.capability.toLowerCase())
  if (capabilities.some((capability) => capability.startsWith('frontend.') || capability.includes('ui'))) return 'frontend'
  if (capabilities.some((capability) => capability.startsWith('backend.') || capability.includes('api') || capability.includes('database'))) return 'backend'
  if (capabilities.some((capability) => capability.startsWith('product.') || capability.includes('research') || capability.includes('requirement'))) return 'pm'
  return 'free'
}
function defaultPipelineIdentity(request: DevelopmentRequestV2, assessment: CapabilityAssessmentV2): { workflow_id: string; workflow_version: string; track_id: string; track_revision: string; pipeline_id: string; pipeline_version: string } {
  const workflow_id = request.workflow_id ?? 'default'
  const workflow_version = request.workflow_version ?? 'auto-v2'
  const track_id = request.track_id ?? inferredTrackId(assessment)
  const track_revision = request.track_revision ?? 'auto-v2'
  const pipeline_id = request.pipeline_id ?? `${workflow_id}:${track_id}:main`
  const pipeline_version = request.pipeline_version ?? '1'
  text(workflow_id, 'workflow_id'); text(workflow_version, 'workflow_version'); text(track_id, 'track_id'); text(track_revision, 'track_revision'); text(pipeline_id, 'pipeline_id'); text(pipeline_version, 'pipeline_version')
  return { workflow_id, workflow_version, track_id, track_revision, pipeline_id, pipeline_version }
}

export function buildWorkGraphV2(input: BuildWorkGraphInputV2): WorkGraphV2 {
  const catalog = input.catalog === undefined ? catalogOrThrow({ skills: [], mcps: [] }) : catalogOrThrow(input.catalog)
  return buildPlan(input, catalog).graph
}
function selectedSkillForRequirement(request: DevelopmentRequestV2, catalog: PlannerCatalogV2, capability: string, mode: 'serial' | 'parallel' = 'serial'): { readonly descriptor?: PlannerSkillDescriptorV2; readonly source: 'user' | 'automatic' | 'none'; readonly mode: 'serial' | 'parallel'; readonly depends_on: readonly string[] } {
  const explicit = request.user_skills.find((selection) => descriptorFor(catalog, selection.id, selection.version)?.capabilities.includes(capability) === true)
  if (explicit !== undefined) return { descriptor: descriptorFor(catalog, explicit.id, explicit.version), source: 'user', mode: explicit.mode, depends_on: explicit.depends_on }
  if (!request.auto_select) return { source: 'none', mode: 'serial', depends_on: [] }
  const descriptor = catalog.skills.find((skill) => skill.availability === 'available' && skill.capabilities.includes(capability) && skill.permissions.every((permission) => catalog.allowed_permissions.includes(permission)) && (mode !== 'parallel' || skill.supports_parallel))
  return descriptor === undefined ? { source: 'none', mode: 'serial', depends_on: [] } : { descriptor, source: 'automatic', mode: 'serial', depends_on: [] }
}
function permissionIssues(descriptor: PlannerSkillDescriptorV2, catalog: PlannerCatalogV2): readonly string[] {
  const allowed = new Set(catalog.allowed_permissions)
  return descriptor.permissions.filter((permission) => !allowed.has(permission)).map((permission) => `permission-denied:${descriptor.id}:${permission}`)
}
export function resolvePlannerCapabilitiesV2(input: ResolvePlannerCapabilitiesInputV2): CapabilityResolutionV2 {
  const catalog = catalogOrThrow(input.catalog)
  if (input.request.project_id !== input.context.project_id || input.assessment.request_id !== input.request.request_id || input.graph.assessment_id !== input.assessment.assessment_id) throw new TypeError('resolution identity mismatch')
  const bindings: CapabilityResolutionV2['bindings'][number][] = []
  const candidates: CapabilityResolutionV2['candidates'][number][] = []
  const blockers: string[] = []
  const graphItems = new Set(input.graph.execution_groups.flatMap((group) => group.work_item_ids))
  const assessedCapabilities = new Set(input.assessment.requirements.map((entry) => entry.capability))
  for (const selection of input.request.user_skills) {
    const descriptor = descriptorFor(catalog, selection.id, selection.version)
    if (descriptor === undefined) continue
    if (!descriptor.capabilities.some((capability) => assessedCapabilities.has(capability))) {
      // Explicit user choices are authoritative and must never be silently
      // dropped merely because the inferred assessment missed their output.
      blockers.push(`user-skill-unmatched:${selection.id}`)
    }
    for (const dependency of selection.depends_on) {
      if (descriptorFor(catalog, dependency) === undefined) blockers.push(`skill-dependency-missing:${selection.id}:${dependency}`)
    }
  }
  for (const req of input.assessment.requirements) {
    const work_item_id = workIdentifier(req.id)
    if (!graphItems.has(work_item_id)) { blockers.push(`graph-missing-work-item:${work_item_id}`); continue }
    const group = input.graph.execution_groups.find((entry) => entry.work_item_ids.includes(work_item_id))
    const chosen = selectedSkillForRequirement(input.request, catalog, req.capability, group?.mode)
    const relevant = catalog.skills.filter((skill) => skill.capabilities.includes(req.capability)).sort((a, b) => `${a.id}\0${a.version}`.localeCompare(`${b.id}\0${b.version}`))
    for (const candidate of relevant) {
      const rejected_reasons: string[] = []
      if (candidate.availability !== 'available') rejected_reasons.push(`availability-${candidate.availability}`)
      rejected_reasons.push(...permissionIssues(candidate, catalog))
      if (group?.mode === 'parallel' && !candidate.supports_parallel) rejected_reasons.push('parallel-unsupported')
      const selected = chosen.descriptor?.id === candidate.id && chosen.descriptor.version === candidate.version
      // Candidate identity stays inside the cross-record ID grammar. The
      // descriptor already carries the version; use a colon rather than the
      // email-like `@` separator rejected by the Kernel codec.
      candidates.push({ capability: req.capability, candidate_id: `${candidate.id}:${candidate.version}`, kind: 'skill', selected, rejected_reasons, rationale: selected ? `${chosen.source} selection` : rejected_reasons.length === 0 ? 'available deterministic candidate' : 'filtered by policy/availability' })
    }
    const descriptor = chosen.descriptor
    if (descriptor === undefined) {
      blockers.push(`unresolved-capability:${req.capability}`)
      continue
    }
    const issues = [...permissionIssues(descriptor, catalog)]
    if (descriptor.availability !== 'available') issues.push(`skill-unavailable:${descriptor.id}`)
    if (group?.mode === 'parallel' && !descriptor.supports_parallel) issues.push(`parallel-unsupported:${descriptor.id}`)
    if (issues.length > 0) { blockers.push(...issues); continue }
    const mcpIds: string[] = []
    for (const selection of input.request.user_mcps) {
      const mcp = catalog.mcps.find((entry) => entry.id === selection.id && (selection.version === undefined || entry.version === selection.version))
      if (mcp === undefined) { if (selection.required) blockers.push(`mcp-unavailable:${selection.id}`); continue }
      if (mcp.availability !== 'available') { if (selection.required) blockers.push(`mcp-unavailable:${mcp.id}`); continue }
      const denied = mcp.permissions.find((permission) => !catalog.allowed_permissions.includes(permission))
      if (denied !== undefined) { blockers.push(`permission-denied:${mcp.id}:${denied}`); continue }
      mcpIds.push(mcp.id)
    }
    bindings.push({ work_item_id, skill_id: descriptor.id, skill_version: descriptor.version, mcp_ids: mcpIds, mode: group?.mode ?? chosen.mode, source: chosen.source === 'user' && mcpIds.length > 0 ? 'hybrid' : chosen.source === 'user' ? 'user' : 'automatic', depends_on: chosen.depends_on })
  }
  for (const selection of input.request.user_skills) if (descriptorFor(catalog, selection.id, selection.version) === undefined) blockers.push(`skill-unavailable:${selection.id}`)
  // Resource safety is checked after deterministic bindings are known.
  for (const group of input.graph.execution_groups.filter((entry) => entry.mode === 'parallel')) {
    const claims = new Map<string, { readonly access: 'read' | 'write'; readonly item: string }>()
    for (const itemId of group.work_item_ids) {
      const binding = bindings.find((entry) => entry.work_item_id === itemId)
      const descriptor = binding === undefined ? undefined : descriptorFor(catalog, binding.skill_id, binding.skill_version)
      for (const claim of descriptor?.resource_claims ?? []) {
        const prior = claims.get(`${claim.kind}:${claim.key}`)
        if (prior !== undefined && (prior.access === 'write' || claim.access === 'write')) blockers.push(`resource-conflict:${prior.item}:${itemId}:${claim.kind}:${claim.key}`)
        claims.set(`${claim.kind}:${claim.key}`, { access: claim.access, item: itemId })
      }
    }
  }
  const inputBlockersOnly = blockers.length > 0 && blockers.every((blocker) => blocker.startsWith('unresolved-capability:') || blocker.startsWith('mcp-unavailable:'))
  const status: CapabilityResolutionV2['status'] = blockers.length > 0 && !inputBlockersOnly ? 'blocked' : blockers.length > 0 ? 'needs-input' : input.assessment.normalization !== 'complete' ? 'needs-input' : 'resolved'
  const resolutionId = input.resolution_id ?? `resolution:${input.graph.graph_id}`
  const resolution: CapabilityResolutionV2 = freeze({ schema_version: 'capability-resolution/v2', record_id: input.record_id ?? `resolution:${resolutionId}`, project_id: input.request.project_id, change_id: input.request.change_id, revision: input.context.revision, correlation_id: input.request.correlation_id, actor: { kind: 'system', id: 'planner' }, created_at: input.now, resolution_id: resolutionId, assessment_id: input.assessment.assessment_id, graph_id: input.graph.graph_id, policy_digest: catalog.policy_digest, status, bindings, candidates, blockers: [...new Set(blockers)].sort(), binding_digest: digest(bindings) })
  return resolution
}
export function planDevelopmentV2(input: PlannerPlanInputV2): PlannerPlanOutcomeV2 {
  let normalized: CatalogNormalizationOutcome
  if (input.catalog !== null && typeof input.catalog === 'object' && 'schema_version' in input.catalog && input.catalog.schema_version === PLANNER_CATALOG_SCHEMA_V2) {
    try { normalized = { ok: true, catalog: catalogOrThrow(input.catalog) } } catch (error) {
      normalized = { ok: false, code: 'catalog-invalid', issues: [error instanceof Error ? error.message : 'catalog is invalid'] }
    }
  } else normalized = normalizeCapabilityCatalogV2(input.catalog)
  if (!normalized.ok) return normalized
  const catalog = normalized.catalog
  try {
    const assessment = input.assessment
    const identity = defaultPipelineIdentity(input.request, assessment)
    const pipeline_id = text(input.pipeline_blueprint?.pipeline_id ?? identity.pipeline_id, 'pipeline_id')
    const plan = buildPlan({ ...input, catalog, pipeline_id }, catalog)
    const resolution = resolvePlannerCapabilitiesV2({ ...input, assessment, graph: plan.graph, catalog })
    if (resolution.status !== 'resolved') return { ok: true, assessment, graph: plan.graph, task_plan: plan.task_plan, resolution, catalog }
    const pipeline = materializeWorkflowPipelineV2({ request: input.request, assessment, graph: plan.graph, resolution, catalog, now: input.now, identity, pipeline_blueprint: input.pipeline_blueprint })
    return { ok: true, assessment, graph: plan.graph, task_plan: plan.task_plan, resolution, catalog, pipeline }
  } catch (error) { return { ok: false, code: 'planner-invalid', issues: [error instanceof Error ? error.message : 'planner failed'] } }
}
export const inferCapabilityAssessmentV2 = assessDevelopmentIntentV2
export const normalizePlannerCatalogV2 = normalizeCapabilityCatalogV2
export const buildDeterministicWorkGraphV2 = buildWorkGraphV2
export const resolveCapabilitiesV2 = resolvePlannerCapabilitiesV2
