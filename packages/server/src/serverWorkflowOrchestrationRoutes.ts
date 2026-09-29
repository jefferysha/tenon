/**
 * 编排总览的两个只读端点：
 *   · `GET /api/workflows/:name/orchestration?root=&track=` —— 工作流定义（与 GET /api/workflows/:name 同一份来源：
 *     内建 → 项目 / 全局存储 → 模板）按轨道选分支后的编排；
 *   · `GET /api/change/:name/orchestration?root=` —— 任务冻结的计划 + 运行状态。
 * 失败沿用 `{ ok: false, code, error }`；机器分支只看 code。
 */
import {
  builtinWorkflow, isTenonUser, loadTrackRegistry, parseWorkflow, resolveTrackForBranch, templateWorkflowSource,
  WorkflowTrackBranchError,
  type TrackDefinition, type TrackValidationContext, type WorkflowDef,
} from '@tenon/kernel'
import { readAnchoredChangeState } from './changeSnapshot.js'
import { ContextBundlePathError } from './contextBundlePreviewSupport.js'
import { resolveSnapshotTrack } from './skillRuns.js'
import type { SnapshotDeps } from './snapshot.js'
import { createCandidateCache, type CandidateReader } from './testCandidateCache.js'
import { defaultResolveUser } from './serverUserRoutes.js'
import { changeOrchestration, definitionOrchestration } from './workflowOrchestration.js'
import { resolveSnapshotEffectivePlan } from './workflowSnapshot.js'
import { readWorkflowForApi, WorkflowNotFoundError, WorkflowPathError, type WorkflowRootAnchor } from './workflows.js'

type RootCheck =
  | { readonly ok: true; readonly anchor: WorkflowRootAnchor; readonly global?: boolean }
  | { readonly ok: false; readonly code: 403 | 404; readonly error: string }

export interface WorkflowOrchestrationRouteDeps {
  readonly workflowRootForRequest: (root: string) => RootCheck
  readonly workflowStoreForRequest: (root: string) => RootCheck
  readonly trackValidationContextFor: (anchor: WorkflowRootAnchor) => TrackValidationContext
  readonly snapshotDeps: (nowMs?: number) => SnapshotDeps
  readonly errMsg: (error: unknown) => string
}

export interface OrchestrationRouteResult {
  readonly status: number
  readonly body: unknown
}

const WORKFLOW_ROUTE = /^\/api\/workflows\/([^/]+)\/orchestration$/
const CHANGE_ROUTE = /^\/api\/change\/([^/]+)\/orchestration$/

function failure(status: number, code: string, error: string): OrchestrationRouteResult {
  return { status, body: { ok: false, code, error } }
}

function decode(segment: string | undefined): string | null {
  if (segment === undefined) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// 候选版本（工作区指纹）按指纹函数缓存，TTL 与快照同一套 createCandidateCache。
const candidateReaders = new WeakMap<object, CandidateReader>()
function candidateFor(deps: SnapshotDeps, root: string): (() => Promise<string | undefined>) | undefined {
  const fingerprint = deps.workspaceFingerprint
  if (fingerprint === undefined) return undefined
  let reader = candidateReaders.get(fingerprint)
  if (reader === undefined) {
    reader = createCandidateCache((target) => fingerprint(target, ''))
    candidateReaders.set(fingerprint, reader)
  }
  const read = reader
  return () => read(root)
}

/** 与 GET /api/workflows/:name 同序：插件内建 → 项目（缺失时全局）→ 模板。 */
function readDefinition(deps: WorkflowOrchestrationRouteDeps, check: Extract<RootCheck, { ok: true }>, name: string): { readonly definition: WorkflowDef; readonly anchor: WorkflowRootAnchor } | null {
  const builtin = builtinWorkflow(name)
  if (builtin !== null) return { definition: builtin, anchor: check.anchor }
  try {
    return { definition: readWorkflowForApi(check.anchor, name), anchor: check.anchor }
  } catch (error) {
    if (!(error instanceof WorkflowNotFoundError)) throw error
  }
  if (check.global !== true) {
    const global = deps.workflowStoreForRequest('')
    if (global.ok) {
      try {
        return { definition: readWorkflowForApi(global.anchor, name), anchor: global.anchor }
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error
      }
    }
  }
  const template = templateWorkflowSource(name)
  return template === undefined ? null : { definition: parseWorkflow(template), anchor: check.anchor }
}

function workflowRoute(rawUrl: string, name: string, deps: WorkflowOrchestrationRouteDeps): OrchestrationRouteResult {
  if (name === '' || !/^[\p{L}\p{N}\p{M}_-]+$/u.test(name)) return failure(400, 'ORCHESTRATION_WORKFLOW_INVALID', '非法 workflow 名')
  const params = new URL(rawUrl, 'http://localhost').searchParams
  const check = deps.workflowStoreForRequest(params.get('root') ?? '')
  if (!check.ok) return failure(check.code, check.code === 404 ? 'ORCHESTRATION_ROOT_NOT_REGISTERED' : 'ORCHESTRATION_ROOT_FORBIDDEN', check.error)
  let found
  try {
    found = readDefinition(deps, check, name)
  } catch (error) {
    if (error instanceof WorkflowPathError) return failure(403, 'ORCHESTRATION_DEFINITION_FORBIDDEN', deps.errMsg(error))
    return failure(500, 'ORCHESTRATION_DEFINITION_UNREADABLE', deps.errMsg(error))
  }
  if (found === null) return failure(404, 'ORCHESTRATION_WORKFLOW_NOT_FOUND', `workflow '${name}' 未找到`)
  const trackId = params.get('track') ?? ''
  let track: TrackDefinition | undefined
  if (trackId !== '') {
    try {
      track = resolveTrackForBranch(loadTrackRegistry(found.anchor.path, deps.trackValidationContextFor(found.anchor)), trackId, found.definition)
    } catch (error) {
      return failure(409, 'ORCHESTRATION_TRACKS_UNREADABLE', deps.errMsg(error))
    }
    if (track === undefined) return failure(404, 'ORCHESTRATION_TRACK_NOT_FOUND', `轨道 '${trackId}' 不存在`)
  }
  try {
    const resolver = deps.snapshotDeps().skillResolverFor?.(found.anchor.path)
    return { status: 200, body: definitionOrchestration({ name, definition: found.definition, track, resolver }) }
  } catch (error) {
    if (error instanceof WorkflowTrackBranchError) return failure(404, 'ORCHESTRATION_TRACK_NOT_FOUND', deps.errMsg(error))
    return failure(422, 'ORCHESTRATION_DEFINITION_INVALID', deps.errMsg(error))
  }
}

function field(value: string | readonly string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : ''
}

async function changeRoute(rawUrl: string, name: string, deps: WorkflowOrchestrationRouteDeps): Promise<OrchestrationRouteResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return failure(400, 'ORCHESTRATION_CHANGE_INVALID', '非法 change 名（仅允许 a-z A-Z 0-9 - _）')
  const root = new URL(rawUrl, 'http://localhost').searchParams.get('root') ?? ''
  if (root === '') return failure(400, 'ORCHESTRATION_ROOT_REQUIRED', '缺少 root 参数')
  const check = deps.workflowRootForRequest(root)
  if (!check.ok) return failure(check.code, check.code === 404 ? 'ORCHESTRATION_ROOT_NOT_REGISTERED' : 'ORCHESTRATION_ROOT_FORBIDDEN', check.error)
  const anchor = check.anchor
  try {
    const anchored = await readAnchoredChangeState(anchor, name)
    if (anchored === null) return failure(404, 'ORCHESTRATION_CHANGE_NOT_FOUND', `change '${name}' 不存在`)
    const { state, changeDir } = anchored
    const workflowName = field(state.fields.workflow) || 'default'
    const plan = resolveSnapshotEffectivePlan(anchor.path, workflowName, {
      documentProfile: state.runMetadata?.documentProfile,
      documentGovernanceFingerprint: state.runMetadata?.documentGovernanceFingerprint,
      workflowPlanFingerprint: state.runMetadata?.workflowPlanFingerprint,
      workflowPlanSnapshot: state.runMetadata?.workflowPlanSnapshot,
    }, (candidate) => {
      try {
        return readWorkflowForApi(anchor, candidate)
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return null
        throw error
      }
    }, resolveSnapshotTrack(anchor.path, field(state.fields.track), workflowName))
    const snapshotDeps = deps.snapshotDeps()
    const resolved = (snapshotDeps.resolveUser ?? defaultResolveUser)(root)
    const body = await changeOrchestration({
      root: anchor.path,
      changeDir,
      changeName: name,
      state,
      plan,
      resolver: snapshotDeps.skillResolverFor?.(anchor.path),
      user: isTenonUser(resolved) ? resolved : undefined,
      candidate: candidateFor(snapshotDeps, anchor.path),
    })
    return { status: 200, body }
  } catch (error) {
    if (error instanceof ContextBundlePathError && error.status === 403) return failure(403, 'ORCHESTRATION_CHANGE_FORBIDDEN', 'Change 路径不可信')
    if (error instanceof WorkflowPathError) return failure(403, 'ORCHESTRATION_DEFINITION_FORBIDDEN', deps.errMsg(error))
    return failure(500, 'ORCHESTRATION_CHANGE_UNREADABLE', deps.errMsg(error))
  }
}

export async function resolveWorkflowOrchestrationRoute(
  rawUrl: string,
  path: string,
  deps: WorkflowOrchestrationRouteDeps,
): Promise<OrchestrationRouteResult | null> {
  const workflow = WORKFLOW_ROUTE.exec(path)
  if (workflow !== null) {
    const name = decode(workflow[1])
    return name === null ? failure(400, 'ORCHESTRATION_WORKFLOW_INVALID', '非法 workflow 名') : workflowRoute(rawUrl, name, deps)
  }
  const change = CHANGE_ROUTE.exec(path)
  if (change !== null) {
    const name = decode(change[1])
    return name === null ? failure(400, 'ORCHESTRATION_CHANGE_INVALID', '非法 change 名') : changeRoute(rawUrl, name, deps)
  }
  return null
}
