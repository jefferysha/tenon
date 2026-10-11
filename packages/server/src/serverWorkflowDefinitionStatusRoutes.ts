import type { PipelineState, PlanOptions } from '@tenon/kernel'
import {
  WorkflowPathError,
  type WorkflowRootAnchor,
} from './workflows.js'
import {
  projectWorkflowDefinitionStatus,
  type WorkflowDefinitionCurrent,
} from './workflowDefinitionStatus.js'
import { ContextBundlePathError } from './contextBundlePreviewSupport.js'
import { readCurrentWorkflowDefinition } from './workflowDefinitionReader.js'

export { readCurrentWorkflowDefinition } from './workflowDefinitionReader.js'

type WorkflowRootCheck =
  | { readonly ok: true; readonly anchor: WorkflowRootAnchor }
  | { readonly ok: false; readonly code: 403 | 404; readonly error: string }

export interface WorkflowDefinitionStatusRouteDeps {
  readonly workflowRootForRequest: (root: string) => WorkflowRootCheck
  readonly readChangeState: (anchor: WorkflowRootAnchor, change: string) => Promise<PipelineState | null>
  readonly readCurrent: (anchor: WorkflowRootAnchor, workflow: string, planOptions: PlanOptions) => WorkflowDefinitionCurrent
}

export interface WorkflowDefinitionStatusRouteResult {
  readonly status: number
  readonly body: unknown
}

function isChangeName(name: string): boolean {
  return name !== '' && /^[a-zA-Z0-9_-]+$/.test(name) && !name.includes('..')
}

export async function resolveWorkflowDefinitionStatusRoute(
  rawUrl: string,
  path: string,
  deps: WorkflowDefinitionStatusRouteDeps,
): Promise<WorkflowDefinitionStatusRouteResult | null> {
  if (path !== '/api/workflow-definition-status') return null

  const params = new URL(rawUrl, 'http://localhost').searchParams
  const name = params.get('change') ?? ''
  if (!isChangeName(name)) {
    return { status: 400, body: { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' } }
  }
  const requestedRoot = params.get('root')
  if (!requestedRoot) {
    return { status: 400, body: { ok: false, error: '缺少 root' } }
  }
  const rootCheck = deps.workflowRootForRequest(requestedRoot)
  if (!rootCheck.ok) {
    return {
      status: rootCheck.code,
      body: { ok: false, error: rootCheck.code === 404 ? 'root 未注册' : 'root 不可信' },
    }
  }
  let state: PipelineState | null
  try {
    state = await deps.readChangeState(rootCheck.anchor, name)
  } catch (error) {
    if (error instanceof WorkflowPathError) {
      return { status: 403, body: { ok: false, error: 'workflow 定义路径不可信' } }
    }
    if (error instanceof ContextBundlePathError && error.status === 403) {
      return { status: 403, body: { ok: false, error: 'canonical change 路径不可信' } }
    }
    return { status: 500, body: { ok: false, error: 'canonical change 读取失败' } }
  }
  if (state === null) {
    return { status: 400, body: { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' } }
  }
  const snapshot = state.runMetadata?.workflowPlanSnapshot
  const fieldWorkflow = state.fields.workflow
  const workflow = snapshot?.workflowId
    ?? (Array.isArray(fieldWorkflow) ? fieldWorkflow.join(',') : fieldWorkflow)
    ?? 'default'
  const frozenFingerprint = snapshot?.workflowFingerprint ?? null
  let current: WorkflowDefinitionCurrent
  try {
    current = frozenFingerprint === null
      ? { kind: 'invalid' } as const
      : deps.readCurrent(rootCheck.anchor, workflow, {
          track: Array.isArray(state.fields.track) ? state.fields.track.join(',') : state.fields.track,
          executionModel: snapshot?.executionModel,
        })
  } catch (error) {
    if (error instanceof WorkflowPathError) {
      return { status: 403, body: { ok: false, error: 'workflow 定义路径不可信' } }
    }
    return { status: 500, body: { ok: false, error: 'workflow definition 读取失败' } }
  }
  return {
    status: 200,
    body: projectWorkflowDefinitionStatus(workflow, frozenFingerprint, current),
  }
}
