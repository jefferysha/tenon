import { createHash } from 'node:crypto'
import {
  decodeCapabilityAssessmentV2,
  type CapabilityAssessmentV2,
  type CapabilityResolutionV2,
  type DevelopmentRequestV2,
  type RepositoryContextV2,
  type WorkGraphV2,
  type WorkflowPipelinePlanV2,
} from '@tenon/kernel'
import { validateTaskPlanRevisionV1, type TaskPlanRevisionV1 } from '@tenon/kernel'
import { JsonBoundaryError, snapshotJsonBoundary, type JsonBoundaryValue } from './jsonBoundary.js'
import { materializeWorkflowPipelineV2, type WorkflowPipelineBlueprintV2 } from './workflow-pipeline-v2.js'
export type { WorkflowPipelineBlueprintV2, WorkflowPipelineSkillBlueprintV2, WorkflowPipelineStageBlueprintV2 } from './workflow-pipeline-v2.js'
/** Application planner: immutable request/context/catalog -> deterministic plan. */
export const PLANNER_CATALOG_SCHEMA_V2 = 'capability-catalog/v2' as const
export const PLANNER_DESCRIPTOR_SCHEMA_V2 = 'capability-descriptor/v2' as const
export const PLANNER_ASSESSMENT_EVIDENCE_V2 = 'assessment:deterministic:v2' as const
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SCHEMA_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/u
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,63}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
export const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const MAX_CATALOG_BYTES = 512 * 1_024
export const MAX_INTENT_BYTES = 8 * 1_024
export type PlannerDescriptorSourceV2 = 'builtin' | 'user' | 'remote'
export type PlannerAvailabilityV2 = 'available' | 'unavailable' | 'unknown'
export interface PlannerResourceClaimV2 {
  readonly kind: 'path' | 'logical' | 'external'
  readonly key: string
  readonly access: 'read' | 'write'
}
/** Skill output is opaque data referenced by schema ids and media hints. */
export interface PlannerSkillDescriptorV2 {
  readonly schema_version: typeof PLANNER_DESCRIPTOR_SCHEMA_V2
  readonly id: string
  readonly version: string
  readonly source: PlannerDescriptorSourceV2
  readonly availability: PlannerAvailabilityV2
  readonly capabilities: readonly string[]
  readonly supports_parallel: boolean
  readonly permissions: readonly string[]
  readonly resource_claims: readonly PlannerResourceClaimV2[]
  readonly input_schema_id?: string
  readonly output_schema_id?: string
  readonly output_media_types: readonly string[]
  readonly validators: readonly string[]
  readonly depends_on: readonly string[]
}
export interface PlannerMcpDescriptorV2 {
  readonly schema_version: typeof PLANNER_DESCRIPTOR_SCHEMA_V2
  readonly id: string
  readonly version: string
  readonly source: PlannerDescriptorSourceV2
  readonly availability: PlannerAvailabilityV2
  readonly capabilities: readonly string[]
  readonly permissions: readonly string[]
}
export interface PlannerCatalogInputV2 {
  readonly skills: readonly Omit<PlannerSkillDescriptorV2, 'schema_version'>[]
  readonly mcps: readonly Omit<PlannerMcpDescriptorV2, 'schema_version'>[]
  readonly allowed_permissions?: readonly string[]
  readonly policy_digest?: `sha256:${string}`
}
export interface PlannerCatalogV2 {
  readonly schema_version: typeof PLANNER_CATALOG_SCHEMA_V2
  readonly skills: readonly PlannerSkillDescriptorV2[]
  readonly mcps: readonly PlannerMcpDescriptorV2[]
  readonly allowed_permissions: readonly string[]
  readonly policy_digest: `sha256:${string}`
  readonly catalog_digest: `sha256:${string}`
}
export type CatalogNormalizationFailureCode = 'catalog-invalid' | 'catalog-too-large'
export type CatalogNormalizationOutcome =
  | { readonly ok: true; readonly catalog: PlannerCatalogV2 }
  | { readonly ok: false; readonly code: CatalogNormalizationFailureCode; readonly issues: readonly string[] }
export interface AssessIntentInputV2 {
  readonly request: DevelopmentRequestV2
  readonly context: RepositoryContextV2
  readonly assessment_id: string
  readonly assessed_at: string
}
export interface BuildWorkGraphInputV2 {
  readonly request: DevelopmentRequestV2
  readonly context: RepositoryContextV2
  readonly assessment: CapabilityAssessmentV2
  readonly graph_id: string
  readonly plan_revision_id: string
  readonly now: string
  readonly catalog?: PlannerCatalogV2 | PlannerCatalogInputV2
  readonly pipeline_id?: string
}
export interface PlannerPlanInputV2 extends BuildWorkGraphInputV2 {
  readonly catalog: PlannerCatalogV2 | PlannerCatalogInputV2
  /** Optional fully explicit user/project pipeline. Omit to materialize the automatic plan. */
  readonly pipeline_blueprint?: WorkflowPipelineBlueprintV2
}
export interface PlannerPlanSuccessV2 {
  readonly ok: true
  readonly assessment: CapabilityAssessmentV2
  readonly graph: WorkGraphV2
  readonly task_plan: TaskPlanRevisionV1
  readonly resolution: CapabilityResolutionV2
  readonly catalog: PlannerCatalogV2
  readonly pipeline?: WorkflowPipelinePlanV2
}
export type PlannerPlanOutcomeV2 = PlannerPlanSuccessV2 | {
  readonly ok: false
  readonly code: CatalogNormalizationFailureCode | 'planner-invalid'
  readonly issues: readonly string[]
}
export interface ResolvePlannerCapabilitiesInputV2 {
  readonly request: DevelopmentRequestV2
  readonly context: RepositoryContextV2
  readonly assessment: CapabilityAssessmentV2
  readonly graph: WorkGraphV2
  readonly catalog: PlannerCatalogV2 | PlannerCatalogInputV2
  readonly now: string
  readonly resolution_id?: string
  readonly record_id?: string
}
export interface AssessmentNormalizationHostV2 {
  readonly assessment_id: string
  readonly record_id?: string
  readonly assessed_at: string
  /** Optional ownership fields let an adapter fail closed before recording a proposal. */
  readonly request_id?: string
  readonly context_record_id?: string
  readonly project_id?: string
  readonly change_id?: string
}
export type AssessmentNormalizationOutcomeV2 =
  | { readonly ok: true; readonly assessment: CapabilityAssessmentV2 }
  | { readonly ok: false; readonly code: 'assessment-invalid' | 'assessment-too-large'; readonly issues: readonly string[] }
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export function stable(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}
export function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(stable(value), 'utf8').digest('hex')}`
}
export function taskIdentifier(value: string): string {
  const normalized = value.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-')
  return normalized.replace(/-{2,}/gu, '-').replace(/^-+|-+$/gu, '') || 'plan'
}
/** Stable work-item identity shared by planner consumers that bind workflow steps. */
export function workItemIdentifierV2(requirementId: string): string { return `work-${taskIdentifier(requirementId)}` }
export const workIdentifier = workItemIdentifierV2
export function acceptanceIdentifier(acceptanceId: string): string { return `acceptance-${taskIdentifier(acceptanceId)}` }
export function text(value: unknown, label: string, pattern = ID, max = 8_192): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > max || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}
export function list(value: unknown, label: string, pattern = ID, max = 2_048): readonly string[] {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${label} is invalid`)
  const values = value.map((entry, index) => text(entry, `${label}[${index}]`, pattern))
  return Object.freeze([...new Set(values)])
}
export function object(value: JsonBoundaryValue, label: string): { readonly [key: string]: JsonBoundaryValue } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid`)
  return value as { readonly [key: string]: JsonBoundaryValue }
}
export function keys(value: { readonly [key: string]: JsonBoundaryValue }, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed)
  for (const key of Object.keys(value)) if (!accepted.has(key)) throw new TypeError(`${label}.${key} is unknown`)
}
export function normalizeSkill(value: JsonBoundaryValue, index: number): PlannerSkillDescriptorV2 {
  const raw = object(value, `skills[${index}]`)
  keys(raw, ['id', 'version', 'source', 'availability', 'capabilities', 'supports_parallel', 'permissions', 'resource_claims', 'input_schema_id', 'output_schema_id', 'output_media_types', 'validators', 'depends_on'], `skills[${index}]`)
  const id = text(raw.id, `skills[${index}].id`)
  const version = text(raw.version, `skills[${index}].version`, VERSION, 64)
  const source = raw.source === 'builtin' || raw.source === 'user' || raw.source === 'remote' ? raw.source : undefined
  const availability = raw.availability === 'available' || raw.availability === 'unavailable' || raw.availability === 'unknown' ? raw.availability : undefined
  if (source === undefined || availability === undefined || typeof raw.supports_parallel !== 'boolean') throw new TypeError(`skills[${index}] enum/boolean is invalid`)
  const capabilities = list(raw.capabilities, `skills[${index}].capabilities`, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u)
  const permissions = list(raw.permissions, `skills[${index}].permissions`, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u)
  const output_media_types = list(raw.output_media_types ?? [], `skills[${index}].output_media_types`, /^[A-Za-z0-9][A-Za-z0-9.+/-]{0,159}$/u)
  const validators = list(raw.validators ?? [], `skills[${index}].validators`)
  const depends_on = list(raw.depends_on ?? [], `skills[${index}].depends_on`)
  const resourceClaimsRaw = raw.resource_claims
  if (!Array.isArray(resourceClaimsRaw) || resourceClaimsRaw.length > 2_048) throw new TypeError(`skills[${index}].resource_claims is invalid`)
  const resource_claims = resourceClaimsRaw.map((entry, claimIndex) => {
    const claim = object(entry, `skills[${index}].resource_claims[${claimIndex}]`)
    keys(claim, ['kind', 'key', 'access'], `skills[${index}].resource_claims[${claimIndex}]`)
    const kind = claim.kind === 'path' || claim.kind === 'logical' || claim.kind === 'external' ? claim.kind : undefined
    const access = claim.access === 'read' || claim.access === 'write' ? claim.access : undefined
    if (kind === undefined || access === undefined) throw new TypeError(`skills[${index}].resource_claims[${claimIndex}] enum is invalid`)
    const key = text(claim.key, `skills[${index}].resource_claims[${claimIndex}].key`, /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u, 512)
    if (kind === 'path' && (key.includes('..') || key.startsWith('/'))) throw new TypeError(`skills[${index}].resource_claims[${claimIndex}].key escapes repository`)
    return Object.freeze({ kind, access, key })
  })
  const input_schema_id = raw.input_schema_id === undefined ? undefined : text(raw.input_schema_id, `skills[${index}].input_schema_id`, SCHEMA_ID)
  const output_schema_id = raw.output_schema_id === undefined ? undefined : text(raw.output_schema_id, `skills[${index}].output_schema_id`, SCHEMA_ID)
  return freeze({ schema_version: PLANNER_DESCRIPTOR_SCHEMA_V2, id, version, source, availability, capabilities, supports_parallel: raw.supports_parallel, permissions, resource_claims: Object.freeze(resource_claims), ...(input_schema_id === undefined ? {} : { input_schema_id }), ...(output_schema_id === undefined ? {} : { output_schema_id }), output_media_types, validators, depends_on })
}
export function normalizeMcp(value: JsonBoundaryValue, index: number): PlannerMcpDescriptorV2 {
  const raw = object(value, `mcps[${index}]`)
  keys(raw, ['id', 'version', 'source', 'availability', 'capabilities', 'permissions'], `mcps[${index}]`)
  const source = raw.source === 'builtin' || raw.source === 'user' || raw.source === 'remote' ? raw.source : undefined
  const availability = raw.availability === 'available' || raw.availability === 'unavailable' || raw.availability === 'unknown' ? raw.availability : undefined
  if (source === undefined || availability === undefined) throw new TypeError(`mcps[${index}] enum is invalid`)
  return freeze({ schema_version: PLANNER_DESCRIPTOR_SCHEMA_V2, id: text(raw.id, `mcps[${index}].id`), version: text(raw.version, `mcps[${index}].version`, VERSION, 64), source, availability, capabilities: list(raw.capabilities, `mcps[${index}].capabilities`, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u), permissions: list(raw.permissions, `mcps[${index}].permissions`, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u) })
}
export function normalizeCapabilityCatalogV2(input: unknown): CatalogNormalizationOutcome {
  let snapshot
  try { snapshot = snapshotJsonBoundary(input, { maxBytes: MAX_CATALOG_BYTES, maxDepth: 24, maxNodes: 16_384 }) } catch (error) {
    return { ok: false, code: error instanceof JsonBoundaryError && error.code === 'json-byte-budget-exceeded' ? 'catalog-too-large' : 'catalog-invalid', issues: [error instanceof JsonBoundaryError ? error.path : '$'] }
  }
  try {
    const raw = object(snapshot.value, '$')
    keys(raw, ['skills', 'mcps', 'allowed_permissions', 'policy_digest'], '$')
    if (!Array.isArray(raw.skills) || !Array.isArray(raw.mcps)) throw new TypeError('skills/mcps must be arrays')
    const skills = raw.skills.map(normalizeSkill).sort((a, b) => `${a.id}\0${a.version}`.localeCompare(`${b.id}\0${b.version}`))
    const mcps = raw.mcps.map(normalizeMcp).sort((a, b) => `${a.id}\0${a.version}`.localeCompare(`${b.id}\0${b.version}`))
    const identities = new Set<string>()
    for (const descriptor of [...skills, ...mcps]) {
      const identity = `${descriptor.id}\0${descriptor.version}`
      if (identities.has(identity)) throw new TypeError(`duplicate descriptor ${identity}`)
      identities.add(identity)
    }
    const allowed_permissions = list(raw.allowed_permissions ?? [], 'allowed_permissions', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u)
    const policy_digest = raw.policy_digest === undefined ? digest({ allowed_permissions }) : text(raw.policy_digest, 'policy_digest', DIGEST, 71) as `sha256:${string}`
    const catalog = { schema_version: PLANNER_CATALOG_SCHEMA_V2, skills: Object.freeze(skills), mcps: Object.freeze(mcps), allowed_permissions, policy_digest, catalog_digest: digest({ skills, mcps, allowed_permissions, policy_digest }) }
    return { ok: true, catalog: freeze(catalog) }
  } catch (error) {
    return { ok: false, code: 'catalog-invalid', issues: [error instanceof Error ? error.message : '$'] }
  }
}
export function catalogOrThrow(input: PlannerCatalogV2 | PlannerCatalogInputV2): PlannerCatalogV2 {
  if ((input as PlannerCatalogV2).schema_version === PLANNER_CATALOG_SCHEMA_V2 && (input as PlannerCatalogV2).catalog_digest !== undefined) {
    const normalized = input as PlannerCatalogV2
    if (normalized.catalog_digest !== digest({ skills: normalized.skills, mcps: normalized.mcps, allowed_permissions: normalized.allowed_permissions, policy_digest: normalized.policy_digest })) throw new TypeError('catalog digest mismatch')
    return normalized
  }
  const normalized = normalizeCapabilityCatalogV2(input)
  if (!normalized.ok) throw new TypeError(normalized.issues.join('; '))
  return normalized.catalog
}
