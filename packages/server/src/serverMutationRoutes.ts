import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import {
  assertTrackDeletable,
  assertUpdatePreservesReferences,
  deleteTrack,
  updateTrack,
  withRegistryGovernanceLock,
  withTrackRegistryLock,
  type ChangeRefScan,
  type TrackRegistry,
  type TrackValidationContext,
  type UpdateTrackPatch,
  isDefaultWorkflowName,
} from '@tenon/kernel'
import { removeProjectFromRegistry } from './projects.js'
import { isValidSecretKey, removeSecret, SECRET_KEY_LIST } from './secrets.js'
import { tokenFromHeaders, tokensMatch } from './token.js'
import { handleWorkflowYamlPut, matchWorkflowYamlRoute } from './serverWorkflowYamlRoutes.js'
import { resolveInstructionMutation } from './instructionRoutes.js'
import { resolveAgentMutation } from './serverAgentRoutes.js'
import { resolveResourceMutation } from './serverResourceRoutes.js'
import { handleTaskLifecycleDelete, type TaskLifecycleRouteDeps } from './serverTaskLifecycleRoutes.js'
import { handleTestDirectionMutation, TEST_DIRECTION_MAX_BYTES } from './serverTestDirectionRoutes.js'
import { readTextBody } from './serverWorkflowYamlRoutes.js'
import type { ServerPaths } from './types.js'
import {
  assertWorkflowRootAnchor,
  captureWorkflowDeletePermit,
  closeWorkflowRootAnchor,
  deleteWorkflowForApi,
  ensureWorkflowGovernanceCoordinationPath,
  scanWorkflowReferencesForApi,
  WorkflowDeleteConflictError,
  type WorkflowRootAnchor,
} from './workflows.js'

type WorkflowStoreCheck =
  | { ok: true; anchor: WorkflowRootAnchor; global: boolean }
  | { ok: false; code: 403 | 404; error: string }
type WorkflowRootCheck =
  | { ok: true; anchor: WorkflowRootAnchor }
  | { ok: false; code: 403 | 404; error: string }

type TrackMutation = {
  registry: TrackRegistry
}

function isWorkflowName(name: string): boolean {
  return name !== '' && /^[\p{L}\p{N}\p{M}_-]+$/u.test(name)
}

export interface MutationRouteDeps {
  isLocalHost: (host: string | undefined, port: number) => boolean
  boundPort: () => number
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
  token: string
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
  workflowRootForRequest: (root: string) => WorkflowRootCheck
  workflowStoreForRequest: (root: string) => WorkflowStoreCheck
  mutateTrackForApi: (
    anchor: WorkflowRootAnchor,
    revision: string,
    mutate: (snapshot: { config: Parameters<typeof updateTrack>[0] }) => Promise<{
      next: Parameters<typeof updateTrack>[0]
      result: undefined
    }>,
  ) => Promise<TrackMutation>
  scanActiveTrackChanges: (root: string) => Promise<ChangeRefScan>
  trackRegistryBody: (registry: TrackRegistry) => Record<string, unknown>
  sendTrackError: (res: ServerResponse, error: unknown) => void
  paths: ServerPaths
  workflowRootAnchors: Map<string, WorkflowRootAnchor>
  trackValidationContextFor: (anchor: WorkflowRootAnchor) => TrackValidationContext
  errMsg: (error: unknown) => string
  resolveUser: import('./serverUserRoutes.js').ResolveUser
  /** 删除 的共享 application；未装配时该路由不存在（不谎报）。 */
  taskLifecycle?: TaskLifecycleRouteDeps
}

export async function handlePatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: MutationRouteDeps,
): Promise<void> {
  const {
    isLocalHost, sendJson, token, readJsonBody, workflowRootForRequest, workflowStoreForRequest, mutateTrackForApi,
    scanActiveTrackChanges, trackRegistryBody, sendTrackError,
  } = deps
  const boundPort = deps.boundPort()
    if (!isLocalHost(req.headers.host, boundPort)) {
      return sendJson(res, 403, { ok: false, error: 'Host header 不合法（疑似 DNS 重绑定攻击）' })
    }
    const provided = tokenFromHeaders(req.headers)
    if (!provided || !tokensMatch(provided, token)) {
      return sendJson(res, 401, { ok: false, error: '缺少或无效 token（写端点需鉴权）' })
    }
    const ctype = (String(req.headers['content-type'] ?? '').split(';', 1)[0] ?? '').trim().toLowerCase()
    if (ctype !== 'application/json') {
      return sendJson(res, 400, { ok: false, error: '写回端点要求 Content-Type: application/json' })
    }
    const match = /^\/api\/tracks\/([^/]+)$/.exec(path)
    if (!match) return sendJson(res, 404, { ok: false, error: '未知写回端点' })
    const segment = match[1]
    if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 track 路径' })
    const id = decodeURIComponent(segment)
    const rawBody = await readJsonBody(req)
    if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
      return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
    }
    const body = rawBody as Record<string, unknown>
    const root = typeof body.root === 'string' ? body.root : ''
    const revision = typeof body.revision === 'string' ? body.revision : ''
    const patch = body.patch
    if (revision === '' || typeof patch !== 'object' || patch === null || Array.isArray(patch) || Object.keys(patch).length === 0) {
      return sendJson(res, 400, { ok: false, error: 'revision 与非空 patch 对象为必填' })
    }
    const rootCheck = workflowRootForRequest(root)
    if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
    try {
      const mutation = await mutateTrackForApi(rootCheck.anchor, revision, async ({ config }) => {
        const next = updateTrack(config, id, patch as UpdateTrackPatch)
        await assertUpdatePreservesReferences(next, id, () => scanActiveTrackChanges(rootCheck.anchor.path))
        return { next, result: undefined }
      })
      return sendJson(res, 200, trackRegistryBody(mutation.registry))
    } catch (error) {
      return sendTrackError(res, error)
    }
  }

export async function handleDeleteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: MutationRouteDeps,
): Promise<void> {
  const {
    isLocalHost, sendJson, token, workflowRootForRequest, workflowStoreForRequest, mutateTrackForApi, scanActiveTrackChanges,
    trackRegistryBody, sendTrackError, paths, workflowRootAnchors, trackValidationContextFor, errMsg,
  } = deps
  const boundPort = deps.boundPort()
    // (1)(2) 同 handlePost 的 Host 守卫 + token 鉴权，DELETE 无请求体不需要 Content-Type 校验。
    if (!isLocalHost(req.headers.host, boundPort)) {
      return sendJson(res, 403, { ok: false, error: 'Host header 不合法（疑似 DNS 重绑定攻击）' })
    }
    const provided = tokenFromHeaders(req.headers)
    if (!provided || !tokensMatch(provided, token)) {
      return sendJson(res, 401, { ok: false, error: '缺少或无效 token（写端点需鉴权）' })
    }

    const instructionDelete = resolveInstructionMutation(req, 'DELETE', path, deps)
    if (instructionDelete) { const result = await instructionDelete; return sendJson(res, result.status, result.body) }
    const resourceDelete = resolveResourceMutation(req, 'DELETE', path, deps)
    if (resourceDelete) { const result = await resourceDelete; return sendJson(res, result.status, result.body) }
    const agentDelete = resolveAgentMutation(req, 'DELETE', path, deps)
    if (agentDelete) { const result = await agentDelete; return sendJson(res, result.status, result.body) }
    if (await handleTaskLifecycleDelete(req, res, path, deps)) return

    if (path.startsWith('/api/test-directions/')) {
      const result = await handleTestDirectionMutation('DELETE', path, '', {
        configRoot: paths.configRoot, authorized: () => true, sendJson,
      })
      if (result !== null) return sendJson(res, result.status, result.body)
    }

    // ── G18：DELETE /api/projects?root= —— 注销项目（注册的对称操作）──
    if (path === '/api/projects') {
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root')
      const result = await removeProjectFromRegistry(paths.registryPath, root)
      if (!result.ok) return sendJson(res, result.code, { ok: false, error: result.error })
      if (root === null) return sendJson(res, 400, { ok: false, error: '缺少 root 参数' })
      const normalized = resolvePath(root)
      const anchor = workflowRootAnchors.get(normalized)
      if (anchor) {
        closeWorkflowRootAnchor(anchor)
        workflowRootAnchors.delete(normalized)
      }
      return sendJson(res, 200, { ok: true })
    }

    // ── v3 Studio：DELETE /api/tracks/:id，活跃 Change 引用与不可读候选均 fail-closed。──
    const trackDelete = /^\/api\/tracks\/([^/]+)$/.exec(path)
    if (trackDelete) {
      const segment = trackDelete[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 track 路径' })
      const id = decodeURIComponent(segment)
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams
      const root = query.get('root') ?? ''
      const revision = query.get('revision') ?? ''
      if (revision === '') return sendJson(res, 400, { ok: false, error: '缺少 revision 参数' })
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        const mutation = await mutateTrackForApi(rootCheck.anchor, revision, async ({ config }) => {
          const next = deleteTrack(config, id)
          await assertTrackDeletable(id, () => scanActiveTrackChanges(rootCheck.anchor.path))
          return { next, result: undefined }
        })
        return sendJson(res, 200, trackRegistryBody(mutation.registry))
      } catch (error) {
        return sendTrackError(res, error)
      }
    }

    // ── workflow 编辑器（GOAL E8）：DELETE /api/workflows/:name ──
    const mWfDelete = /^\/api\/workflows\/([^/]+)$/.exec(path)
    if (mWfDelete) {
      const segment = mWfDelete[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 workflow 路径' })
      const wfName = decodeURIComponent(segment)
      // 防路径穿越（同 POST /api/workflows/:name、GET /api/workflows/:name 共用的 name 校验
      // 模式）：必须先于下面的 'default' 检查执行——不挡住的话，恶意 name 能让
      // deleteWorkflowForApi 内部的 join(dir, `${name}.yaml`) 删到 .pipeline/workflows/ 之外
      // 的任意文件（DELETE 比 POST 更危险：一次成功调用即不可逆地抹掉目标文件）。
      if (!isWorkflowName(wfName)) {
        return sendJson(res, 400, { ok: false, error: '非法 workflow 名（允许中文、字母、数字、- 与 _；不允许空格、点或路径符号）' })
      }
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      const rootCheck = workflowStoreForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      let permit: ReturnType<typeof captureWorkflowDeletePermit>
      try {
        // 先安全打开并钉住目标 inode；不存在不创建任何协调目录。随后准备两把现有跨进程锁的
        // 真实父目录，拒绝 symlink/换位，保留 G6 O_NOFOLLOW/root identity 边界。
        permit = captureWorkflowDeletePermit(rootCheck.anchor, wfName)
        if (!permit) return sendJson(res, 404, { ok: false, error: `workflow '${wfName}' 不存在` })
        ensureWorkflowGovernanceCoordinationPath(rootCheck.anchor)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }

      type DeleteWorkflowOutcome =
        | { readonly kind: 'deleted' }
        | { readonly kind: 'referenced'; readonly references: ReturnType<typeof scanWorkflowReferencesForApi>['references'] }
        | {
            readonly kind: 'scan-failed'
            readonly references: ReturnType<typeof scanWorkflowReferencesForApi>['references']
            readonly blockers: ReturnType<typeof scanWorkflowReferencesForApi>['blockers']
          }
      let enteredGovernance = false
      let enteredTrackSnapshot = false
      try {
        const outcome = await withRegistryGovernanceLock(rootCheck.anchor.path, async (): Promise<DeleteWorkflowOutcome> => {
          enteredGovernance = true
          assertWorkflowRootAnchor(rootCheck.anchor)
          return withTrackRegistryLock(
            rootCheck.anchor.path,
            trackValidationContextFor(rootCheck.anchor),
            async ({ registry }): Promise<DeleteWorkflowOutcome> => {
              enteredTrackSnapshot = true
              assertWorkflowRootAnchor(rootCheck.anchor)
              // default 的删除 = 撤掉项目覆盖、回到内建模板：引用它的 change 继续可用，无需引用扫描。
              if (!isDefaultWorkflowName(wfName)) {
                const scan = scanWorkflowReferencesForApi(rootCheck.anchor, wfName, registry)
                if (scan.blockers.length > 0) {
                  return { kind: 'scan-failed', references: scan.references, blockers: scan.blockers }
                }
                if (scan.references.length > 0) return { kind: 'referenced', references: scan.references }
              }
              if (permit === null) throw new WorkflowDeleteConflictError(`workflow '${wfName}' 删除许可缺失`)
              deleteWorkflowForApi(rootCheck.anchor, wfName, permit)
              return { kind: 'deleted' }
            },
          )
        })
        if (outcome.kind === 'scan-failed') {
          return sendJson(res, 409, {
            ok: false,
            code: 'WORKFLOW_REFERENCE_SCAN_FAILED',
            workflow: wfName,
            references: outcome.references,
            blockers: outcome.blockers,
          })
        }
        if (outcome.kind === 'referenced') {
          return sendJson(res, 409, {
            ok: false,
            code: 'WORKFLOW_REFERENCED',
            workflow: wfName,
            references: outcome.references,
          })
        }
        return sendJson(res, 200, { ok: true })
      } catch (e) {
        if (e instanceof WorkflowDeleteConflictError) {
          return sendJson(res, 409, {
            ok: false,
            code: 'WORKFLOW_DELETE_STALE',
            workflow: wfName,
            error: errMsg(e),
          })
        }
        if (enteredGovernance && !enteredTrackSnapshot) {
          return sendJson(res, 409, {
            ok: false,
            code: 'WORKFLOW_REFERENCE_SCAN_FAILED',
            workflow: wfName,
            references: [],
            blockers: [{ source: 'track-registry', detail: errMsg(e) }],
          })
        }
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }

    // ── v6 T1：DELETE /api/secrets?key= —— 删单键（同现有 DELETE 惯例：query string 传参，
    //    对齐 DELETE /api/projects?root=、DELETE /api/workflows/:name?root= 的传参风格）──
    if (path === '/api/secrets') {
      const key = new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? ''
      if (!isValidSecretKey(key)) {
        return sendJson(res, 400, { ok: false, error: `非法 key（仅允许 ${SECRET_KEY_LIST}）` })
      }
      try {
        await removeSecret(paths.secretsPath, key)
        return sendJson(res, 200, { ok: true })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }

    return sendJson(res, 404, { ok: false, error: '未知端点' })
  }

/** PUT 路由表：目前只有 PUT /api/workflows/:name/yaml（导入原文）。Host 守卫 + token 鉴权同 POST/DELETE。 */
export async function handlePutRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: MutationRouteDeps,
): Promise<void> {
  const { isLocalHost, sendJson, token, workflowRootForRequest, workflowStoreForRequest, trackValidationContextFor, errMsg } = deps
  const boundPort = deps.boundPort()
  if (!isLocalHost(req.headers.host, boundPort)) {
    return sendJson(res, 403, { ok: false, error: 'Host header 不合法（疑似 DNS 重绑定攻击）' })
  }
  const provided = tokenFromHeaders(req.headers)
  if (!provided || !tokensMatch(provided, token)) {
    return sendJson(res, 401, { ok: false, error: '缺少或无效 token（写端点需鉴权）' })
  }
  const instructionPut = resolveInstructionMutation(req, 'PUT', path, deps)
  if (instructionPut) { const result = await instructionPut; return sendJson(res, result.status, result.body) }
  const resourcePut = resolveResourceMutation(req, 'PUT', path, deps)
  if (resourcePut) { const result = await resourcePut; return sendJson(res, result.status, result.body) }
  const agentPut = resolveAgentMutation(req, 'PUT', path, deps)
  if (agentPut) { const result = await agentPut; return sendJson(res, result.status, result.body) }
  if (path.startsWith('/api/test-directions/')) {
    const body = await readTextBody(req, TEST_DIRECTION_MAX_BYTES)
    if (body === null) return sendJson(res, 400, { ok: false, error: `方向文件超过 ${TEST_DIRECTION_MAX_BYTES} 字节` })
    const result = await handleTestDirectionMutation('PUT', path, body, {
      configRoot: deps.paths.configRoot, authorized: () => true, sendJson,
    })
    if (result !== null) return sendJson(res, result.status, result.body)
  }
  const yamlName = matchWorkflowYamlRoute(path)
  if (yamlName !== null) {
    const result = await handleWorkflowYamlPut(req, yamlName, {
      workflowRootForRequest: workflowStoreForRequest, trackValidationContextFor, errMsg, paths: deps.paths,
    })
    return sendJson(res, result.status, result.body)
  }
  return sendJson(res, 404, { ok: false, error: 'not found' })
}
