/** Whole-document TaskPlan read-model decoder: canonical and legacy sources. */
import {
  MAX_TASK_PLAN_DOCUMENT_BYTES, MAX_TASK_PLAN_LEGACY_PROJECTION_BYTES, MAX_TASK_PLAN_WORK_ITEMS,
  TASK_PLAN_READ_SCHEMA_VERSION,
} from './taskPlanTypes'
import type {
  CanonicalTaskPlanReadModelV1, LegacyTaskPlanItemV1, LegacyTaskPlanReadModelV1,
  TaskPlanCoverageEntry, TaskPlanReadModelV1,
} from './taskPlanTypes'
import {
  budget, consume, exactKeys, isCanonicalCompletenessState, isEnum, isFingerprint, isPlainRecord,
  isSafePositiveInteger, safeIdentifier, safeText, strictArray,
} from './taskPlanDecodePrimitives'
import {
  addEntityIds, decodeCatalog, decodeCoverage, decodeDependencies, decodeGroups, decodeItems,
  decodeProjection, decodeResources, decodeValidation, sameCoverage, sameDependencies,
  sameResources,
} from './taskPlanSectionDecoders'

export function decodeCanonical(value: Record<string, unknown>): CanonicalTaskPlanReadModelV1 | null {
  const budgetState = budget(MAX_TASK_PLAN_DOCUMENT_BYTES)
  if (!exactKeys(value, [
    'schema_version', 'source', 'schedulable', 'plan_id', 'revision_id', 'revision_number',
    'fingerprint', 'revision_status', 'validation', 'completeness', 'requirements',
    'acceptance_criteria', 'groups', 'items', 'coverage', 'dependencies', 'resources', 'projection',
  ]) || !consume(budgetState) || value.schema_version !== TASK_PLAN_READ_SCHEMA_VERSION
    || value.source !== 'canonical' || typeof value.schedulable !== 'boolean'
    || !safeIdentifier(value.plan_id, budgetState) || !safeIdentifier(value.revision_id, budgetState)
    || !isSafePositiveInteger(value.revision_number)
    || !isFingerprint(value.fingerprint)
    || !isEnum(value.revision_status, ['draft', 'frozen'] as const)) return null
  const validation = decodeValidation(value.validation, budgetState)
  const completeness = exactKeys(value.completeness, ['state']) && consume(budgetState)
    && isCanonicalCompletenessState(value.completeness.state)
    ? { state: value.completeness.state }
    : null
  const requirements = decodeCatalog(value.requirements, budgetState)
  const acceptanceCriteria = decodeCatalog(value.acceptance_criteria, budgetState)
  const groups = decodeGroups(value.groups, budgetState)
  const items = decodeItems(value.items, budgetState)
  const coverage = decodeCoverage(value.coverage, budgetState)
  const dependencies = decodeDependencies(value.dependencies, budgetState)
  const resources = decodeResources(value.resources, budgetState)
  const projection = decodeProjection(value.projection, budgetState)
  if (validation === null || completeness === null || requirements === null || acceptanceCriteria === null
    || groups === null || items === null || coverage === null || dependencies === null
    || resources === null || projection === null) return null

  const entityIds = new Set<string>()
  if (!addEntityIds(entityIds, [value.plan_id, value.revision_id])
    || !addEntityIds(entityIds, requirements.map((entry) => entry.id))
    || !addEntityIds(entityIds, acceptanceCriteria.map((entry) => entry.id))
    || !addEntityIds(entityIds, groups.map((group) => group.id))
    || !addEntityIds(entityIds, items.map((item) => item.id))) return null
  for (const item of items) {
    if (!addEntityIds(entityIds, item.expected_outputs.map((output) => output.id))
      || !addEntityIds(entityIds, item.validators.map((validator) => validator.id))) return null
  }
  const requirementIds = new Set(requirements.map((entry) => entry.id))
  const acceptanceIds = new Set(acceptanceCriteria.map((entry) => entry.id))
  const itemIds = new Set(items.map((item) => item.id))
  const validateCoverage = (entries: readonly TaskPlanCoverageEntry[], catalogIds: Set<string>, uncovered: readonly string[]): boolean =>
    entries.length === catalogIds.size
      && entries.every((entry) => catalogIds.has(entry.id))
      && new Set(entries.map((entry) => entry.id)).size === entries.length
      && uncovered.every((id) => catalogIds.has(id))
      && new Set(uncovered).size === uncovered.length
      && entries.every((entry) => uncovered.includes(entry.id) === (entry.work_item_ids.length === 0))
  if (!validateCoverage(coverage.requirements, requirementIds, coverage.uncovered_requirement_ids)
    || !validateCoverage(coverage.acceptance_criteria, acceptanceIds, coverage.uncovered_acceptance_ids)
    || coverage.complete !== (coverage.uncovered_requirement_ids.length === 0 && coverage.uncovered_acceptance_ids.length === 0)
    || !coverage.requirements.every((entry) => entry.work_item_ids.every((id) => itemIds.has(id)))
    || !coverage.acceptance_criteria.every((entry) => entry.work_item_ids.every((id) => itemIds.has(id)))
    || !dependencies.edges.every((edge) => itemIds.has(edge.from_work_item_id) && itemIds.has(edge.to_work_item_id))
    || dependencies.cyclic_work_item_ids.some((id) => !itemIds.has(id))
    || !resources.conflicts.every((entry) => entry.work_item_ids.every((id) => itemIds.has(id)))
    || !resources.serialized.every((entry) => itemIds.has(entry.before_work_item_id) && itemIds.has(entry.after_work_item_id))
    || !sameCoverage(validation.coverage, coverage)
    || !sameDependencies(validation.dependencies, dependencies)
    || !sameResources(validation.resources, resources)
    || completeness.state !== (coverage.complete ? 'complete' : 'incomplete')
    || validation.valid !== (validation.issues.length === 0 && !validation.truncated)
    || validation.freezable !== validation.valid
    || value.schedulable !== (value.revision_status === 'frozen' && validation.valid)) return null
  return {
    schema_version: TASK_PLAN_READ_SCHEMA_VERSION,
    source: 'canonical',
    schedulable: value.schedulable,
    plan_id: value.plan_id,
    revision_id: value.revision_id,
    revision_number: value.revision_number,
    fingerprint: value.fingerprint,
    revision_status: value.revision_status,
    validation,
    completeness,
    requirements,
    acceptance_criteria: acceptanceCriteria,
    groups,
    items,
    coverage,
    dependencies,
    resources,
    projection,
  }
}

export function decodeLegacy(value: Record<string, unknown>): LegacyTaskPlanReadModelV1 | null {
  const budgetState = budget(MAX_TASK_PLAN_LEGACY_PROJECTION_BYTES)
  if (!exactKeys(value, ['schema_version', 'source', 'schedulable', 'groups', 'items', 'completeness', 'projection'])
    || !consume(budgetState) || value.schema_version !== TASK_PLAN_READ_SCHEMA_VERSION
    || value.source !== 'legacy' || value.schedulable !== false) return null
  const groups = strictArray(value.groups, budgetState, 0)
  const itemsValue = strictArray(value.items, budgetState, MAX_TASK_PLAN_WORK_ITEMS)
  if (groups === null || groups.length !== 0 || itemsValue === null) return null
  const items: LegacyTaskPlanItemV1[] = []
  const ids = new Set<string>()
  for (const [index, entry] of itemsValue.entries()) {
    if (!exactKeys(entry, [
      'id', 'identity_quality', 'title', 'stage', 'completed', 'order', 'depends_on',
      'requirement_refs', 'acceptance_refs', 'resource_claims', 'expected_outputs', 'validators',
    ]) || !consume(budgetState) || entry.identity_quality !== 'legacy-derived'
      || !safeIdentifier(entry.id, budgetState) || ids.has(entry.id)
      || !safeText(entry.title, budgetState)
      || (entry.stage !== null && !safeText(entry.stage, budgetState))
      || typeof entry.completed !== 'boolean' || !Number.isSafeInteger(entry.order)
      || entry.order !== index) return null
    const dependsOn = strictArray(entry.depends_on, budgetState, 0)
    const requirementRefs = strictArray(entry.requirement_refs, budgetState, 0)
    const acceptanceRefs = strictArray(entry.acceptance_refs, budgetState, 0)
    const resourceClaims = strictArray(entry.resource_claims, budgetState, 0)
    const expectedOutputs = strictArray(entry.expected_outputs, budgetState, 0)
    const validators = strictArray(entry.validators, budgetState, 0)
    if (dependsOn === null || requirementRefs === null || acceptanceRefs === null
      || resourceClaims === null || expectedOutputs === null || validators === null
      || dependsOn.length !== 0 || requirementRefs.length !== 0 || acceptanceRefs.length !== 0
      || resourceClaims.length !== 0 || expectedOutputs.length !== 0 || validators.length !== 0) return null
    ids.add(entry.id)
    items.push({
      id: entry.id,
      identity_quality: 'legacy-derived',
      title: entry.title,
      stage: entry.stage,
      completed: entry.completed,
      order: entry.order,
      depends_on: [],
      requirement_refs: [],
      acceptance_refs: [],
      resource_claims: [],
      expected_outputs: [],
      validators: [],
    })
  }
  if (!exactKeys(value.completeness, ['state', 'reason']) || !consume(budgetState)
    || value.completeness.state !== 'unknown'
    || value.completeness.reason !== 'legacy-semantics-unproven'
    || !exactKeys(value.projection, ['state']) || !consume(budgetState)
    || value.projection.state !== 'legacy') return null
  return {
    schema_version: TASK_PLAN_READ_SCHEMA_VERSION,
    source: 'legacy',
    schedulable: false,
    groups: [],
    items,
    completeness: { state: 'unknown', reason: 'legacy-semantics-unproven' },
    projection: { state: 'legacy' },
  }
}

export function decodeTaskPlanReadModel(value: unknown): TaskPlanReadModelV1 | null {
  if (!isPlainRecord(value)) return null
  if (value.source === 'canonical') return decodeCanonical(value)
  if (value.source === 'legacy') return decodeLegacy(value)
  return null
}

export const decodeTaskPlanReadModelV1 = decodeTaskPlanReadModel
