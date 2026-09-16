/** Global loopback dashboard server assembly; bounded route handlers live in sibling modules. */
import { join as joinPath } from 'node:path'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  builtinWorkflow,
  ABSENT_REGISTRY_EPOCH, applyLevelChange, assertTrackDeletable, assertUpdatePreservesReferences, assertWorkflowAllowed,
  BUILTIN_TRACK_DEFINITIONS, BuiltinTrackDeleteError, BuiltinTrackPolicyError, ChangeScanFailedError, createBreadcrumbWriter, createFlowEngine,
  decodeWorkflowDef, createEffectiveSkillResolver, createHistoryWriter, createLoopLedgerStore, createStateStore, machineStateScopeId,
  createTrack, createTransitionRecordStore, createWorkflowRunRepository, deleteTrack, firstStep, loadManifest,
  listAutomationPolicyTemplates, loadRegistry, loadTrackRegistry, loadWorkflow, mutateTrackRegistry, readRegistrySnapshot, RegistryRevisionConflictError,
  requireTrack, TrackAlreadyExistsError, TrackNotFoundError, TrackReferencedError, TrackReferencesInvalidatedError, updateTrack,
  validateWorkflow,
  stateStorageExistsSync, validateWorkflowTrackReferences, withRegistryGovernanceLock, withTrackRegistryLock,
  writeRegistryWithGovernance,
  createOrchestrationLedger,
} from '@tenon/kernel'
import { artifactNamespaceForChange, createRunnerSkillContentLocator, createProductionExecutionRuntimeV2, evaluateLoopExecutionWiring, openArtifactService, type ArtifactService } from '@tenon/automation'
import type { FreezeWorkflowInputV2 } from './serverOrchestrationV2Routes.js'
import type {
  ChangeRefScan, CreateTrackSpec, ExtendedManifestData, FlowEngine, GraduationFs, StateStore, TrackDefinition,
  ProjectTrackConfig, TrackRegistry, TrackValidationContext, UpdateTrackPatch, WorkflowDef,
} from '@tenon/kernel'
import { buildAfkLog, buildAfkSnapshot, cancelAfkRun, dismissAfkRun, enqueueAfkRun, readAfkRunLog, retryAfkRun } from './afk.js'
import { applyLoopsUpdate, buildLoopsSnapshot, type LoopActivationValidator } from './loops.js'
import { readConfigSnapshot, validateMandatorySkillsBody, writeMandatorySkills } from './config.js'
import { readAutomationSettings, validateAutomationSettingsBody, writeAutomationSettings } from './automationConfig.js'
import { HOOK_METAS, readHooksMatrix, validateHookToggleBody, writeHookToggle } from './hooksConfig.js'
import { addProjectToRegistry, removeProjectFromRegistry } from './projects.js'
import {
  assertWorkflowRootAnchor, captureWorkflowDeletePermit, captureWorkflowRootAnchor, closeWorkflowRootAnchor,
  deleteWorkflowForApi, ensureWorkflowGovernanceCoordinationPath, ensureWorkflowProjectCoordinationPath,
  listWorkflowNames, readWorkflowForApi, scanWorkflowReferencesForApi, writeWorkflowForApi,
  WorkflowDeleteConflictError, WorkflowNotFoundError,
  type WorkflowRootAnchor,
} from './workflows.js'
import { readRegistry } from './registry.js'
import { buildSecretsResponse, isValidSecretKey, removeSecret, SECRET_KEY_LIST, validateSecretWriteBody, writeSecret } from './secrets.js'
import { listAllSkillsDetailed } from './skillsRegistry.js'
import { buildSnapshot, computeFingerprint, dedupeRoots, snapshotDepsFactory } from './snapshot.js'
import { generateToken, tokenFromHeaders, tokensMatch } from './token.js'
import { buildAfkReadiness } from './afkReadiness.js'
import { listDockerImages } from './dockerImages.js'
import { hasTraceTimelineReader, listTraceSessions, readTraceRecords } from './traces.js'
import { performTransition, readChangeHistory } from './transition.js'
import { buildRunDetail } from './runDetail.js'
import {
  activateChangeSession, notRequestedSessionActivation, parseChangeSessionActivation,
  parseChangeTaskPrompt, writeChangeTaskPrompt,
} from './changeLaunch.js'
import {
  cliExitHttpStatus, parsePipelineCliJson, pipelineCliAvailable, runPipelineCli,
  type PipelineCliRunner,
} from './operations.js'
import { applyRouterDraft, parseRouterDraft, previewTrackRouting, scoreRouterPatternWithGrep } from './routerPreview.js'
import { createCadenceScheduler } from './cadence.js'
import { handleGet as handleGetRoute } from './serverGetRoutes.js'
import { createHostTargetPlanRuntime } from './serverGetHostTargetPlanRoutes.js'
import { handleDeleteRoute, handlePatchRoute, handlePutRoute } from './serverMutationRoutes.js'
import { handlePostRoute } from './serverPostRoutes.js'
import {
  assertDashboardTransactionId,
  errMsg,
  indexHtml,
  isoNow,
  isLocalHost,
  REAL_GRADUATION_FS,
  repoRootForSkills,
} from './serverSupport.js'
import { createFreezeHandlers } from './serverFreezeHandlers.js'
import { createServerTransport } from './serverTransport.js'
import { createServerGovernance } from './serverGovernance.js'
import { AdapterInstallManager } from './adapterInstall.js'
import type { DashboardServer, DashboardServerOptions } from './types.js'
import { createRelatedSessionMemoryServices } from './relatedSessionMemory.js'
import { resolveSessionLink as resolveSessionLinkForChange } from './sessionLinkResolver.js'
import { SERVER_VERSION } from './version.js'
import { defaultResolveUser } from './serverUserRoutes.js'
const MAX_POST_BODY = 64 * 1024
const WORKFLOW_NAME_RE = /^[\p{L}\p{N}\p{M}_-]+$/u

function isWorkflowName(name: string): boolean {
  return name !== '' && WORKFLOW_NAME_RE.test(name)
}
export { isLocalHost } from './serverSupport.js'

export function createDashboardServer(options: DashboardServerOptions): DashboardServer {
  const version = options.version ?? SERVER_VERSION
  const releaseId = options.releaseId
  const transactionId = options.transactionId
  assertDashboardTransactionId(transactionId)
  const token = options.token ?? generateToken()
  const clock = options.clock ?? isoNow
  const paths = options.paths
  const hostHome = options.hostHome ?? paths.homeDir
  const stateScopeId = machineStateScopeId(paths.stateRoot)
  const registry: () => string[] = options.registry ?? (() => readRegistry(paths.registryPath))
  const store: StateStore = options.store ?? createStateStore()
  const recordStore = createTransitionRecordStore()
  const orchestrationLedger = options.orchestrationLedger ?? createOrchestrationLedger()
  const { freezePipeline, freezeWorkflow } = createFreezeHandlers({ ledger: orchestrationLedger, clock })
  const loopLedger = createLoopLedgerStore()
  const runRepo = createWorkflowRunRepository({ store, recordStore, clock })
  const history = createHistoryWriter()
  const breadcrumb = createBreadcrumbWriter()
  const loadedManifest: ExtendedManifestData | undefined =
    options.manifestPath ? loadManifest(options.manifestPath) : undefined
  const flow: FlowEngine = options.flow
    ?? (loadedManifest
      ? createFlowEngine(loadedManifest)
      : (() => { throw new Error('createDashboardServer: 需注入 flow 或 manifestPath') })())
  // Track Registry 校验用 skill profile 集合（GOAL.md 清单 T · R2）：内建轨 profile（pm/frontend/
  // backend，即 manifest 现行 skill 表 track 键）∪ manifest 两表已声明的非 '_all' 键。仅在项目
  // tracks.yaml 存在且含自定义 track 时被 validateTrackRegistry 查；POST /api/changes 每请求按 root
  // 现载 registry（多项目 server 无单一 root，不能装配处一次性 load）。profile 键空间改名属 R5。
  const trackSkillProfiles: ReadonlySet<string> = (() => {
    const s = new Set<string>()
    for (const t of BUILTIN_TRACK_DEFINITIONS) {
      if (t.policyProfile.skills.profile !== '_all') s.add(t.policyProfile.skills.profile)
    }
    if (loadedManifest) {
      for (const table of [loadedManifest.mandatorySkills, loadedManifest.recommendedSkills]) {
        for (const row of Object.values(table)) {
          for (const k of Object.keys(row)) if (k !== '_all') s.add(k)
        }
      }
    }
    return s
  })()
  const validateLoopActivation: LoopActivationValidator | undefined = options.validateLoopActivation
    ?? (loadedManifest === undefined
      ? undefined
      : async ({ root, loopId, candidate }) => {
          const loop = candidate.loops.find((entry) => entry.id === loopId)
          if (loop === undefined) return { ok: false, error: `候选 registry 中找不到 loop "${loopId}"` }
          const resolver = createEffectiveSkillResolver({
            registry: () => {
              const rootCheck = workflowRootForRequest(root)
              if (!rootCheck.ok) throw new Error(rootCheck.error)
              return loadTrackRegistry(root, trackValidationContextFor(rootCheck.anchor))
            },
            manifest: loadedManifest,
          })
          const wiringForRunner = (runner: string) => ({
            resolver,
            locator: createRunnerSkillContentLocator({
              runner,
              home: hostHome,
              bundledRoot: join(repoRootForSkills(), 'skills'),
            }),
            isSkillProfileKnown: (profileId: string) => profileId === '_all' || trackSkillProfiles.has(profileId),
          })
          const wiring = await evaluateLoopExecutionWiring(loop, candidate.loops, {
            repoRoot: root,
            skillBundleWiring: wiringForRunner(loop.runner),
            skillBundleWiringForLoop: (entry) => wiringForRunner(entry.runner),
          })
          return wiring.status === 'ready'
            ? { ok: true }
            : { ok: false, error: `${wiring.dimension}: ${wiring.reason}` }
        })
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const heartbeatMs = options.heartbeatMs ?? 15000
  const gitHeadSha = options.gitHeadSha
  const workspaceFingerprint = options.workspaceFingerprint
  const resolveUser = options.resolveUser ?? defaultResolveUser
  const traceStore = options.traceStore
  const { memFs, executor: relatedSessionSearch } =
    createRelatedSessionMemoryServices({ hostHome, memFs: options.memFs, runner: options.relatedSessionSearch })
  // config 写端点（M3 可选增量）数据源：manifest.yaml 路径。未注入（如测试只传 flow 而非
  // manifestPath）→ capabilities.config=false，GET/POST config 端点降级 404（不谎报，同 traffic 手法）。
  const manifestPath = options.manifestPath
  // 能力声明（GOAL B6）：afk 数据端始终已接线（读同一 registry+store 的 automation_* 字段）；
  // traffic 仅注入 timeline-capable traceStore 时为真（旧 records-only adapter 不谎报新 UI 能力）；
  // loops 数据端始终已接线（无可选运行时依赖）。#29d / #34d。
  const operationRunner: PipelineCliRunner = options.runPipelineCli ?? runPipelineCli
  const adapterInstall = new AdapterInstallManager(operationRunner, clock)
  const operationsAvailable = options.runPipelineCli !== undefined || pipelineCliAvailable()
  const hostTargetPlanRuntime = createHostTargetPlanRuntime()
  const cadenceScheduler = options.cadence === undefined || options.cadence === false
    ? null
    : createCadenceScheduler({
        ...options.cadence,
        roots: registry,
        clock,
        runPipelineCli: operationRunner,
      })
  const routerPatternScorer = options.scoreRouterPattern ?? scoreRouterPatternWithGrep
  const capabilities: Record<string, boolean> = {
    afk: true, loops: true, operations: operationsAvailable, config: Boolean(manifestPath),
    traffic: traceStore !== undefined && hasTraceTimelineReader(traceStore),
    router_preview: true, cadence: cadenceScheduler !== null, orchestration_v2: true,
  }
  let snapshotRootAnchor: ((root: string) => WorkflowRootAnchor | undefined) | undefined
  const artifactServices = new Map<string, Promise<ArtifactService>>()
  const artifactServiceForRoot = options.artifactServiceForRoot ?? (async (root: string, _anchor: WorkflowRootAnchor): Promise<ArtifactService> => {
    const existing = artifactServices.get(root)
    if (existing) return existing
    const created = openArtifactService({ rootDir: root, scopeId: artifactNamespaceForChange(root) })
    const guarded = created.catch((error: unknown) => {
      if (artifactServices.get(root) === guarded) artifactServices.delete(root)
      throw error
    })
    artifactServices.set(root, guarded)
    return guarded
  })

  const snapshotDeps = snapshotDepsFactory({
    registry, store, version, clock, capabilities, gitHeadSha, workspaceFingerprint,
    rootAnchor: (root) => snapshotRootAnchor?.(root),
    artifactServiceForRoot,
    ...(loadedManifest === undefined ? {} : { mandatorySkills: loadedManifest.mandatorySkills }),
  })

  const {
    clients,
    stopPoll,
    sendJson,
    sendHtml,
    readJsonBody,
    handleStream,
    serveIndexWithToken,
    serveAsset,
  } = createServerTransport({
    registry,
    snapshotDeps,
    heartbeatMs,
    pollIntervalMs,
    webRoot: options.webRoot,
    token,
  })
  const {
    trackRegistryBody,
    scanActiveTrackChanges,
    sendTrackError,
    mutateTrackForApi,
    fileExists,
    isRegisteredRoot,
    executeOperation,
    workflowRootAnchors,
    workflowRootForRequest,
    workflowStoreForRequest,
    trackValidationContextFor,
  } = createServerGovernance({
    registry,
    globalWorkflowRoot: joinPath(paths.configRoot, 'workflows'),
    store,
    sendJson,
    trackSkillProfiles,
    operationsAvailable,
    operationRunner,
  })
  snapshotRootAnchor = (root) => {
    const checked = workflowRootForRequest(root)
    return checked.ok ? checked.anchor : undefined
  }

  let boundPort = 0
  // ── 路由 ──
  const mutateTrackForRoutes = async (
    anchor: WorkflowRootAnchor,
    revision: string,
    mutate: (snapshot: { config: ProjectTrackConfig }) => Promise<{
      next: ProjectTrackConfig
      result: undefined
    }>,
  ): Promise<{ registry: TrackRegistry }> =>
    mutateTrackForApi(anchor, revision, async ({ config }) => mutate({ config }))

  const handleGet = (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> =>
    handleGetRoute(req, res, path, {
      cadenceScheduler, sendJson, sendHtml, serveIndexWithToken, serveAsset, indexHtml, token,
      version, releaseId, transactionId, stateScopeId, isLocalHost, boundPort: () => boundPort, snapshotDeps,
      handleStream, isRegisteredRoot, clock, store, recordStore, loopLedger, registry, traceStore,
      workflowRootForRequest, workflowStoreForRequest, trackValidationContextFor, trackRegistryBody, manifestPath, paths,
      hostHome, operationsAvailable, hostTargetPlanRuntime, options, operationRunner,
      resolveSessionLink: (root, name) => resolveSessionLinkForChange(root, name, { store, memFs }), errMsg,
      orchestrationV2: { ledger: orchestrationLedger, workflowRootForRequest, freezePipeline, freezeWorkflow, runChange: (changeDir) => createProductionExecutionRuntimeV2({ change_dir: changeDir, ledger: orchestrationLedger, worker_id: `server:${process.pid}` }).then(runtime => runtime.run()) },
      definitionCatalog: {
        workflowRootForRequest,
        hostHome,
        operationRunner,
        trackValidationContextFor,
        clock,
        pollIntervalMs,
        heartbeatMs,
      },
      adapterInstall,
      resolveUser,
    })
  const handlePost = (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> =>
    handlePostRoute(req, res, path, {
      isLocalHost, boundPort: () => boundPort, sendJson, token, readJsonBody, routerPatternScorer,
      workflowRootForRequest, workflowStoreForRequest, trackValidationContextFor, executeOperation, operationRunner,
      operationsAvailable, isRegisteredRoot, store, recordStore, clock, history, workflowRootAnchors,
      trackSkillProfiles, loadedManifest, runRepo, flow, fileExists, gitHeadSha,
      workspaceFingerprint, breadcrumb, manifestPath, paths, validateLoopActivation,
      mutateTrackForApi: mutateTrackForRoutes, trackRegistryBody, sendTrackError, errMsg,
      realGraduationFs: REAL_GRADUATION_FS,
      relatedSessionSearch,
      resolveUser,
      orchestrationV2: { ledger: orchestrationLedger, workflowRootForRequest, freezePipeline, freezeWorkflow, runChange: (changeDir) => createProductionExecutionRuntimeV2({ change_dir: changeDir, ledger: orchestrationLedger, worker_id: `server:${process.pid}` }).then(runtime => runtime.run()) },
      adapterInstall,
    })
  const mutationRouteDeps = {
    isLocalHost,
    boundPort: () => boundPort,
    sendJson,
    token,
    readJsonBody,
    workflowRootForRequest,
    workflowStoreForRequest,
    mutateTrackForApi: mutateTrackForRoutes,
    scanActiveTrackChanges,
    trackRegistryBody,
    sendTrackError,
    paths,
    workflowRootAnchors,
    trackValidationContextFor,
    errMsg,
  }
  const handlePatch = (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> =>
    handlePatchRoute(req, res, path, mutationRouteDeps)
  const handleDelete = (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> =>
    handleDeleteRoute(req, res, path, mutationRouteDeps)
  const handlePut = (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> =>
    handlePutRoute(req, res, path, mutationRouteDeps)
  const httpServer: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/'
    const method = req.method ?? 'GET'
    const handler = method === 'GET'
      ? handleGet(req, res, path)
      : method === 'POST'
        ? handlePost(req, res, path)
        : method === 'PATCH'
          ? handlePatch(req, res, path)
          : method === 'DELETE'
            ? handleDelete(req, res, path)
            : method === 'PUT'
              ? handlePut(req, res, path)
              : Promise.resolve(sendJson(res, 405, { ok: false, error: 'method not allowed' }))
    handler.catch((e) => {
      try { sendJson(res, 500, { ok: false, error: errMsg(e) }) } catch { /* 已写头 */ }
    })
  })

  return {
    token,
    version,
    httpServer,
    listen(port = 0, host = '127.0.0.1'): Promise<{ port: number; host: string }> {
      return new Promise((resolve, reject) => {
        const onError = (e: Error): void => reject(e)
        httpServer.once('error', onError)
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', onError)
          const address = httpServer.address()
          if (address === null || typeof address === 'string') {
            reject(new Error('dashboard server 未返回 TCP address'))
            return
          }
          boundPort = address.port
          cadenceScheduler?.start()
          resolve({ port: boundPort, host })
        })
      })
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        stopPoll()
        cadenceScheduler?.stop()
        for (const anchor of workflowRootAnchors.values()) closeWorkflowRootAnchor(anchor)
        workflowRootAnchors.clear()
        for (const res of clients) {
          try { res.end() } catch { /* ignore */ }
        }
        clients.clear()
        httpServer.close(() => resolve())
        const closeAllConnections = Reflect.get(httpServer, 'closeAllConnections')
        if (typeof closeAllConnections === 'function') closeAllConnections.call(httpServer)
      })
    },
  }
}
