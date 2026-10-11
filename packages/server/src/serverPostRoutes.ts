import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  ExtendedManifestData,
  FlowEngine,
  GraduationFs,
  HistoryWriter,
  StateStore,
  WorkflowRunRepository,
  TransitionRecordStore,
} from '@tenon/kernel'
import type { LoopActivationValidator } from './loops.js'
import type { PipelineCliRunner } from './operations.js'
import { tokenFromHeaders, tokensMatch } from './token.js'
import { performTransition } from './transition.js'
import type { ServerPaths } from './types.js'
import type { WorkflowRootAnchor } from './workflows.js'
import { handlePostProjectRoutes } from './serverPostProjectRoutes.js'
import { handlePostExecutionRoutes } from './serverPostExecutionRoutes.js'
import { handlePostGovernanceRoutes } from './serverPostGovernanceRoutes.js'
import { handlePostOperationsRoutes } from './serverPostOperationsRoutes.js'
import { handlePostMemoryRoutes } from './serverPostMemoryRoutes.js'
import type { RelatedSessionSearchExecutor } from './relatedSessionMemory.js'
import { handleOrchestrationV2PostRoute, type OrchestrationV2RouteDeps } from './serverOrchestrationV2Routes.js'
import { resolveAdapterInstallPost } from './adapterInstallRoutes.js'
import { handlePostUserRoutes } from './serverUserRoutes.js'
import { handleTaskLifecyclePost, type TaskLifecycleRouteDeps } from './serverTaskLifecycleRoutes.js'
import { resolveInstructionMutation } from './instructionRoutes.js'
import { resolveFsPost } from './fsRoutes.js'
import { PROJECT_CREATE_STREAM_PATH, handleProjectCreateStream } from './projectCreateStream.js'
import { resolveAgentMutation } from './serverAgentRoutes.js'
import { resolveResourceMutation } from './serverResourceRoutes.js'
import type { AdapterInstallManager } from './adapterInstall.js'
import type { PresencePort } from './serverAccess.js'

type WorkflowRootCheck =
  | { ok: true; anchor: WorkflowRootAnchor }
  | { ok: false; code: 403 | 404; error: string }

export interface PostRouteDeps {
  isLocalHost: (host: string | undefined, port: number) => boolean
  boundPort: () => number
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
  token: string
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
  workflowRootForRequest: (root: string) => WorkflowRootCheck
  workflowStoreForRequest: (root: string) => { ok: true; anchor: WorkflowRootAnchor; global: boolean } | { ok: false; code: 403 | 404; error: string }
  executeOperation: (res: ServerResponse, root: string, args: readonly string[]) => Promise<void>
  operationRunner: PipelineCliRunner
  operationsAvailable: boolean
  isRegisteredRoot: (root: string) => boolean
  store: StateStore
  clock: () => string
  history: HistoryWriter
  workflowRootAnchors: Map<string, WorkflowRootAnchor>
  loadedManifest?: ExtendedManifestData
  runRepo: WorkflowRunRepository
  /** Transition chain reader used by the decision projection preflight. */
  recordStore?: TransitionRecordStore
  flow: FlowEngine
  fileExists: (root: string, relPath: string) => boolean
  gitHeadSha?: (cwd: string) => Promise<string>
  workspaceFingerprint?: (cwd: string, changeName: string) => Promise<string>
  breadcrumb: Parameters<typeof performTransition>[0]['breadcrumb']
  paths: ServerPaths
  validateLoopActivation?: LoopActivationValidator
  errMsg: (error: unknown) => string
  realGraduationFs: GraduationFs
  relatedSessionSearch: RelatedSessionSearchExecutor
  folderChooser: import('./folderChooser.js').FolderChooser
  runGit?: import('./projectCreate.js').GitRunner
  /** DESIGN.md 起步抓取器（`/api/design/seed` 与新建项目 design 步骤）；缺省走 https。 */
  designSeedFetch?: import('./designSeed.js').DesignSeedFetch
  /** Canonical v2 orchestration ledger; omitted by legacy embedders. */
  orchestrationV2?: OrchestrationV2RouteDeps
  adapterInstall?: AdapterInstallManager
  /** Declared identity for a request root (`''` = aggregate view). */
  resolveUser: import('./serverUserRoutes.js').ResolveUser
  /** Proof-of-presence nonces that gate the human review confirmation (`POST …/decisions`). */
  presence: PresencePort
  /** 归档 / 取消归档 的共享 application；未装配时这两条路由不存在（不谎报）。 */
  taskLifecycle?: TaskLifecycleRouteDeps
}

export async function handlePostRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: PostRouteDeps,
): Promise<void> {
  const { isLocalHost, sendJson, token, readJsonBody, workflowRootForRequest, adapterInstall } = deps
  const boundPort = deps.boundPort()
    // (1) DNS-rebinding 守卫
    if (!isLocalHost(req.headers.host, boundPort)) {
      return sendJson(res, 403, { ok: false, error: 'Host header 不合法（疑似 DNS 重绑定攻击）' })
    }
    // (2) B5：所有写端点强制 token 鉴权
    const provided = tokenFromHeaders(req.headers)
    if (!provided || !tokensMatch(provided, token)) {
      return sendJson(res, 401, { ok: false, error: '缺少或无效 token（写端点需鉴权）' })
    }
    // (3) 强制 application/json（借同源策略：跨源 JSON POST 触发预检，本 server 零 CORS 头 → 被阻断）
    const ctype = (String(req.headers['content-type'] ?? '').split(';', 1)[0] ?? '').trim().toLowerCase()
    if (ctype !== 'application/json') {
      return sendJson(res, 400, { ok: false, error: '写回端点要求 Content-Type: application/json' })
    }

    if (deps.orchestrationV2) {
      const handled = await handleOrchestrationV2PostRoute(req, res, path, {
        ...deps.orchestrationV2,
        sendJson,
        readJsonBody,
        token,
        isLocalHost,
        boundPort: () => boundPort,
      })
      if (handled) return
    }
    if (adapterInstall) {
      const handled = await resolveAdapterInstallPost(req, res, path, readJsonBody, {
        manager: adapterInstall,
        workflowRootForRequest,
        sendJson,
      })
      if (handled) return
    }
    if (path === PROJECT_CREATE_STREAM_PATH) return handleProjectCreateStream(req, res, deps)
    const fsPost = resolveFsPost(req, path, deps)
    if (fsPost) { const result = await fsPost; return sendJson(res, result.status, result.body) }
    const instructionPost = resolveInstructionMutation(req, 'POST', path, deps)
    if (instructionPost) { const result = await instructionPost; return sendJson(res, result.status, result.body) }
    const resourcePost = resolveResourceMutation(req, 'POST', path, deps)
    if (resourcePost) { const result = await resourcePost; return sendJson(res, result.status, result.body) }
    const agentPost = resolveAgentMutation(req, 'POST', path, deps)
    if (agentPost) { const result = await agentPost; return sendJson(res, result.status, result.body) }
    if (await handleTaskLifecyclePost(req, res, path, deps)) return

  await handlePostOperationsRoutes(req, res, path, deps)
  if (res.writableEnded) return
  await handlePostProjectRoutes(req, res, path, deps)
  if (res.writableEnded) return
  await handlePostGovernanceRoutes(req, res, path, deps)
  if (res.writableEnded) return
  await handlePostMemoryRoutes(req, res, path, deps)
  if (res.writableEnded) return
  await handlePostUserRoutes(req, res, path, deps)
  if (res.writableEnded) return
  await handlePostExecutionRoutes(req, res, path, deps)
  if (res.writableEnded) return
  return sendJson(res, 404, { ok: false, error: '未知端点' })
  }
