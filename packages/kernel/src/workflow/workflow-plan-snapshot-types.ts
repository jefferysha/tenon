import type { DocumentGovernancePolicy } from './document-contract.js'
import type { WorkflowIR } from './ir.js'
import type {
  WorkflowDecompositionPolicyV1,
  WorkflowInteractionPolicyV1,
  WorkflowReviewBudgetPolicyV1,
} from './types.js'

/** V1/V2 snapshots may still carry the removed `openspecContract` alias. */
export type LegacyWorkflowIR = Omit<WorkflowIR, 'decomposition' | 'interaction' | 'reviewBudget'> & {
  readonly openspecContract?: 'required'
}
export type WorkflowIRV3 = Omit<WorkflowIR, 'reviewBudget'> & {
  readonly reviewBudget?: WorkflowReviewBudgetPolicyV1
}

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
  /** Added compatibly to V3; absence means the finite product default for pre-policy snapshots. */
  readonly reviewBudget?: WorkflowReviewBudgetPolicyV1
}

export type WorkflowPlanSnapshot = WorkflowPlanSnapshotV1 | WorkflowPlanSnapshotV2 | WorkflowPlanSnapshotV3
