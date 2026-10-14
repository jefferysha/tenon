import {
  effectiveWorkflowPlanFromSnapshot,
  type WorkflowPermissionLayerInput,
  type WorkflowPlanSnapshot,
} from '@tenon/kernel'
import type { WorkflowProjectAuthority } from './workflow-action-authority-binding.js'

/** WorkflowRun 里项目层要核对的那几项（准入绑定回来的 run 是它的超集）。 */
export interface FrozenRunRef {
  readonly workflowId?: string
  readonly workflowPlanFingerprint?: string
  readonly workflowPlanSnapshot?: WorkflowPlanSnapshot
}

export interface FrozenProjectLayer {
  readonly layer: WorkflowPermissionLayerInput
  /** 只有项目层放行 enter-afk 时才有：授权所依据的冻结分支。 */
  readonly authority?: WorkflowProjectAuthority
}

const unavailable = (status: 'missing' | 'malformed'): FrozenProjectLayer => ({
  layer: { status, grants: [] },
})

/**
 * 项目层只读任务冻结计划里所选分支的 `automation.eligible`（没写 automation 的分支不可进入 AFK）。
 * 分支由宿主报告的任务轨道选出，但授权值取自 WorkflowRun 的不可变快照，宿主无法代授；快照缺失、
 * 轨道不在冻结定义里、计划与 Run 绑定的指纹不符，都按失败关闭处理。
 */
export function frozenProjectLayer(run: FrozenRunRef, trackId: string | undefined): FrozenProjectLayer {
  if (run.workflowPlanSnapshot === undefined) return unavailable('missing')
  if (trackId === undefined || trackId === '') return unavailable('malformed')
  try {
    const plan = effectiveWorkflowPlanFromSnapshot(run.workflowPlanSnapshot, trackId)
    if (run.workflowPlanFingerprint !== plan.workflowFingerprint || run.workflowId !== plan.id) {
      return { layer: { status: 'fingerprint-mismatch', grants: [] } }
    }
    if (!plan.capabilities.automation.eligible) return { layer: { status: 'valid', grants: [] } }
    return {
      layer: { status: 'valid', grants: ['enter-afk'] },
      authority: { trackId, revision: plan.workflowFingerprint.slice(0, 16) },
    }
  } catch {
    return unavailable('malformed')
  }
}
