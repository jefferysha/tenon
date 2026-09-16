import type { DocumentGovernancePolicy } from './document-contract.js'
import type { WorkflowIR } from './ir.js'
import type {
  WorkflowDecompositionPolicyV1,
  WorkflowInteractionPolicyV1,
} from './types.js'

/** 已删除的有限 Review 次数策略；只在读旧快照与复算历史指纹时出现，运行期没有任何行为。 */
export interface RetiredReviewBudget { readonly version: 'v1'; readonly max_attempts: number }

/** V1/V2 snapshots may still carry the removed `openspecContract` alias. */
export type LegacyWorkflowIR = Omit<WorkflowIR, 'decomposition' | 'interaction'> & {
  readonly openspecContract?: 'required'
}
export type WorkflowIRV3 = WorkflowIR & { readonly reviewBudget?: RetiredReviewBudget }

interface WorkflowPlanSnapshotBase {
  readonly workflowId: string
  readonly executionModel: 'phase-manifest' | 'step-graph'
  readonly workflowFingerprint: string
}

export interface WorkflowPlanSnapshotV1 extends WorkflowPlanSnapshotBase {
  readonly version: 1
  readonly workflow: LegacyWorkflowIR
}

export interface WorkflowPlanSnapshotV2 extends WorkflowPlanSnapshotBase {
  readonly version: 2
  readonly workflow: LegacyWorkflowIR
  readonly documentPolicy: DocumentGovernancePolicy | null
}

export interface WorkflowPlanSnapshotV3 extends WorkflowPlanSnapshotBase {
  readonly version: 3
  readonly workflow: WorkflowIRV3
  readonly documentPolicy: DocumentGovernancePolicy | null
  readonly decomposition: WorkflowDecompositionPolicyV1
  readonly interaction: WorkflowInteractionPolicyV1
  /** 已删除的策略；旧快照里可能有，读回时只用于复算历史指纹。 */
  readonly reviewBudget?: RetiredReviewBudget
}

/** V4 = V3 去掉 reviewBudget：新 Change 一律写这一版。 */
export interface WorkflowPlanSnapshotV4 extends WorkflowPlanSnapshotBase {
  readonly version: 4
  readonly workflow: WorkflowIR
  readonly documentPolicy: DocumentGovernancePolicy | null
  readonly decomposition: WorkflowDecompositionPolicyV1
  readonly interaction: WorkflowInteractionPolicyV1
}

export type WorkflowPlanSnapshot =
  | WorkflowPlanSnapshotV1 | WorkflowPlanSnapshotV2 | WorkflowPlanSnapshotV3 | WorkflowPlanSnapshotV4
