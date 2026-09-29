/** Decoders for the sections of a TaskPlan read model (catalog, groups, items, diagnostics). */
import {
  MAX_TASK_PLAN_CATALOG_ENTRIES, MAX_TASK_PLAN_DIAGNOSTIC_ENTRIES, MAX_TASK_PLAN_GROUPS,
  MAX_TASK_PLAN_RELATIONS_PER_ITEM, MAX_TASK_PLAN_RESOURCE_BYTES, MAX_TASK_PLAN_VALIDATION_ISSUES,
  MAX_TASK_PLAN_WORK_ITEMS,
} from './taskPlanTypes'
import type {
  ExpectedOutputV1, ResourceClaimV1, TaskGroupV1, TaskPlanCatalogEntry, TaskPlanCoverageEntry,
  TaskPlanCoverageSummary, TaskPlanDependencyDiagnostics, TaskPlanProjectionStatus,
  TaskPlanResourceDiagnostics, TaskPlanValidationIssue, TaskPlanValidationResult, TaskValidatorV1,
  WorkItemV1,
} from './taskPlanTypes'
import {
  OUTPUT_KINDS, RESOURCE_ACCESS, RESOURCE_KINDS, VALIDATION_ISSUE_CODES, VALIDATOR_KINDS,
  canonicalResourceKey, consume, exactKeys, isEnum, resourceKey, safeIdentifier, safeText,
  strictArray, stringArray, unique,
} from './taskPlanDecodePrimitives'
import type { DecodeBudget } from './taskPlanDecodePrimitives'

export function decodeCatalog(
  value: unknown,
  budgetState: DecodeBudget,
): TaskPlanCatalogEntry[] | null {
  const entries = strictArray(value, budgetState, MAX_TASK_PLAN_CATALOG_ENTRIES)
  if (entries === null) return null
  const decoded: TaskPlanCatalogEntry[] = []
  for (const entry of entries) {
    if (!exactKeys(entry, ['id', 'title']) || !consume(budgetState)) return null
    if (!safeIdentifier(entry.id, budgetState) || !safeText(entry.title, budgetState)) return null
    decoded.push({ id: entry.id, title: entry.title })
  }
  return decoded
}

export function decodeGroups(
  value: unknown,
  budgetState: DecodeBudget,
): TaskGroupV1[] | null {
  const entries = strictArray(value, budgetState, MAX_TASK_PLAN_GROUPS)
  if (entries === null) return null
  const decoded: TaskGroupV1[] = []
  for (const entry of entries) {
    if (!exactKeys(entry, ['id', 'title', 'parent_id', 'work_item_ids']) || !consume(budgetState)) return null
    if (!safeIdentifier(entry.id, budgetState) || !safeText(entry.title, budgetState)) return null
    const parent = entry.parent_id === null
      ? null
      : safeIdentifier(entry.parent_id, budgetState) ? entry.parent_id : undefined
    const workItemIds = stringArray(entry.work_item_ids, budgetState)
    if (parent === undefined || workItemIds === null) return null
    decoded.push({ id: entry.id, title: entry.title, parent_id: parent, work_item_ids: workItemIds })
  }
  return decoded
}

export function decodeResourceClaims(
  value: unknown,
  budgetState: DecodeBudget,
): ResourceClaimV1[] | null {
  const entries = strictArray(value, budgetState, MAX_TASK_PLAN_RELATIONS_PER_ITEM)
  if (entries === null) return null
  const decoded: ResourceClaimV1[] = []
  for (const entry of entries) {
    if (!exactKeys(entry, ['kind', 'access', 'key']) || !consume(budgetState)
      || !isEnum(entry.kind, RESOURCE_KINDS) || !isEnum(entry.access, RESOURCE_ACCESS)
      || !safeText(entry.key, budgetState, MAX_TASK_PLAN_RESOURCE_BYTES)
      || canonicalResourceKey(entry.kind, entry.key) === null) return null
    decoded.push({ kind: entry.kind, access: entry.access, key: entry.key })
  }
  return decoded
}

export function decodeOutputs(
  value: unknown,
  budgetState: DecodeBudget,
): ExpectedOutputV1[] | null {
  const entries = strictArray(value, budgetState, MAX_TASK_PLAN_RELATIONS_PER_ITEM)
  if (entries === null) return null
  const decoded: ExpectedOutputV1[] = []
  for (const entry of entries) {
    if (!exactKeys(entry, ['id', 'kind', 'ref']) || !consume(budgetState)
      || !safeIdentifier(entry.id, budgetState) || !isEnum(entry.kind, OUTPUT_KINDS)
      || !safeText(entry.ref, budgetState, MAX_TASK_PLAN_RESOURCE_BYTES)) return null
    if (entry.kind === 'file' && canonicalResourceKey('path', entry.ref) === null) return null
    decoded.push({ id: entry.id, kind: entry.kind, ref: entry.ref })
  }
  return decoded
}

export function decodeValidators(
  value: unknown,
  budgetState: DecodeBudget,
): TaskValidatorV1[] | null {
  const entries = strictArray(value, budgetState, MAX_TASK_PLAN_RELATIONS_PER_ITEM)
  if (entries === null) return null
  const decoded: TaskValidatorV1[] = []
  for (const entry of entries) {
    if (!exactKeys(entry, ['id', 'kind', 'version', 'output_ids']) || !consume(budgetState)
      || !safeIdentifier(entry.id, budgetState) || !isEnum(entry.kind, VALIDATOR_KINDS)
      || entry.version !== 1) return null
    const outputIds = stringArray(entry.output_ids, budgetState)
    if (outputIds === null) return null
    decoded.push({ id: entry.id, kind: entry.kind, version: 1, output_ids: outputIds })
  }
  return decoded
}

export function decodeItems(
  value: unknown,
  budgetState: DecodeBudget,
): Array<WorkItemV1 & { readonly identity_quality: 'canonical' }> | null {
  const entries = strictArray(value, budgetState, MAX_TASK_PLAN_WORK_ITEMS)
  if (entries === null) return null
  const decoded: Array<WorkItemV1 & { readonly identity_quality: 'canonical' }> = []
  for (const entry of entries) {
    if (!exactKeys(entry, [
      'id', 'identity_quality', 'title', 'group_id', 'requirement_refs', 'acceptance_refs',
      'depends_on', 'resource_claims', 'expected_outputs', 'validators',
    ], ['description']) || !consume(budgetState)
      || entry.identity_quality !== 'canonical'
      || !safeIdentifier(entry.id, budgetState)
      || !safeText(entry.title, budgetState)
      || !safeIdentifier(entry.group_id, budgetState)) return null
    const description = !Object.prototype.hasOwnProperty.call(entry, 'description')
      ? undefined
      : safeText(entry.description, budgetState) ? entry.description : null
    if (description === null) return null
    const requirementRefs = stringArray(entry.requirement_refs, budgetState)
    const acceptanceRefs = stringArray(entry.acceptance_refs, budgetState)
    const dependsOn = stringArray(entry.depends_on, budgetState)
    const resourceClaims = decodeResourceClaims(entry.resource_claims, budgetState)
    const expectedOutputs = decodeOutputs(entry.expected_outputs, budgetState)
    const validators = decodeValidators(entry.validators, budgetState)
    if (requirementRefs === null || acceptanceRefs === null || dependsOn === null
      || resourceClaims === null || expectedOutputs === null || validators === null) return null
    decoded.push({
      id: entry.id,
      identity_quality: 'canonical',
      title: entry.title,
      ...(description === undefined ? {} : { description }),
      group_id: entry.group_id,
      requirement_refs: requirementRefs,
      acceptance_refs: acceptanceRefs,
      depends_on: dependsOn,
      resource_claims: resourceClaims,
      expected_outputs: expectedOutputs,
      validators,
    })
  }
  return decoded
}

export function decodeCoverage(
  value: unknown,
  budgetState: DecodeBudget,
): TaskPlanCoverageSummary | null {
  if (!exactKeys(value, [
    'complete', 'requirements', 'acceptance_criteria',
    'uncovered_requirement_ids', 'uncovered_acceptance_ids',
  ]) || !consume(budgetState) || typeof value.complete !== 'boolean') return null
  const decodeEntries = (candidate: unknown): TaskPlanCoverageEntry[] | null => {
    const entries = strictArray(candidate, budgetState, MAX_TASK_PLAN_CATALOG_ENTRIES)
    if (entries === null) return null
    const result: TaskPlanCoverageEntry[] = []
    for (const entry of entries) {
      if (!exactKeys(entry, ['id', 'work_item_ids']) || !consume(budgetState)
        || !safeIdentifier(entry.id, budgetState)) return null
      const workItemIds = stringArray(entry.work_item_ids, budgetState, MAX_TASK_PLAN_WORK_ITEMS)
      if (workItemIds === null || !unique(workItemIds)) return null
      result.push({ id: entry.id, work_item_ids: workItemIds })
    }
    return result
  }
  const requirements = decodeEntries(value.requirements)
  const acceptanceCriteria = decodeEntries(value.acceptance_criteria)
  const uncoveredRequirements = stringArray(
    value.uncovered_requirement_ids, budgetState, MAX_TASK_PLAN_CATALOG_ENTRIES,
  )
  const uncoveredAcceptance = stringArray(
    value.uncovered_acceptance_ids, budgetState, MAX_TASK_PLAN_CATALOG_ENTRIES,
  )
  if (requirements === null || acceptanceCriteria === null || uncoveredRequirements === null
    || uncoveredAcceptance === null || !unique(requirements.map((entry) => entry.id))
    || !unique(acceptanceCriteria.map((entry) => entry.id))
    || !unique(uncoveredRequirements) || !unique(uncoveredAcceptance)) return null
  return {
    complete: value.complete,
    requirements,
    acceptance_criteria: acceptanceCriteria,
    uncovered_requirement_ids: uncoveredRequirements,
    uncovered_acceptance_ids: uncoveredAcceptance,
  }
}

export function decodeDependencies(
  value: unknown,
  budgetState: DecodeBudget,
): TaskPlanDependencyDiagnostics | null {
  if (!exactKeys(value, ['edges', 'cyclic_work_item_ids']) || !consume(budgetState)) return null
  const edgeValues = strictArray(value.edges, budgetState, MAX_TASK_PLAN_DIAGNOSTIC_ENTRIES)
  const cyclicIds = stringArray(value.cyclic_work_item_ids, budgetState, MAX_TASK_PLAN_WORK_ITEMS)
  if (edgeValues === null || cyclicIds === null || !unique(cyclicIds)) return null
  const edges: TaskPlanDependencyDiagnostics['edges'][number][] = []
  const edgeKeys = new Set<string>()
  for (const entry of edgeValues) {
    if (!exactKeys(entry, ['from_work_item_id', 'to_work_item_id']) || !consume(budgetState)
      || !safeIdentifier(entry.from_work_item_id, budgetState)
      || !safeIdentifier(entry.to_work_item_id, budgetState)) return null
    const key = `${entry.from_work_item_id}\u0000${entry.to_work_item_id}`
    if (edgeKeys.has(key)) return null
    edgeKeys.add(key)
    edges.push({ from_work_item_id: entry.from_work_item_id, to_work_item_id: entry.to_work_item_id })
  }
  return { edges, cyclic_work_item_ids: cyclicIds }
}

export function decodeResources(
  value: unknown,
  budgetState: DecodeBudget,
): TaskPlanResourceDiagnostics | null {
  if (!exactKeys(value, ['conflicts', 'serialized']) || !consume(budgetState)) return null
  const conflictsValue = strictArray(value.conflicts, budgetState, MAX_TASK_PLAN_DIAGNOSTIC_ENTRIES)
  const serializedValue = strictArray(value.serialized, budgetState, MAX_TASK_PLAN_DIAGNOSTIC_ENTRIES)
  if (conflictsValue === null || serializedValue === null) return null
  const conflicts: TaskPlanResourceDiagnostics['conflicts'][number][] = []
  const conflictKeys = new Set<string>()
  for (const entry of conflictsValue) {
    if (!exactKeys(entry, ['resource', 'work_item_ids']) || !consume(budgetState)) return null
    const resource = resourceKey(entry.resource, budgetState)
    const workItemIds = stringArray(entry.work_item_ids, budgetState, MAX_TASK_PLAN_WORK_ITEMS)
    if (resource === null || workItemIds === null || !unique(workItemIds)) return null
    const key = `${resource}\u0000${workItemIds.join('\u0000')}`
    if (conflictKeys.has(key)) return null
    conflictKeys.add(key)
    conflicts.push({ resource, work_item_ids: workItemIds })
  }
  const serialized: TaskPlanResourceDiagnostics['serialized'][number][] = []
  const serializedKeys = new Set<string>()
  for (const entry of serializedValue) {
    if (!exactKeys(entry, ['resource', 'before_work_item_id', 'after_work_item_id']) || !consume(budgetState)) return null
    const resource = resourceKey(entry.resource, budgetState)
    if (resource === null || !safeIdentifier(entry.before_work_item_id, budgetState)
      || !safeIdentifier(entry.after_work_item_id, budgetState)
      || entry.before_work_item_id === entry.after_work_item_id) return null
    const key = `${resource}\u0000${entry.before_work_item_id}\u0000${entry.after_work_item_id}`
    if (serializedKeys.has(key)) return null
    serializedKeys.add(key)
    serialized.push({
      resource,
      before_work_item_id: entry.before_work_item_id,
      after_work_item_id: entry.after_work_item_id,
    })
  }
  return { conflicts, serialized }
}

export function decodeValidationIssue(
  value: unknown,
  budgetState: DecodeBudget,
): TaskPlanValidationIssue | null {
  if (!exactKeys(value, ['severity', 'code', 'path', 'related_ids']) || !consume(budgetState)
    || value.severity !== 'error' || !isEnum(value.code, VALIDATION_ISSUE_CODES)
    || !safeText(value.path, budgetState)) return null
  const relatedIds = stringArray(value.related_ids, budgetState, MAX_TASK_PLAN_DIAGNOSTIC_ENTRIES)
  if (relatedIds === null || !unique(relatedIds)) return null
  return { severity: 'error', code: value.code, path: value.path, related_ids: relatedIds }
}

export function decodeValidation(
  value: unknown,
  budgetState: DecodeBudget,
): TaskPlanValidationResult | null {
  if (!exactKeys(value, ['valid', 'freezable', 'truncated', 'issues', 'coverage', 'dependencies', 'resources'])
    || !consume(budgetState) || typeof value.valid !== 'boolean'
    || typeof value.freezable !== 'boolean' || typeof value.truncated !== 'boolean') return null
  const issueValues = strictArray(value.issues, budgetState, MAX_TASK_PLAN_VALIDATION_ISSUES)
  if (issueValues === null) return null
  const issues: TaskPlanValidationIssue[] = []
  for (const issueValue of issueValues) {
    const issue = decodeValidationIssue(issueValue, budgetState)
    if (issue === null) return null
    issues.push(issue)
  }
  const coverage = decodeCoverage(value.coverage, budgetState)
  const dependencies = decodeDependencies(value.dependencies, budgetState)
  const resources = decodeResources(value.resources, budgetState)
  if (coverage === null || dependencies === null || resources === null
    || (value.valid && (!value.freezable || value.truncated || issues.length !== 0))
    || (value.freezable && !value.valid)) return null
  return { valid: value.valid, freezable: value.freezable, truncated: value.truncated, issues, coverage, dependencies, resources }
}

export function decodeProjection(
  value: unknown,
  budgetState: DecodeBudget,
): TaskPlanProjectionStatus | null {
  if (!exactKeys(value, ['state'], ['reason']) || !consume(budgetState)) return null
  if (value.state === 'current') {
    return 'reason' in value ? null : { state: 'current' }
  }
  if (value.state !== 'pending' && value.state !== 'drift') return null
  if (!Object.prototype.hasOwnProperty.call(value, 'reason')) return { state: value.state }
  if (value.reason === undefined) return null
  if (!safeText(value.reason, budgetState)) return null
  return { state: value.state, reason: value.reason }
}

export function sameCoverage(left: TaskPlanCoverageSummary, right: TaskPlanCoverageSummary): boolean {
  const sameEntries = (a: readonly TaskPlanCoverageEntry[], b: readonly TaskPlanCoverageEntry[]): boolean =>
    a.length === b.length && a.every((entry, index) => {
      const other = b[index]
      return other !== undefined && entry.id === other.id
        && entry.work_item_ids.length === other.work_item_ids.length
        && entry.work_item_ids.every((id, itemIndex) => id === other.work_item_ids[itemIndex])
    })
  return left.complete === right.complete
    && sameEntries(left.requirements, right.requirements)
    && sameEntries(left.acceptance_criteria, right.acceptance_criteria)
    && left.uncovered_requirement_ids.length === right.uncovered_requirement_ids.length
    && left.uncovered_requirement_ids.every((id, index) => id === right.uncovered_requirement_ids[index])
    && left.uncovered_acceptance_ids.length === right.uncovered_acceptance_ids.length
    && left.uncovered_acceptance_ids.every((id, index) => id === right.uncovered_acceptance_ids[index])
}

export function sameDependencies(left: TaskPlanDependencyDiagnostics, right: TaskPlanDependencyDiagnostics): boolean {
  return left.edges.length === right.edges.length
    && left.edges.every((edge, index) => {
      const other = right.edges[index]
      return other !== undefined && edge.from_work_item_id === other.from_work_item_id
        && edge.to_work_item_id === other.to_work_item_id
    })
    && left.cyclic_work_item_ids.length === right.cyclic_work_item_ids.length
    && left.cyclic_work_item_ids.every((id, index) => id === right.cyclic_work_item_ids[index])
}

export function sameResources(left: TaskPlanResourceDiagnostics, right: TaskPlanResourceDiagnostics): boolean {
  const sameConflicts = left.conflicts.length === right.conflicts.length
    && left.conflicts.every((entry, index) => {
      const other = right.conflicts[index]
      return other !== undefined && entry.resource === other.resource
        && entry.work_item_ids.length === other.work_item_ids.length
        && entry.work_item_ids.every((id, idIndex) => id === other.work_item_ids[idIndex])
    })
  const sameSerialized = left.serialized.length === right.serialized.length
    && left.serialized.every((entry, index) => {
      const other = right.serialized[index]
      return other !== undefined && entry.resource === other.resource
        && entry.before_work_item_id === other.before_work_item_id
        && entry.after_work_item_id === other.after_work_item_id
    })
  return sameConflicts && sameSerialized
}

export function addEntityIds(ids: Set<string>, values: readonly string[]): boolean {
  for (const id of values) {
    if (ids.has(id)) return false
    ids.add(id)
  }
  return true
}
