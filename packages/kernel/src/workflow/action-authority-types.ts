import type {
  WorkflowAction,
  WorkflowPermissionLayer,
  WorkflowPermissionLayerStatus,
  WorkflowPermissionLayers,
} from './policy.js'

export type WorkflowActionAuthorityProvenanceKind =
  | 'platform-policy'
  | 'skill-contract'
  // 持久化值沿用旧名（在途任务已落盘的快照要能解析）：project 层现在对应任务冻结计划里所选分支。
  | 'track-registry'
  | 'workflow-plan'
  | 'workflow-run'

export interface WorkflowActionAuthorityProvenanceV1 {
  readonly kind: WorkflowActionAuthorityProvenanceKind
  readonly identity: string
  readonly revision: string
}

export interface WorkflowActionAuthorityLayerSnapshotV1 {
  readonly layer: WorkflowPermissionLayer
  readonly status: WorkflowPermissionLayerStatus
  readonly grants: readonly WorkflowAction[]
  readonly provenance: WorkflowActionAuthorityProvenanceV1
}

export interface WorkflowActionAuthoritySnapshotV1 {
  readonly version: 1
  readonly action: WorkflowAction
  readonly workflow_run_id: string
  readonly workflow_id: string
  readonly workflow_fingerprint: string
  readonly loop_id: string
  readonly iteration_id: string
  readonly attempt_id: string
  readonly reservation_id: string
  readonly skill_bundle_id: string
  readonly track_id: string
  /** 持久化字段名沿用旧名（在途任务已落盘）：存的是冻结计划指纹的前 16 位十六进制。 */
  readonly track_registry_revision: string
  readonly layers: readonly WorkflowActionAuthorityLayerSnapshotV1[]
  readonly authorization_fingerprint: string
}

export interface CreateWorkflowActionAuthoritySnapshotInput {
  readonly action: WorkflowAction
  readonly workflowRunId: string
  readonly workflowId: string
  readonly workflowFingerprint: string
  readonly loopId: string
  readonly iterationId: string
  readonly attemptId: string
  readonly reservationId: string
  readonly skillBundleId: string
  readonly trackId: string
  /** 写入持久化字段 `track_registry_revision`：冻结计划指纹的前 16 位十六进制。 */
  readonly trackRegistryRevision: string
  readonly layers: WorkflowPermissionLayers
  readonly provenance: Readonly<Record<WorkflowPermissionLayer, WorkflowActionAuthorityProvenanceV1>>
}
