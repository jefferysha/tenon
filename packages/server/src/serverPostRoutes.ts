import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstatSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import {
  applyLevelChange,
  assertWorkflowAllowed,
  builtinWorkflow,
  createEffectiveSkillResolver,
  createTrack,
  decodeWorkflowDef,
  firstStep,
  listAutomationPolicyTemplates,
  loadTrackRegistry,
  loadWorkflow,
  requireTrack,
  stateStorageExistsSync,
  validateWorkflow,
  validateWorkflowTrackReferences,
  withTrackRegistryLock,
  type CreateTrackSpec,
  type ExtendedManifestData,
  type FlowEngine,
  type GraduationFs,
  type HistoryWriter,
  type StateStore,
  type TrackDefinition,
  type TrackRegistry,
  type TrackValidationContext,
  type WorkflowDef,
  type WorkflowRunRepository,
  type TransitionRecordStore,
} from '@tenon/kernel'
import {
  cancelAfkRun,
  dismissAfkRun,
  enqueueAfkRun,
  retryAfkRun,
} from './afk.js'
import { validateAutomationSettingsBody, writeAutomationSettings } from './automationConfig.js'
import {
  activateChangeSession,
  notRequestedSessionActivation,
  parseChangeSessionActivation,
  parseChangeTaskPrompt,
  writeChangeTaskPrompt,
} from './changeLaunch.js'
import { validateMandatorySkillsBody, writeMandatorySkills } from './config.js'
import { validateHookToggleBody, writeHookToggle } from './hooksConfig.js'
import { applyLoopsUpdate, type LoopActivationValidator } from './loops.js'
import { parsePipelineCliJson, type PipelineCliRunner } from './operations.js'
import { addProjectToRegistry, removeProjectFromRegistry } from './projects.js'
import {
  applyRouterDraft,
  parseRouterDraft,
  previewTrackRouting,
  type RouterPatternScorer,
} from './routerPreview.js'
import { validateSecretWriteBody, writeSecret } from './secrets.js'
import { tokenFromHeaders, tokensMatch } from './token.js'
import { performTransition } from './transition.js'
import type { ServerPaths } from './types.js'
import {
  assertWorkflowRootAnchor,
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  ensureWorkflowProjectCoordinationPath,
  readWorkflowForApi,
  WorkflowNotFoundError,
  writeWorkflowForApi,
  type WorkflowRootAnchor,
} from './workflows.js'
import { handlePostChangesRoutes } from './serverPostChangesRoutes.js'
import { handlePostExecutionRoutes } from './serverPostExecutionRoutes.js'
import { handlePostGovernanceRoutes } from './serverPostGovernanceRoutes.js'
import { handlePostOperationsRoutes } from './serverPostOperationsRoutes.js'
import { handlePostMemoryRoutes } from './serverPostMemoryRoutes.js'
import type { RelatedSessionSearchExecutor } from './relatedSessionMemory.js'
import { handleOrchestrationV2PostRoute, type OrchestrationV2RouteDeps } from './serverOrchestrationV2Routes.js'
import { resolveAdapterInstallPost } from './adapterInstallRoutes.js'
import { handlePostUserRoutes } from './serverUserRoutes.js'
import { resolveInstructionMutation } from './instructionRoutes.js'
import type { AdapterInstallManager } from './adapterInstall.js'

type WorkflowRootCheck =
  | { ok: true; anchor: WorkflowRootAnchor }
  | { ok: false; code: 403 | 404; error: string }

export interface PostRouteDeps {
  isLocalHost: (host: string | undefined, port: number) => boolean
  boundPort: () => number
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
  token: string
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
  routerPatternScorer: RouterPatternScorer
  workflowRootForRequest: (root: string) => WorkflowRootCheck
  workflowStoreForRequest: (root: string) => { ok: true; anchor: WorkflowRootAnchor; global: boolean } | { ok: false; code: 403 | 404; error: string }
  trackValidationContextFor: (anchor: WorkflowRootAnchor) => TrackValidationContext
  executeOperation: (res: ServerResponse, root: string, args: readonly string[]) => Promise<void>
  operationRunner: PipelineCliRunner
  operationsAvailable: boolean
  isRegisteredRoot: (root: string) => boolean
  store: StateStore
  clock: () => string
  history: HistoryWriter
  workflowRootAnchors: Map<string, WorkflowRootAnchor>
  trackSkillProfiles: ReadonlySet<string>
  loadedManifest?: ExtendedManifestData
  runRepo: WorkflowRunRepository
  /** Transition chain reader used by the decision projection preflight. */
  recordStore?: TransitionRecordStore
  flow: FlowEngine
  fileExists: (root: string, relPath: string) => boolean
  gitHeadSha?: (cwd: string) => Promise<string>
  workspaceFingerprint?: (cwd: string, changeName: string) => Promise<string>
  breadcrumb: Parameters<typeof performTransition>[0]['breadcrumb']
  manifestPath?: string
  paths: ServerPaths
  validateLoopActivation?: LoopActivationValidator
  mutateTrackForApi: (
    anchor: WorkflowRootAnchor,
    revision: string,
    mutate: (snapshot: { config: Parameters<typeof createTrack>[0] }) => Promise<{
      next: Parameters<typeof createTrack>[0]
      result: undefined
    }>,
  ) => Promise<{ registry: TrackRegistry }>
  trackRegistryBody: (registry: TrackRegistry) => Record<string, unknown>
  sendTrackError: (res: ServerResponse, error: unknown) => void
  errMsg: (error: unknown) => string
  realGraduationFs: GraduationFs
  relatedSessionSearch: RelatedSessionSearchExecutor
  /** Canonical v2 orchestration ledger; omitted by legacy embedders. */
  orchestrationV2?: OrchestrationV2RouteDeps
  adapterInstall?: AdapterInstallManager
  /** Declared identity for a request root (`''` = aggregate view). */
  resolveUser: import('./serverUserRoutes.js').ResolveUser
}

export async function handlePostRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: PostRouteDeps,
): Promise<void> {
  const {
    isLocalHost, sendJson, token, readJsonBody, routerPatternScorer, workflowRootForRequest,
    trackValidationContextFor, executeOperation, operationRunner, operationsAvailable,
    isRegisteredRoot, store, clock, history, workflowRootAnchors, trackSkillProfiles,
    loadedManifest, runRepo, flow, fileExists, gitHeadSha, workspaceFingerprint, breadcrumb,
    manifestPath, paths, validateLoopActivation, mutateTrackForApi, trackRegistryBody,
    sendTrackError, errMsg, adapterInstall,
  } = deps
  const boundPort = deps.boundPort()
  const REAL_GRADUATION_FS = deps.realGraduationFs

  function isWorkflowName(name: string): boolean {
    return name !== '' && /^[\p{L}\p{N}\p{M}_-]+$/u.test(name)
  }
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
    const instructionPost = resolveInstructionMutation(req, 'POST', path, deps)
    if (instructionPost) { const result = await instructionPost; return sendJson(res, result.status, result.body) }

    // ── Track Router 公共预览：消费 effective registry，生产默认 scorer 真执行 grep -ciE。──
    // 虽然不写盘，仍走 POST：prompt 可能较长且携带用户意图，不放 URL/query；统一受 token、Host、
    // JSON 三闸保护。响应保留全部候选分数，suppressed_reason 非空时 winner=null，显式创建 UI 仍可手选。
  await handlePostOperationsRoutes(req, res, path, deps)
  if (res.writableEnded) return
  await handlePostChangesRoutes(req, res, path, deps)
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
