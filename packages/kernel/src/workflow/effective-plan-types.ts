import type { DocumentProfileId } from '../types.js'
import type { CoverageProfile } from '../tracks/types.js'
import type { DocumentGovernancePolicy } from './document-contract.js'
import type { WorkflowIR } from './ir.js'
import type {
  AgentSeverity,
  WorkflowDecompositionPolicyV1,
  WorkflowInteractionPolicyV1,
} from './types.js'

/** 步骤 agent 的投影：`tenon workflow plan --json` 与 CLI / server 都只读它，不再回头翻 IR。 */
export interface StepAgentsCapability {
  readonly stepId: string
  readonly executors: readonly { readonly agent: string; readonly dependsOn: readonly string[] }[]
  readonly reviewers: readonly {
    readonly agent: string
    readonly required: boolean
    readonly blockAt: AgentSeverity
    readonly dependsOn: readonly string[]
    readonly readsTests: readonly string[]
  }[]
}

export interface EffectiveWorkflowPlan {
  readonly id: string
  /** Transition/check execution capability; consumers never infer this from the workflow id. */
  readonly executionModel: 'phase-manifest' | 'step-graph'
  /** 完整定义（含全部 track 分支）：指纹与冻结快照的身份。老计划对象可能没有该字段（等于 workflow）。 */
  readonly definition?: WorkflowIR
  /** 按 change 的 track 选中的那条 pipeline（未命中分支 → 通用分支）；运行时只看它。 */
  readonly workflow: WorkflowIR
  readonly decomposition: WorkflowDecompositionPolicyV1
  readonly interaction: WorkflowInteractionPolicyV1
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
        readonly declared: readonly { readonly id: string; readonly dependsOn: readonly string[] }[]
      }[]
      readonly trackOverlay: {
        readonly matrix: boolean
        readonly profile: string
      }
    }
    readonly documents: {
      readonly governed: boolean
      readonly profile?: DocumentProfileId
      readonly policy?: DocumentGovernancePolicy
    }
    readonly review: {
      readonly steps: readonly string[]
    }
    readonly agents: {
      readonly steps: readonly StepAgentsCapability[]
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
