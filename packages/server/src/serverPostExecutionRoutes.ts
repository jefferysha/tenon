import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  createEffectiveSkillResolver,
  loadCompiledWorkflow,
  planAutomationPolicy,
  requireRunPlan,
  resolveWorkflowName,
  stateStorageExistsSync,
} from '@tenon/kernel'
import {
  cancelAfkRun,
  dismissAfkRun,
  enqueueAfkRun,
  retryAfkRun,
} from './afk.js'
import { validateSecretWriteBody, writeSecret } from './secrets.js'
import { resolveTrackPolicyFor } from './trackPolicy.js'
import { performTransition } from './transition.js'
import type { PostRouteDeps } from './serverPostRoutes.js'
import { handlePostDecisionRoutes } from './serverPostDecisionRoutes.js'
import { readAnchoredChange } from './serverTaskPlanRoutes.js'
import {
  applyTaskRunOperationForChange,
  resolveTaskRunOperation,
  TaskRunOperationConflictError,
} from './serverTaskRunOperations.js'

export async function handlePostExecutionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: PostRouteDeps,
): Promise<void> {
  const {
    sendJson, readJsonBody, workflowRootForRequest,
    isRegisteredRoot, store, clock, history,
    loadedManifest, runRepo, flow, fileExists, gitHeadSha, workspaceFingerprint, breadcrumb,
    paths, errMsg,
  } = deps
    if (/^\/api\/task-runs\/[^/]+\/operations$/.test(path)) {
      const rawBody = await readJsonBody(req)
      const result = await resolveTaskRunOperation(path, rawBody, {
        workflowRootForRequest,
        clock,
        operationId: randomUUID,
        mutateRun: async (anchor, change, operation) => {
          const updated = await readAnchoredChange(
            anchor,
            change,
            async (changeDir) => applyTaskRunOperationForChange(changeDir, operation),
          )
          if (updated === null) throw new TaskRunOperationConflictError('Task Run is missing')
          return updated
        },
      })
      if (result !== null) return sendJson(res, result.status, result.body)
    }
    const cancelMatch = /^\/api\/afk\/([^/]+)\/cancel$/.exec(path)
    if (cancelMatch) {
      const segment = cancelMatch[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
      const name = decodeURIComponent(segment)
      // 同 /api/change/<name>/transition 的 change 名校验（防路径穿越：拒 '..' 等非法段落入 join）。
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.includes('..')) {
        return sendJson(res, 400, { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' })
      }
      const body = await readJsonBody(req)
      const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).root : undefined
      if (typeof root !== 'string' || !root) {
        return sendJson(res, 400, { ok: false, error: 'root 须为非空字符串' })
      }
      // 信任锚：同 /api/loops/level、/api/change/<name>/transition 共用的「两侧规范化再比较」模式。
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const dir = join(root, 'openspec', 'changes', name)
      const result = await cancelAfkRun(store, dir)
      return sendJson(res, result.ok ? 200 : 400, result)
    }

    // ── afk-workbench Task 5：POST /api/afk/:name/retry —— 重试 failed/conflict/paused 任务
    //    （CAS automation→queued + automation_attempts 清零，见 afk.ts::retryAfkRun）──
    const retryMatch = /^\/api\/afk\/([^/]+)\/retry$/.exec(path)
    if (retryMatch) {
      const segment = retryMatch[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
      const name = decodeURIComponent(segment)
      // 同 /api/change/<name>/transition、/api/afk/<name>/cancel 的 change 名校验（防路径穿越：拒 '..' 等非法段落入 join）。
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.includes('..')) {
        return sendJson(res, 400, { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' })
      }
      const body = await readJsonBody(req)
      const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).root : undefined
      if (typeof root !== 'string' || !root) {
        return sendJson(res, 400, { ok: false, error: 'root 须为非空字符串' })
      }
      // 信任锚：同 /api/loops/level、/api/change/<name>/transition、/api/afk/<name>/cancel 共用的「两侧规范化再比较」模式。
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const dir = join(root, 'openspec', 'changes', name)
      const result = await retryAfkRun(store, dir)
      return sendJson(res, result.ok ? 200 : 400, result)
    }

    // ── v5-T11（决议 #4）：POST /api/afk/:name/dismiss —— 放弃 failed/conflict 任务
    //    （CAS automation→off，现场保留不清 automation_* 尸检字段，见 afk.ts::dismissAfkRun）──
    const dismissMatch = /^\/api\/afk\/([^/]+)\/dismiss$/.exec(path)
    if (dismissMatch) {
      const segment = dismissMatch[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
      const name = decodeURIComponent(segment)
      // 同 /api/afk/<name>/cancel、/api/afk/<name>/retry 的 change 名校验（防路径穿越：拒 '..' 等非法段落入 join）。
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.includes('..')) {
        return sendJson(res, 400, { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' })
      }
      const body = await readJsonBody(req)
      const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).root : undefined
      if (typeof root !== 'string' || !root) {
        return sendJson(res, 400, { ok: false, error: 'root 须为非空字符串' })
      }
      // 信任锚：同 /api/afk/<name>/cancel、/api/afk/<name>/retry 共用的「两侧规范化再比较」模式。
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const dir = join(root, 'openspec', 'changes', name)
      const result = await dismissAfkRun(store, dir)
      return sendJson(res, result.ok ? 200 : 400, result)
    }

    // ── afk-workbench 缺口修复：POST /api/afk/:name/enqueue —— 挂入 AFK 队列
    //    （automation=off/未设 → queued，见 afk.ts::enqueueAfkRun）──
    const enqueueMatch = /^\/api\/afk\/([^/]+)\/enqueue$/.exec(path)
    if (enqueueMatch) {
      const segment = enqueueMatch[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
      const name = decodeURIComponent(segment)
      // 同 /api/afk/<name>/cancel、/api/afk/<name>/retry 的 change 名校验（防路径穿越）。
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.includes('..')) {
        return sendJson(res, 400, { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' })
      }
      const body = await readJsonBody(req)
      const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).root : undefined
      if (typeof root !== 'string' || !root) {
        return sendJson(res, 400, { ok: false, error: 'root 须为非空字符串' })
      }
      // 信任锚：同 /api/afk/<name>/cancel、/api/afk/<name>/retry 共用的「两侧规范化再比较」模式。
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const dir = join(root, 'openspec', 'changes', name)
      // 先保留旧端点对不存在 change 的精确 400 语义；只有真 state 才进 registry 解析。
      if (!stateStorageExistsSync(dir)) {
        return sendJson(res, 400, { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' })
      }
      let eligibility: { automationEligible: boolean; trackLabel: string }
      try {
        // 计划取自任务冻结的快照（没有快照才读现行工作流），资格读选中分支的 automation，不查登记表。
        const state = await store.read(dir)
        const trackId = Array.isArray(state.fields.track) ? state.fields.track.join(',') : (state.fields.track ?? '')
        const plan = requireRunPlan(
          resolveWorkflowName(state), trackId, state.runMetadata?.workflowPlanSnapshot,
          (workflowName) => loadCompiledWorkflow(root, workflowName),
        )
        eligibility = { automationEligible: planAutomationPolicy(plan).automationEligible, trackLabel: plan.capabilities.track.id ?? trackId }
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: errMsg(e) })
      }
      const result = await enqueueAfkRun(store, dir, clock, eligibility)
      return sendJson(res, result.ok ? 200 : 400, result)
    }

    // ── v6 T1：POST /api/secrets —— 写入单个凭证键（值只进文件，不落 HTTP 响应/日志）──
    //    body：{ key: 'CLAUDE_CODE_OAUTH_TOKEN' | 'OPENAI_API_KEY', value: string }，每次只写
    //    一个键（不是整份表覆盖式写，见 proposal C.3）。不需要 root——机器级资源，与其余写端点
    //    「①格式→②root 信任锚→③业务校验→④真读写」四步顺序不同：本端点压根没有 root 概念，
    //    第②步不存在（同 POST /api/projects 是另一个没有信任锚概念的写端点，但原因不同：
    //    projects 是信任锚本身；secrets 是机器级资源，与项目注册无关）。
    if (path === '/api/secrets') {
      const rawBody = await readJsonBody(req)
      const validated = validateSecretWriteBody(rawBody)
      if (!validated.ok) return sendJson(res, 400, { ok: false, error: validated.error })
      try {
        const info = await writeSecret(paths.secretsPath, validated.value.key, validated.value.value)
        return sendJson(res, 200, { ok: true, key: validated.value.key, ...info })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }

    const decisionHandled = await handlePostDecisionRoutes(req, res, path, { sendJson, readJsonBody, isRegisteredRoot, store, recordStore: deps.recordStore, clock, history, resolveUser: deps.resolveUser, presence: deps.presence })
    if (decisionHandled) return

    const mTr = /^\/api\/change\/([^/]+)\/transition$/.exec(path)
    if (!mTr) return sendJson(res, 404, { ok: false, error: '未知写回端点' })

    const body = await readJsonBody(req)
    if (typeof body !== 'object' || body === null) {
      return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
    }
    const b = body as Record<string, unknown>
    const root = b.root
    const event = b.event
    if (typeof root !== 'string' || typeof event !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'root / event 须为字符串' })
    }
    // 信任锚：root 必须是已注册 Project（挡路径穿越到任意目录）——对位老仓 resolve_change_worktree。
    // 统一用 dedupeRoots 规范化（同下面四个写端点），而不是本地重新拼一遍 Set——inline 版本
    // 对注册表里的空字符串条目会解析成 resolvePath('')=cwd 当一个"可信"条目，dedupeRoots 已
    // 显式过滤掉空条目（whole-branch review 抓出的真实不一致，两者对合法注册表行为等价，
    // 仅在这个边界输入上有差异）。
    if (!isRegisteredRoot(root)) {
      return sendJson(res, 404, { ok: false, error: 'root 非已知 Project（未注册或不可信）' })
    }
    const segment = mTr[1]
    if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
    const name = decodeURIComponent(segment)
    // history 注入（G20 / v5-T1）：转换成功 → .pipeline-history.jsonl 记账，guard 拒绝零记账。
    const outcome = await performTransition(
      {
        store,
        runRepo,
        ...(deps.recordStore === undefined ? {} : { recordStore: deps.recordStore }),
        flow,
        clock,
        fileExists,
        gitHeadSha,
        workspaceFingerprint,
        history,
        breadcrumb,
        resolveUser: deps.resolveUser,
        // 规格完成后是否自动入队，读任务自己冻结的快照里该轨道的 automation 设置（旧引擎的 default 任务
        // 按旧策略表），不靠 track id 写死 PM；转换里的轨道也由内核按同一份快照解析，宿主无需注入。
        resolveTrackPolicy: await resolveTrackPolicyFor(store, root, name),
        skillResolver: loadedManifest ? createEffectiveSkillResolver(loadedManifest) : undefined,
      },
      root,
      name,
      event,
    )
    return sendJson(res, outcome.code, outcome.body)
}
