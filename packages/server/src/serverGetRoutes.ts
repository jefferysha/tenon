import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstatSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_WORKFLOW_SOURCE,
  builtinWorkflow,
  listAutomationPolicyTemplates,
  materializeWorkflowIo,
  selectTrackBranch,
  parseWorkflow,
  loadTrackRegistry,
  validateWorkflowTrackReferences,
  isDefaultWorkflowName,
  withTrackRegistryLock,
  type StateStore,
  type TrackRegistry,
  type TrackValidationContext,
  type TransitionRecordStore,
} from '@tenon/kernel'
import { buildAfkLog, buildAfkSnapshot, readAfkRunLog } from './afk.js'
import { buildAfkReadiness } from './afkReadiness.js'
import { readAutomationSettings } from './automationConfig.js'
import type { CadenceScheduler } from './cadence.js'
import { readConfigSnapshot } from './config.js'
import { listDockerImages } from './dockerImages.js'
import { HOOK_METAS, readHooksConfig } from './hooksConfig.js'
import { buildLoopsSnapshot } from './loops.js'
import { buildRunDetail } from './runDetail.js'
import { buildSecretsResponse } from './secrets.js'
import { resolveSkillsGet } from './serverGetSkillsRoutes.js'
import { dedupeRoots, type SnapshotDeps } from './snapshot.js'
import { readChangeHistory } from './transition.js'
import type { DashboardServerOptions, ServerPaths } from './types.js'
import {
  assertWorkflowRootAnchor,
  ensureWorkflowProjectCoordinationPath,
  listWorkflowNames,
  readWorkflowForApi,
  WorkflowNotFoundError,
  type WorkflowRootAnchor,
  workflowBranchesForApi,
} from './workflows.js'
import { handleGetActivityRoutes } from './serverGetActivityRoutes.js'
import { handleGetSessionRoutes } from './serverGetSessionRoutes.js'
import { handleGetTraceRoutes } from './serverGetTraceRoutes.js'
import type { TraceStoreReader } from './traces.js'
import { resolveHostTargetPlanRoute } from './serverGetHostTargetPlanRoutes.js'
import { resolveDocumentReadRoute } from './serverGetDocumentRoutes.js'
import { handleTestGetRoutes } from './serverGetTestRoutes.js'
import { resolveWorkflowYamlGet } from './serverWorkflowYamlRoutes.js'
import { resolveInstructionGet } from './instructionRoutes.js'
import { resolveDefinitionCatalogRoute, type DefinitionCatalogRouteDeps } from './definitionCatalogRoutes.js'
import { resolveAdapterInstallGet } from './adapterInstallRoutes.js'
import type { AdapterInstallManager } from './adapterInstall.js'
import { resolveOrchestrationRoutes } from './serverOrchestrationRoutes.js'
import { handleOrchestrationV2GetRoute, type OrchestrationV2RouteDeps } from './serverOrchestrationV2Routes.js'
import { readAnchoredChange, readAnchoredTaskPlan, resolveTaskPlanRoute } from './serverTaskPlanRoutes.js'
import { readTaskRunForChange, resolveTaskRunRoute } from './serverTaskRunRoutes.js'
import {
  readAnchoredSkillInvocationEvidence,
  resolveSkillInvocationRoute,
} from './serverSkillInvocationRoutes.js'
import { handleGetDecisionRoute } from './serverGetDecisionRoutes.js'
import { handleTaskLifecycleGet, type TaskLifecycleRouteDeps } from './serverTaskLifecycleRoutes.js'
type WorkflowStoreCheck =
  | { ok: true; anchor: WorkflowRootAnchor; global: boolean }
  | { ok: false; code: 403 | 404; error: string }
type WorkflowRootCheck =
  | { ok: true; anchor: WorkflowRootAnchor }
  | { ok: false; code: 403 | 404; error: string }
export interface GetRouteDeps {
  cadenceScheduler: CadenceScheduler | null
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
  sendHtml: (res: ServerResponse, code: number, body: string) => void
  serveIndexWithToken: (res: ServerResponse) => boolean
  serveAsset: (req: IncomingMessage, res: ServerResponse, path: string) => boolean
  indexHtml: (token: string) => string
  token: string
  version: string
  releaseId?: string
  transactionId?: string
  stateScopeId: string
  isLocalHost: (host: string | undefined, port: number) => boolean
  boundPort: () => number
  snapshotDeps: (nowMs?: number) => SnapshotDeps
  handleStream: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  isRegisteredRoot: (root: string) => boolean
  clock: () => string
  store: StateStore
  recordStore: TransitionRecordStore
  loopLedger: Parameters<typeof buildRunDetail>[3]['ledger']
  registry: () => string[]
  traceStore?: TraceStoreReader
  workflowRootForRequest: (root: string) => WorkflowRootCheck
  workflowStoreForRequest: (root: string) => WorkflowStoreCheck
  trackValidationContextFor: (anchor: WorkflowRootAnchor) => TrackValidationContext
  trackRegistryBody: (registry: TrackRegistry) => Record<string, unknown>
  manifestPath?: string
  paths: ServerPaths
  hostHome: string; operationsAvailable: boolean; hostTargetPlanRuntime: import('./serverGetHostTargetPlanRoutes.js').HostTargetPlanRuntime
  options: DashboardServerOptions; operationRunner: import('./operations.js').PipelineCliRunner
  resolveSessionLink: (root: string, name: string) => Promise<Record<string, unknown>>
  errMsg: (error: unknown) => string
  orchestrationV2?: OrchestrationV2RouteDeps
  definitionCatalog?: Omit<DefinitionCatalogRouteDeps, 'sendJson'>
  adapterInstall?: AdapterInstallManager
  resolveUser: import('./serverUserRoutes.js').ResolveUser
  /** 删除 / 归档 / 取消归档 的共享 application；未装配时这三条路由不存在（不谎报）。 */
  taskLifecycle?: TaskLifecycleRouteDeps
}
function repoRootForSkills(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}
function isWorkflowName(name: string): boolean {
  return name !== '' && /^[\p{L}\p{N}\p{M}_-]+$/u.test(name)
}
export async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: GetRouteDeps,
): Promise<void> {
  const {
    cadenceScheduler, sendJson, sendHtml, serveIndexWithToken, serveAsset, indexHtml, token,
    version, releaseId, transactionId, stateScopeId, isLocalHost, snapshotDeps, handleStream, isRegisteredRoot,
    clock, store, recordStore, loopLedger, registry, traceStore, workflowRootForRequest, workflowStoreForRequest,
    trackValidationContextFor, trackRegistryBody, manifestPath, paths, hostHome, operationsAvailable,
    hostTargetPlanRuntime, options, operationRunner, resolveSessionLink, errMsg, orchestrationV2, definitionCatalog, adapterInstall,
  } = deps
  const boundPort = deps.boundPort()
  if (orchestrationV2) {
    const handled = await handleOrchestrationV2GetRoute(req, res, path, {
      ...orchestrationV2,
      sendJson,
      token,
      isLocalHost,
      boundPort: () => boundPort,
    })
    if (handled) return
  }
  if (definitionCatalog) {
    const handled = await resolveDefinitionCatalogRoute(req, res, path, { ...definitionCatalog, sendJson })
    if (handled) return
  }
  if (adapterInstall && (path.startsWith('/api/adapters/install/'))) {
    const handled = await resolveAdapterInstallGet(req, res, path, { manager: adapterInstall, workflowRootForRequest, sendJson })
    if (handled) return
  }
  await handleGetActivityRoutes(req, res, path, deps)
  if (res.headersSent) return
  if (await handleGetDecisionRoute(req, res, path, { sendJson, store, recordStore, workflowRootForRequest })) return
  if (await handleTaskLifecycleGet(req, res, path, deps)) return
  if (handleGetTraceRoutes(req, res, path, { clock, sendJson, traceStore })) return
  const hostPlan = await resolveHostTargetPlanRoute(req.url ?? '/', path, { hostHome, operationsAvailable, operationRunner, runtime: hostTargetPlanRuntime })
  if (hostPlan !== null) return sendJson(res, hostPlan.status, hostPlan.body)
  const orchestration = await resolveOrchestrationRoutes(req.url ?? '/', path, {
    workflowRootForRequest, snapshotDeps, store,
  })
  if (orchestration !== null) return sendJson(res, orchestration.status, orchestration.body)
  const taskPlan = await resolveTaskPlanRoute(req.url ?? '/', path, {
    workflowRootForRequest,
    readPlan: readAnchoredTaskPlan,
  })
  if (taskPlan !== null) return sendJson(res, taskPlan.status, taskPlan.body)
  const taskRun = await resolveTaskRunRoute(req.url ?? '/', path, {
    workflowRootForRequest,
    readRun: (anchor, change) => readAnchoredChange(anchor, change, readTaskRunForChange),
  })
  if (taskRun !== null) return sendJson(res, taskRun.status, taskRun.body)
  const skillInvocations = await resolveSkillInvocationRoute(req.url ?? '/', path, {
    workflowRootForRequest,
    readEvidence: readAnchoredSkillInvocationEvidence,
  })
  if (skillInvocations !== null) return sendJson(res, skillInvocations.status, skillInvocations.body)
    const documentRead = resolveDocumentReadRoute(req, path, { workflowRootForRequest, errMsg })
    if (documentRead !== null) return sendJson(res, documentRead.status, documentRead.body)
    if (await handleTestGetRoutes(req, res, path, {
      workflowRootForRequest, sendJson, configRoot: paths.configRoot,
    })) return
    if (path === '/api/loops/snapshot') {
      try {
        const snap = await buildLoopsSnapshot({ registry: () => dedupeRoots(registry()), now: () => new Date(clock()) })
        return sendJson(res, 200, snap)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    if (path === '/api/tracks') {
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        assertWorkflowRootAnchor(rootCheck.anchor)
        let pipelineExists = true
        try { lstatSync(join(rootCheck.anchor.path, '.pipeline')) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') pipelineExists = false
          else throw error
        }
        if (pipelineExists) ensureWorkflowProjectCoordinationPath(rootCheck.anchor)
        const trackRegistry = loadTrackRegistry(rootCheck.anchor.path, trackValidationContextFor(rootCheck.anchor))
        assertWorkflowRootAnchor(rootCheck.anchor)
        return sendJson(res, 200, trackRegistryBody(trackRegistry))
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: errMsg(error) })
      }
    }
    if (path === '/api/config') {
      if (!manifestPath) return sendJson(res, 404, { ok: false, error: 'config 数据端未装（capabilities.config=false）' })
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      if (root === '') return sendJson(res, 400, { ok: false, error: '缺少 root 参数' })
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        assertWorkflowRootAnchor(rootCheck.anchor)
        let pipelineExists = true
        try {
          lstatSync(join(rootCheck.anchor.path, '.pipeline'))
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') pipelineExists = false
          else throw e
        }
        if (pipelineExists) ensureWorkflowProjectCoordinationPath(rootCheck.anchor)
        const snapshot = readConfigSnapshot({
          manifestPath,
          repoRoot: rootCheck.anchor.path,
          trackValidationContext: trackValidationContextFor(rootCheck.anchor),
          generatedAt: clock(),
        })
        assertWorkflowRootAnchor(rootCheck.anchor)
        return sendJson(res, 200, snapshot)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    if (resolveSkillsGet(req, res, path, { hostHome, repoRoot: repoRootForSkills(), stateRoot: paths.stateRoot, sendJson, errMsg })) return
    if (path === '/api/hooks') {
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        const { matrix, promptSkipKeyword } = readHooksConfig(rootCheck.anchor)
        return sendJson(res, 200, { ok: true, hooks: HOOK_METAS, matrix, prompt_skip_keyword: promptSkipKeyword })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    if (path === '/api/automation') {
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      try {
        return sendJson(res, 200, { ok: true, settings: readAutomationSettings(root) })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    const instructionGet = resolveInstructionGet(req, path, deps); if (instructionGet) { const result = await instructionGet; return sendJson(res, result.status, result.body) }
    if (path === '/api/workflows') {
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      const rootCheck = workflowStoreForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        const files = listWorkflowNames(rootCheck.anchor)
        return sendJson(res, 200, {
          names: files.filter((name) => !isDefaultWorkflowName(name)),
          default: { source: files.includes('default') ? (rootCheck.global ? 'global' : 'project') : 'builtin' },
        })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    const yamlGet = resolveWorkflowYamlGet(req, path, { workflowRootForRequest: workflowStoreForRequest, errMsg })
    if (yamlGet !== null) {
      if (yamlGet.kind === 'json') return sendJson(res, yamlGet.status, yamlGet.body)
      const bytes = Buffer.from(yamlGet.text, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' })
      res.end(bytes)
      return
    }
    const mWfGet = /^\/api\/workflows\/([^/]+)$/.exec(path)
    if (mWfGet) {
      const segment = mWfGet[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 workflow 路径' })
      const wfName = decodeURIComponent(segment)
      if (!isWorkflowName(wfName)) {
        return sendJson(res, 400, { ok: false, error: '非法 workflow 名（允许中文、字母、数字、- 与 _；不允许空格、点或路径符号）' })
      }
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      let rootCheck = workflowStoreForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      const builtin = builtinWorkflow(wfName)
      if (builtin !== null) {
        return sendJson(res, 200, { ...builtin, source: 'builtin', effectiveIo: materializeWorkflowIo(selectTrackBranch(builtin, undefined)), branches: workflowBranchesForApi(builtin) })
      }
      try {
        try {
          readWorkflowForApi(rootCheck.anchor, wfName)
        } catch (e) {
          if (!(e instanceof WorkflowNotFoundError) || rootCheck.global) throw e
          const globalCheck = workflowStoreForRequest('')
          if (!globalCheck.ok) throw e
          readWorkflowForApi(globalCheck.anchor, wfName)
          rootCheck = globalCheck
        }
        ensureWorkflowProjectCoordinationPath(rootCheck.anchor)
      } catch (e) {
        if (e instanceof WorkflowNotFoundError && isDefaultWorkflowName(wfName)) {
          const template = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
          return sendJson(res, 200, { ...template, source: 'builtin', effectiveIo: materializeWorkflowIo(selectTrackBranch(template, undefined)), branches: workflowBranchesForApi(template) })
        }
        return sendJson(res, e instanceof WorkflowNotFoundError ? 404 : 500, { ok: false, error: errMsg(e) })
      }
      try {
        const checked = await withTrackRegistryLock(
          rootCheck.anchor.path,
          trackValidationContextFor(rootCheck.anchor),
          async ({ registry }) => {
            assertWorkflowRootAnchor(rootCheck.anchor)
            const workflow = readWorkflowForApi(rootCheck.anchor, wfName)
            return { workflow, errors: validateWorkflowTrackReferences(workflow, registry) }
          },
        )
        if (checked.errors.length > 0) {
          return sendJson(res, 409, {
            ok: false,
            code: 'WORKFLOW_TRACK_REFERENCES_INVALID',
            workflow: wfName,
            errors: checked.errors,
          })
        }
        return sendJson(res, 200, { ...checked.workflow, source: rootCheck.global ? 'global' : 'project', effectiveIo: materializeWorkflowIo(selectTrackBranch(checked.workflow, undefined)), branches: workflowBranchesForApi(checked.workflow) })
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) return sendJson(res, 404, { ok: false, error: errMsg(e) })
        return sendJson(res, 409, {
          ok: false,
          code: 'WORKFLOW_REFERENCE_CONTEXT_DEGRADED',
          workflow: wfName,
          errors: [errMsg(e)],
        })
      }
    }
    if (path === '/api/secrets') {
      try {
        return sendJson(res, 200, buildSecretsResponse(paths.secretsPath))
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    if (path === '/api/docker/images') {
      const r = await listDockerImages(options.execDocker)
      return sendJson(res, 200, { ok: true, ...r })
    }
    if (path === '/api/afk/readiness') {
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      if (root === '') return sendJson(res, 400, { ok: false, error: '缺少 root 参数' })
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const image = readAutomationSettings(root).image || 'sandcastle:local'
      const r = await buildAfkReadiness({
        image,
        secretsPath: paths.secretsPath,
        exec: options.execDocker,
        defaultCodexHome: join(hostHome, '.codex'),
      })
      return sendJson(res, 200, r)
    }
    if (await handleGetSessionRoutes(req, res, path, {
      sendJson, isRegisteredRoot, resolveSessionLink,
    })) return
    return sendJson(res, 404, { ok: false, error: '未知端点' })
  }
