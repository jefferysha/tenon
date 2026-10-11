import {
  createWorkflowActionAuthoritySnapshot,
  type WorkflowActionAuthoritySnapshotV1,
  type WorkflowPermissionLayerInput,
  type WorkflowPermissionLayers,
} from '@tenon/kernel'

/**
 * 宿主在每次复核时现读的、不属于 Workflow 的权限事实。项目层不在其中：它由准入自己读任务冻结计划里
 * 所选分支的 `automation`（见 workflow-action-admission.ts），宿主只能说明「任务现在记着哪条轨道」，
 * 不能代授项目层。
 */
export interface WorkflowActionAuthorityFacts {
  readonly platform: WorkflowPermissionLayerInput
  readonly skill: WorkflowPermissionLayerInput
  readonly run: WorkflowPermissionLayerInput
  /** 任务状态里记着的轨道 id；缺失或为空 = 项目层无从判定（失败关闭）。 */
  readonly trackId?: string
}

/** 项目层授权所依据的冻结分支：轨道 id，和该分支所在冻结计划的修订标识。 */
export interface WorkflowProjectAuthority {
  readonly trackId: string
  /** 冻结计划指纹的前 16 位十六进制。 */
  readonly revision: string
}

/** Builds the kernel-owned full effective snapshot without changing the Workflow definition. */
export function buildAfkWorkflowActionAuthoritySnapshot(input: {
  readonly run: { readonly id: string; readonly workflowId?: string; readonly workflowPlanFingerprint?: string }
  readonly context: {
    readonly loop_id: string; readonly iteration_id?: string
    readonly attempt_id: string; readonly reservation_id: string; readonly skill_bundle_id?: string | null
  }
  readonly project: WorkflowProjectAuthority
  readonly layers: WorkflowPermissionLayers
}): WorkflowActionAuthoritySnapshotV1 {
  const workflowId = input.run.workflowId ?? ''
  const workflowFingerprint = input.run.workflowPlanFingerprint ?? ''
  const iterationId = input.context.iteration_id ?? ''
  const skillBundleId = input.context.skill_bundle_id ?? ''
  const project = input.project
  return createWorkflowActionAuthoritySnapshot({
    action: 'enter-afk',
    workflowRunId: input.run.id,
    workflowId,
    workflowFingerprint,
    loopId: input.context.loop_id,
    iterationId,
    attemptId: input.context.attempt_id,
    reservationId: input.context.reservation_id,
    skillBundleId,
    trackId: project.trackId,
    // 持久化的快照格式沿用旧字段名（在途任务的已落盘快照仍须能解析）：这里存的是冻结计划的修订标识。
    trackRegistryRevision: project.revision,
    layers: input.layers,
    provenance: {
      platform: { kind: 'platform-policy', identity: 'tenon-workflow-action', revision: 'v1' },
      skill: { kind: 'skill-contract', identity: skillBundleId, revision: workflowFingerprint },
      project: { kind: 'track-registry', identity: project.trackId, revision: project.revision },
      workflow: { kind: 'workflow-plan', identity: workflowId, revision: workflowFingerprint },
      run: { kind: 'workflow-run', identity: input.run.id, revision: iterationId },
    },
  })
}
