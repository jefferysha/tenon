import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstatSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_WORKFLOW_SOURCE,
  builtinWorkflow,
  listAutomationPolicyTemplates,
  materializeWorkflowIo,
  parseWorkflow,
  loadTrackRegistry,
  validateWorkflowTrackReferences,
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
import { listAllSkillsDetailed } from './skillsRegistry.js'
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
} from './workflows.js'
import { handleGetActivityRoutes } from './serverGetActivityRoutes.js'
import { handleGetSessionRoutes } from './serverGetSessionRoutes.js'
import { handleGetTraceRoutes } from './serverGetTraceRoutes.js'
import type { TraceStoreReader } from './traces.js'
import { resolveHostTargetPlanRoute } from './serverGetHostTargetPlanRoutes.js'
import { resolveDocumentReadRoute } from './serverGetDocumentRoutes.js'
import { resolveWorkflowYamlGet } from './serverWorkflowYamlRoutes.js'
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
  trackValidationContextFor: (anchor: WorkflowRootAnchor) => TrackValidationContext
  trackRegistryBody: (registry: TrackRegistry) => Record<string, unknown>
  manifestPath?: string
  paths: ServerPaths
  hostHome: string; operationsAvailable: boolean; hostTargetPlanRuntime: import('./serverGetHostTargetPlanRoutes.js').HostTargetPlanRuntime
  options: DashboardServerOptions; operationRunner: import('./operations.js').PipelineCliRunner
  resolveSessionLink: (root: string, name: string) => Promise<Record<string, unknown>>
  errMsg: (error: unknown) => string
  /** Canonical v2 orchestration ledger; omitted by legacy embedders. */
  orchestrationV2?: OrchestrationV2RouteDeps
  /** Unified workflow/track/pipeline/adapter projection and realtime stream. */
  definitionCatalog?: Omit<DefinitionCatalogRouteDeps, 'sendJson'>
  adapterInstall?: AdapterInstallManager
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
    clock, store, recordStore, loopLedger, registry, traceStore, workflowRootForRequest,
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
    // ── 工作台「文件阅读」：只读取已登记项目根内的文本文件（readTrustedFile，256KB 上限）──
    const documentRead = resolveDocumentReadRoute(req, path, { workflowRootForRequest, errMsg })
    if (documentRead !== null) return sendJson(res, documentRead.status, documentRead.body)
    // ── loops 治理面数据端：跨项目聚合 loops.yaml ──
    if (path === '/api/loops/snapshot') {
      try {
        const snap = await buildLoopsSnapshot({ registry: () => dedupeRoots(registry()), now: () => new Date(clock()) })
        return sendJson(res, 200, snap)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    // ── v3 Studio Track Registry：独立只读端点，不依赖 manifest/config capability。──
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
    // ── G3/T-R5 config 数据端：manifest 强制 skill 表 + 项目 effective Track Registry。──
    if (path === '/api/config') {
      if (!manifestPath) return sendJson(res, 404, { ok: false, error: 'config 数据端未装（capabilities.config=false）' })
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      if (root === '') return sendJson(res, 400, { ok: false, error: '缺少 root 参数' })
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        assertWorkflowRootAnchor(rootCheck.anchor)
        // 缺 `.pipeline` 是 builtin-only 的合法纯读路径，不能为 GET 凭空创建目录；目录一旦存在，
        // 则先复用 G6 的 O_NOFOLLOW/inode 校验，拒绝 `.pipeline` 或 tracks.yaml 外部 symlink。
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
    // ── skills registry 数据端：本仓 skills 目录 + EXTERNAL-SKILLS.md 合并明细（GET 只读，本机回环不鉴权）。
    //    T6：响应体从 {skills:string[]} 破坏性升级为 {skills:SkillEntry[]}（研究报告 §4.2 方案 a，
    //    仓内两个消费方同批改，无仓外第三方）；「已装」三源检测只按显式 hostHome（hermetic 可覆盖）。──
    if (path === '/api/skills/registry') {
      try {
        return sendJson(res, 200, { skills: listAllSkillsDetailed(repoRootForSkills(), join(hostHome, '.claude')) })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    // ── v5 T5（决议#2）：GET /api/hooks —— hook 元数据 + 阶段×hook 开关矩阵 ──
    //    数据源 <root>/.pipeline/hooks.json（只存禁用项；缺文件/损坏 → 空矩阵 = 缺省全启用，
    //    fail-open，见 hooksConfig.ts 头注释）。root 信任锚同 /api/workflows；读端点对齐
    //    /api/config、/api/skills/registry：本机回环 GET 不鉴权。
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
    // ── T21：GET /api/automation —— AFK 执行参数（.pipeline/automation.json）──
    //    缺文件/损坏 → 全默认（fail-open，见 automationConfig.ts 头注释）。root 信任锚 +
    //    本机回环 GET 不鉴权，全部对齐 /api/hooks 先例。
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
    // ── workflow 编辑器（GOAL E8）：GET /api/workflows —— 列出自定义 workflow；default 恒在，标出来源 ──
    if (path === '/api/workflows') {
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        const files = listWorkflowNames(rootCheck.anchor)
        return sendJson(res, 200, {
          names: files.filter((name) => name !== 'default'),
          default: { source: files.includes('default') ? 'project' : 'builtin' },
        })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }

    // ── GET /api/workflows/:name/yaml —— 导出原文（自定义 / default 覆盖 / 内建模板）──
    const yamlGet = resolveWorkflowYamlGet(req, path, { workflowRootForRequest, errMsg })
    if (yamlGet !== null) {
      if (yamlGet.kind === 'json') return sendJson(res, yamlGet.status, yamlGet.body)
      const bytes = Buffer.from(yamlGet.text, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' })
      res.end(bytes)
      return
    }

    // ── workflow 编辑器（GOAL E8）：GET /api/workflows/:name —— 读单个 workflow ──
    // 校验顺序同 /api/afk/<name>/log、/api/afk/<name>/cancel、/api/afk/<name>/retry：
    // 先 name 格式（防路径穿越：拒 '..' 等非法段落入安全读取层的 child lookup），
    // 再 root 信任锚，最后真读+解析。
    const mWfGet = /^\/api\/workflows\/([^/]+)$/.exec(path)
    if (mWfGet) {
      const segment = mWfGet[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 workflow 路径' })
      const wfName = decodeURIComponent(segment)
      if (!isWorkflowName(wfName)) {
        return sendJson(res, 400, { ok: false, error: '非法 workflow 名（允许中文、字母、数字、- 与 _；不允许空格、点或路径符号）' })
      }
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      const builtin = builtinWorkflow(wfName)
      if (builtin !== null) {
        // Built-ins are immutable plugin assets. They are readable by the same client contract as
        // custom workflows, but never resolved from or shadowed by a project file.
        return sendJson(res, 200, { ...builtin, source: 'builtin', effectiveIo: materializeWorkflowIo(builtin) })
      }
      try {
        // 先用 G6 安全读区分真 404/结构损坏；目标存在后才准备 project lock，避免 GET ghost
        // 为纯查询凭空创建 `.pipeline`。
        readWorkflowForApi(rootCheck.anchor, wfName)
        ensureWorkflowProjectCoordinationPath(rootCheck.anchor)
      } catch (e) {
        if (e instanceof WorkflowNotFoundError && wfName === 'default') {
          // default 无项目覆盖 → 内建模板源；有覆盖时走下方同自定义 workflow 的受信读 + track 引用校验。
          const template = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
          return sendJson(res, 200, { ...template, source: 'builtin', effectiveIo: materializeWorkflowIo(template) })
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
        return sendJson(res, 200, { ...checked.workflow, source: 'project', effectiveIo: materializeWorkflowIo(checked.workflow) })
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) return sendJson(res, 404, { ok: false, error: errMsg(e) })
        // registry 本身损坏/引用缺失同样不能把 workflow 伪装成健康 200；显式 degraded 409。
        return sendJson(res, 409, {
          ok: false,
          code: 'WORKFLOW_REFERENCE_CONTEXT_DEGRADED',
          workflow: wfName,
          errors: [errMsg(e)],
        })
      }
    }
    // ── v6 T1：GET /api/secrets —— 机器级凭证存储只读探测（掩码，永不回明文）──
    //    不要求 root（机器级资源，与 GET /api/skills/registry、B 节 GET /api/docker/images
    //    同类「无信任锚分支」的端点，proposal C.3 明确本端点无 root 概念）；不要求 token
    //    （维持 GET 惯例，同 B.2 判断）；Host 头 DNS 重绑定守卫已由 handleGet 顶部统一施加
    //    （本端点碰凭证子系统本就该有，proposal 决策点 C.3——现在全部只读 GET 都有了）。
    if (path === '/api/secrets') {
      try {
        return sendJson(res, 200, buildSecretsResponse(paths.secretsPath))
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    // ── v6 T3：GET /api/docker/images —— 本机 docker 镜像列表（repo:tag，过滤悬空）。──
    //    无 root 概念（单机资源，同 /api/secrets 一类）；不要求 token（Host 头 DNS 重绑定守卫
    //    已由 handleGet 顶部统一施加，决策 B.2）。docker 不可用/超时(5s) → 200 + available:false
    //    （ok 恒 true——「没装 docker」是常态不是 HTTP 错误，前端据此降级纯文本框，B.1/B.3）。
    if (path === '/api/docker/images') {
      const r = await listDockerImages(options.execDocker)
      return sendJson(res, 200, { ok: true, ...r })
    }
    // ── v6 T4：GET /api/afk/readiness?root= —— AFK 就绪三灯(docker/镜像/凭证)。──
    //    root 必填(镜像检查要读该 root 的 automation.json;显式缺失 400,未注册 404 信任锚);
    //    Host 头 DNS 重绑定守卫已由 handleGet 顶部统一施加;「没装/没建/没配」是常态不是错误
    //    → 恒 200,永不回凭证值(D.1 契约,与 /api/secrets 同条红线)。
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
