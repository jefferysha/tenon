import type { DocumentProfileId } from '../types.js'
import type { CoverageProfile } from '../tracks/types.js'
import type { DocumentGovernancePolicy } from './document-contract.js'
import type { WorkflowIR } from './ir.js'
import type { TrackPredicate } from './predicates.js'
import type {
  WorkflowDecompositionPolicyV1,
  WorkflowInteractionPolicyV1,
  WorkflowReviewBudgetPolicyV1,
} from './types.js'

export interface EffectiveWorkflowPlan {
  readonly id: string
  /** Transition/check execution capability; consumers never infer this from the workflow id. */
  readonly executionModel: 'phase-manifest' | 'step-graph'
  readonly workflow: WorkflowIR
  readonly decomposition: WorkflowDecompositionPolicyV1
  readonly interaction: WorkflowInteractionPolicyV1
  readonly reviewBudget: WorkflowReviewBudgetPolicyV1
  readonly documentPolicy?: DocumentGovernancePolicy
  readonly skillPolicy: 'manifest-overlay' | 'step-declared'
  readonly reviewSteps: readonly string[]
  /** Stable identity of workflow-owned behavior; Track overlay is intentionally a runtime overlay. */
  readonly workflowFingerprint: string
  readonly capabilities: {
    readonly execution: {
      readonly model: EffectiveWorkflowPlan['executionModel']
    }
    readonly skills: {
      readonly source: EffectiveWorkflowPlan['skillPolicy']
      readonly steps: readonly {
        readonly stepId: string
        readonly requiredSkillIds: readonly string[]
        readonly declared: readonly {
          readonly id: string
          readonly dependsOn: readonly string[]
          readonly kind: 'work' | 'review'
          readonly reviewLane?: string
        }[]
        /**
         * 带轨道条件的技能（YAML `when`），manifest-overlay 模型下作为 per-track 矩阵叠加层，
         * 由 resolver 按 track / profile 求值；step-graph 模型下已按轨道过滑进 requiredSkillIds，此处为空。
         */
        readonly conditional: readonly {
          readonly id: string
          readonly when: TrackPredicate
        }[]
      }[]
      readonly trackOverlay: {
        readonly matrix: boolean
        readonly profile: string
      }
      /** 定义自带轨道矩阵（任一技能声明了 when）：resolver 忽略机器级 manifest mandatory 表，只叠加 conditional。 */
      readonly matrixEmbedded: boolean
    }
    readonly documents: {
      readonly governed: boolean
      readonly profile?: DocumentProfileId
      readonly policy?: DocumentGovernancePolicy
    }
    readonly review: {
      readonly steps: readonly string[]
      readonly budget: WorkflowReviewBudgetPolicyV1
      readonly laneScopes: readonly {
        readonly stepId: string
        readonly lanes: readonly string[]
      }[]
    }
    readonly automation: {
      readonly eligible: boolean
      readonly autoEnqueueOnSpecComplete: boolean
    }
    readonly track: {
      readonly id: string | null
      readonly coverageProfile: CoverageProfile
      readonly routingEnabled: boolean
    }
  }
  readonly projection: {
    readonly steps: readonly { readonly id: string; readonly label: string }[]
    readonly stepLabelSource: 'localized-builtin' | 'workflow-defined'
  }
}

export interface PersistedDocumentGovernanceBinding {
  readonly documentProfile?: DocumentProfileId
  readonly documentGovernanceFingerprint?: string
  readonly workflowPlanFingerprint?: string
}
