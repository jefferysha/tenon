/** Global loopback dashboard server assembly; bounded route handlers live in sibling modules. */
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join, join as joinPath, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createBreadcrumbWriter, createFlowEngine, createHistoryWriter, createLoopLedgerStore, createStateStore, machineStateScopeId,
  createTransitionRecordStore, createWorkflowRunRepository, loadManifest, knownSkillProfiles,
  createOrchestrationLedger,
} from '@tenon/kernel'
import { artifactNamespaceForChange, createProductionExecutionRuntimeV2, openArtifactService, type ArtifactService } from '@tenon/automation'
import type { FreezeWorkflowInputV2 } from './serverOrchestrationV2Routes.js'
import type { ExtendedManifestData, FlowEngine, StateStore } from '@tenon/kernel'
import { type LoopActivationValidator } from './loops.js'
import {
  captureWorkflowRootAnchor, closeWorkflowRootAnchor, type WorkflowRootAnchor,
} from './workflows.js'
import { readRegistry } from './registry.js'
import { dedupeRoots, snapshotDepsFactory } from './snapshot.js'
import { generateToken } from './token.js'
import { hasTraceTimelineReader } from './traces.js'
import {
  pipelineCliAvailable, runPipelineCli,
  type PipelineCliRunner,
} from './operations.js'
import { createCadenceScheduler } from './cadence.js'
import { handleGet as handleGetRoute } from './serverGetRoutes.js'
import { createHostTargetPlanRuntime } from './serverGetHostTargetPlanRoutes.js'
import { handleDeleteRoute, handlePutRoute } from './serverMutationRoutes.js'
import { handlePostRoute } from './serverPostRoutes.js'
import { countProjectDeletions, createTaskLifecycleRouteDeps } from './serverTaskLifecycleRoutes.js'
import {
  assertDashboardTransactionId,
  errMsg,
  indexHtml,
  isoNow,
  isLocalHost,
  REAL_GRADUATION_FS,
} from './serverSupport.js'
import { createFreezeHandlers } from './serverFreezeHandlers.js'
import { createServerTransport } from './serverTransport.js'
import { createAccessControl } from './serverAccess.js'
import { createLoopActivationValidator } from './loopActivationWiring.js'
import { createSessionAuthority } from './serverSession.js'
import { openInBrowser } from './browserOpener.js'
import { createDispatcher } from './serverDispatch.js'
import { createServerGovernance } from './serverGovernance.js'
import { AdapterInstallManager } from './adapterInstall.js'
import { createFolderChooser } from './folderChooser.js'
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
  const folderChooser = options.folderChooser ?? createFolderChooser({ platform: process.platform, env: process.env })
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
  const validateLoopActivation: LoopActivationValidator | undefined = options.validateLoopActivation
    ?? (loadedManifest === undefined
      ? undefined
      : createLoopActivationValidator({
          manifest: loadedManifest,
          hostHome,
          trackSkillProfiles: knownSkillProfiles(loadedManifest),
          resolverForRoot: (root, manifest) => rootSkillResolver(root, manifest),
        }))
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const heartbeatMs = options.heartbeatMs ?? 15000
  const gitHeadSha = options.gitHeadSha
  const workspaceFingerprint = options.workspaceFingerprint
  const resolveUser = options.resolveUser ?? defaultResolveUser
  const traceStore = options.traceStore
  const { memFs, executor: relatedSessionSearch } =
    createRelatedSessionMemoryServices({ hostHome, memFs: options.memFs, runner: options.relatedSessionSearch, now: options.relatedSessionNow })
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
  const capabilities: Record<string, boolean> = {
    afk: true, loops: true, operations: operationsAvailable,
    traffic: traceStore !== undefined && hasTraceTimelineReader(traceStore),
    cadence: cadenceScheduler !== null, orchestration_v2: true,
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

  const taskLifecycle = createTaskLifecycleRouteDeps({
    store, clock, viewer: resolveUser, artifactServices,
    ...(options.runOpenspecArchive === undefined ? {} : { runOpenspecArchive: options.runOpenspecArchive }),
  })
  const snapshotDeps = snapshotDepsFactory({
    registry, store, version, clock, capabilities, gitHeadSha, workspaceFingerprint,
    rootAnchor: (root) => snapshotRootAnchor?.(root),
    artifactServiceForRoot,
    // 未提交删除是仓库事实，按项目读一次。
    countDeletions: (repoRoot) => countProjectDeletions(repoRoot),
    // readiness 与 `tenon status` exits 同一份判定：相位出口规则表 + 与 transition 技能门同源的解析器。
    flow,
    ...(loadedManifest === undefined ? {} : {
      skillResolverFor: (root: string) => rootSkillResolver(root, loadedManifest),
    }),
  })

  const {
    snapshotCache, clients,
    stopPoll,
    sendJson,
    sendHtml,
    readJsonBody,
    handleStream,
    serveIndexWithToken,
    serveAsset,
  } = createServerTransport({
    snapshotDeps,
    heartbeatMs,
    pollIntervalMs,
    webRoot: options.webRoot,
    token,
  })
  const {
    fileExists,
    isRegisteredRoot,
    executeOperation,
    workflowRootAnchors,
    workflowRootForRequest,
    workflowStoreForRequest,
    rootSkillResolver,
  } = createServerGovernance({
    registry,
    globalWorkflowRoot: joinPath(paths.configRoot, 'workflows'),
    sendJson,
    operationsAvailable,
    operationRunner,
  })
  snapshotRootAnchor = (root) => {
    const checked = workflowRootForRequest(root)
    return checked.ok ? checked.anchor : undefined
  }

  let boundPort = 0
  // Sessions live only in this process; the gate runs before any route sees the request.
  const access = createAccessControl({
    authority: createSessionAuthority(), boundPort: () => boundPort, isLocalHost, sendJson, sendHtml,
    openBrowser: options.openBrowser ?? openInBrowser,
  })
  // ── 路由 ──
  const handleGet = (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> =>
    handleGetRoute(req, res, path, {
      cadenceScheduler, sendJson, sendHtml, serveIndexWithToken, serveAsset, indexHtml, token,
      version, releaseId, transactionId, stateScopeId, isLocalHost, boundPort: () => boundPort, snapshotDeps, snapshotCache,
      handleStream, isRegisteredRoot, clock, store, recordStore, loopLedger, registry, traceStore,
      workflowRootForRequest, workflowStoreForRequest, paths,
      hostHome, operationsAvailable, hostTargetPlanRuntime, options, operationRunner, folderChooser,
      resolveSessionLink: (root, name) => resolveSessionLinkForChange(root, name, { store, memFs }), errMsg,
      orchestrationV2: { ledger: orchestrationLedger, workflowRootForRequest, freezePipeline, freezeWorkflow, runChange: (changeDir) => createProductionExecutionRuntimeV2({ change_dir: changeDir, ledger: orchestrationLedger, worker_id: `server:${process.pid}` }).then(runtime => runtime.run()) },
      definitionCatalog: {
        workflowRootForRequest,
        hostHome,
        operationRunner,
        clock,
        pollIntervalMs,
        heartbeatMs,
      },
      adapterInstall,
      resolveUser,
      taskLifecycle,
    })
  const handlePost = (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> =>
    handlePostRoute(req, res, path, {
      isLocalHost, boundPort: () => boundPort, sendJson, token, readJsonBody,
      workflowRootForRequest, workflowStoreForRequest, executeOperation, operationRunner,
      operationsAvailable, isRegisteredRoot, store, recordStore, clock, history, workflowRootAnchors,
      loadedManifest, runRepo, flow, fileExists, gitHeadSha,
      workspaceFingerprint, breadcrumb, paths, validateLoopActivation, errMsg,
      realGraduationFs: REAL_GRADUATION_FS,
      relatedSessionSearch, folderChooser, runGit: options.projectCreateGit, designSeedFetch: options.designSeedFetch,
      resolveUser,
      taskLifecycle,
      presence: access.presence,
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
    paths,
    workflowRootAnchors,
    errMsg,
    resolveUser,
    taskLifecycle,
  }
  const handleDelete = (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> =>
    handleDeleteRoute(req, res, path, mutationRouteDeps)
  const handlePut = (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> =>
    handlePutRoute(req, res, path, mutationRouteDeps)
  const dispatch = createDispatcher({
    routes: new Map([['GET', handleGet], ['POST', handlePost], ['DELETE', handleDelete], ['PUT', handlePut]]),
    snapshotCache, sendJson, errMsg,
  })
  const httpServer: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/'
    const method = req.method ?? 'GET'
    access.handle(req, res, path, method).then((handled) => {
      if (!handled) dispatch(req, res, path, method)
    }).catch((e) => {
      try { sendJson(res, 500, { ok: false, error: errMsg(e) }) } catch { /* 已写头 */ }
    })
  })

  return {
    token,
    version,
    httpServer,
    issueLoginUrl: access.issueLoginUrl,
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
