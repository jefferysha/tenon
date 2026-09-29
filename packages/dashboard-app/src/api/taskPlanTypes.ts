/** TaskPlan read model v1: the wire shape of GET /api/task-plans/:change and its size bounds. */
export const TASK_PLAN_READ_SCHEMA_VERSION = 'task-plan-read/v1' as const

export const TASK_PLAN_ERROR_CODES = [
  'TASK_PLAN_CHANGE_INVALID',
  'TASK_PLAN_ROOT_REQUIRED',
  'TASK_PLAN_ROOT_NOT_REGISTERED',
  'TASK_PLAN_ROOT_FORBIDDEN',
  'TASK_PLAN_NOT_FOUND',
  'TASK_PLAN_PATH_FORBIDDEN',
  'TASK_PLAN_CORRUPT',
] as const

export type TaskPlanErrorCode = (typeof TASK_PLAN_ERROR_CODES)[number]
export type TaskPlanRevisionStatus = 'draft' | 'frozen'
export type ResourceKind = 'path' | 'logical' | 'external'
export type ResourceAccess = 'read' | 'write'
export type ExpectedOutputKind = 'file' | 'artifact' | 'value'
export type TaskValidatorKind = 'file-exists' | 'json-schema' | 'test-report' | 'artifact-digest'

export const MAX_TASK_PLAN_TEXT_BYTES = 8 * 1024
export const MAX_TASK_PLAN_ID_BYTES = 160
export const MAX_TASK_PLAN_RESOURCE_BYTES = 1024
export const MAX_TASK_PLAN_GROUPS = 256
export const MAX_TASK_PLAN_WORK_ITEMS = 1024
export const MAX_TASK_PLAN_CATALOG_ENTRIES = 2048
export const MAX_TASK_PLAN_RELATIONS_PER_ITEM = 128
export const MAX_TASK_PLAN_VALIDATION_ISSUES = 256
export const MAX_TASK_PLAN_DIAGNOSTIC_ENTRIES = 4096
export const MAX_TASK_PLAN_DECODE_NODES = 65_536
export const MAX_TASK_PLAN_DOCUMENT_BYTES = 1024 * 1024
export const MAX_TASK_PLAN_LEGACY_PROJECTION_BYTES = 256 * 1024

export interface TaskPlanCatalogEntry {
  readonly id: string
  readonly title: string
}

export interface TaskGroupV1 {
  readonly id: string
  readonly title: string
  readonly parent_id: string | null
  readonly work_item_ids: readonly string[]
}

export interface ResourceClaimV1 {
  readonly kind: ResourceKind
  readonly access: ResourceAccess
  readonly key: string
}

export interface ExpectedOutputV1 {
  readonly id: string
  readonly kind: ExpectedOutputKind
  readonly ref: string
}

export interface TaskValidatorV1 {
  readonly id: string
  readonly kind: TaskValidatorKind
  readonly version: 1
  readonly output_ids: readonly string[]
}

export interface WorkItemV1 {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly group_id: string
  readonly requirement_refs: readonly string[]
  readonly acceptance_refs: readonly string[]
  readonly depends_on: readonly string[]
  readonly resource_claims: readonly ResourceClaimV1[]
  readonly expected_outputs: readonly ExpectedOutputV1[]
  readonly validators: readonly TaskValidatorV1[]
}

export interface TaskPlanCoverageEntry {
  readonly id: string
  readonly work_item_ids: readonly string[]
}

export interface TaskPlanCoverageSummary {
  readonly complete: boolean
  readonly requirements: readonly TaskPlanCoverageEntry[]
  readonly acceptance_criteria: readonly TaskPlanCoverageEntry[]
  readonly uncovered_requirement_ids: readonly string[]
  readonly uncovered_acceptance_ids: readonly string[]
}

export interface TaskPlanDependencyDiagnostics {
  readonly edges: readonly {
    readonly from_work_item_id: string
    readonly to_work_item_id: string
  }[]
  readonly cyclic_work_item_ids: readonly string[]
}

export interface TaskPlanResourceDiagnostics {
  readonly conflicts: readonly {
    readonly resource: string
    readonly work_item_ids: readonly string[]
  }[]
  readonly serialized: readonly {
    readonly resource: string
    readonly before_work_item_id: string
    readonly after_work_item_id: string
  }[]
}

export type TaskPlanValidationIssueCode =
  | 'acceptance-ref-duplicate'
  | 'acceptance-ref-unknown'
  | 'acceptance-uncovered'
  | 'dependency-cycle'
  | 'dependency-duplicate'
  | 'dependency-self'
  | 'dependency-unknown'
  | 'entity-id-duplicate'
  | 'group-cycle'
  | 'group-parent-unknown'
  | 'group-work-item-unknown'
  | 'requirement-ref-duplicate'
  | 'requirement-ref-unknown'
  | 'requirement-uncovered'
  | 'resource-claim-duplicate'
  | 'resource-write-conflict'
  | 'task-plan-contract-invalid'
  | 'validator-output-unknown'
  | 'work-item-group-mismatch'
  | 'work-item-multiple-groups'
  | 'work-item-unowned'
  | 'diagnostic-budget-exceeded'

export interface TaskPlanValidationIssue {
  readonly severity: 'error'
  readonly code: TaskPlanValidationIssueCode
  readonly path: string
  readonly related_ids: readonly string[]
}

export interface TaskPlanValidationResult {
  readonly valid: boolean
  readonly freezable: boolean
  readonly truncated: boolean
  readonly issues: readonly TaskPlanValidationIssue[]
  readonly coverage: TaskPlanCoverageSummary
  readonly dependencies: TaskPlanDependencyDiagnostics
  readonly resources: TaskPlanResourceDiagnostics
}

export type TaskPlanProjectionStatus =
  | { readonly state: 'current' }
  | { readonly state: 'pending'; readonly reason?: string }
  | { readonly state: 'drift'; readonly reason?: string }

export interface CanonicalTaskPlanReadModelV1 {
  readonly schema_version: typeof TASK_PLAN_READ_SCHEMA_VERSION
  readonly source: 'canonical'
  readonly schedulable: boolean
  readonly plan_id: string
  readonly revision_id: string
  readonly revision_number: number
  readonly fingerprint: `sha256:${string}`
  readonly revision_status: TaskPlanRevisionStatus
  readonly validation: TaskPlanValidationResult
  readonly completeness: { readonly state: 'complete' | 'incomplete' }
  readonly requirements: readonly TaskPlanCatalogEntry[]
  readonly acceptance_criteria: readonly TaskPlanCatalogEntry[]
  readonly groups: readonly TaskGroupV1[]
  readonly items: readonly (WorkItemV1 & { readonly identity_quality: 'canonical' })[]
  readonly coverage: TaskPlanCoverageSummary
  readonly dependencies: TaskPlanDependencyDiagnostics
  readonly resources: TaskPlanResourceDiagnostics
  readonly projection: TaskPlanProjectionStatus
}

export interface LegacyTaskPlanItemV1 {
  readonly id: string
  readonly identity_quality: 'legacy-derived'
  readonly title: string
  readonly stage: string | null
  readonly completed: boolean
  readonly order: number
  readonly depends_on: readonly []
  readonly requirement_refs: readonly []
  readonly acceptance_refs: readonly []
  readonly resource_claims: readonly []
  readonly expected_outputs: readonly []
  readonly validators: readonly []
}

export interface LegacyTaskPlanReadModelV1 {
  readonly schema_version: typeof TASK_PLAN_READ_SCHEMA_VERSION
  readonly source: 'legacy'
  readonly schedulable: false
  readonly groups: readonly []
  readonly items: readonly LegacyTaskPlanItemV1[]
  readonly completeness: { readonly state: 'unknown'; readonly reason: 'legacy-semantics-unproven' }
  readonly projection: { readonly state: 'legacy' }
}

export type TaskPlanReadModelV1 = CanonicalTaskPlanReadModelV1 | LegacyTaskPlanReadModelV1
