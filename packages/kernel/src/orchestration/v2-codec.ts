import {
  V2_SCHEMAS,
  type BoardCommandV2,
  type BoardSnapshotV2,
  type CapabilityAssessmentV2,
  type CapabilityResolutionV2,
  type DevelopmentRequestV2,
  type GateEvaluationV2,
  type RepositoryContextV2,
  type SkillResultV2,
  type SkillRunV2,
  type SkillInputManifestV2,
  type ValidationReportV2,
  type WorkGraphV2,
  type WorkflowPipelinePlanV2,
  type PipelineStageV2,
  type PipelineSkillV2,
  type WorkItemV2,
  type BoardEventV2,
  type RunLeaseV2,
  type OrchestrationEffectV2,
  type V2Schema,
} from './v2-types.js'

export interface V2CodecError { readonly code: 'json-invalid' | 'object-invalid' | 'unknown-field' | 'field-invalid' | 'limit-exceeded'; readonly path: string; readonly message?: string }
export type V2DecodeResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly V2CodecError[] }
export const V2_MAX_BYTES = 512_000
export const V2_MAX_DEPTH = 16
export const V2_MAX_ITEMS = 2_048
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const SCHEMA_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/
const RESOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

function parse(input: unknown, errors: V2CodecError[]): unknown { if (typeof input === 'string') { try { return JSON.parse(input) as unknown } catch { errors.push({ code: 'json-invalid', path: '$' }); return undefined } } return input }
function walkLimit(value: unknown, path: string, depth: number, seen: Set<object>, errors: V2CodecError[]): void {
  if (depth > V2_MAX_DEPTH) { errors.push({ code: 'limit-exceeded', path }); return }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) { errors.push({ code: 'field-invalid', path, message: 'cycle' }); return }
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > V2_MAX_ITEMS) errors.push({ code: 'limit-exceeded', path })
    value.forEach((item, index) => walkLimit(item, `${path}[${index}]`, depth + 1, seen, errors))
  } else {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) errors.push({ code: 'object-invalid', path })
    for (const [key, item] of Object.entries(value)) walkLimit(item, `${path}.${key}`, depth + 1, seen, errors)
  }
  seen.delete(value)
}
function object(value: unknown, path: string, errors: V2CodecError[]): Record<string, unknown> | undefined { if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) { errors.push({ code: 'object-invalid', path }); return undefined } return value as Record<string, unknown> }
function closed(raw: Record<string, unknown>, allowed: readonly string[], path: string, errors: V2CodecError[]): void { const set = new Set(allowed); for (const key of Object.keys(raw)) if (!set.has(key)) errors.push({ code: 'unknown-field', path: `${path}.${key}` }) }
function text(value: unknown, path: string, errors: V2CodecError[], pattern?: RegExp, max = 8_192): string | undefined { if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > max || (pattern !== undefined && !pattern.test(value))) { errors.push({ code: 'field-invalid', path }); return undefined } return value }
function optionalText(value: unknown, path: string, errors: V2CodecError[], pattern?: RegExp): string | undefined { return value === undefined ? undefined : text(value, path, errors, pattern) }
function bool(value: unknown, path: string, errors: V2CodecError[]): boolean | undefined { if (typeof value !== 'boolean') { errors.push({ code: 'field-invalid', path }); return undefined } return value }
function integer(value: unknown, path: string, errors: V2CodecError[]): number | undefined { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { errors.push({ code: 'field-invalid', path }); return undefined } return value }
function array(value: unknown, path: string, errors: V2CodecError[]): readonly unknown[] { if (!Array.isArray(value) || value.length > V2_MAX_ITEMS || Object.getPrototypeOf(value) !== Array.prototype) { errors.push({ code: 'field-invalid', path }); return [] } return value }
function strings(value: unknown, path: string, errors: V2CodecError[]): readonly string[] { return array(value, path, errors).map((entry, index) => text(entry, `${path}[${index}]`, errors) ?? '') }
function digest(value: unknown, path: string, errors: V2CodecError[]): `sha256:${string}` | undefined { return text(value, path, errors, DIGEST) as `sha256:${string}` | undefined }
function actor(value: unknown, path: string, errors: V2CodecError[]): { readonly kind: 'user' | 'system' | 'worker' | 'policy'; readonly id: string } | undefined {
  const raw = object(value, path, errors); if (raw === undefined) return undefined
  closed(raw, ['kind', 'id'], path, errors)
  const kind = raw.kind === 'user' || raw.kind === 'system' || raw.kind === 'worker' || raw.kind === 'policy' ? raw.kind : undefined
  if (kind === undefined) errors.push({ code: 'field-invalid', path: `${path}.kind` })
  const id = text(raw.id, `${path}.id`, errors, ID)
  return kind === undefined || id === undefined ? undefined : { kind, id }
}

interface MetaParts { schema_version: string; record_id: string; project_id: string; change_id: string; revision: number; correlation_id: string; causation_id?: string; actor: { readonly kind: 'user' | 'system' | 'worker' | 'policy'; readonly id: string }; created_at: string }
function meta(raw: Record<string, unknown>, path: string, errors: V2CodecError[]): MetaParts | undefined {
  const record_id = text(raw.record_id, `${path}.record_id`, errors, ID)
  const project_id = text(raw.project_id, `${path}.project_id`, errors, ID)
  const change_id = text(raw.change_id, `${path}.change_id`, errors, ID)
  const revision = integer(raw.revision, `${path}.revision`, errors)
  const correlation_id = text(raw.correlation_id, `${path}.correlation_id`, errors, ID)
  const causation_id = optionalText(raw.causation_id, `${path}.causation_id`, errors, ID)
  const actorValue = actor(raw.actor, `${path}.actor`, errors)
  const created_at = text(raw.created_at, `${path}.created_at`, errors, UTC)
  if (record_id === undefined || project_id === undefined || change_id === undefined || revision === undefined || correlation_id === undefined || actorValue === undefined || created_at === undefined) return undefined
  return { schema_version: String(raw.schema_version), record_id, project_id, change_id, revision, correlation_id, ...(causation_id === undefined ? {} : { causation_id }), actor: actorValue, created_at }
}
function prepare(input: unknown, schema: string, allowed: readonly string[], errors: V2CodecError[]): Record<string, unknown> | undefined {
  const parsed = parse(input, errors)
  if (parsed === undefined) return undefined
  walkLimit(parsed, '$', 0, new Set(), errors)
  if (typeof input === 'string' && new TextEncoder().encode(input).byteLength > V2_MAX_BYTES) errors.push({ code: 'limit-exceeded', path: '$' })
  const raw = object(parsed, '$', errors); if (raw === undefined) return undefined
  closed(raw, allowed, '$', errors)
  if (raw.schema_version !== schema) errors.push({ code: 'field-invalid', path: '$.schema_version' })
  return raw
}

const META = ['schema_version', 'record_id', 'project_id', 'change_id', 'revision', 'correlation_id', 'causation_id', 'actor', 'created_at']
function result<T>(value: T, errors: readonly V2CodecError[]): V2DecodeResult<T> { return errors.length ? { ok: false, errors } : { ok: true, value } }

function nested<T>(input: unknown, decoder: (value: unknown) => V2DecodeResult<T>, path: string, errors: V2CodecError[]): T | undefined {
  if (input === undefined) return undefined
  const decoded = decoder(input)
  if (!decoded.ok) {
    errors.push(...decoded.errors.map((error) => ({ ...error, path: `${path}${error.path.slice(1)}` })))
    return undefined
  }
  return decoded.value
}

export function decodeDevelopmentRequestV2(input: unknown): V2DecodeResult<DevelopmentRequestV2> {
  const errors: V2CodecError[] = []; const raw = prepare(input, V2_SCHEMAS.request, [...META, 'request_id', 'intent', 'interaction_policy', 'requested_effects', 'constraints', 'user_skills', 'user_mcps', 'auto_select', 'workflow_id', 'workflow_version', 'track_id', 'track_revision', 'pipeline_id', 'pipeline_version'], errors); if (raw === undefined) return { ok: false, errors }
  const m = meta(raw, '$', errors); const request_id = text(raw.request_id, '$.request_id', errors, ID); const intent = text(raw.intent, '$.intent', errors); const interaction_policy = raw.interaction_policy === 'interactive' || raw.interaction_policy === 'recommended-defaults' || raw.interaction_policy === 'afk' ? raw.interaction_policy : undefined
  if (interaction_policy === undefined) errors.push({ code: 'field-invalid', path: '$.interaction_policy' }); const requested_effects = array(raw.requested_effects, '$.requested_effects', errors).map((v, i) => { const x = ['read', 'write', 'git', 'network', 'deploy-preview'].includes(String(v)) ? String(v) : undefined; if (!x) errors.push({ code: 'field-invalid', path: `$.requested_effects[${i}]` }); return x ?? 'read' }) as DevelopmentRequestV2['requested_effects']; const constraints = strings(raw.constraints, '$.constraints', errors); const auto_select = bool(raw.auto_select, '$.auto_select', errors)
  const skills = array(raw.user_skills, '$.user_skills', errors).map((entry, i) => { const x = object(entry, `$.user_skills[${i}]`, errors); if (!x) return undefined; closed(x, ['id', 'version', 'mode', 'depends_on'], `$.user_skills[${i}]`, errors); const id = text(x.id, `$.user_skills[${i}].id`, errors, ID); const version = optionalText(x.version, `$.user_skills[${i}].version`, errors, ID); const mode = x.mode === 'serial' || x.mode === 'parallel' ? x.mode as 'serial' | 'parallel' : undefined; if (!mode) errors.push({ code: 'field-invalid', path: `$.user_skills[${i}].mode` }); return id && mode ? { id, ...(version ? { version } : {}), mode, depends_on: strings(x.depends_on, `$.user_skills[${i}].depends_on`, errors) } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined)
  const mcps = array(raw.user_mcps, '$.user_mcps', errors).map((entry, i) => { const x = object(entry, `$.user_mcps[${i}]`, errors); if (!x) return undefined; closed(x, ['id', 'version', 'required'], `$.user_mcps[${i}]`, errors); const id = text(x.id, `$.user_mcps[${i}].id`, errors, ID); const version = optionalText(x.version, `$.user_mcps[${i}].version`, errors, ID); const required = bool(x.required, `$.user_mcps[${i}].required`, errors); return id && required !== undefined ? { id, ...(version ? { version } : {}), required } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined)
  const workflow_id = optionalText(raw.workflow_id, '$.workflow_id', errors, ID)
  const workflow_version = optionalText(raw.workflow_version, '$.workflow_version', errors, ID)
  const track_id = optionalText(raw.track_id, '$.track_id', errors, ID)
  const track_revision = optionalText(raw.track_revision, '$.track_revision', errors, ID)
  const pipeline_id = optionalText(raw.pipeline_id, '$.pipeline_id', errors, ID)
  const pipeline_version = optionalText(raw.pipeline_version, '$.pipeline_version', errors, ID)
  if (!m || !request_id || !intent || auto_select === undefined || interaction_policy === undefined) return { ok: false, errors }
  return result({
    ...m, schema_version: V2_SCHEMAS.request, request_id, intent, interaction_policy, requested_effects, constraints,
    user_skills: skills, user_mcps: mcps, auto_select,
    ...(workflow_id === undefined ? {} : { workflow_id }), ...(workflow_version === undefined ? {} : { workflow_version }),
    ...(track_id === undefined ? {} : { track_id }), ...(track_revision === undefined ? {} : { track_revision }),
    ...(pipeline_id === undefined ? {} : { pipeline_id }), ...(pipeline_version === undefined ? {} : { pipeline_version }),
  } as DevelopmentRequestV2, errors)
}

export function decodeRepositoryContextV2(input: unknown): V2DecodeResult<RepositoryContextV2> { const errors: V2CodecError[] = []; const raw = prepare(input, V2_SCHEMAS.context, [...META, 'request_id', 'repository', 'workspace_fingerprint', 'policy_digest', 'skill_catalog_digest', 'mcp_catalog_digest', 'observed_facts'], errors); if (!raw) return { ok: false, errors }; const m = meta(raw, '$', errors); const request_id = text(raw.request_id, '$.request_id', errors, ID); const repo = object(raw.repository, '$.repository', errors); if (repo) closed(repo, ['ref', 'branch', 'base_branch', 'head_sha', 'dirty'], '$.repository', errors); const ref = repo && text(repo.ref, '$.repository.ref', errors); const branch = repo && text(repo.branch, '$.repository.branch', errors); const base_branch = repo && text(repo.base_branch, '$.repository.base_branch', errors); const head_sha = repo && text(repo.head_sha, '$.repository.head_sha', errors); const dirty = repo && bool(repo.dirty, '$.repository.dirty', errors); const workspace_fingerprint = digest(raw.workspace_fingerprint, '$.workspace_fingerprint', errors); const policy_digest = digest(raw.policy_digest, '$.policy_digest', errors); const skill_catalog_digest = digest(raw.skill_catalog_digest, '$.skill_catalog_digest', errors); const mcp_catalog_digest = digest(raw.mcp_catalog_digest, '$.mcp_catalog_digest', errors); const facts = array(raw.observed_facts, '$.observed_facts', errors).map((entry, i) => { const x = object(entry, `$.observed_facts[${i}]`, errors); if (!x) return undefined; closed(x, ['key', 'value_ref', 'digest'], `$.observed_facts[${i}]`, errors); const key = text(x.key, `$.observed_facts[${i}].key`, errors); const value_ref = text(x.value_ref, `$.observed_facts[${i}].value_ref`, errors); const d = digest(x.digest, `$.observed_facts[${i}].digest`, errors); return key && value_ref && d ? { key, value_ref, digest: d } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined); if (!m || !request_id || !repo || !ref || !branch || !base_branch || !head_sha || dirty === undefined || !workspace_fingerprint || !policy_digest || !skill_catalog_digest || !mcp_catalog_digest) return { ok: false, errors }; return result({ ...m, schema_version: V2_SCHEMAS.context, request_id, repository: { ref, branch, base_branch, head_sha, dirty }, workspace_fingerprint, policy_digest, skill_catalog_digest, mcp_catalog_digest, observed_facts: facts }, errors) }

function decodeAssessment(input: unknown, errors: V2CodecError[]): CapabilityAssessmentV2 | undefined { const raw = prepare(input, V2_SCHEMAS.assessment, [...META, 'assessment_id', 'request_id', 'context_record_id', 'normalization', 'requirements', 'questions', 'risks', 'proposal_evidence_ref'], errors); if (!raw) return undefined; const m = meta(raw, '$', errors); const assessment_id = text(raw.assessment_id, '$.assessment_id', errors, ID); const request_id = text(raw.request_id, '$.request_id', errors, ID); const context_record_id = text(raw.context_record_id, '$.context_record_id', errors, ID); const normalization = ['complete', 'needs-input', 'rejected'].includes(String(raw.normalization)) ? raw.normalization as CapabilityAssessmentV2['normalization'] : undefined; if (!normalization) errors.push({ code: 'field-invalid', path: '$.normalization' }); const requirements = array(raw.requirements, '$.requirements', errors).map((entry, i) => { const x = object(entry, `$.requirements[${i}]`, errors); if (!x) return undefined; closed(x, ['id', 'capability', 'necessity', 'acceptance_refs', 'evidence_refs', 'constraints', 'risk'], `$.requirements[${i}]`, errors); const id = text(x.id, `$.requirements[${i}].id`, errors, ID); const capability = text(x.capability, `$.requirements[${i}].capability`, errors); const necessity = ['required', 'recommended', 'optional'].includes(String(x.necessity)) ? x.necessity as 'required' | 'recommended' | 'optional' : undefined; const risk = ['low', 'medium', 'high'].includes(String(x.risk)) ? x.risk as 'low' | 'medium' | 'high' : undefined; if (!necessity) errors.push({ code: 'field-invalid', path: `$.requirements[${i}].necessity` }); if (!risk) errors.push({ code: 'field-invalid', path: `$.requirements[${i}].risk` }); return id && capability && necessity && risk ? { id, capability, necessity, acceptance_refs: strings(x.acceptance_refs, `$.requirements[${i}].acceptance_refs`, errors), evidence_refs: strings(x.evidence_refs, `$.requirements[${i}].evidence_refs`, errors), constraints: strings(x.constraints, `$.requirements[${i}].constraints`, errors), risk } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined); const questions = array(raw.questions, '$.questions', errors).map((entry, i) => { const x = object(entry, `$.questions[${i}]`, errors); if (!x) return undefined; closed(x, ['id', 'prompt', 'blocking'], `$.questions[${i}]`, errors); const id = text(x.id, `$.questions[${i}].id`, errors, ID); const prompt = text(x.prompt, `$.questions[${i}].prompt`, errors); const blocking = bool(x.blocking, `$.questions[${i}].blocking`, errors); return id && prompt && blocking !== undefined ? { id, prompt, blocking } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined); const risks = strings(raw.risks, '$.risks', errors); const proposal_evidence_ref = text(raw.proposal_evidence_ref, '$.proposal_evidence_ref', errors); if (!m || !assessment_id || !request_id || !context_record_id || !normalization || !proposal_evidence_ref) return undefined; return { ...m, schema_version: V2_SCHEMAS.assessment, assessment_id, request_id, context_record_id, normalization, requirements, questions, risks, proposal_evidence_ref } }
export function decodeCapabilityAssessmentV2(input: unknown): V2DecodeResult<CapabilityAssessmentV2> { const errors: V2CodecError[] = []; const value = decodeAssessment(input, errors); return value ? result(value, errors) : { ok: false, errors } }

function decodePipelineSkill(input: unknown, path: string, errors: V2CodecError[]): PipelineSkillV2 | undefined {
  const raw = object(input, path, errors); if (!raw) return undefined
  closed(raw, ['binding_id', 'skill_id', 'skill_version', 'order', 'role', 'source', 'mode', 'depends_on', 'mcp_ids', 'input_schema_id', 'output_schema_id', 'validator_ids', 'resource_claims'], path, errors)
  const binding_id = text(raw.binding_id, `${path}.binding_id`, errors, ID)
  const skill_id = text(raw.skill_id, `${path}.skill_id`, errors, ID)
  const skill_version = text(raw.skill_version, `${path}.skill_version`, errors, ID)
  const order = integer(raw.order, `${path}.order`, errors)
  const role = ['workflow', 'track-mandatory', 'track-recommended', 'user', 'automatic', 'review'].includes(String(raw.role)) ? raw.role as PipelineSkillV2['role'] : undefined
  const source = ['builtin', 'project', 'user', 'automatic'].includes(String(raw.source)) ? raw.source as PipelineSkillV2['source'] : undefined
  const mode = raw.mode === 'serial' || raw.mode === 'parallel' ? raw.mode as PipelineSkillV2['mode'] : undefined
  if (!role) errors.push({ code: 'field-invalid', path: `${path}.role` })
  if (!source) errors.push({ code: 'field-invalid', path: `${path}.source` })
  if (!mode) errors.push({ code: 'field-invalid', path: `${path}.mode` })
  const input_schema_id = optionalText(raw.input_schema_id, `${path}.input_schema_id`, errors, SCHEMA_ID)
  const output_schema_id = optionalText(raw.output_schema_id, `${path}.output_schema_id`, errors, SCHEMA_ID)
  const resource_claims = raw.resource_claims === undefined ? [] : array(raw.resource_claims, `${path}.resource_claims`, errors).map((entry, index) => {
    const claim = object(entry, `${path}.resource_claims[${index}]`, errors)
    if (!claim) return undefined
    closed(claim, ['kind', 'key', 'access'], `${path}.resource_claims[${index}]`, errors)
    const kind = ['path', 'logical', 'external'].includes(String(claim.kind)) ? claim.kind as 'path' | 'logical' | 'external' : undefined
    const key = text(claim.key, `${path}.resource_claims[${index}].key`, errors, RESOURCE_KEY)
    if (key?.includes('..') || key?.startsWith('/')) errors.push({ code: 'field-invalid', path: `${path}.resource_claims[${index}].key` })
    const access = claim.access === 'read' || claim.access === 'write' ? claim.access as 'read' | 'write' : undefined
    if (!kind) errors.push({ code: 'field-invalid', path: `${path}.resource_claims[${index}].kind` })
    if (!access) errors.push({ code: 'field-invalid', path: `${path}.resource_claims[${index}].access` })
    return kind && key && access ? { kind, key, access } : undefined
  }).filter((value): value is NonNullable<typeof value> => value !== undefined)
  if (!binding_id || !skill_id || !skill_version || order === undefined || !role || !source || !mode) return undefined
  return { binding_id, skill_id, skill_version, order, role, source, mode, depends_on: strings(raw.depends_on, `${path}.depends_on`, errors), mcp_ids: strings(raw.mcp_ids, `${path}.mcp_ids`, errors), ...(input_schema_id === undefined ? {} : { input_schema_id }), ...(output_schema_id === undefined ? {} : { output_schema_id }), validator_ids: strings(raw.validator_ids, `${path}.validator_ids`, errors), ...(raw.resource_claims === undefined ? {} : { resource_claims }) }
}
function decodeSkillInputManifestV2(input: unknown, path: string, errors: V2CodecError[]): SkillInputManifestV2 | undefined {
  const raw = object(input, path, errors); if (!raw) return undefined
  closed(raw, ['schema_version', 'manifest_id', 'run_id', 'work_item_id', 'input_refs', 'artifact_digests', 'bundle_digest', 'byte_length', 'delivery', 'rejection_reason', 'created_at'], path, errors)
  if (raw.schema_version !== V2_SCHEMAS.inputManifest) errors.push({ code: 'field-invalid', path: `${path}.schema_version` })
  const manifest_id = text(raw.manifest_id, `${path}.manifest_id`, errors, ID)
  const run_id = text(raw.run_id, `${path}.run_id`, errors, ID)
  const work_item_id = text(raw.work_item_id, `${path}.work_item_id`, errors, ID)
  const input_refs = strings(raw.input_refs, `${path}.input_refs`, errors)
  const artifact_digests = array(raw.artifact_digests, `${path}.artifact_digests`, errors).map((value, index) => digest(value, `${path}.artifact_digests[${index}]`, errors)).filter((value): value is `sha256:${string}` => value !== undefined)
  const bundle_digest = digest(raw.bundle_digest, `${path}.bundle_digest`, errors)
  const byte_length = integer(raw.byte_length, `${path}.byte_length`, errors)
  const delivery = ['not-required', 'injected', 'rejected'].includes(String(raw.delivery)) ? raw.delivery as SkillInputManifestV2['delivery'] : undefined
  if (!delivery) errors.push({ code: 'field-invalid', path: `${path}.delivery` })
  const rejection_reason = optionalText(raw.rejection_reason, `${path}.rejection_reason`, errors, ID)
  const created_at = text(raw.created_at, `${path}.created_at`, errors, UTC)
  if (delivery === 'rejected' && rejection_reason === undefined) errors.push({ code: 'field-invalid', path: `${path}.rejection_reason` })
  if (delivery === 'not-required' && (input_refs.length !== 0 || artifact_digests.length !== 0 || byte_length !== 0)) errors.push({ code: 'field-invalid', path })
  if (delivery === 'injected' && artifact_digests.length !== input_refs.length) errors.push({ code: 'field-invalid', path: `${path}.artifact_digests` })
  if (!manifest_id || !run_id || !work_item_id || bundle_digest === undefined || byte_length === undefined || !delivery || !created_at) return undefined
  return { schema_version: V2_SCHEMAS.inputManifest, manifest_id, run_id, work_item_id, input_refs, artifact_digests, bundle_digest, byte_length, delivery, ...(rejection_reason === undefined ? {} : { rejection_reason }), created_at }
}
function decodePipelineStage(input: unknown, path: string, errors: V2CodecError[]): PipelineStageV2 | undefined {
  const raw = object(input, path, errors); if (!raw) return undefined
  closed(raw, ['stage_id', 'name', 'ordinal', 'execution_mode', 'depends_on', 'work_item_ids', 'gate', 'skills', 'input_refs', 'output_refs', 'input_subject_refs', 'output_subject_refs'], path, errors)
  const stage_id = text(raw.stage_id, `${path}.stage_id`, errors, ID)
  const name = text(raw.name, `${path}.name`, errors)
  const ordinal = integer(raw.ordinal, `${path}.ordinal`, errors)
  const execution_mode = raw.execution_mode === 'serial' || raw.execution_mode === 'parallel' ? raw.execution_mode as PipelineStageV2['execution_mode'] : undefined
  const gate = ['none', 'input', 'review', 'verification', 'release'].includes(String(raw.gate)) ? raw.gate as PipelineStageV2['gate'] : undefined
  if (!execution_mode) errors.push({ code: 'field-invalid', path: `${path}.execution_mode` })
  if (!gate) errors.push({ code: 'field-invalid', path: `${path}.gate` })
  const skills = array(raw.skills, `${path}.skills`, errors).map((value, index) => decodePipelineSkill(value, `${path}.skills[${index}]`, errors)).filter((value): value is PipelineSkillV2 => value !== undefined)
  if (!stage_id || !name || ordinal === undefined || !execution_mode || !gate) return undefined
  const input_subject_refs = raw.input_subject_refs === undefined ? undefined : strings(raw.input_subject_refs, `${path}.input_subject_refs`, errors)
  const output_subject_refs = raw.output_subject_refs === undefined ? undefined : strings(raw.output_subject_refs, `${path}.output_subject_refs`, errors)
  return { stage_id, name, ordinal, execution_mode, depends_on: strings(raw.depends_on, `${path}.depends_on`, errors), work_item_ids: strings(raw.work_item_ids, `${path}.work_item_ids`, errors), gate, skills, input_refs: strings(raw.input_refs, `${path}.input_refs`, errors), output_refs: strings(raw.output_refs, `${path}.output_refs`, errors), ...(input_subject_refs === undefined ? {} : { input_subject_refs }), ...(output_subject_refs === undefined ? {} : { output_subject_refs }) }
}
export function decodeWorkflowPipelineV2(input: unknown): V2DecodeResult<WorkflowPipelinePlanV2> {
  return genericMetaRecord(input, V2_SCHEMAS.pipeline, ['pipeline_id', 'pipeline_version', 'workflow_id', 'workflow_version', 'workflow_source', 'workflow_fingerprint', 'track_id', 'track_revision', 'track_source', 'pipeline_source', 'graph_id', 'assessment_id', 'status', 'stage_order', 'stages', 'customizations', 'pipeline_digest'], (raw, errors, m) => {
    const pipeline_id = text(raw.pipeline_id, '$.pipeline_id', errors, ID)
    const pipeline_version = text(raw.pipeline_version, '$.pipeline_version', errors, ID)
    const workflow_id = text(raw.workflow_id, '$.workflow_id', errors, ID)
    const workflow_version = text(raw.workflow_version, '$.workflow_version', errors, ID)
    const workflow_source = ['builtin', 'project', 'user', 'automatic'].includes(String(raw.workflow_source)) ? raw.workflow_source as WorkflowPipelinePlanV2['workflow_source'] : undefined
    const workflow_fingerprint = text(raw.workflow_fingerprint, '$.workflow_fingerprint', errors, ID)
    const track_id = text(raw.track_id, '$.track_id', errors, ID)
    const track_revision = text(raw.track_revision, '$.track_revision', errors, ID)
    const track_source = ['builtin', 'project', 'user', 'automatic'].includes(String(raw.track_source)) ? raw.track_source as WorkflowPipelinePlanV2['track_source'] : undefined
    const pipeline_source = ['builtin', 'project', 'user', 'automatic'].includes(String(raw.pipeline_source)) ? raw.pipeline_source as WorkflowPipelinePlanV2['pipeline_source'] : undefined
    const graph_id = text(raw.graph_id, '$.graph_id', errors, ID)
    const assessment_id = text(raw.assessment_id, '$.assessment_id', errors, ID)
    const status = ['draft', 'validated', 'frozen', 'superseded'].includes(String(raw.status)) ? raw.status as WorkflowPipelinePlanV2['status'] : undefined
    if (!workflow_source) errors.push({ code: 'field-invalid', path: '$.workflow_source' })
    if (!track_source) errors.push({ code: 'field-invalid', path: '$.track_source' })
    if (!pipeline_source) errors.push({ code: 'field-invalid', path: '$.pipeline_source' })
    if (!status) errors.push({ code: 'field-invalid', path: '$.status' })
    const stages = array(raw.stages, '$.stages', errors).map((value, index) => decodePipelineStage(value, `$.stages[${index}]`, errors)).filter((value): value is PipelineStageV2 => value !== undefined)
    const customizations = object(raw.customizations, '$.customizations', errors)
    if (customizations) closed(customizations, ['custom_workflow', 'custom_track', 'custom_pipeline', 'user_skill_ids', 'user_mcp_ids'], '$.customizations', errors)
    const custom_workflow = customizations ? bool(customizations.custom_workflow, '$.customizations.custom_workflow', errors) : undefined
    const custom_track = customizations ? bool(customizations.custom_track, '$.customizations.custom_track', errors) : undefined
    const custom_pipeline = customizations ? bool(customizations.custom_pipeline, '$.customizations.custom_pipeline', errors) : undefined
    const pipeline_digest = digest(raw.pipeline_digest, '$.pipeline_digest', errors)
    if (!pipeline_id || !pipeline_version || !workflow_id || !workflow_version || !workflow_source || !workflow_fingerprint || !track_id || !track_revision || !track_source || !pipeline_source || !graph_id || !assessment_id || !status || !customizations || custom_workflow === undefined || custom_track === undefined || custom_pipeline === undefined || !pipeline_digest) return undefined
    return { ...m, schema_version: V2_SCHEMAS.pipeline, pipeline_id, pipeline_version, workflow_id, workflow_version, workflow_source, workflow_fingerprint, track_id, track_revision, track_source, pipeline_source, graph_id, assessment_id, status, stage_order: strings(raw.stage_order, '$.stage_order', errors), stages, customizations: { custom_workflow, custom_track, custom_pipeline, user_skill_ids: strings(customizations.user_skill_ids, '$.customizations.user_skill_ids', errors), user_mcp_ids: strings(customizations.user_mcp_ids, '$.customizations.user_mcp_ids', errors) }, pipeline_digest }
  })
}

function genericMetaRecord<T extends Record<string, unknown>>(input: unknown, schema: string, allowed: string[], parseFields: (raw: Record<string, unknown>, errors: V2CodecError[], meta: MetaParts) => T | undefined): V2DecodeResult<T> { const errors: V2CodecError[] = []; const raw = prepare(input, schema, [...META, ...allowed], errors); if (!raw) return { ok: false, errors }; const m = meta(raw, '$', errors); const value = m ? parseFields(raw, errors, m) : undefined; return value ? result(value, errors) : { ok: false, errors } }

export function decodeWorkGraphV2(input: unknown): V2DecodeResult<WorkGraphV2> { return genericMetaRecord(input, V2_SCHEMAS.graph, ['graph_id', 'graph_revision', 'assessment_id', 'task_plan_revision_id', 'task_plan_digest', 'pipeline_id', 'dependency_edges', 'execution_groups', 'acceptance_coverage', 'status'], (r, e, m) => { const graph_id = text(r.graph_id, '$.graph_id', e, ID); const graph_revision = integer(r.graph_revision, '$.graph_revision', e); const assessment_id = text(r.assessment_id, '$.assessment_id', e, ID); const task_plan_revision_id = text(r.task_plan_revision_id, '$.task_plan_revision_id', e, ID); const task_plan_digest = digest(r.task_plan_digest, '$.task_plan_digest', e); const pipeline_id = optionalText(r.pipeline_id, '$.pipeline_id', e, ID); const status = ['draft', 'validated', 'frozen', 'superseded'].includes(String(r.status)) ? r.status as WorkGraphV2['status'] : undefined; if (!status) e.push({ code: 'field-invalid', path: '$.status' }); const edges = array(r.dependency_edges, '$.dependency_edges', e).map((x, i) => { const v = object(x, `$.dependency_edges[${i}]`, e); if (!v) return undefined; closed(v, ['from', 'to', 'reason'], `$.dependency_edges[${i}]`, e); const from = text(v.from, `$.dependency_edges[${i}].from`, e, ID); const to = text(v.to, `$.dependency_edges[${i}].to`, e, ID); const reason = ['data', 'resource', 'ordering', 'gate'].includes(String(v.reason)) ? v.reason as 'data' | 'resource' | 'ordering' | 'gate' : undefined; if (!reason) e.push({ code: 'field-invalid', path: `$.dependency_edges[${i}].reason` }); return from && to && reason ? { from, to, reason } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined); const groups = array(r.execution_groups, '$.execution_groups', e).map((x, i) => { const v = object(x, `$.execution_groups[${i}]`, e); if (!v) return undefined; closed(v, ['id', 'mode', 'work_item_ids'], `$.execution_groups[${i}]`, e); const id = text(v.id, `$.execution_groups[${i}].id`, e, ID); const mode = v.mode === 'serial' || v.mode === 'parallel' ? v.mode as 'serial' | 'parallel' : undefined; if (!mode) e.push({ code: 'field-invalid', path: `$.execution_groups[${i}].mode` }); return id && mode ? { id, mode, work_item_ids: strings(v.work_item_ids, `$.execution_groups[${i}].work_item_ids`, e) } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined); const coverage = array(r.acceptance_coverage, '$.acceptance_coverage', e).map((x, i) => { const v = object(x, `$.acceptance_coverage[${i}]`, e); if (!v) return undefined; closed(v, ['acceptance_id', 'work_item_ids'], `$.acceptance_coverage[${i}]`, e); const acceptance_id = text(v.acceptance_id, `$.acceptance_coverage[${i}].acceptance_id`, e, ID); return acceptance_id ? { acceptance_id, work_item_ids: strings(v.work_item_ids, `$.acceptance_coverage[${i}].work_item_ids`, e) } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined); if (!graph_id || graph_revision === undefined || !assessment_id || !task_plan_revision_id || !task_plan_digest || !status) return undefined; return { ...m, schema_version: V2_SCHEMAS.graph, graph_id, graph_revision, assessment_id, task_plan_revision_id, task_plan_digest, ...(pipeline_id === undefined ? {} : { pipeline_id }), dependency_edges: edges, execution_groups: groups, acceptance_coverage: coverage, status } }) }

export function decodeCapabilityResolutionV2(input: unknown): V2DecodeResult<CapabilityResolutionV2> { return genericMetaRecord(input, V2_SCHEMAS.resolution, ['resolution_id', 'assessment_id', 'graph_id', 'policy_digest', 'status', 'bindings', 'candidates', 'blockers', 'binding_digest'], (r, e, m) => { const resolution_id = text(r.resolution_id, '$.resolution_id', e, ID); const assessment_id = text(r.assessment_id, '$.assessment_id', e, ID); const graph_id = text(r.graph_id, '$.graph_id', e, ID); const policy_digest = digest(r.policy_digest, '$.policy_digest', e); const status = ['resolved', 'needs-input', 'blocked'].includes(String(r.status)) ? r.status as CapabilityResolutionV2['status'] : undefined; if (!status) e.push({ code: 'field-invalid', path: '$.status' }); const bindings = array(r.bindings, '$.bindings', e).map((x, i) => { const v = object(x, `$.bindings[${i}]`, e); if (!v) return undefined; closed(v, ['work_item_id', 'skill_id', 'skill_version', 'mcp_ids', 'mode', 'source', 'depends_on'], `$.bindings[${i}]`, e); const work_item_id = text(v.work_item_id, `$.bindings[${i}].work_item_id`, e, ID); const skill_id = text(v.skill_id, `$.bindings[${i}].skill_id`, e, ID); const skill_version = text(v.skill_version, `$.bindings[${i}].skill_version`, e, ID); const mode = v.mode === 'serial' || v.mode === 'parallel' ? v.mode as 'serial' | 'parallel' : undefined; const source = ['user', 'automatic', 'hybrid'].includes(String(v.source)) ? v.source as 'user' | 'automatic' | 'hybrid' : undefined; if (!mode) e.push({ code: 'field-invalid', path: `$.bindings[${i}].mode` }); if (!source) e.push({ code: 'field-invalid', path: `$.bindings[${i}].source` }); return work_item_id && skill_id && skill_version && mode && source ? { work_item_id, skill_id, skill_version, mcp_ids: strings(v.mcp_ids, `$.bindings[${i}].mcp_ids`, e), mode, source, depends_on: strings(v.depends_on, `$.bindings[${i}].depends_on`, e) } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined); const candidates = array(r.candidates, '$.candidates', e).map((x, i) => { const v = object(x, `$.candidates[${i}]`, e); if (!v) return undefined; closed(v, ['capability', 'candidate_id', 'kind', 'selected', 'rejected_reasons', 'rationale'], `$.candidates[${i}]`, e); const capability = text(v.capability, `$.candidates[${i}].capability`, e); const candidate_id = text(v.candidate_id, `$.candidates[${i}].candidate_id`, e, ID); const kind: 'skill' | 'mcp' | undefined = v.kind === 'skill' || v.kind === 'mcp' ? v.kind : undefined; const selected = bool(v.selected, `$.candidates[${i}].selected`, e); const rationale = text(v.rationale, `$.candidates[${i}].rationale`, e); if (!kind) e.push({ code: 'field-invalid', path: `$.candidates[${i}].kind` }); return capability && candidate_id && kind && selected !== undefined && rationale ? { capability, candidate_id, kind, selected, rejected_reasons: strings(v.rejected_reasons, `$.candidates[${i}].rejected_reasons`, e), rationale } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined); const blockers = strings(r.blockers, '$.blockers', e); const binding_digest = digest(r.binding_digest, '$.binding_digest', e); if (!resolution_id || !assessment_id || !graph_id || !policy_digest || !status || !binding_digest) return undefined; return { ...m, schema_version: V2_SCHEMAS.resolution, resolution_id, assessment_id, graph_id, policy_digest, status, bindings, candidates, blockers, binding_digest } }) }

export function decodeWorkItemV2(input: unknown): V2DecodeResult<WorkItemV2> { return genericMetaRecord(input, V2_SCHEMAS.workItem, ['work_item_id', 'title', 'status', 'group_id', 'depends_on', 'required_artifact_refs', 'validation_refs', 'selected_skill_id', 'selected_skill_version', 'mode', 'attempt_count', 'active_run_id', 'blockers'], (r, e, m) => { const work_item_id = text(r.work_item_id, '$.work_item_id', e, ID); const title = text(r.title, '$.title', e); const status = ['pending', 'ready', 'queued', 'claimed', 'running', 'waiting-input', 'reviewing', 'verifying', 'completed', 'blocked', 'failed', 'interrupted', 'cancelled'].includes(String(r.status)) ? r.status as WorkItemV2['status'] : undefined; if (!status) e.push({ code: 'field-invalid', path: '$.status' }); const mode = r.mode === 'serial' || r.mode === 'parallel' ? r.mode : undefined; if (!mode) e.push({ code: 'field-invalid', path: '$.mode' }); const attempt_count = integer(r.attempt_count, '$.attempt_count', e); if (!work_item_id || !title || !status || !mode || attempt_count === undefined) return undefined; return { ...m, schema_version: V2_SCHEMAS.workItem, work_item_id, title, status, ...(optionalText(r.group_id, '$.group_id', e, ID) ? { group_id: optionalText(r.group_id, '$.group_id', e, ID) } : {}), depends_on: strings(r.depends_on, '$.depends_on', e), required_artifact_refs: strings(r.required_artifact_refs, '$.required_artifact_refs', e), validation_refs: strings(r.validation_refs, '$.validation_refs', e), ...(optionalText(r.selected_skill_id, '$.selected_skill_id', e, ID) ? { selected_skill_id: optionalText(r.selected_skill_id, '$.selected_skill_id', e, ID) } : {}), ...(optionalText(r.selected_skill_version, '$.selected_skill_version', e, ID) ? { selected_skill_version: optionalText(r.selected_skill_version, '$.selected_skill_version', e, ID) } : {}), mode, attempt_count, ...(optionalText(r.active_run_id, '$.active_run_id', e, ID) ? { active_run_id: optionalText(r.active_run_id, '$.active_run_id', e, ID) } : {}), blockers: strings(r.blockers, '$.blockers', e) } }) }

function decodeSkillRunV2Legacy(input: unknown): V2DecodeResult<SkillRunV2> { return genericMetaRecord(input, V2_SCHEMAS.run, ['run_id', 'attempt_id', 'attempt', 'work_item_id', 'skill_id', 'skill_version', 'mcp_ids', 'status', 'lease', 'input_refs', 'result_id', 'prior_attempt_id', 'failure', 'started_at', 'finished_at'], (r, e, m) => { const run_id = text(r.run_id, '$.run_id', e, ID); const attempt_id = text(r.attempt_id, '$.attempt_id', e, ID); const attempt = integer(r.attempt, '$.attempt', e); const work_item_id = text(r.work_item_id, '$.work_item_id', e, ID); const skill_id = text(r.skill_id, '$.skill_id', e, ID); const skill_version = text(r.skill_version, '$.skill_version', e, ID); const status = ['queued', 'claimed', 'running', 'waiting-input', 'completed', 'failed', 'interrupted', 'cancelled'].includes(String(r.status)) ? r.status as SkillRunV2['status'] : undefined; if (!status) e.push({ code: 'field-invalid', path: '$.status' }); if (!run_id || !attempt_id || attempt === undefined || !work_item_id || !skill_id || !skill_version || !status) return undefined; return { ...m, schema_version: V2_SCHEMAS.run, run_id, attempt_id, attempt, work_item_id, skill_id, skill_version, mcp_ids: strings(r.mcp_ids, '$.mcp_ids', e), status, input_refs: strings(r.input_refs, '$.input_refs', e), ...(optionalText(r.result_id, '$.result_id', e, ID) ? { result_id: optionalText(r.result_id, '$.result_id', e, ID) } : {}), ...(optionalText(r.prior_attempt_id, '$.prior_attempt_id', e, ID) ? { prior_attempt_id: optionalText(r.prior_attempt_id, '$.prior_attempt_id', e, ID) } : {}) } }) }

export function decodeSkillRunV2(input: unknown): V2DecodeResult<SkillRunV2> {
  return genericMetaRecord(input, V2_SCHEMAS.run, ['run_id', 'attempt_id', 'attempt', 'work_item_id', 'skill_id', 'skill_version', 'mcp_ids', 'status', 'lease', 'input_refs', 'input_manifest', 'result_id', 'prior_attempt_id', 'failure', 'started_at', 'finished_at'], (r, e, m) => {
    const run_id = text(r.run_id, '$.run_id', e, ID); const attempt_id = text(r.attempt_id, '$.attempt_id', e, ID); const attempt = integer(r.attempt, '$.attempt', e)
    const work_item_id = text(r.work_item_id, '$.work_item_id', e, ID); const skill_id = text(r.skill_id, '$.skill_id', e, ID); const skill_version = text(r.skill_version, '$.skill_version', e, ID)
    const status = ['queued', 'claimed', 'running', 'waiting-input', 'completed', 'failed', 'interrupted', 'cancelled'].includes(String(r.status)) ? r.status as SkillRunV2['status'] : undefined
    if (!status) e.push({ code: 'field-invalid', path: '$.status' })
    const lease = nested(r.lease, decodeRunLeaseV2, '$.lease', e)
    const input_manifest = r.input_manifest === undefined ? undefined : decodeSkillInputManifestV2(r.input_manifest, '$.input_manifest', e)
    const result_id = optionalText(r.result_id, '$.result_id', e, ID); const prior_attempt_id = optionalText(r.prior_attempt_id, '$.prior_attempt_id', e, ID)
    const started_at = optionalText(r.started_at, '$.started_at', e, UTC); const finished_at = optionalText(r.finished_at, '$.finished_at', e, UTC)
    let failure: SkillRunV2['failure'] | undefined
    if (r.failure !== undefined) {
      const rawFailure = object(r.failure, '$.failure', e)
      if (rawFailure) {
        closed(rawFailure, ['code', 'retryable', 'detail_ref'], '$.failure', e)
        const code = text(rawFailure.code, '$.failure.code', e, ID); const retryable = bool(rawFailure.retryable, '$.failure.retryable', e); const detail_ref = optionalText(rawFailure.detail_ref, '$.failure.detail_ref', e, ID)
        if (code && retryable !== undefined) failure = { code, retryable, ...(detail_ref === undefined ? {} : { detail_ref }) }
      }
    }
    if (!run_id || !attempt_id || attempt === undefined || !work_item_id || !skill_id || !skill_version || !status) return undefined
    return { ...m, schema_version: V2_SCHEMAS.run, run_id, attempt_id, attempt, work_item_id, skill_id, skill_version, mcp_ids: strings(r.mcp_ids, '$.mcp_ids', e), status, ...(lease === undefined ? {} : { lease }), input_refs: strings(r.input_refs, '$.input_refs', e), ...(input_manifest === undefined ? {} : { input_manifest }), ...(result_id === undefined ? {} : { result_id }), ...(prior_attempt_id === undefined ? {} : { prior_attempt_id }), ...(failure === undefined ? {} : { failure }), ...(started_at === undefined ? {} : { started_at }), ...(finished_at === undefined ? {} : { finished_at }) }
  })
}

function decodeSkillResultV2Legacy(input: unknown): V2DecodeResult<SkillResultV2> { return genericMetaRecord(input, V2_SCHEMAS.result, ['result_id', 'run_id', 'status', 'contract_status', 'output_schema_id', 'summary', 'raw_output', 'artifacts', 'validation_refs', 'diagnostics'], (r, e, m) => { const result_id = text(r.result_id, '$.result_id', e, ID); const run_id = text(r.run_id, '$.run_id', e, ID); const status = ['completed', 'failed', 'blocked', 'incomplete', 'corrupt'].includes(String(r.status)) ? r.status as SkillResultV2['status'] : undefined; const contract_status = ['validated', 'unknown', 'invalid'].includes(String(r.contract_status)) ? r.contract_status as SkillResultV2['contract_status'] : undefined; if (!status) e.push({ code: 'field-invalid', path: '$.status' }); if (!contract_status) e.push({ code: 'field-invalid', path: '$.contract_status' }); if (!result_id || !run_id || !status || !contract_status) return undefined; return { ...m, schema_version: V2_SCHEMAS.result, result_id, run_id, status, contract_status, ...(optionalText(r.output_schema_id, '$.output_schema_id', e, ID) ? { output_schema_id: optionalText(r.output_schema_id, '$.output_schema_id', e, ID) } : {}), ...(optionalText(r.summary, '$.summary', e) ? { summary: optionalText(r.summary, '$.summary', e) } : {}), artifacts: array(r.artifacts, '$.artifacts', e).map((x, i) => { const v = object(x, `$.artifacts[${i}]`, e); if (!v) return undefined; closed(v, ['id', 'kind', 'ref', 'digest', 'media_type', 'byte_length'], `$.artifacts[${i}]`, e); const id = text(v.id, `$.artifacts[${i}].id`, e, ID); const kind = ['file', 'diff', 'document', 'json', 'text', 'url', 'report', 'value', 'unknown'].includes(String(v.kind)) ? v.kind as SkillResultV2['artifacts'][number]['kind'] : undefined; const ref = text(v.ref, `$.artifacts[${i}].ref`, e); const d = digest(v.digest, `$.artifacts[${i}].digest`, e); if (!kind) e.push({ code: 'field-invalid', path: `$.artifacts[${i}].kind` }); return id && kind && ref && d ? { id, kind, ref, digest: d, ...(optionalText(v.media_type, `$.artifacts[${i}].media_type`, e) ? { media_type: optionalText(v.media_type, `$.artifacts[${i}].media_type`, e) } : {}) } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined), validation_refs: strings(r.validation_refs, '$.validation_refs', e), diagnostics: strings(r.diagnostics, '$.diagnostics', e) } }) }

export function decodeSkillResultV2(input: unknown): V2DecodeResult<SkillResultV2> {
  return genericMetaRecord(input, V2_SCHEMAS.result, ['result_id', 'run_id', 'status', 'contract_status', 'output_schema_id', 'summary', 'raw_output', 'artifacts', 'validation_refs', 'diagnostics', 'output_digest', 'output_bytes'], (r, e, m) => {
    const result_id = text(r.result_id, '$.result_id', e, ID); const run_id = text(r.run_id, '$.run_id', e, ID)
    const status = ['completed', 'failed', 'blocked', 'incomplete', 'corrupt'].includes(String(r.status)) ? r.status as SkillResultV2['status'] : undefined
    const contract_status = ['validated', 'unknown', 'invalid'].includes(String(r.contract_status)) ? r.contract_status as SkillResultV2['contract_status'] : undefined
    if (!status) e.push({ code: 'field-invalid', path: '$.status' }); if (!contract_status) e.push({ code: 'field-invalid', path: '$.contract_status' })
    const output_schema_id = optionalText(r.output_schema_id, '$.output_schema_id', e, SCHEMA_ID); const summary = optionalText(r.summary, '$.summary', e)
    const output_digest = r.output_digest === undefined ? undefined : digest(r.output_digest, '$.output_digest', e)
    const output_bytes = r.output_bytes === undefined ? undefined : integer(r.output_bytes, '$.output_bytes', e)
    let raw_output: SkillResultV2['raw_output'] | undefined
    if (r.raw_output !== undefined) {
      const v = object(r.raw_output, '$.raw_output', e)
      if (v) { closed(v, ['ref', 'digest', 'media_type', 'byte_length'], '$.raw_output', e); const ref = text(v.ref, '$.raw_output.ref', e); const d = digest(v.digest, '$.raw_output.digest', e); const media_type = text(v.media_type, '$.raw_output.media_type', e); const byte_length = integer(v.byte_length, '$.raw_output.byte_length', e); if (ref && d && media_type && byte_length !== undefined) raw_output = { ref, digest: d, media_type, byte_length } }
    }
    const artifacts = array(r.artifacts, '$.artifacts', e).map((x, i) => {
      const v = object(x, `$.artifacts[${i}]`, e); if (!v) return undefined
      closed(v, ['id', 'kind', 'ref', 'digest', 'media_type', 'byte_length'], `$.artifacts[${i}]`, e)
      const id = text(v.id, `$.artifacts[${i}].id`, e, ID); const kind = ['file', 'diff', 'document', 'json', 'text', 'url', 'report', 'value', 'unknown'].includes(String(v.kind)) ? v.kind as SkillResultV2['artifacts'][number]['kind'] : undefined; const ref = text(v.ref, `$.artifacts[${i}].ref`, e); const d = digest(v.digest, `$.artifacts[${i}].digest`, e); const media_type = optionalText(v.media_type, `$.artifacts[${i}].media_type`, e); const byte_length = v.byte_length === undefined ? undefined : integer(v.byte_length, `$.artifacts[${i}].byte_length`, e)
      if (!kind) e.push({ code: 'field-invalid', path: `$.artifacts[${i}].kind` })
      return id && kind && ref && d ? { id, kind, ref, digest: d, ...(media_type === undefined ? {} : { media_type }), ...(byte_length === undefined ? {} : { byte_length }) } : undefined
    }).filter((x): x is NonNullable<typeof x> => x !== undefined)
    if (!result_id || !run_id || !status || !contract_status) return undefined
    return { ...m, schema_version: V2_SCHEMAS.result, result_id, run_id, status, contract_status, ...(output_schema_id === undefined ? {} : { output_schema_id }), ...(summary === undefined ? {} : { summary }), ...(raw_output === undefined ? {} : { raw_output }), artifacts, validation_refs: strings(r.validation_refs, '$.validation_refs', e), diagnostics: strings(r.diagnostics, '$.diagnostics', e), ...(output_digest === undefined ? {} : { output_digest }), ...(output_bytes === undefined ? {} : { output_bytes }) }
  })
}

export function decodeValidationReportV2(input: unknown): V2DecodeResult<ValidationReportV2> { return genericMetaRecord(input, V2_SCHEMAS.validation, ['report_id', 'work_item_id', 'result_id', 'validator_id', 'validator_version', 'status', 'target_digests', 'evidence_refs', 'checks'], (r, e, m) => { const report_id = text(r.report_id, '$.report_id', e, ID); const work_item_id = text(r.work_item_id, '$.work_item_id', e, ID); const result_id = text(r.result_id, '$.result_id', e, ID); const validator_id = text(r.validator_id, '$.validator_id', e, ID); const validator_version = text(r.validator_version, '$.validator_version', e, ID); const status = ['pass', 'fail', 'unknown', 'incomplete'].includes(String(r.status)) ? r.status as ValidationReportV2['status'] : undefined; if (!status) e.push({ code: 'field-invalid', path: '$.status' }); if (!report_id || !work_item_id || !result_id || !validator_id || !validator_version || !status) return undefined; const target_digests = array(r.target_digests, '$.target_digests', e).map((x, i) => digest(x, `$.target_digests[${i}]`, e) ?? 'sha256:' + '0'.repeat(64)) as `sha256:${string}`[]; const checks = array(r.checks, '$.checks', e).map((x, i) => { const v = object(x, `$.checks[${i}]`, e); if (!v) return undefined; closed(v, ['id', 'status', 'message'], `$.checks[${i}]`, e); const id = text(v.id, `$.checks[${i}].id`, e, ID); const s = ['pass', 'fail', 'unknown'].includes(String(v.status)) ? v.status as 'pass' | 'fail' | 'unknown' : undefined; if (!s) e.push({ code: 'field-invalid', path: `$.checks[${i}].status` }); return id && s ? { id, status: s, ...(optionalText(v.message, `$.checks[${i}].message`, e) ? { message: optionalText(v.message, `$.checks[${i}].message`, e) } : {}) } : undefined }).filter((x): x is NonNullable<typeof x> => x !== undefined); return { ...m, schema_version: V2_SCHEMAS.validation, report_id, work_item_id, result_id, validator_id, validator_version, status, target_digests, evidence_refs: strings(r.evidence_refs, '$.evidence_refs', e), checks } }) }

export function decodeGateEvaluationV2(input: unknown): V2DecodeResult<GateEvaluationV2> { return genericMetaRecord(input, V2_SCHEMAS.gate, ['gate_id', 'kind', 'status', 'required_evidence_refs', 'decision_revision', 'rationale', 'waiver_receipt_ref'], (r, e, m) => { const gate_id = text(r.gate_id, '$.gate_id', e, ID); const kind = ['input', 'review', 'verification', 'release'].includes(String(r.kind)) ? r.kind as GateEvaluationV2['kind'] : undefined; const status = ['pending', 'passed', 'rejected', 'waived'].includes(String(r.status)) ? r.status as GateEvaluationV2['status'] : undefined; const decision_revision = integer(r.decision_revision, '$.decision_revision', e); if (!kind) e.push({ code: 'field-invalid', path: '$.kind' }); if (!status) e.push({ code: 'field-invalid', path: '$.status' }); if (!gate_id || !kind || !status || decision_revision === undefined) return undefined; return { ...m, schema_version: V2_SCHEMAS.gate, gate_id, kind, status, required_evidence_refs: strings(r.required_evidence_refs, '$.required_evidence_refs', e), decision_revision, ...(optionalText(r.rationale, '$.rationale', e) ? { rationale: optionalText(r.rationale, '$.rationale', e) } : {}), ...(optionalText(r.waiver_receipt_ref, '$.waiver_receipt_ref', e, ID) ? { waiver_receipt_ref: optionalText(r.waiver_receipt_ref, '$.waiver_receipt_ref', e, ID) } : {}) } }) }

export function decodeRunLeaseV2(input: unknown): V2DecodeResult<RunLeaseV2> { const errors: V2CodecError[] = []; const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined; if (!raw) return { ok: false, errors: [{ code: 'object-invalid', path: '$' }] }; closed(raw, ['lease_id', 'owner_id', 'acquired_at', 'heartbeat_at', 'expires_at', 'generation', 'status'], '$', errors); const lease_id = text(raw.lease_id, '$.lease_id', errors, ID); const owner_id = text(raw.owner_id, '$.owner_id', errors, ID); const acquired_at = text(raw.acquired_at, '$.acquired_at', errors, UTC); const heartbeat_at = text(raw.heartbeat_at, '$.heartbeat_at', errors, UTC); const expires_at = text(raw.expires_at, '$.expires_at', errors, UTC); const generation = integer(raw.generation, '$.generation', errors); const status = ['active', 'renewed', 'expired', 'released', 'revoked'].includes(String(raw.status)) ? raw.status as RunLeaseV2['status'] : undefined; if (!status) errors.push({ code: 'field-invalid', path: '$.status' }); if (!lease_id || !owner_id || !acquired_at || !heartbeat_at || !expires_at || generation === undefined || !status) return { ok: false, errors }; return result({ lease_id, owner_id, acquired_at, heartbeat_at, expires_at, generation, status }, errors) }

function decodeEffects(input: unknown, path: string, errors: V2CodecError[]): readonly OrchestrationEffectV2[] {
  return array(input, path, errors).map((entry, index) => {
    const itemPath = `${path}[${index}]`
    const raw = object(entry, itemPath, errors)
    if (!raw) return undefined
    const type = raw.type
    if (type === 'persist-record') {
      closed(raw, ['type', 'record_schema', 'record_id'], itemPath, errors)
      const schemaValue = text(raw.record_schema, `${itemPath}.record_schema`, errors, ID)
      const record_schema = schemaValue !== undefined && (Object.values(V2_SCHEMAS) as readonly string[]).includes(schemaValue) ? schemaValue as V2Schema : undefined
      if (schemaValue !== undefined && record_schema === undefined) errors.push({ code: 'field-invalid', path: `${itemPath}.record_schema` })
      const record_id = text(raw.record_id, `${itemPath}.record_id`, errors, ID)
      if (record_schema && record_id) return { type, record_schema, record_id }
    } else if (type === 'request-executor-cancel') {
      closed(raw, ['type', 'run_id'], itemPath, errors)
      const run_id = text(raw.run_id, `${itemPath}.run_id`, errors, ID)
      if (run_id) return { type, run_id }
    } else if (type === 'wake-scheduler') {
      closed(raw, ['type', 'reason'], itemPath, errors)
      const reason = text(raw.reason, `${itemPath}.reason`, errors, ID)
      if (reason) return { type, reason }
    } else {
      errors.push({ code: 'field-invalid', path: `${itemPath}.type` })
    }
    return undefined
  }).filter((value): value is OrchestrationEffectV2 => value !== undefined)
}

export function decodeBoardEventV2(input: unknown): V2DecodeResult<BoardEventV2> { const errors: V2CodecError[] = []; const raw = prepare(input, V2_SCHEMAS.event, ['schema_version', 'event_id', 'event_type', 'command_id', 'idempotency_key', 'project_id', 'change_id', 'correlation_id', 'causation_id', 'actor', 'revision', 'issued_at', 'before_digest', 'after_digest', 'payload', 'effects'], errors); if (!raw) return { ok: false, errors }; const event_id = text(raw.event_id, '$.event_id', errors, ID); const command_id = text(raw.command_id, '$.command_id', errors, ID); const idempotency_key = text(raw.idempotency_key, '$.idempotency_key', errors, ID); const project_id = text(raw.project_id, '$.project_id', errors, ID); const change_id = text(raw.change_id, '$.change_id', errors, ID); const correlation_id = text(raw.correlation_id, '$.correlation_id', errors, ID); const event_type = text(raw.event_type, '$.event_type', errors, ID) as BoardEventV2['event_type'] | undefined; const revision = integer(raw.revision, '$.revision', errors); const issued_at = text(raw.issued_at, '$.issued_at', errors, UTC); const before_digest = digest(raw.before_digest, '$.before_digest', errors); const after_digest = digest(raw.after_digest, '$.after_digest', errors); const actorValue = actor(raw.actor, '$.actor', errors); const payload = decodeBoardCommandV2(raw.payload); if (!payload.ok) errors.push(...payload.errors.map((error) => ({ ...error, path: `$.payload${error.path.slice(1)}` }))); const effects = decodeEffects(raw.effects, '$.effects', errors); if (!event_id || !command_id || !idempotency_key || !project_id || !change_id || !correlation_id || !event_type || revision === undefined || !issued_at || !before_digest || !after_digest || !actorValue || !payload.ok) return { ok: false, errors }; return result({ schema_version: V2_SCHEMAS.event, event_id, event_type, command_id, idempotency_key, project_id, change_id, correlation_id, ...(optionalText(raw.causation_id, '$.causation_id', errors, ID) ? { causation_id: optionalText(raw.causation_id, '$.causation_id', errors, ID) } : {}), actor: actorValue, revision, issued_at, before_digest, after_digest, payload: payload.value, effects }, errors) }

export function decodeBoardSnapshotV2(input: unknown): V2DecodeResult<BoardSnapshotV2> {
  // Snapshots are read models with host provenance, but do not use the generic
  // record-meta parser because their optional projection fields differ.
  const errors: V2CodecError[] = []
  const allowed = ['schema_version', 'record_id', 'project_id', 'change_id', 'revision', 'correlation_id', 'actor', 'created_at', 'event_head_id', 'event_head_digest', 'command_head_id', 'status', 'request', 'context', 'assessment', 'pipeline', 'graph', 'resolution', 'work_items', 'runs', 'results', 'validations', 'gates', 'leases', 'blockers', 'next_actions', 'resume_status', 'updated_at']
  const parsed = parse(input, errors)
  if (parsed === undefined) return { ok: false, errors }
  walkLimit(parsed, '$', 0, new Set(), errors)
  if (typeof input === 'string' && new TextEncoder().encode(input).byteLength > V2_MAX_BYTES) errors.push({ code: 'limit-exceeded', path: '$' })
  const raw = object(parsed, '$', errors)
  if (raw === undefined) return { ok: false, errors }
  closed(raw, allowed, '$', errors)
  if (raw.schema_version !== V2_SCHEMAS.snapshot) errors.push({ code: 'field-invalid', path: '$.schema_version' })
  const record_id = text(raw.record_id, '$.record_id', errors, ID)
  const project_id = text(raw.project_id, '$.project_id', errors, ID)
  const change_id = text(raw.change_id, '$.change_id', errors, ID)
  const revision = integer(raw.revision, '$.revision', errors)
  const correlation_id = text(raw.correlation_id, '$.correlation_id', errors, ID)
  const actorValue = actor(raw.actor, '$.actor', errors)
  const created_at = text(raw.created_at, '$.created_at', errors, UTC)
  const status = ['draft', 'contextualizing', 'assessing', 'planning', 'planned', 'ready', 'executing', 'reviewing', 'verifying', 'completed', 'waiting-input', 'blocked', 'paused', 'failed', 'cancelled'].includes(String(raw.status)) ? raw.status as BoardSnapshotV2['status'] : undefined
  if (!status) errors.push({ code: 'field-invalid', path: '$.status' })
  const updated_at = text(raw.updated_at, '$.updated_at', errors, UTC)
  const event_head_id = raw.event_head_id === undefined ? undefined : optionalText(raw.event_head_id, '$.event_head_id', errors, ID)
  const event_head_digest = raw.event_head_digest === undefined ? undefined : digest(raw.event_head_digest, '$.event_head_digest', errors)
  const command_head_id = raw.command_head_id === undefined ? undefined : optionalText(raw.command_head_id, '$.command_head_id', errors, ID)
  const resume_status = raw.resume_status === undefined ? undefined : optionalText(raw.resume_status, '$.resume_status', errors, ID) as BoardSnapshotV2['resume_status']
  const nested = <T>(key: string, decoder: (value: unknown) => V2DecodeResult<T>): T | undefined => {
    if (raw[key] === undefined) return undefined
    const decoded = decoder(raw[key])
    if (!decoded.ok) { errors.push(...decoded.errors.map((error) => ({ ...error, path: `$.${key}${error.path.slice(1)}` }))); return undefined }
    return decoded.value
  }
  const collection = <T>(key: string, decoder: (value: unknown) => V2DecodeResult<T>): readonly T[] => {
    const values = array(raw[key], `$.${key}`, errors)
    return values.map((value, index) => {
      const decoded = decoder(value)
      if (!decoded.ok) { errors.push(...decoded.errors.map((error) => ({ ...error, path: `$.${key}[${index}]${error.path.slice(1)}` }))); return undefined }
      return decoded.value
    }).filter((value): value is T => value !== undefined)
  }
  const request = nested('request', decodeDevelopmentRequestV2)
  const context = nested('context', decodeRepositoryContextV2)
  const assessment = nested('assessment', decodeCapabilityAssessmentV2)
  const pipeline = nested('pipeline', decodeWorkflowPipelineV2)
  const graph = nested('graph', decodeWorkGraphV2)
  const resolution = nested('resolution', decodeCapabilityResolutionV2)
  const work_items = collection('work_items', decodeWorkItemV2)
  const runs = collection('runs', decodeSkillRunV2)
  const results = collection('results', decodeSkillResultV2)
  const validations = collection('validations', decodeValidationReportV2)
  const gates = collection('gates', decodeGateEvaluationV2)
  const leases = collection('leases', decodeRunLeaseV2)
  if (record_id === undefined || project_id === undefined || change_id === undefined || revision === undefined || correlation_id === undefined || actorValue === undefined || created_at === undefined || status === undefined || updated_at === undefined) return { ok: false, errors }
  const value: BoardSnapshotV2 = {
    schema_version: V2_SCHEMAS.snapshot, record_id, project_id, change_id, revision, correlation_id, actor: actorValue, created_at,
    ...(event_head_id === undefined ? {} : { event_head_id }), ...(event_head_digest === undefined ? {} : { event_head_digest }),
    ...(command_head_id === undefined ? {} : { command_head_id }), status,
    ...(request === undefined ? {} : { request }), ...(context === undefined ? {} : { context }), ...(assessment === undefined ? {} : { assessment }),
    ...(pipeline === undefined ? {} : { pipeline }), ...(graph === undefined ? {} : { graph }), ...(resolution === undefined ? {} : { resolution }), work_items, runs, results, validations, gates, leases,
    blockers: strings(raw.blockers, '$.blockers', errors), next_actions: strings(raw.next_actions, '$.next_actions', errors),
    ...(raw.resume_status === undefined ? {} : { resume_status }), updated_at,
  }
  return result(value, errors)
}

export function decodeBoardCommandV2(input: unknown): V2DecodeResult<BoardCommandV2> {
  const errors: V2CodecError[] = []
  const raw = prepare(input, V2_SCHEMAS.command, [
    'schema_version', 'command_id', 'idempotency_key', 'expected_revision', 'actor', 'issued_at',
    'correlation_id', 'causation_id', 'change_id', 'type', 'request', 'context', 'assessment',
    'graph', 'pipeline', 'resolution', 'work_item_id', 'run', 'lease', 'run_id', 'lease_id', 'owner_id',
    'generation', 'heartbeat_at', 'expires_at', 'result', 'report', 'gate', 'reason', 'attempt_id',
    'artifact_ref', 'digest',
  ], errors)
  if (!raw) return { ok: false, errors }
  const command_id = text(raw.command_id, '$.command_id', errors, ID)
  const idempotency_key = text(raw.idempotency_key, '$.idempotency_key', errors, ID)
  const expected_revision = integer(raw.expected_revision, '$.expected_revision', errors)
  const actorValue = actor(raw.actor, '$.actor', errors)
  const issued_at = text(raw.issued_at, '$.issued_at', errors, UTC)
  const correlation_id = text(raw.correlation_id, '$.correlation_id', errors, ID)
  const change_id = text(raw.change_id, '$.change_id', errors, ID)
  const type = typeof raw.type === 'string' ? raw.type as BoardCommandV2['type'] : undefined
  const allowedTypes: readonly BoardCommandV2['type'][] = [
    'accept-request', 'record-context', 'record-assessment', 'freeze-pipeline', 'freeze-work-graph',
    'resolve-capabilities', 'start-change', 'enqueue-work-item', 'claim-run', 'heartbeat-run',
    'begin-run', 'complete-run', 'record-validation', 'evaluate-gate', 'pause-change',
    'resume-change', 'retry-work-item', 'cancel-change', 'replan-change', 'bind-artifact',
  ]
  if (type === undefined || !allowedTypes.includes(type)) errors.push({ code: 'field-invalid', path: '$.type' })
  const causation_id = optionalText(raw.causation_id, '$.causation_id', errors, ID)
  if (!command_id || !idempotency_key || expected_revision === undefined || !actorValue || !issued_at || !correlation_id || !change_id || type === undefined || !allowedTypes.includes(type)) return { ok: false, errors }
  const base = { schema_version: V2_SCHEMAS.command, command_id, idempotency_key, expected_revision, actor: actorValue, issued_at, correlation_id, ...(causation_id === undefined ? {} : { causation_id }), change_id }
  const requireText = (key: string, pattern: RegExp = ID, max = 8_192): string | undefined => text(raw[key], `$.${key}`, errors, pattern, max)
  const rejectExtra = (allowed: readonly string[]): void => {
    const set = new Set(['schema_version', 'command_id', 'idempotency_key', 'expected_revision', 'actor', 'issued_at', 'correlation_id', 'causation_id', 'change_id', 'type', ...allowed])
    for (const key of Object.keys(raw)) if (!set.has(key)) errors.push({ code: 'unknown-field', path: `$.${key}` })
  }
  let value: BoardCommandV2 | undefined
  switch (type) {
    case 'accept-request': {
      rejectExtra(['request']); const request = nested(raw.request, decodeDevelopmentRequestV2, '$.request', errors)
      if (request) value = { ...base, type, request }; break
    }
    case 'record-context': {
      rejectExtra(['context']); const context = nested(raw.context, decodeRepositoryContextV2, '$.context', errors)
      if (context) value = { ...base, type, context }; break
    }
    case 'record-assessment': {
      rejectExtra(['assessment']); const assessment = nested(raw.assessment, decodeCapabilityAssessmentV2, '$.assessment', errors)
      if (assessment) value = { ...base, type, assessment }; break
    }
    case 'freeze-pipeline': {
      rejectExtra(['pipeline']); const pipeline = nested(raw.pipeline, decodeWorkflowPipelineV2, '$.pipeline', errors)
      if (pipeline) value = { ...base, type, pipeline }; break
    }
    case 'freeze-work-graph': {
      rejectExtra(['graph']); const graph = nested(raw.graph, decodeWorkGraphV2, '$.graph', errors)
      if (graph) value = { ...base, type, graph }; break
    }
    case 'resolve-capabilities': {
      rejectExtra(['resolution']); const resolution = nested(raw.resolution, decodeCapabilityResolutionV2, '$.resolution', errors)
      if (resolution) value = { ...base, type, resolution }; break
    }
    case 'start-change': case 'resume-change': {
      rejectExtra([]); value = { ...base, type }; break
    }
    case 'enqueue-work-item': {
      rejectExtra(['work_item_id']); const work_item_id = requireText('work_item_id')
      if (work_item_id) value = { ...base, type, work_item_id }; break
    }
    case 'claim-run': {
      rejectExtra(['run', 'lease']); const run = nested(raw.run, decodeSkillRunV2, '$.run', errors); const lease = nested(raw.lease, decodeRunLeaseV2, '$.lease', errors)
      if (run && lease) value = { ...base, type, run, lease }; break
    }
    case 'heartbeat-run': {
      rejectExtra(['run_id', 'lease_id', 'owner_id', 'generation', 'heartbeat_at', 'expires_at'])
      const run_id = requireText('run_id'); const lease_id = requireText('lease_id'); const owner_id = requireText('owner_id'); const generation = integer(raw.generation, '$.generation', errors); const heartbeat_at = text(raw.heartbeat_at, '$.heartbeat_at', errors, UTC); const expires_at = text(raw.expires_at, '$.expires_at', errors, UTC)
      if (run_id && lease_id && owner_id && generation !== undefined && heartbeat_at && expires_at) value = { ...base, type, run_id, lease_id, owner_id, generation, heartbeat_at, expires_at }; break
    }
    case 'begin-run': {
      rejectExtra(['run_id', 'lease_id', 'owner_id', 'generation']); const run_id = requireText('run_id'); const lease_id = requireText('lease_id'); const owner_id = requireText('owner_id'); const generation = integer(raw.generation, '$.generation', errors)
      if (run_id && lease_id && owner_id && generation !== undefined) value = { ...base, type, run_id, lease_id, owner_id, generation }; break
    }
    case 'complete-run': {
      rejectExtra(['run_id', 'result']); const run_id = requireText('run_id'); const resultValue = nested(raw.result, decodeSkillResultV2, '$.result', errors)
      if (run_id && resultValue) value = { ...base, type, run_id, result: resultValue }; break
    }
    case 'record-validation': {
      rejectExtra(['report']); const report = nested(raw.report, decodeValidationReportV2, '$.report', errors)
      if (report) value = { ...base, type, report }; break
    }
    case 'evaluate-gate': {
      rejectExtra(['gate']); const gate = nested(raw.gate, decodeGateEvaluationV2, '$.gate', errors)
      if (gate) value = { ...base, type, gate }; break
    }
    case 'pause-change': case 'cancel-change': case 'replan-change': {
      rejectExtra(['reason']); const reason = text(raw.reason, '$.reason', errors, undefined, 8_192)
      if (reason) value = { ...base, type, reason }; break
    }
    case 'retry-work-item': {
      rejectExtra(['work_item_id', 'attempt_id', 'run_id']); const work_item_id = requireText('work_item_id'); const attempt_id = requireText('attempt_id'); const run_id = requireText('run_id')
      if (work_item_id && attempt_id && run_id) value = { ...base, type, work_item_id, attempt_id, run_id }; break
    }
    case 'bind-artifact': {
      rejectExtra(['work_item_id', 'artifact_ref', 'digest']); const work_item_id = requireText('work_item_id'); const artifact_ref = requireText('artifact_ref', /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u, 512); const digestValue = digest(raw.digest, '$.digest', errors)
      if (work_item_id && artifact_ref && digestValue) value = { ...base, type, work_item_id, artifact_ref, digest: digestValue }; break
    }
  }
  return value === undefined ? { ok: false, errors } : result(value, errors)
}
