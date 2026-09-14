export const SKILL_INVOCATION_SCHEMA_VERSION = 'skill-invocation-evidence/v1' as const
export const SKILL_INVOCATION_READ_SCHEMA_VERSION = 'skill-invocation-read/v1' as const

export const SKILL_INVOCATION_LIMITS = Object.freeze({
  maxLedgerBytes: 16 * 1024 * 1024,
  maxEventBytes: 128 * 1024,
  maxEvents: 8192,
  maxInvocations: 1024,
  maxFields: 128,
  maxQuestions: 128,
  maxArtifacts: 128,
  maxOptions: 64,
  maxIdBytes: 192,
  maxRefBytes: 1024,
})

export type SkillInvocationStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'incomplete'
  | 'corrupt'

export type SkillInvocationFieldClassification =
  | 'identifier'
  | 'project-data'
  | 'configuration'
  | 'user-provided'
  | 'sensitive-redacted'

export type SkillInvocationValidatorStatus = 'pass' | 'fail' | 'unknown'
export type SkillInvocationAdapterKind = 'native' | 'codex' | 'afk'
export type SkillInvocationArtifactKind = 'document' | 'file' | 'artifact' | 'value'
export type SkillInvocationQuestionRequiredness = 'routine' | 'advisory' | 'hard-gate'
export type SkillInvocationDecisionMode = 'user-answer' | 'recommended-default'

export interface StepVisitIdV1 {
  readonly run_id: string
  readonly transition_sequence: number
}

export interface SkillInvocationAttemptBindingV1 {
  readonly attempt_id: string
  readonly reservation_id: string
}

export interface SkillInvocationSubjectV1 {
  readonly project_id: string
  readonly workflow_definition_id: string
  readonly workflow_run_id: string
  readonly step_id: string
  readonly step_visit: StepVisitIdV1
  readonly task_plan_revision_id?: string
  readonly work_item_id?: string
  readonly attempt?: SkillInvocationAttemptBindingV1
}

export interface SkillInvocationValidatorProofV1 {
  readonly id: string
  readonly status: SkillInvocationValidatorStatus
  readonly code?: string
}

export interface SkillInvocationFieldProofV1 {
  readonly name: string
  readonly classification: SkillInvocationFieldClassification
  readonly digest: string
  readonly validator: SkillInvocationValidatorProofV1
}

export interface SkillInvocationIoProofV1 {
  readonly schema_id: string
  readonly fields: readonly SkillInvocationFieldProofV1[]
}

export interface SkillInvocationAdapterProofV1 {
  readonly kind: SkillInvocationAdapterKind
  readonly proof_ref: string
}

export interface SkillInvocationStartedPayloadV1 {
  readonly skill: { readonly id: string; readonly version: string }
  readonly input: SkillInvocationIoProofV1
  readonly adapter: SkillInvocationAdapterProofV1
}

export interface SkillInvocationQuestionPayloadV1 {
  readonly question_id: string
  readonly key: string
  readonly schema_id: string
  readonly option_ids: readonly string[]
  readonly requiredness: SkillInvocationQuestionRequiredness
  readonly shown: boolean
}

export interface SkillInvocationPolicyRefV1 {
  readonly id: string
  readonly version: string
  readonly rule_id: string
}

export interface SkillInvocationDecisionPayloadV1 {
  readonly decision_id: string
  readonly question_id: string
  readonly mode: SkillInvocationDecisionMode
  readonly selected_option_ids: readonly string[]
  readonly free_text?: {
    readonly classification: SkillInvocationFieldClassification
    readonly digest: string
  }
  readonly policy?: SkillInvocationPolicyRefV1
  readonly rationale_code?: string
}

export interface SkillInvocationCompletedPayloadV1 {
  readonly output: SkillInvocationIoProofV1
  readonly adapter: SkillInvocationAdapterProofV1
}

export interface SkillInvocationFailedPayloadV1 {
  readonly code: string
}

export interface SkillInvocationInterruptedPayloadV1 {
  readonly code: string
  readonly recovery: {
    readonly owner_id: string
    readonly proof_ref: string
  }
}

export interface SkillInvocationArtifactRefV1 {
  readonly kind: SkillInvocationArtifactKind
  readonly ref: string
  readonly digest: string
  readonly document?: {
    readonly kind: string
    readonly recorded_at: string
  }
}

export interface SkillInvocationArtifactIntentPayloadV1 {
  readonly binding_id: string
  readonly output_id: string
  readonly artifact: SkillInvocationArtifactRefV1
  readonly validator_ids: readonly string[]
}

export interface SkillInvocationArtifactBoundPayloadV1 {
  readonly binding_id: string
  readonly artifact_digest: string
  readonly validators: readonly SkillInvocationValidatorProofV1[]
}

interface SkillInvocationEventBaseV1 {
  readonly schema_version: typeof SKILL_INVOCATION_SCHEMA_VERSION
  readonly event_id: string
  readonly invocation_id: string
  readonly sequence: number
  readonly subject: SkillInvocationSubjectV1
  readonly recorded_at: string
}

export type SkillInvocationEventV1 =
  | (SkillInvocationEventBaseV1 & { readonly type: 'invocation-started'; readonly payload: SkillInvocationStartedPayloadV1 })
  | (SkillInvocationEventBaseV1 & { readonly type: 'question-recorded'; readonly payload: SkillInvocationQuestionPayloadV1 })
  | (SkillInvocationEventBaseV1 & { readonly type: 'decision-recorded'; readonly payload: SkillInvocationDecisionPayloadV1 })
  | (SkillInvocationEventBaseV1 & { readonly type: 'invocation-completed'; readonly payload: SkillInvocationCompletedPayloadV1 })
  | (SkillInvocationEventBaseV1 & { readonly type: 'invocation-failed'; readonly payload: SkillInvocationFailedPayloadV1 })
  | (SkillInvocationEventBaseV1 & { readonly type: 'invocation-interrupted'; readonly payload: SkillInvocationInterruptedPayloadV1 })
  | (SkillInvocationEventBaseV1 & { readonly type: 'artifact-binding-intent'; readonly payload: SkillInvocationArtifactIntentPayloadV1 })
  | (SkillInvocationEventBaseV1 & { readonly type: 'artifact-bound'; readonly payload: SkillInvocationArtifactBoundPayloadV1 })

export type SkillInvocationCodecResult =
  | { readonly ok: true; readonly value: SkillInvocationEventV1 }
  | { readonly ok: false; readonly code: 'json-invalid' | 'object-invalid' | 'unknown-field' | 'field-invalid' | 'limit-exceeded'; readonly path: string }

export interface SkillInvocationFieldReadV1 {
  readonly name: string
  readonly classification: SkillInvocationFieldClassification
  readonly validator: { readonly id: string; readonly status: SkillInvocationValidatorStatus; readonly code?: string }
}

export interface SkillInvocationReadModelV1 {
  readonly schema_version: typeof SKILL_INVOCATION_READ_SCHEMA_VERSION
  readonly invocation_id: string
  readonly status: SkillInvocationStatus
  readonly skill: { readonly id: string; readonly version: string }
  readonly subject: Omit<SkillInvocationSubjectV1, 'project_id'>
  readonly started_at: string
  readonly finished_at?: string
  readonly input: { readonly schema_id: string; readonly fields: readonly SkillInvocationFieldReadV1[] }
  readonly output?: { readonly schema_id: string; readonly fields: readonly SkillInvocationFieldReadV1[] }
  readonly questions: readonly {
    readonly id: string
    readonly key: string
    readonly schema_id: string
    readonly option_ids: readonly string[]
    readonly requiredness: SkillInvocationQuestionRequiredness
    readonly shown: boolean
  }[]
  readonly decisions: readonly {
    readonly id: string
    readonly question_id: string
    readonly mode: SkillInvocationDecisionMode
    readonly selected_option_ids: readonly string[]
    readonly free_text_classification?: SkillInvocationFieldClassification
    readonly policy?: SkillInvocationPolicyRefV1
    readonly rationale_code?: string
  }[]
  readonly artifacts: readonly {
    readonly binding_id: string
    readonly output_id: string
    readonly kind: SkillInvocationArtifactKind
    readonly ref: string
    readonly state: 'intent' | 'bound'
    readonly validators: readonly SkillInvocationValidatorProofV1[]
  }[]
  readonly terminal_code?: string
}

export interface SkillInvocationListReadModelV1 {
  readonly schema_version: 'skill-invocation-list/v1'
  readonly state: 'ready' | 'empty' | 'corrupt'
  readonly items: readonly SkillInvocationReadModelV1[]
}
