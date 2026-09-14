import { SKILL_INVOCATION_LIMITS } from './types.js'
import type {
  SkillInvocationArtifactBoundPayloadV1,
  SkillInvocationArtifactIntentPayloadV1,
  SkillInvocationDecisionPayloadV1,
  SkillInvocationEventV1,
  SkillInvocationFieldProofV1,
  SkillInvocationQuestionPayloadV1,
  SkillInvocationReadModelV1,
  SkillInvocationStartedPayloadV1,
} from './types.js'

export class SkillInvocationEvidenceConflictError extends Error {
  override readonly name = 'SkillInvocationEvidenceConflictError'
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function publicFields(fields: readonly SkillInvocationFieldProofV1[]): SkillInvocationReadModelV1['input']['fields'] {
  return fields.map((field) => ({
    name: field.name,
    classification: field.classification,
    validator: { ...field.validator },
  }))
}

function assertSubject(first: SkillInvocationEventV1, event: SkillInvocationEventV1): void {
  if (event.invocation_id !== first.invocation_id || !same(event.subject, first.subject)) {
    throw new SkillInvocationEvidenceConflictError('invocation subject binding mismatch')
  }
}

function assertCompletedQuestions(
  questions: ReadonlyMap<string, SkillInvocationQuestionPayloadV1>,
  decisions: ReadonlyMap<string, SkillInvocationDecisionPayloadV1>,
): void {
  for (const question of questions.values()) {
    const decision = decisions.get(question.question_id)
    if (question.requiredness === 'hard-gate'
      && (!question.shown || decision?.mode !== 'user-answer')) {
      throw new SkillInvocationEvidenceConflictError('hard-gate completion requires a shown question and non-empty user answer')
    }
    if (!question.shown && decision?.mode !== 'recommended-default') {
      throw new SkillInvocationEvidenceConflictError('unshown question completion requires a verified recommended default')
    }
  }
}

export function projectSkillInvocationEvents(events: readonly SkillInvocationEventV1[]): SkillInvocationReadModelV1 {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  const first = ordered[0]
  if (first === undefined || first.type !== 'invocation-started' || first.sequence !== 1) {
    throw new SkillInvocationEvidenceConflictError('invocation must have exactly one started event at sequence 1')
  }
  const started: SkillInvocationStartedPayloadV1 = first.payload
  let terminal: Extract<SkillInvocationEventV1, { type: 'invocation-completed' | 'invocation-failed' | 'invocation-interrupted' }> | undefined
  const questions = new Map<string, SkillInvocationQuestionPayloadV1>()
  const decisions = new Map<string, SkillInvocationDecisionPayloadV1>()
  const decisionIds = new Set<string>()
  const intents = new Map<string, SkillInvocationArtifactIntentPayloadV1>()
  const bindings = new Map<string, SkillInvocationArtifactBoundPayloadV1>()
  const eventIds = new Set<string>()
  let expectedSequence = 1
  for (const event of ordered) {
    assertSubject(first, event)
    if (event.sequence !== expectedSequence) throw new SkillInvocationEvidenceConflictError('invocation event sequence is not contiguous')
    expectedSequence += 1
    if (eventIds.has(event.event_id)) throw new SkillInvocationEvidenceConflictError('duplicate invocation event id')
    eventIds.add(event.event_id)
    if (event !== first && event.type === 'invocation-started') throw new SkillInvocationEvidenceConflictError('duplicate invocation started event')
    if (event.type === 'question-recorded') {
      if (terminal !== undefined) throw new SkillInvocationEvidenceConflictError('question cannot be recorded after terminal')
      if (questions.has(event.payload.question_id)) throw new SkillInvocationEvidenceConflictError('duplicate question')
      if (questions.size >= SKILL_INVOCATION_LIMITS.maxQuestions) {
        throw new SkillInvocationEvidenceConflictError('invocation question budget exceeded')
      }
      questions.set(event.payload.question_id, event.payload)
    }
    if (event.type === 'decision-recorded') {
      if (terminal !== undefined) throw new SkillInvocationEvidenceConflictError('decision cannot be recorded after terminal')
      const question = questions.get(event.payload.question_id)
      if (question === undefined) throw new SkillInvocationEvidenceConflictError('decision references a missing question')
      if (decisions.has(event.payload.question_id)) throw new SkillInvocationEvidenceConflictError('question already has a decision')
      if (decisionIds.has(event.payload.decision_id)) throw new SkillInvocationEvidenceConflictError('duplicate decision id')
      if (event.payload.selected_option_ids.some((option) => !question.option_ids.includes(option))) {
        throw new SkillInvocationEvidenceConflictError('decision selects an unknown option')
      }
      if (event.payload.mode === 'user-answer') {
        if (!question.shown) throw new SkillInvocationEvidenceConflictError('user answer requires a shown question')
        if (event.payload.selected_option_ids.length === 0 && event.payload.free_text === undefined) {
          throw new SkillInvocationEvidenceConflictError('user answer must be non-empty')
        }
        if (event.payload.policy !== undefined || event.payload.rationale_code !== undefined) {
          throw new SkillInvocationEvidenceConflictError('user answer cannot claim a default policy')
        }
      } else {
        if (question.requiredness === 'hard-gate') throw new SkillInvocationEvidenceConflictError('hard-gate question cannot use a recommended default')
        if (question.shown) throw new SkillInvocationEvidenceConflictError('recommended default requires shown=false')
        if (event.payload.policy === undefined || event.payload.rationale_code === undefined) {
          throw new SkillInvocationEvidenceConflictError('recommended default requires frozen policy and rationale')
        }
        if (event.payload.selected_option_ids.length === 0) {
          throw new SkillInvocationEvidenceConflictError('recommended default must select an option')
        }
      }
      decisions.set(event.payload.question_id, event.payload)
      decisionIds.add(event.payload.decision_id)
    }
    if (event.type === 'invocation-completed' || event.type === 'invocation-failed' || event.type === 'invocation-interrupted') {
      if (terminal !== undefined) throw new SkillInvocationEvidenceConflictError('invocation terminal is unique')
      if (event.type === 'invocation-completed' && event.payload.adapter.kind !== started.adapter.kind) {
        throw new SkillInvocationEvidenceConflictError('completion adapter does not match invocation start')
      }
      if (event.type === 'invocation-completed') assertCompletedQuestions(questions, decisions)
      terminal = event
    }
    if (event.type === 'artifact-binding-intent') {
      if (terminal?.type !== 'invocation-completed') throw new SkillInvocationEvidenceConflictError('artifact intent requires completed invocation')
      if (intents.has(event.payload.binding_id)) throw new SkillInvocationEvidenceConflictError('duplicate artifact binding intent')
      if (intents.size >= SKILL_INVOCATION_LIMITS.maxArtifacts) {
        throw new SkillInvocationEvidenceConflictError('invocation artifact budget exceeded')
      }
      if (!terminal.payload.output.fields.some((field) => field.name === event.payload.output_id)) {
        throw new SkillInvocationEvidenceConflictError('artifact intent must reference a declared output')
      }
      if ([...intents.values()].some((intent) => intent.output_id === event.payload.output_id)) {
        throw new SkillInvocationEvidenceConflictError('artifact output binding must be unique')
      }
      if (event.payload.validator_ids.length === 0) {
        throw new SkillInvocationEvidenceConflictError('artifact intent requires at least one validator')
      }
      intents.set(event.payload.binding_id, event.payload)
    }
    if (event.type === 'artifact-bound') {
      const intent = intents.get(event.payload.binding_id)
      if (intent === undefined) throw new SkillInvocationEvidenceConflictError('artifact commit requires matching intent')
      if (bindings.has(event.payload.binding_id)) throw new SkillInvocationEvidenceConflictError('duplicate artifact binding commit')
      if (intent.artifact.digest !== event.payload.artifact_digest) throw new SkillInvocationEvidenceConflictError('artifact digest drift')
      const validatorIds = new Set(event.payload.validators.map((validator) => validator.id))
      if (validatorIds.size !== event.payload.validators.length
        || validatorIds.size !== intent.validator_ids.length
        || intent.validator_ids.some((id) => !validatorIds.has(id))) {
        throw new SkillInvocationEvidenceConflictError('artifact validators must exactly match the binding intent')
      }
      if (event.payload.validators.some((validator) => validator.status !== 'pass')) {
        throw new SkillInvocationEvidenceConflictError('artifact validator verdicts must pass before binding')
      }
      bindings.set(event.payload.binding_id, event.payload)
    }
  }
  const status = terminal?.type === 'invocation-completed'
    ? 'completed'
    : terminal?.type === 'invocation-failed'
      ? 'failed'
      : terminal?.type === 'invocation-interrupted'
        ? 'interrupted'
        : 'incomplete'
  const subject = { ...first.subject }
  delete (subject as Partial<typeof subject>).project_id
  const terminalCode = terminal?.type === 'invocation-failed' || terminal?.type === 'invocation-interrupted'
    ? terminal.payload.code
    : undefined
  return {
    schema_version: 'skill-invocation-read/v1',
    invocation_id: first.invocation_id,
    status,
    skill: { ...started.skill },
    subject,
    started_at: first.recorded_at,
    ...(terminal === undefined ? {} : { finished_at: terminal.recorded_at }),
    input: { schema_id: started.input.schema_id, fields: publicFields(started.input.fields) },
    ...(terminal?.type === 'invocation-completed'
      ? { output: { schema_id: terminal.payload.output.schema_id, fields: publicFields(terminal.payload.output.fields) } }
      : {}),
    questions: [...questions.values()].map((question) => ({
      id: question.question_id,
      key: question.key,
      schema_id: question.schema_id,
      option_ids: [...question.option_ids],
      requiredness: question.requiredness,
      shown: question.shown,
    })),
    decisions: [...decisions.values()].map((decision) => ({
      id: decision.decision_id,
      question_id: decision.question_id,
      mode: decision.mode,
      selected_option_ids: [...decision.selected_option_ids],
      ...(decision.free_text === undefined ? {} : { free_text_classification: decision.free_text.classification }),
      ...(decision.policy === undefined ? {} : { policy: { ...decision.policy } }),
      ...(decision.rationale_code === undefined ? {} : { rationale_code: decision.rationale_code }),
    })),
    artifacts: [...intents.values()].map((intent) => {
      const bound = bindings.get(intent.binding_id)
      return {
        binding_id: intent.binding_id,
        output_id: intent.output_id,
        kind: intent.artifact.kind,
        ref: intent.artifact.ref,
        state: bound === undefined ? 'intent' as const : 'bound' as const,
        validators: bound?.validators.map((validator) => ({ ...validator })) ?? [],
      }
    }),
    ...(terminalCode === undefined ? {} : { terminal_code: terminalCode }),
  }
}
