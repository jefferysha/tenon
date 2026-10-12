import type { CoverageProfile, DocumentProfileId } from '../types.js'
import type { DocumentGovernancePolicy } from './document-contract.js'
import type { WorkflowIR } from './ir.js'
import type {
  AgentSeverity,
  ReviewerHost,
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
    /** 工作流声明的执行宿主；没写 = 不要求。 */
    readonly host?: ReviewerHost
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
  /** 指纹输入：旧引擎计划记 'manifest-overlay'（叠加已删除，只剩标识），新计划恒为 'step-declared'。 */
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
        /**
         * `dependsOnDeclared` = 定义里写了 depends_on（含 `[]`）；false 时按声明顺序串行
         * （skill-order.orderSkillSlots）。老计划对象可能缺该字段，按 dependsOn 非空推断。
         */
        readonly declared: readonly {
          readonly id: string
          readonly dependsOn: readonly string[]
          readonly dependsOnDeclared?: boolean
        }[]
      }[]
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
    /** 选中分支的 `automation`；没声明 = 不可进入 AFK。旧引擎计划按旧表（见 legacy-track-policy.ts）。 */
    readonly automation: {
      readonly eligible: boolean
      readonly autoEnqueueOnSpecComplete: boolean
    }
    readonly track: {
      /** 任务所在轨道（平铺工作流也回显任务记着的值）；计划没有轨道语境时为 null。 */
      readonly id: string | null
      /** 只有旧引擎计划（phase-manifest）按旧表读它；新计划恒为 'none'。 */
      readonly coverageProfile: CoverageProfile
      /** 选中分支是否声明了 `route`（参与自动路由）。 */
      readonly routingEnabled: boolean
    }
  }
  readonly projection: {
    readonly steps: readonly { readonly id: string; readonly label: string }[]
    readonly stepLabelSource: 'localized-builtin' | 'workflow-defined'
  }
}

/** AFK 挂队与规格完成自动入队读的两个策略位（取自计划的 `capabilities.automation`）。 */
export interface AutomationPolicyBits {
  readonly automationEligible: boolean
  readonly autoEnqueueOnSpecComplete?: boolean
}

export interface PersistedDocumentGovernanceBinding {
  readonly documentProfile?: DocumentProfileId
  readonly documentGovernanceFingerprint?: string
  readonly workflowPlanFingerprint?: string
}
