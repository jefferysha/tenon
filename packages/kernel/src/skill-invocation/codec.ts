import {
  SKILL_INVOCATION_LIMITS,
  SKILL_INVOCATION_SCHEMA_VERSION,
  type SkillInvocationAdapterProofV1,
  type SkillInvocationArtifactBoundPayloadV1,
  type SkillInvocationArtifactIntentPayloadV1,
  type SkillInvocationCodecResult,
  type SkillInvocationDecisionPayloadV1,
  type SkillInvocationEventV1,
  type SkillInvocationIoProofV1,
  type SkillInvocationPolicyRefV1,
  type SkillInvocationQuestionPayloadV1,
  type SkillInvocationStartedPayloadV1,
  type SkillInvocationSubjectV1,
  type SkillInvocationValidatorProofV1,
} from './types.js'

const EVENT_TYPES: ReadonlySet<SkillInvocationEventV1['type']> = new Set([
  'invocation-started', 'question-recorded', 'decision-recorded', 'invocation-completed',
  'invocation-failed', 'invocation-interrupted', 'artifact-binding-intent', 'artifact-bound',
])
const CLASSIFICATIONS: ReadonlySet<'identifier' | 'project-data' | 'configuration' | 'user-provided' | 'sensitive-redacted'> = new Set(['identifier', 'project-data', 'configuration', 'user-provided', 'sensitive-redacted'])
const VALIDATOR_STATUSES: ReadonlySet<'pass' | 'fail' | 'unknown'> = new Set(['pass', 'fail', 'unknown'])
const ADAPTERS: ReadonlySet<'native' | 'codex' | 'afk'> = new Set(['native', 'codex', 'afk'])
const REQUIREDNESS: ReadonlySet<'routine' | 'advisory' | 'hard-gate'> = new Set(['routine', 'advisory', 'hard-gate'])
const DECISION_MODES: ReadonlySet<'user-answer' | 'recommended-default'> = new Set(['user-answer', 'recommended-default'])
const ARTIFACT_KINDS: ReadonlySet<'document' | 'file' | 'artifact' | 'value'> = new Set(['document', 'file', 'artifact', 'value'])
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u

type RecordValue = Record<string, unknown>
class DecodeFailure extends Error {
  constructor(readonly code: Exclude<SkillInvocationCodecResult, { ok: true }>['code'], readonly path: string) {
    super(`${code}: ${path}`)
  }
}

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DecodeFailure('object-invalid', path)
  return value as RecordValue
}

function closed(value: RecordValue, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new DecodeFailure('unknown-field', `${path}.${key}`)
  }
}

function string(value: unknown, path: string, max: number = SKILL_INVOCATION_LIMITS.maxRefBytes): string {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DecodeFailure('field-invalid', path)
  }
  return value
}

function id(value: unknown, path: string): string {
  const result = string(value, path, SKILL_INVOCATION_LIMITS.maxIdBytes)
  if (!ID.test(result) || result.includes('..')) throw new DecodeFailure('field-invalid', path)
  return result
}

function digest(value: unknown, path: string): string {
  const result = string(value, path, 71)
  if (!DIGEST.test(result)) throw new DecodeFailure('field-invalid', path)
  return result
}

function artifactRef(value: unknown, path: string): string {
  const result = string(value, path)
  if (
    result.startsWith('/')
    || result.includes('\\')
    || /^[A-Za-z]:/u.test(result)
    || result.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) throw new DecodeFailure('field-invalid', path)
  return result
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path, 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || Number.isNaN(Date.parse(result))) {
    throw new DecodeFailure('field-invalid', path)
  }
  return result
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new DecodeFailure('field-invalid', path)
  return value as number
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new DecodeFailure('field-invalid', path)
  return value
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  const result = string(value, path, 64)
  for (const candidate of values) {
    if (candidate === result) return candidate
  }
  throw new DecodeFailure('field-invalid', path)
}

function ids(value: unknown, path: string, maximum = SKILL_INVOCATION_LIMITS.maxOptions): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new DecodeFailure('limit-exceeded', path)
  const result = value.map((item, index) => id(item, `${path}[${index}]`))
  if (new Set(result).size !== result.length) throw new DecodeFailure('field-invalid', path)
  return result
}

function validator(value: unknown, path: string): SkillInvocationValidatorProofV1 {
  const item = record(value, path)
  closed(item, ['id', 'status', 'code'], path)
  return {
    id: id(item.id, `${path}.id`),
    status: enumValue(item.status, VALIDATOR_STATUSES, `${path}.status`),
    ...(item.code === undefined ? {} : { code: id(item.code, `${path}.code`) }),
  }
}

function io(value: unknown, path: string): SkillInvocationIoProofV1 {
  const item = record(value, path)
  closed(item, ['schema_id', 'fields'], path)
  if (!Array.isArray(item.fields) || item.fields.length > SKILL_INVOCATION_LIMITS.maxFields) {
    throw new DecodeFailure('limit-exceeded', `${path}.fields`)
  }
  const names = new Set<string>()
  const fields = item.fields.map((field, index) => {
    const fieldPath = `${path}.fields[${index}]`
    const entry = record(field, fieldPath)
    closed(entry, ['name', 'classification', 'digest', 'validator'], fieldPath)
    const name = id(entry.name, `${fieldPath}.name`)
    if (names.has(name)) throw new DecodeFailure('field-invalid', `${fieldPath}.name`)
    names.add(name)
    return {
      name,
      classification: enumValue(entry.classification, CLASSIFICATIONS, `${fieldPath}.classification`),
      digest: digest(entry.digest, `${fieldPath}.digest`),
      validator: validator(entry.validator, `${fieldPath}.validator`),
    }
  })
  return { schema_id: id(item.schema_id, `${path}.schema_id`), fields }
}

function adapter(value: unknown, path: string): SkillInvocationAdapterProofV1 {
  const item = record(value, path)
  closed(item, ['kind', 'proof_ref'], path)
  return {
    kind: enumValue(item.kind, ADAPTERS, `${path}.kind`),
    proof_ref: id(item.proof_ref, `${path}.proof_ref`),
  }
}

function subject(value: unknown, path: string): SkillInvocationSubjectV1 {
  const item = record(value, path)
  closed(item, [
    'project_id', 'workflow_definition_id', 'workflow_run_id', 'step_id', 'step_visit',
    'task_plan_revision_id', 'work_item_id', 'attempt',
  ], path)
  const visit = record(item.step_visit, `${path}.step_visit`)
  closed(visit, ['run_id', 'transition_sequence'], `${path}.step_visit`)
  const base = {
    project_id: id(item.project_id, `${path}.project_id`),
    workflow_definition_id: id(item.workflow_definition_id, `${path}.workflow_definition_id`),
    workflow_run_id: id(item.workflow_run_id, `${path}.workflow_run_id`),
    step_id: id(item.step_id, `${path}.step_id`),
    step_visit: {
      run_id: id(visit.run_id, `${path}.step_visit.run_id`),
      transition_sequence: integer(visit.transition_sequence, `${path}.step_visit.transition_sequence`),
    },
  }
  const taskPlanRevisionId = item.task_plan_revision_id === undefined
    ? undefined
    : id(item.task_plan_revision_id, `${path}.task_plan_revision_id`)
  const workItemId = item.work_item_id === undefined
    ? undefined
    : id(item.work_item_id, `${path}.work_item_id`)
  if ((workItemId === undefined) !== (taskPlanRevisionId === undefined)) {
    throw new DecodeFailure('field-invalid', path)
  }
  let attempt: SkillInvocationSubjectV1['attempt']
  if (item.attempt !== undefined) {
    const attemptValue = record(item.attempt, `${path}.attempt`)
    closed(attemptValue, ['attempt_id', 'reservation_id'], `${path}.attempt`)
    attempt = {
      attempt_id: id(attemptValue.attempt_id, `${path}.attempt.attempt_id`),
      reservation_id: id(attemptValue.reservation_id, `${path}.attempt.reservation_id`),
    }
  }
  return {
    ...base,
    ...(taskPlanRevisionId === undefined ? {} : { task_plan_revision_id: taskPlanRevisionId }),
    ...(workItemId === undefined ? {} : { work_item_id: workItemId }),
    ...(attempt === undefined ? {} : { attempt }),
  }
}

function policy(value: unknown, path: string): SkillInvocationPolicyRefV1 {
  const item = record(value, path)
  closed(item, ['id', 'version', 'rule_id'], path)
  return { id: id(item.id, `${path}.id`), version: id(item.version, `${path}.version`), rule_id: id(item.rule_id, `${path}.rule_id`) }
}

function decodePayload(type: 'invocation-started', value: unknown, path: string): SkillInvocationStartedPayloadV1
function decodePayload(type: 'question-recorded', value: unknown, path: string): SkillInvocationQuestionPayloadV1
function decodePayload(type: 'decision-recorded', value: unknown, path: string): SkillInvocationDecisionPayloadV1
function decodePayload(
  type: 'invocation-completed', value: unknown, path: string,
): Extract<SkillInvocationEventV1, { type: 'invocation-completed' }>['payload']
function decodePayload(
  type: 'invocation-failed', value: unknown, path: string,
): Extract<SkillInvocationEventV1, { type: 'invocation-failed' }>['payload']
function decodePayload(
  type: 'invocation-interrupted', value: unknown, path: string,
): Extract<SkillInvocationEventV1, { type: 'invocation-interrupted' }>['payload']
function decodePayload(type: 'artifact-binding-intent', value: unknown, path: string): SkillInvocationArtifactIntentPayloadV1
function decodePayload(type: 'artifact-bound', value: unknown, path: string): SkillInvocationArtifactBoundPayloadV1
function decodePayload(type: SkillInvocationEventV1['type'], value: unknown, path: string): SkillInvocationEventV1['payload'] {
  const item = record(value, path)
  if (type === 'invocation-started') {
    closed(item, ['skill', 'input', 'adapter'], path)
    const skill = record(item.skill, `${path}.skill`)
    closed(skill, ['id', 'version'], `${path}.skill`)
    return { skill: { id: id(skill.id, `${path}.skill.id`), version: id(skill.version, `${path}.skill.version`) }, input: io(item.input, `${path}.input`), adapter: adapter(item.adapter, `${path}.adapter`) }
  }
  if (type === 'question-recorded') {
    closed(item, ['question_id', 'key', 'schema_id', 'option_ids', 'requiredness', 'shown'], path)
    return { question_id: id(item.question_id, `${path}.question_id`), key: id(item.key, `${path}.key`), schema_id: id(item.schema_id, `${path}.schema_id`), option_ids: ids(item.option_ids, `${path}.option_ids`), requiredness: enumValue(item.requiredness, REQUIREDNESS, `${path}.requiredness`), shown: boolean(item.shown, `${path}.shown`) }
  }
  if (type === 'decision-recorded') {
    closed(item, ['decision_id', 'question_id', 'mode', 'selected_option_ids', 'free_text', 'policy', 'rationale_code'], path)
    let freeText: SkillInvocationDecisionPayloadV1['free_text']
    if (item.free_text !== undefined) {
      const freeTextValue = record(item.free_text, `${path}.free_text`)
      closed(freeTextValue, ['classification', 'digest'], `${path}.free_text`)
      freeText = {
        classification: enumValue(freeTextValue.classification, CLASSIFICATIONS, `${path}.free_text.classification`),
        digest: digest(freeTextValue.digest, `${path}.free_text.digest`),
      }
    }
    return {
      decision_id: id(item.decision_id, `${path}.decision_id`),
      question_id: id(item.question_id, `${path}.question_id`),
      mode: enumValue(item.mode, DECISION_MODES, `${path}.mode`),
      selected_option_ids: ids(item.selected_option_ids, `${path}.selected_option_ids`),
      ...(freeText === undefined ? {} : { free_text: freeText }),
      ...(item.policy === undefined ? {} : { policy: policy(item.policy, `${path}.policy`) }),
      ...(item.rationale_code === undefined ? {} : { rationale_code: id(item.rationale_code, `${path}.rationale_code`) }),
    }
  }
  if (type === 'invocation-completed') {
    closed(item, ['output', 'adapter'], path)
    return { output: io(item.output, `${path}.output`), adapter: adapter(item.adapter, `${path}.adapter`) }
  }
  if (type === 'invocation-failed') {
    closed(item, ['code'], path)
    return { code: id(item.code, `${path}.code`) }
  }
  if (type === 'invocation-interrupted') {
    closed(item, ['code', 'recovery'], path)
    const recovery = record(item.recovery, `${path}.recovery`)
    closed(recovery, ['owner_id', 'proof_ref'], `${path}.recovery`)
    return { code: id(item.code, `${path}.code`), recovery: { owner_id: id(recovery.owner_id, `${path}.recovery.owner_id`), proof_ref: id(recovery.proof_ref, `${path}.recovery.proof_ref`) } }
  }
  if (type === 'artifact-binding-intent') {
    closed(item, ['binding_id', 'output_id', 'artifact', 'validator_ids'], path)
    const artifact = record(item.artifact, `${path}.artifact`)
    closed(artifact, ['kind', 'ref', 'digest', 'document'], `${path}.artifact`)
    let document: SkillInvocationArtifactIntentPayloadV1['artifact']['document']
    if (artifact.document !== undefined) {
      const documentValue = record(artifact.document, `${path}.artifact.document`)
      closed(documentValue, ['kind', 'recorded_at'], `${path}.artifact.document`)
      document = {
        kind: id(documentValue.kind, `${path}.artifact.document.kind`),
        recorded_at: timestamp(documentValue.recorded_at, `${path}.artifact.document.recorded_at`),
      }
    }
    return {
      binding_id: id(item.binding_id, `${path}.binding_id`),
      output_id: id(item.output_id, `${path}.output_id`),
      artifact: {
        kind: enumValue(artifact.kind, ARTIFACT_KINDS, `${path}.artifact.kind`),
        ref: artifactRef(artifact.ref, `${path}.artifact.ref`),
        digest: digest(artifact.digest, `${path}.artifact.digest`),
        ...(document === undefined ? {} : { document }),
      },
      validator_ids: ids(item.validator_ids, `${path}.validator_ids`),
    }
  }
  closed(item, ['binding_id', 'artifact_digest', 'validators'], path)
  if (!Array.isArray(item.validators) || item.validators.length > SKILL_INVOCATION_LIMITS.maxFields) throw new DecodeFailure('limit-exceeded', `${path}.validators`)
  return { binding_id: id(item.binding_id, `${path}.binding_id`), artifact_digest: digest(item.artifact_digest, `${path}.artifact_digest`), validators: item.validators.map((entry, index) => validator(entry, `${path}.validators[${index}]`)) }
}

export function decodeSkillInvocationEventV1(input: string | unknown): SkillInvocationCodecResult {
  try {
    if (typeof input === 'string' && Buffer.byteLength(input) > SKILL_INVOCATION_LIMITS.maxEventBytes) throw new DecodeFailure('limit-exceeded', '$')
    if (typeof input !== 'string') {
      const encoded = JSON.stringify(input)
      if (encoded === undefined || Buffer.byteLength(encoded) > SKILL_INVOCATION_LIMITS.maxEventBytes) {
        throw new DecodeFailure('limit-exceeded', '$')
      }
    }
    let value: unknown = input
    if (typeof input === 'string') {
      try { value = JSON.parse(input) } catch { throw new DecodeFailure('json-invalid', '$') }
    }
    const item = record(value, '$')
    closed(item, ['schema_version', 'event_id', 'invocation_id', 'sequence', 'type', 'subject', 'recorded_at', 'payload'], '$')
    if (item.schema_version !== SKILL_INVOCATION_SCHEMA_VERSION) throw new DecodeFailure('field-invalid', '$.schema_version')
    const type = enumValue(item.type, EVENT_TYPES, '$.type')
    const base = {
      schema_version: SKILL_INVOCATION_SCHEMA_VERSION,
      event_id: id(item.event_id, '$.event_id'),
      invocation_id: id(item.invocation_id, '$.invocation_id'),
      sequence: integer(item.sequence, '$.sequence', 1),
      subject: subject(item.subject, '$.subject'),
      recorded_at: timestamp(item.recorded_at, '$.recorded_at'),
    }
    if (type === 'invocation-started') return { ok: true, value: { ...base, type, payload: decodePayload(type, item.payload, '$.payload') } }
    if (type === 'question-recorded') return { ok: true, value: { ...base, type, payload: decodePayload(type, item.payload, '$.payload') } }
    if (type === 'decision-recorded') return { ok: true, value: { ...base, type, payload: decodePayload(type, item.payload, '$.payload') } }
    if (type === 'invocation-completed') return { ok: true, value: { ...base, type, payload: decodePayload(type, item.payload, '$.payload') } }
    if (type === 'invocation-failed') return { ok: true, value: { ...base, type, payload: decodePayload(type, item.payload, '$.payload') } }
    if (type === 'invocation-interrupted') return { ok: true, value: { ...base, type, payload: decodePayload(type, item.payload, '$.payload') } }
    if (type === 'artifact-binding-intent') return { ok: true, value: { ...base, type, payload: decodePayload(type, item.payload, '$.payload') } }
    return { ok: true, value: { ...base, type, payload: decodePayload(type, item.payload, '$.payload') } }
  } catch (error) {
    if (error instanceof DecodeFailure) return { ok: false, code: error.code, path: error.path }
    return { ok: false, code: 'field-invalid', path: '$' }
  }
}

export function encodeSkillInvocationEventV1(event: SkillInvocationEventV1): string {
  const decoded = decodeSkillInvocationEventV1(event)
  if (!decoded.ok) throw new Error(`SkillInvocation event invalid: ${decoded.code} ${decoded.path}`)
  return JSON.stringify(decoded.value)
}
