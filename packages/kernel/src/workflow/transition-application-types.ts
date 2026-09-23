import type { FieldName, FlowEngine, HistoryWriter, Phase, PipelineState } from '../types.js'
import type { BreadcrumbWriter, DocumentEvidenceReport } from '../state/index.js'
import type { TransitionContext } from '../flow/index.js'
import type { AutomationPolicySnapshot, ConstraintDecision } from '../loops/automation-policy.js'
import type { WorkflowIR } from './ir.js'
import type { DocumentContractPhase, DocumentGovernancePolicy } from './document-contract.js'
import type { TransitionRecord, WorkflowRunRepository } from './run-types.js'
import type { EffectiveWorkflowPlan } from './effective-plan.js'
import type { TrackDefinition } from '../tracks/types.js'
import type { AgentBlocker } from './agent-verdict.js'
import type { BuildRevisionBlocker } from './build-revision.js'
import type { InteractionEventRecorder } from '../interaction/ports.js'
import { INTERACTION_PROJECTION_WRITE_FAILED } from '../interaction/contract.js'
import type { RecordActor, UserRef } from '../users/user.js'
import type { TestEvidenceContext } from '../test-evidence/evaluate.js'
import type { TestEvidenceReader } from '../test-evidence/transition-gate.js'

export interface TransitionApplicationDeps {
  runRepository: WorkflowRunRepository
  /** Best-effort interaction projection emitter; it never participates in canonical decisions. */
  interaction?: InteractionEventRecorder
  /** Canonical review binding verifier; projection data is never consulted here. */
  reviewGateBinding: (input: {
    readonly changeDir: string
    readonly state: PipelineState
    readonly phase: string
    readonly event: string
  }) => Promise<boolean>
  flow: FlowEngine
  clock: () => string
  history?: HistoryWriter
  breadcrumb?: BreadcrumbWriter
  /**
   * 本步未完成的必需技能（逐条可读文案）。`plan` 带着 document 契约：契约点名为 producer 的技能，
   * 须在本次步骤访问里登记了它的文档才算完成，只调用不算。
   */
  missingStepSkills?: (input: {
    readonly changeDir: string
    readonly stepId: string
    readonly capability: EffectiveWorkflowPlan['capabilities']['skills']
    readonly plan: EffectiveWorkflowPlan
  }) => Promise<readonly string[]>
  /**
   * 离开步骤前的 agent 判定；只在前进出边上调用（退回边永不检查 agent）。
   * 缺省 undefined = 宿主未接线，不产生 agent 拦截。
   */
  stepAgentBlockers?: (input: {
    readonly changeDir: string
    readonly stepId: string
    readonly plan: EffectiveWorkflowPlan
    readonly state: PipelineState
  }) => Promise<readonly AgentBlocker[]>
  resolveTrack?: (trackId: string) => TrackDefinition
  documentEvidence?: (
    root: string,
    changeDir: string,
    phase: DocumentContractPhase,
  ) => Promise<DocumentEvidenceReport>
  /** 测试证据判定的注入面：缺省 = 声明了测试就失败关闭（宿主必须给身份）。 */
  testEvidence?: TestEvidenceContext
  /**
   * 判定读取面的覆写；缺省读权威的按用户运行记录。同 documentEvidence：生产不注入，
   * 只有命令层单测用它隔离渲染与退出码，绝不因此关闭门禁。
   */
  testEvidenceReader?: TestEvidenceReader
  resolveConstraintContext?: (input: {
    readonly policy: AutomationPolicySnapshot
    readonly command: TransitionCommand
    readonly target: string
  }) => Promise<{ readonly active: boolean; readonly humanGateSatisfied: boolean }>
}

export interface TransitionCommand {
  root: string
  changeDir: string
  changeName: string
  event: string
  context: TransitionContext
  loadWorkflow: (name: string) => WorkflowIR | null
  /** Declared operator; only the task owner may advance, and the record stores its user ref. */
  actor: RecordActor
}

export type TransitionApplicationWarning =
  | { readonly kind: 'build-sha-missing' }
  | {
      readonly kind: 'projection-write-failed'
      readonly projection: 'state-yaml' | 'breadcrumb' | 'history'
      readonly cause: unknown
    }
  | {
      readonly kind: 'projection-write-failed'
      readonly projection: 'interaction'
      readonly code: typeof INTERACTION_PROJECTION_WRITE_FAILED
      readonly cause: unknown
    }

export type TransitionApplicationResult =
  | {
      readonly kind: 'applied'
      readonly from: string
      readonly to: string
      readonly record: TransitionRecord
      readonly warnings: readonly TransitionApplicationWarning[]
    }
  | { readonly kind: 'owner-required'; readonly owner: UserRef | null }
  | { readonly kind: 'unknown-event'; readonly event: string }
  | {
      readonly kind: 'event-source-mismatch'
      readonly event: string
      readonly current: string
      readonly expected: Phase
      readonly to: Phase
    }
  | { readonly kind: 'illegal-transition'; readonly from: Phase; readonly to: Phase }
  | { readonly kind: 'precondition-violated'; readonly lines: readonly string[] }
  | { readonly kind: 'revision-untrusted'; readonly blocker: BuildRevisionBlocker }
  | { readonly kind: 'workflow-not-found'; readonly workflowName: string }
  | {
      readonly kind: 'retired-skills'
      readonly workflowName: string
      readonly skills: readonly string[]
    }
  | {
      readonly kind: 'document-governance-invalid'
      readonly workflowName: string
      readonly reason: string
    }
  | { readonly kind: 'step-not-in-graph'; readonly workflowName: string; readonly stepId: string }
  | {
      readonly kind: 'event-unsupported'
      readonly workflowName: string
      readonly stepId: string
      readonly event: string
      readonly available: readonly string[]
    }
  | {
      readonly kind: 'step-guard-failed'
      readonly workflowName: string
      readonly stepId: string
      readonly failures: readonly string[]
      readonly blockers?: readonly BuildRevisionBlocker[]
    }
  | {
      readonly kind: 'step-skills-incomplete'
      readonly workflowName: string
      readonly stepId: string
      readonly missing: readonly string[]
    }
  | {
      readonly kind: 'step-agents-incomplete'
      readonly workflowName: string
      readonly stepId: string
      readonly blockers: readonly AgentBlocker[]
    }
  | {
      readonly kind: 'document-evidence-failed'
      readonly phase: string
      readonly blockers: readonly string[]
    }
  | {
      readonly kind: 'test-evidence-failed'
      readonly stepId: string
      readonly blockers: readonly string[]
    }
  | {
      readonly kind: 'review-approval-required'
      readonly phase: string
      readonly event: string
      /** Event of a review request for this phase that is still waiting for acknowledgement. */
      readonly pendingEvent?: string
    }
  | { readonly kind: 'constraint-denied'; readonly reason: Exclude<ConstraintDecision, { allowed: true }>['reason'] }

export interface TransitionApplication {
  execute(command: TransitionCommand): Promise<TransitionApplicationResult>
}

export interface PreparedTransition {
  readonly governedDocumentContract: boolean
  readonly documentPolicy?: DocumentGovernancePolicy
  readonly requiresReviewApproval: boolean
  readonly from: string
  readonly to: string
  readonly nextFields: Record<FieldName, string | string[]>
  readonly warnings: TransitionApplicationWarning[]
}

export type TransitionRejection = Exclude<TransitionApplicationResult, { kind: 'applied' }>
