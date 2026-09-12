/** Bounded executor/validator boundary for the durable v2 runtime. */
import { createHash } from 'node:crypto'
import type { SkillResultV2, SkillRunV2, ValidationReportV2 } from '@tenon/kernel'
import { JsonBoundaryError, snapshotJsonBoundary, type JsonBoundaryValue } from './jsonBoundary.js'

export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1_024
const DEFAULT_MAX_ROUNDS = 256
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_MAX_PARALLEL = 8
const DEFAULT_LEASE_DURATION_MS = 60_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u

export interface RuntimePolicyV2 {
  readonly max_attempts?: number
  readonly auto_retry?: boolean
  readonly max_parallel?: number
  readonly max_rounds?: number
  readonly lease_duration_ms?: number
  readonly heartbeat_interval_ms?: number
  readonly max_output_bytes?: number
}

export interface NormalizedPolicyV2 {
  readonly max_attempts: number
  readonly auto_retry: boolean
  readonly max_parallel: number
  readonly max_rounds: number
  readonly lease_duration_ms: number
  readonly heartbeat_interval_ms: number
  readonly max_output_bytes: number
}

export interface RuntimeConsumedV2 {
  /** Stable source path or content URI when artifact_id/version are omitted. */
  readonly ref: string
  readonly artifact_id?: string
  readonly version?: string
  readonly representation?: 'metadata' | 'structure' | 'summary' | 'content'
  readonly max_bytes?: number
}

export interface RuntimeObservationV2 {
  readonly output: JsonBoundaryValue
  readonly raw_output_ref?: string
  readonly artifacts: readonly RuntimeArtifactV2[]
  /** Bounded declarations of versions the stage actually consumed. */
  readonly consumed?: readonly RuntimeConsumedV2[]
  readonly summary?: string
  readonly diagnostics: readonly string[]
  readonly output_digest: `sha256:${string}`
  readonly output_bytes: number
}

export interface RuntimeArtifactV2 {
  readonly id: string
  readonly kind: SkillResultV2['artifacts'][number]['kind']
  readonly ref: string
  readonly digest: `sha256:${string}`
  readonly media_type?: string
  readonly byte_length?: number
}

export interface RuntimeValidationInputV2 {
  readonly result_id: string
  readonly work_item_id: string
}

export function idValid(value: string): boolean { return SAFE_ID.test(value) }

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

export function resultIdentity(runId: string): string { return `result:${digest(runId).slice(7, 39)}` }

function requirePositiveInt(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${label} must be a positive integer`)
  return result
}

export function normalizePolicy(input: RuntimePolicyV2 | undefined): NormalizedPolicyV2 {
  return {
    max_attempts: requirePositiveInt(input?.max_attempts, DEFAULT_MAX_ATTEMPTS, 'max_attempts'),
    auto_retry: input?.auto_retry ?? true,
    max_parallel: requirePositiveInt(input?.max_parallel, DEFAULT_MAX_PARALLEL, 'max_parallel'),
    max_rounds: requirePositiveInt(input?.max_rounds, DEFAULT_MAX_ROUNDS, 'max_rounds'),
    lease_duration_ms: requirePositiveInt(input?.lease_duration_ms, DEFAULT_LEASE_DURATION_MS, 'lease_duration_ms'),
    heartbeat_interval_ms: requirePositiveInt(input?.heartbeat_interval_ms, DEFAULT_HEARTBEAT_INTERVAL_MS, 'heartbeat_interval_ms'),
    max_output_bytes: requirePositiveInt(input?.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, 'max_output_bytes'),
  }
}

export function utc(clock: () => string): string {
  const value = clock()
  if (!UTC.test(value)) throw new TypeError('clock must return an ISO UTC timestamp')
  return value
}

export function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) throw new TypeError('invalid UTC timestamp')
  return new Date(value + milliseconds).toISOString()
}

export function redact(value: string, max = 256): string {
  return value
    .replace(/(Bearer\s+)[^\s]+/giu, '$1[redacted]')
    .replace(/(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .slice(0, max)
}

function diagnosticList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [`${label}-invalid`]
  return value.slice(0, 64).map((entry) => typeof entry === 'string' ? redact(entry) : `${label}-non-string`)
}

function record(value: JsonBoundaryValue): { readonly [key: string]: JsonBoundaryValue } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as { readonly [key: string]: JsonBoundaryValue } : undefined
}

function onlyKeys(value: { readonly [key: string]: JsonBoundaryValue }, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed)
  return Object.keys(value).every((key) => accepted.has(key))
}

function normalizeConsumed(value: JsonBoundaryValue): RuntimeConsumedV2 | undefined {
  if (typeof value === 'string') {
    if (!SAFE_REF.test(value) || value.includes('..')) return undefined
    return { ref: value }
  }
  const raw = record(value)
  if (raw === undefined || !onlyKeys(raw, ['ref', 'artifact_id', 'version', 'representation', 'max_bytes'])) return undefined
  const ref = typeof raw.ref === 'string' && SAFE_REF.test(raw.ref) && !raw.ref.includes('..') ? raw.ref : undefined
  if (ref === undefined) return undefined
  const artifact_id = raw.artifact_id === undefined ? undefined : typeof raw.artifact_id === 'string' && idValid(raw.artifact_id) ? raw.artifact_id : undefined
  if (raw.artifact_id !== undefined && artifact_id === undefined) return undefined
  const version = raw.version === undefined ? undefined : typeof raw.version === 'string' && /^v[0-9]{1,9}$/u.test(raw.version) ? raw.version : undefined
  if (raw.version !== undefined && version === undefined) return undefined
  const representation = raw.representation === undefined ? undefined : raw.representation === 'metadata' || raw.representation === 'structure' || raw.representation === 'summary' || raw.representation === 'content' ? raw.representation : undefined
  if (raw.representation !== undefined && representation === undefined) return undefined
  const max_bytes = raw.max_bytes === undefined ? undefined : typeof raw.max_bytes === 'number' && Number.isSafeInteger(raw.max_bytes) && raw.max_bytes > 0 && raw.max_bytes <= 4 * 1024 * 1024 ? raw.max_bytes : undefined
  if (raw.max_bytes !== undefined && max_bytes === undefined) return undefined
  return { ref, ...(artifact_id === undefined ? {} : { artifact_id }), ...(version === undefined ? {} : { version }), ...(representation === undefined ? {} : { representation }), ...(max_bytes === undefined ? {} : { max_bytes }) }
}

function normalizeArtifact(value: JsonBoundaryValue, index: number): RuntimeArtifactV2 | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const ref = typeof raw.ref === 'string' && SAFE_REF.test(raw.ref) && !raw.ref.includes('..') ? raw.ref : undefined
  if (ref === undefined) return undefined
  const id = typeof raw.id === 'string' && idValid(raw.id) ? raw.id : `artifact:${digest(ref).slice(7, 39)}`
  const kinds: readonly SkillResultV2['artifacts'][number]['kind'][] = ['file', 'diff', 'document', 'json', 'text', 'url', 'report', 'value', 'unknown']
  const kind = typeof raw.kind === 'string' && kinds.includes(raw.kind as SkillResultV2['artifacts'][number]['kind']) ? raw.kind as SkillResultV2['artifacts'][number]['kind'] : 'unknown'
  const artifactDigest = typeof raw.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(raw.digest) ? raw.digest as `sha256:${string}` : digest(ref)
  const media_type = typeof raw.media_type === 'string' && raw.media_type.length <= 160 ? raw.media_type : undefined
  const byte_length = typeof raw.byte_length === 'number' && Number.isSafeInteger(raw.byte_length) && raw.byte_length >= 0 ? raw.byte_length : undefined
  return { id: `${id}:${index}`.slice(0, 160), kind, ref, digest: artifactDigest, ...(media_type === undefined ? {} : { media_type }), ...(byte_length === undefined ? {} : { byte_length }) }
}

export function normalizeObservation(raw: unknown, policy: NormalizedPolicyV2): { readonly ok: true; readonly observation: RuntimeObservationV2 } | { readonly ok: false; readonly code: string } {
  let snapshot
  try { snapshot = snapshotJsonBoundary(raw, { maxBytes: policy.max_output_bytes, maxDepth: 40, maxNodes: 8_192 }) } catch (error) { return { ok: false, code: error instanceof JsonBoundaryError ? error.code : 'observation-invalid' } }
  const candidate = record(snapshot.value)
  const isEnvelope = candidate !== undefined && Object.prototype.hasOwnProperty.call(candidate, 'output')
  if (isEnvelope && !onlyKeys(candidate, ['output', 'raw_output_ref', 'artifacts', 'consumed', 'summary', 'diagnostics'])) return { ok: false, code: 'observation-shape-invalid' }
  const output = isEnvelope ? (candidate.output ?? null) : snapshot.value
  const artifactsRaw = isEnvelope ? candidate.artifacts : []
  const consumedRaw = isEnvelope ? candidate.consumed : []
  if (isEnvelope && !Array.isArray(artifactsRaw)) return { ok: false, code: 'artifacts-invalid' }
  if (isEnvelope && !Array.isArray(candidate.diagnostics)) return { ok: false, code: 'diagnostics-invalid' }
  if (isEnvelope && candidate.raw_output_ref !== undefined && (typeof candidate.raw_output_ref !== 'string' || !SAFE_REF.test(candidate.raw_output_ref) || candidate.raw_output_ref.includes('..'))) return { ok: false, code: 'raw-output-ref-invalid' }
  const artifacts = Array.isArray(artifactsRaw) ? artifactsRaw.map(normalizeArtifact) : []
  if (artifacts.some((item) => item === undefined)) return { ok: false, code: 'artifact-invalid' }
  const normalizedArtifacts = artifacts.filter((item): item is RuntimeArtifactV2 => item !== undefined).slice(0, 256)
  const consumedValues = Array.isArray(consumedRaw) ? consumedRaw.slice(0, 128) : []
  const consumed = consumedValues.map(normalizeConsumed).filter((item): item is RuntimeConsumedV2 => item !== undefined)
  const consumedInvalid = isEnvelope && (consumedRaw !== undefined && !Array.isArray(consumedRaw) || Array.isArray(consumedRaw) && consumed.length !== Math.min(consumedRaw.length, 128))
  const artifactIssue: string[] = []
  const diagnostics = [...artifactIssue, ...(consumedInvalid ? ['consumed-invalid'] : []), ...(isEnvelope ? diagnosticList(candidate.diagnostics ?? [], 'diagnostics') : [])].slice(0, 64)
  const rawOutputRef = isEnvelope && typeof candidate.raw_output_ref === 'string' && SAFE_REF.test(candidate.raw_output_ref) && !candidate.raw_output_ref.includes('..') ? candidate.raw_output_ref : undefined
  const summary = isEnvelope && typeof candidate.summary === 'string' ? redact(candidate.summary, 512) : undefined
  const outputJson = stable(output)
  return { ok: true, observation: { output, consumed: Object.freeze(consumed), ...(rawOutputRef === undefined ? {} : { raw_output_ref: rawOutputRef }), artifacts: Object.freeze(normalizedArtifacts), ...(summary === undefined ? {} : { summary }), diagnostics: Object.freeze(diagnostics), output_digest: digest(output), output_bytes: new TextEncoder().encode(outputJson).byteLength } }
}

export function normalizeReport(raw: unknown, input: RuntimeValidationInputV2, now: string): { readonly ok: true; readonly report: ValidationReportV2 } | { readonly ok: false; readonly code: string } {
  let snap: JsonBoundaryValue
  try { snap = snapshotJsonBoundary(raw, { maxBytes: 64 * 1_024, maxDepth: 16, maxNodes: 2_048 }).value } catch { return { ok: false, code: 'validator-output-invalid' } }
  const value = record(snap)
  if (value === undefined) return { ok: false, code: 'validator-output-invalid' }
  if (!onlyKeys(value, ['schema_version', 'record_id', 'project_id', 'change_id', 'revision', 'correlation_id', 'actor', 'created_at', 'report_id', 'work_item_id', 'result_id', 'validator_id', 'validator_version', 'status', 'target_digests', 'evidence_refs', 'checks'])) return { ok: false, code: 'validator-output-unknown-field' }
  if (value.work_item_id !== undefined && value.work_item_id !== input.work_item_id) return { ok: false, code: 'validator-work-item-mismatch' }
  if (value.result_id !== undefined && value.result_id !== input.result_id) return { ok: false, code: 'validator-result-mismatch' }
  const status = value.status
  if (status !== 'pass' && status !== 'fail' && status !== 'unknown' && status !== 'incomplete') return { ok: false, code: 'validator-status-invalid' }
  if (value.checks !== undefined && !Array.isArray(value.checks)) return { ok: false, code: 'validator-checks-invalid' }
  const rawChecks = Array.isArray(value.checks) ? value.checks.slice(0, 256) : []
  const checks: ValidationReportV2['checks'] = rawChecks.flatMap((entry, index) => { const check = record(entry); if (check === undefined || !onlyKeys(check, ['id', 'status', 'message']) || typeof check.id !== 'string' || !idValid(check.id) || (check.status !== 'pass' && check.status !== 'fail' && check.status !== 'unknown')) return []; return [{ id: `${check.id}:${index}`.slice(0, 160), status: check.status as 'pass' | 'fail' | 'unknown', ...(typeof check.message === 'string' ? { message: redact(check.message, 512) } : {}) }] })
  if (checks.length !== rawChecks.length) return { ok: false, code: 'validator-check-invalid' }
  if (value.target_digests !== undefined && !Array.isArray(value.target_digests)) return { ok: false, code: 'validator-target-digests-invalid' }
  const rawTargetDigests = Array.isArray(value.target_digests) ? value.target_digests : []
  const targetDigests = rawTargetDigests.filter((entry): entry is `sha256:${string}` => typeof entry === 'string' && /^sha256:[a-f0-9]{64}$/u.test(entry)).slice(0, 256)
  if (targetDigests.length !== rawTargetDigests.length) return { ok: false, code: 'validator-target-digest-invalid' }
  if (value.evidence_refs !== undefined && !Array.isArray(value.evidence_refs)) return { ok: false, code: 'validator-evidence-refs-invalid' }
  const rawEvidenceRefs = Array.isArray(value.evidence_refs) ? value.evidence_refs : []
  const evidenceRefs = rawEvidenceRefs.filter((entry): entry is string => typeof entry === 'string' && SAFE_REF.test(entry) && !entry.includes('..')).slice(0, 256)
  if (evidenceRefs.length !== rawEvidenceRefs.length) return { ok: false, code: 'validator-evidence-ref-invalid' }
  const validatorId = typeof value.validator_id === 'string' && idValid(value.validator_id) ? value.validator_id : 'validator'
  const validatorVersion = typeof value.validator_version === 'string' && idValid(value.validator_version) ? value.validator_version : 'unknown'
  return { ok: true, report: { schema_version: 'validation-report/v2', record_id: `validation:${input.result_id}`, project_id: 'runtime', change_id: 'runtime', revision: 0, correlation_id: 'runtime', actor: { kind: 'system', id: validatorId }, created_at: now, report_id: `report:${input.result_id}`, work_item_id: input.work_item_id, result_id: input.result_id, validator_id: validatorId, validator_version: validatorVersion, status, target_digests: targetDigests, evidence_refs: evidenceRefs, checks } }
}

export function resultFor(run: SkillRunV2, observation: RuntimeObservationV2 | undefined, report: ValidationReportV2 | undefined, now: string, issue?: string, outputSchemaId?: string): SkillResultV2 {
  const diagnostics = [...(observation?.diagnostics ?? []), ...(issue === undefined ? [] : [issue])].map((entry) => redact(entry)).slice(0, 64)
  const isValidated = report !== undefined && (report.status === 'pass' || report.status === 'fail')
  const resultId = resultIdentity(run.run_id)
  return { schema_version: 'skill-result/v2', record_id: resultId, project_id: run.project_id, change_id: run.change_id, revision: run.revision, correlation_id: run.correlation_id, actor: run.actor, created_at: now, result_id: resultId, run_id: run.run_id, status: issue === undefined && isValidated ? 'completed' : issue === undefined ? 'incomplete' : 'failed', contract_status: isValidated ? 'validated' : 'unknown', ...(outputSchemaId === undefined ? {} : { output_schema_id: outputSchemaId }), ...(observation?.raw_output_ref === undefined ? {} : { raw_output: { ref: observation.raw_output_ref, digest: observation.output_digest, media_type: 'application/json', byte_length: observation.output_bytes } }), ...(observation === undefined ? {} : { output_digest: observation.output_digest, output_bytes: observation.output_bytes }), ...(observation?.summary === undefined ? {} : { summary: observation.summary }), artifacts: observation?.artifacts ?? [], validation_refs: report === undefined ? [] : [report.report_id], diagnostics }
}
