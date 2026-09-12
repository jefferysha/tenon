/** Canonical, provider-neutral orchestration aggregate contracts (v2). */

export const V2_SCHEMAS = {
  request: 'development-request/v2',
  context: 'repository-context/v2',
  assessment: 'capability-assessment/v2',
  graph: 'work-graph/v2',
  pipeline: 'workflow-pipeline/v2',
  inputManifest: 'skill-input-manifest/v2',
  resolution: 'capability-resolution/v2',
  workItem: 'work-item/v2',
  run: 'skill-run/v2',
  result: 'skill-result/v2',
  validation: 'validation-report/v2',
  gate: 'gate-evaluation/v2',
  command: 'board-command/v2',
  event: 'board-event/v2',
  snapshot: 'board-snapshot/v2',
} as const

export type V2Schema = typeof V2_SCHEMAS[keyof typeof V2_SCHEMAS]
export type V2ActorKind = 'user' | 'system' | 'worker' | 'policy'
export type V2Source = 'user' | 'rule' | 'model' | 'system'
export type V2SelectionMode = 'serial' | 'parallel'

export interface OrchestrationRecordMetaV2 {
  readonly [key: string]: unknown
  readonly schema_version: V2Schema | string
  readonly record_id: string
  readonly project_id: string
  readonly change_id: string
  readonly revision: number
  readonly correlation_id: string
  readonly actor: { readonly kind: V2ActorKind; readonly id: string }
  readonly created_at: string
  readonly causation_id?: string
}

export interface DevelopmentRequestV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'development-request/v2'
  readonly request_id: string
  readonly intent: string
  readonly interaction_policy: 'interactive' | 'recommended-defaults' | 'afk'
  readonly requested_effects: readonly ('read' | 'write' | 'git' | 'network' | 'deploy-preview')[]
  readonly constraints: readonly string[]
  readonly user_skills: readonly { readonly id: string; readonly version?: string; readonly mode: V2SelectionMode; readonly depends_on: readonly string[] }[]
  readonly user_mcps: readonly { readonly id: string; readonly version?: string; readonly required: boolean }[]
  readonly auto_select: boolean
  /** Optional explicit names; omitted values are resolved from the request/context. */
  readonly workflow_id?: string
  readonly workflow_version?: string
  readonly track_id?: string
  readonly track_revision?: string
  readonly pipeline_id?: string
  readonly pipeline_version?: string
}

export interface RepositoryContextV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'repository-context/v2'
  readonly request_id: string
  readonly repository: { readonly ref: string; readonly branch: string; readonly base_branch: string; readonly head_sha: string; readonly dirty: boolean }
  readonly workspace_fingerprint: `sha256:${string}`
  readonly policy_digest: `sha256:${string}`
  readonly skill_catalog_digest: `sha256:${string}`
  readonly mcp_catalog_digest: `sha256:${string}`
  readonly observed_facts: readonly { readonly key: string; readonly value_ref: string; readonly digest: `sha256:${string}` }[]
}

export interface CapabilityAssessmentV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'capability-assessment/v2'
  readonly assessment_id: string
  readonly request_id: string
  readonly context_record_id: string
  readonly normalization: 'complete' | 'needs-input' | 'rejected'
  readonly requirements: readonly { readonly id: string; readonly capability: string; readonly necessity: 'required' | 'recommended' | 'optional'; readonly acceptance_refs: readonly string[]; readonly evidence_refs: readonly string[]; readonly constraints: readonly string[]; readonly risk: 'low' | 'medium' | 'high' }[]
  readonly questions: readonly { readonly id: string; readonly prompt: string; readonly blocking: boolean }[]
  readonly risks: readonly string[]
  readonly proposal_evidence_ref: string
}

export interface WorkGraphV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'work-graph/v2'
  readonly graph_id: string
  readonly graph_revision: number
  readonly assessment_id: string
  readonly task_plan_revision_id: string
  readonly task_plan_digest: `sha256:${string}`
  /** Optional on legacy graphs; V2 planners bind the graph to the frozen pipeline identity. */
  readonly pipeline_id?: string
  readonly dependency_edges: readonly { readonly from: string; readonly to: string; readonly reason: 'data' | 'resource' | 'ordering' | 'gate' }[]
  readonly execution_groups: readonly { readonly id: string; readonly mode: V2SelectionMode; readonly work_item_ids: readonly string[] }[]
  readonly acceptance_coverage: readonly { readonly acceptance_id: string; readonly work_item_ids: readonly string[] }[]
  readonly status: 'draft' | 'validated' | 'frozen' | 'superseded'
}

export type PipelineSourceV2 = 'builtin' | 'project' | 'user' | 'automatic'
export type PipelineSkillRoleV2 = 'workflow' | 'track-mandatory' | 'track-recommended' | 'user' | 'automatic' | 'review'

/** The ordered Skill slot that a stage will execute. The order is persisted, not inferred by the runtime. */
export interface PipelineSkillV2 {
  readonly binding_id: string
  readonly skill_id: string
  readonly skill_version: string
  readonly order: number
  readonly role: PipelineSkillRoleV2
  readonly source: PipelineSourceV2
  readonly mode: V2SelectionMode
  readonly depends_on: readonly string[]
  readonly mcp_ids: readonly string[]
  readonly input_schema_id?: string
  readonly output_schema_id?: string
  readonly validator_ids: readonly string[]
  /** Frozen resource claims used to re-check parallel safety at execution time. */
  readonly resource_claims?: readonly { readonly kind: 'path' | 'logical' | 'external'; readonly key: string; readonly access: 'read' | 'write' }[]
}

/** A stage is a first-class pipeline node; stage_order and ordinal are both retained for replay/audit. */
export interface PipelineStageV2 {
  readonly stage_id: string
  readonly name: string
  readonly ordinal: number
  readonly execution_mode: V2SelectionMode
  readonly depends_on: readonly string[]
  readonly work_item_ids: readonly string[]
  readonly gate: 'none' | 'input' | 'review' | 'verification' | 'release'
  readonly skills: readonly PipelineSkillV2[]
  readonly input_refs: readonly string[]
  readonly output_refs: readonly string[]
  /** Stable logical artifact subjects exposed at planning time; file paths remain runtime metadata. */
  readonly input_subject_refs?: readonly string[]
  readonly output_subject_refs?: readonly string[]
}

/**
 * Canonical effective workflow/track/pipeline selection. It deliberately keeps
 * custom names and opaque Skill output contracts instead of narrowing them to
 * built-in enums, so user-defined workflows and Skills remain first-class.
 */
export interface WorkflowPipelinePlanV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'workflow-pipeline/v2'
  readonly pipeline_id: string
  readonly pipeline_version: string
  readonly workflow_id: string
  readonly workflow_version: string
  readonly workflow_source: PipelineSourceV2
  readonly workflow_fingerprint: string
  readonly track_id: string
  readonly track_revision: string
  readonly track_source: PipelineSourceV2
  readonly pipeline_source: PipelineSourceV2
  readonly graph_id: string
  readonly assessment_id: string
  readonly status: 'draft' | 'validated' | 'frozen' | 'superseded'
  readonly stage_order: readonly string[]
  readonly stages: readonly PipelineStageV2[]
  readonly customizations: {
    readonly custom_workflow: boolean
    readonly custom_track: boolean
    readonly custom_pipeline: boolean
    readonly user_skill_ids: readonly string[]
    readonly user_mcp_ids: readonly string[]
  }
  readonly pipeline_digest: `sha256:${string}`
}

export interface CapabilityResolutionV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'capability-resolution/v2'
  readonly resolution_id: string
  readonly assessment_id: string
  readonly graph_id: string
  readonly policy_digest: `sha256:${string}`
  readonly status: 'resolved' | 'needs-input' | 'blocked'
  readonly bindings: readonly { readonly work_item_id: string; readonly skill_id: string; readonly skill_version: string; readonly mcp_ids: readonly string[]; readonly mode: V2SelectionMode; readonly source: 'user' | 'automatic' | 'hybrid'; readonly depends_on: readonly string[] }[]
  readonly candidates: readonly { readonly capability: string; readonly candidate_id: string; readonly kind: 'skill' | 'mcp'; readonly selected: boolean; readonly rejected_reasons: readonly string[]; readonly rationale: string }[]
  readonly blockers: readonly string[]
  readonly binding_digest: `sha256:${string}`
}

export type ChangeStatusV2 = 'draft' | 'contextualizing' | 'assessing' | 'planning' | 'planned' | 'ready' | 'executing' | 'reviewing' | 'verifying' | 'completed' | 'waiting-input' | 'blocked' | 'paused' | 'failed' | 'cancelled'
export type WorkItemStatusV2 = 'pending' | 'ready' | 'queued' | 'claimed' | 'running' | 'waiting-input' | 'reviewing' | 'verifying' | 'completed' | 'blocked' | 'failed' | 'interrupted' | 'cancelled'
export type RunStatusV2 = 'queued' | 'claimed' | 'running' | 'waiting-input' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
export type GateStatusV2 = 'pending' | 'passed' | 'rejected' | 'waived'

export interface WorkItemV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'work-item/v2'
  readonly work_item_id: string
  readonly title: string
  readonly status: WorkItemStatusV2
  readonly group_id?: string
  readonly depends_on: readonly string[]
  readonly required_artifact_refs: readonly string[]
  readonly validation_refs: readonly string[]
  readonly selected_skill_id?: string
  readonly selected_skill_version?: string
  readonly mode: V2SelectionMode
  readonly attempt_count: number
  readonly active_run_id?: string
  readonly blockers: readonly string[]
}

export interface RunLeaseV2 {
  readonly [key: string]: unknown
  readonly lease_id: string
  readonly owner_id: string
  readonly acquired_at: string
  readonly heartbeat_at: string
  readonly expires_at: string
  readonly generation: number
  readonly status: 'active' | 'renewed' | 'expired' | 'released' | 'revoked'
}

export interface SkillRunV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'skill-run/v2'
  readonly run_id: string
  readonly attempt_id: string
  readonly attempt: number
  readonly work_item_id: string
  readonly skill_id: string
  readonly skill_version: string
  readonly mcp_ids: readonly string[]
  readonly status: RunStatusV2
  readonly lease?: RunLeaseV2
  readonly input_refs: readonly string[]
  /** Host-owned proof that all dependency inputs were materialized and delivered to the executor. */
  readonly input_manifest?: SkillInputManifestV2
  readonly result_id?: string
  readonly prior_attempt_id?: string
  readonly failure?: { readonly code: string; readonly retryable: boolean; readonly detail_ref?: string }
  readonly started_at?: string
  readonly finished_at?: string
}

export interface SkillResultV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'skill-result/v2'
  readonly result_id: string
  readonly run_id: string
  readonly status: 'completed' | 'failed' | 'blocked' | 'incomplete' | 'corrupt'
  readonly contract_status: 'validated' | 'unknown' | 'invalid'
  readonly output_schema_id?: string
  readonly summary?: string
  readonly raw_output?: { readonly ref: string; readonly digest: `sha256:${string}`; readonly media_type: string; readonly byte_length: number }
  readonly artifacts: readonly { readonly id: string; readonly kind: 'file' | 'diff' | 'document' | 'json' | 'text' | 'url' | 'report' | 'value' | 'unknown'; readonly ref: string; readonly digest: `sha256:${string}`; readonly media_type?: string; readonly byte_length?: number }[]
  readonly validation_refs: readonly string[]
  readonly diagnostics: readonly string[]
  /** Semantic digest/size of the bounded output that was persisted for downstream reads. */
  readonly output_digest?: `sha256:${string}`
  readonly output_bytes?: number
}

export interface SkillInputManifestV2 {
  readonly schema_version: 'skill-input-manifest/v2'
  readonly manifest_id: string
  readonly run_id: string
  readonly work_item_id: string
  readonly input_refs: readonly string[]
  readonly artifact_digests: readonly `sha256:${string}`[]
  readonly bundle_digest: `sha256:${string}`
  readonly byte_length: number
  readonly delivery: 'not-required' | 'injected' | 'rejected'
  readonly rejection_reason?: string
  readonly created_at: string
}

export interface ValidationReportV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'validation-report/v2'
  readonly report_id: string
  readonly work_item_id: string
  readonly result_id: string
  readonly validator_id: string
  readonly validator_version: string
  readonly status: 'pass' | 'fail' | 'unknown' | 'incomplete'
  readonly target_digests: readonly `sha256:${string}`[]
  readonly evidence_refs: readonly string[]
  readonly checks: readonly { readonly id: string; readonly status: 'pass' | 'fail' | 'unknown'; readonly message?: string }[]
}

export interface GateEvaluationV2 extends OrchestrationRecordMetaV2 {
  readonly schema_version: 'gate-evaluation/v2'
  readonly gate_id: string
  readonly kind: 'input' | 'review' | 'verification' | 'release'
  readonly status: GateStatusV2
  readonly required_evidence_refs: readonly string[]
  readonly decision_revision: number
  readonly actor: { readonly kind: V2ActorKind; readonly id: string }
  readonly rationale?: string
  readonly waiver_receipt_ref?: string
}

export type BoardCommandV2 =
  | BoardCommandBaseV2 & { readonly type: 'accept-request'; readonly request: DevelopmentRequestV2 }
  | BoardCommandBaseV2 & { readonly type: 'record-context'; readonly context: RepositoryContextV2 }
  | BoardCommandBaseV2 & { readonly type: 'record-assessment'; readonly assessment: CapabilityAssessmentV2 }
  | BoardCommandBaseV2 & { readonly type: 'freeze-pipeline'; readonly pipeline: WorkflowPipelinePlanV2 }
  | BoardCommandBaseV2 & { readonly type: 'freeze-work-graph'; readonly graph: WorkGraphV2 }
  | BoardCommandBaseV2 & { readonly type: 'resolve-capabilities'; readonly resolution: CapabilityResolutionV2 }
  | BoardCommandBaseV2 & { readonly type: 'start-change' }
  | BoardCommandBaseV2 & { readonly type: 'enqueue-work-item'; readonly work_item_id: string }
  | BoardCommandBaseV2 & { readonly type: 'claim-run'; readonly run: SkillRunV2; readonly lease: RunLeaseV2 }
  | BoardCommandBaseV2 & { readonly type: 'heartbeat-run'; readonly run_id: string; readonly lease_id: string; readonly owner_id: string; readonly generation: number; readonly heartbeat_at: string; readonly expires_at: string }
  | BoardCommandBaseV2 & { readonly type: 'begin-run'; readonly run_id: string; readonly lease_id: string; readonly owner_id: string; readonly generation: number }
  | BoardCommandBaseV2 & { readonly type: 'complete-run'; readonly run_id: string; readonly result: SkillResultV2 }
  | BoardCommandBaseV2 & { readonly type: 'record-validation'; readonly report: ValidationReportV2 }
  | BoardCommandBaseV2 & { readonly type: 'evaluate-gate'; readonly gate: GateEvaluationV2 }
  | BoardCommandBaseV2 & { readonly type: 'pause-change'; readonly reason: string }
  | BoardCommandBaseV2 & { readonly type: 'resume-change' }
  | BoardCommandBaseV2 & { readonly type: 'retry-work-item'; readonly work_item_id: string; readonly attempt_id: string; readonly run_id: string }
  | BoardCommandBaseV2 & { readonly type: 'cancel-change'; readonly reason: string }
  | BoardCommandBaseV2 & { readonly type: 'replan-change'; readonly reason: string }
  | BoardCommandBaseV2 & { readonly type: 'bind-artifact'; readonly work_item_id: string; readonly artifact_ref: string; readonly digest: `sha256:${string}` }

export interface BoardCommandBaseV2 {
  readonly schema_version: 'board-command/v2'
  readonly command_id: string
  readonly idempotency_key: string
  readonly expected_revision: number
  readonly actor: { readonly kind: V2ActorKind; readonly id: string }
  readonly issued_at: string
  readonly correlation_id: string
  readonly causation_id?: string
  readonly change_id: string
}

export type BoardEventTypeV2 = BoardCommandV2['type']
export interface BoardEventV2 {
  readonly schema_version: 'board-event/v2'
  readonly event_id: string
  readonly event_type: BoardEventTypeV2
  readonly command_id: string
  readonly idempotency_key: string
  readonly project_id: string
  readonly change_id: string
  readonly correlation_id: string
  readonly causation_id?: string
  readonly actor: { readonly kind: V2ActorKind; readonly id: string }
  readonly revision: number
  readonly issued_at: string
  readonly before_digest: `sha256:${string}`
  readonly after_digest: `sha256:${string}`
  readonly payload: BoardCommandV2
  readonly effects: readonly OrchestrationEffectV2[]
}

export type OrchestrationEffectV2 =
  | { readonly type: 'persist-record'; readonly record_schema: V2Schema; readonly record_id: string }
  | { readonly type: 'request-executor-cancel'; readonly run_id: string }
  | { readonly type: 'wake-scheduler'; readonly reason: string }

export interface BoardSnapshotV2 {
  readonly schema_version: 'board-snapshot/v2'
  readonly record_id: string
  readonly project_id: string
  readonly change_id: string
  readonly revision: number
  readonly correlation_id: string
  readonly actor: { readonly kind: V2ActorKind; readonly id: string }
  readonly created_at: string
  readonly event_head_id?: string
  readonly event_head_digest?: `sha256:${string}`
  readonly command_head_id?: string
  readonly status: ChangeStatusV2
  readonly request?: DevelopmentRequestV2
  readonly context?: RepositoryContextV2
  readonly assessment?: CapabilityAssessmentV2
  readonly pipeline?: WorkflowPipelinePlanV2
  readonly graph?: WorkGraphV2
  readonly resolution?: CapabilityResolutionV2
  readonly work_items: readonly WorkItemV2[]
  readonly runs: readonly SkillRunV2[]
  readonly results: readonly SkillResultV2[]
  readonly validations: readonly ValidationReportV2[]
  readonly gates: readonly GateEvaluationV2[]
  readonly leases: readonly RunLeaseV2[]
  readonly blockers: readonly string[]
  readonly next_actions: readonly string[]
  readonly resume_status?: Exclude<ChangeStatusV2, 'paused'>
  readonly updated_at: string
}

export type OrchestrationAggregateV2 = BoardSnapshotV2

export type V2RejectionCode = 'json-invalid' | 'contract-invalid' | 'revision-conflict' | 'invalid-transition' | 'not-found' | 'lease-mismatch' | 'missing-evidence' | 'terminal-state' | 'idempotency-conflict' | 'policy-blocked'
export interface V2Rejection { readonly code: V2RejectionCode; readonly message: string; readonly reason_code: string; readonly next_actions: readonly string[] }
export type V2Decision = { readonly ok: true; readonly event: BoardEventV2 } | { readonly ok: false; readonly rejection: V2Rejection }
