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
  validateWorkflowForStorage,
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
import {
  validateHookToggleBody,
  validatePromptRoutingBypassBody,
  writeHookToggle,
  writePromptRoutingBypass,
} from './hooksConfig.js'
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
  workflowOrigin,
} from './workflows.js'

import type { PostRouteDeps } from './serverPostRoutes.js'

export async function handlePostGovernanceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: PostRouteDeps,
): Promise<void> {
  const {
    sendJson, readJsonBody, routerPatternScorer, workflowRootForRequest,
    trackValidationContextFor, executeOperation, operationRunner, operationsAvailable,
    isRegisteredRoot, store, clock, history, workflowRootAnchors, trackSkillProfiles,
    loadedManifest, runRepo, flow, fileExists, gitHeadSha, workspaceFingerprint, breadcrumb,
    manifestPath, paths, validateLoopActivation, mutateTrackForApi, trackRegistryBody,
    sendTrackError, errMsg,
  } = deps
  const REAL_GRADUATION_FS = deps.realGraduationFs
  function isWorkflowName(name: string): boolean {
    return name !== '' && /^[\p{L}\p{N}\p{M}_-]+$/u.test(name)
  }
    if (path === '/api/config/mandatory-skills') {
      if (!manifestPath) return sendJson(res, 404, { ok: false, error: 'config 数据端未装（capabilities.config=false）' })
      const body = await readJsonBody(req)
      const validated = validateMandatorySkillsBody(body)
      if (!validated.ok) return sendJson(res, 400, { ok: false, error: validated.error })
      const { phase, track, skills } = validated.value
      try {
        await writeMandatorySkills(manifestPath, phase, track, skills)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
      return sendJson(res, 200, { ok: true, phase, track, skills })
    }

    // ── loops 升降档写端点：POST /api/loops/level ──
    if (path === '/api/loops/level') {
      const body = await readJsonBody(req)
      const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).root : undefined
      const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined
      const target = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).target : undefined
      if (typeof root !== 'string' || typeof id !== 'string' || typeof target !== 'string' || !root || !id || !target) {
        return sendJson(res, 400, { ok: false, error: 'root/id/target 必填' })
      }
      // 信任锚：与 /api/change/<name>/transition 同一「两侧规范化再比较」模式——注册表条目
      // （dedupeRoots 已 resolve）与提交的 root（此处同样 resolvePath）都规范化后再比较，
      // 防止「同一路径的非规范写法（如结尾多一个斜杠）」被误判为未注册。
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const result = await applyLevelChange(root, id, target, { now: new Date(clock()), confirm: true }, REAL_GRADUATION_FS)
      // exitCode 0 = 已应用 或 合法 noop（如目标档已达到，dry-run 语义）；2 = 逻辑拒绝（跨级/
      // 就绪未达标）；3 = 载入/未知 loop/写回错误——只有前者是「请求本身处理成功」，非 0 必须
      // 映射非 2xx，否则前端只看 res.ok 会把一次真实拒绝误当成功（同 cancel/retry 两个兄弟
      // 端点的 `result.ok ? 200 : 400` 处置一致，这里字段名是 exitCode 不是 ok，语义对齐）。
      return sendJson(res, result.exitCode === 0 ? 200 : 400, result)
    }

    // ── loops 字段写端点：POST /api/loops/update（v5 T3 / 决议 #3 #12 存储侧）──
    //    只 patch 已存在 loop 的标量/字符串数组字段（cadence/goal/budget.*/human_gates/
    //    kill_criteria/allowlist/denylist 等，全集见 kernel loops/update.ts）；autonomy_level
    //    不收——升降档必须走上面的 /api/loops/level 毕业制裁决，本端点是它的旁路禁区。
    //    写回逻辑（文本手术 + 整文档 schema 重校验 + 读-判-写 CAS）见 loops.ts::applyLoopsUpdate。
    if (path === '/api/loops/update') {
      const rawBody = await readJsonBody(req)
      // 同 /api/workflows/:name 的 body 形状前置校验：空/非对象 body 不提前拦会在属性访问处
      // 抛 TypeError 走味成 500。
      if (typeof rawBody !== 'object' || rawBody === null) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const b = rawBody as Record<string, unknown>
      const root = typeof b.root === 'string' ? b.root : ''
      const id = typeof b.id === 'string' ? b.id : ''
      if (!root || !id) {
        return sendJson(res, 400, { ok: false, error: 'root/id 必填' })
      }
      const patch = b.patch
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch) || Object.keys(patch).length === 0) {
        return sendJson(res, 400, { ok: false, error: 'patch 须为非空 JSON 对象（字段名 → 新值）' })
      }
      // 信任锚：同 /api/loops/level、/api/change/<name>/transition 共用的「两侧规范化再比较」模式。
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const result = await applyLoopsUpdate(root, id, patch as Record<string, unknown>, {
        validateActivation: validateLoopActivation,
      })
      return sendJson(res, result.ok ? 200 : 400, result)
    }

    // ── v5 T5（决议#2）：POST /api/hooks —— 阶段×hook 开关写回（.pipeline/hooks.json）──
    //    gate / interactive-skill-gate 强制常开：validateHookToggleBody 直接 400（决议#2
    //    「server 写端点拒绝、sh 侧忽略」的前半句）。enabled=true 删键、false 写键（矩阵只存
    //    禁用项），落盘 canonical 一键一行供热路径 sh 纯 bash grep（CONTRACT §5.4）。
    if (path === '/api/hooks') {
      const rawBody = await readJsonBody(req)
      const validated = validateHookToggleBody(rawBody)
      if (!validated.ok) return sendJson(res, 400, { ok: false, error: validated.error })
      const root = typeof (rawBody as Record<string, unknown>).root === 'string'
        ? (rawBody as Record<string, unknown>).root as string
        : ''
      if (!root) {
        return sendJson(res, 400, { ok: false, error: 'root 必填' })
      }
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        await writeHookToggle(rootCheck.anchor, validated.value)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
      return sendJson(res, 200, { ok: true, ...validated.value })
    }

    if (path === '/api/hooks/prompt-routing-bypass') {
      const rawBody = await readJsonBody(req)
      const validated = validatePromptRoutingBypassBody(rawBody)
      if (!validated.ok) return sendJson(res, 400, { ok: false, error: validated.error })
      const root = typeof (rawBody as Record<string, unknown>).root === 'string'
        ? (rawBody as Record<string, unknown>).root as string
        : ''
      if (!root) return sendJson(res, 400, { ok: false, error: 'root 必填' })
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        await writePromptRoutingBypass(rootCheck.anchor, validated.value)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
      return sendJson(res, 200, {
        ok: true,
        prompt_skip_keyword: validated.value.promptSkipKeyword,
      })
    }

    // ── T21：POST /api/automation —— AFK 执行参数写回（.pipeline/automation.json）──
    //    校验序对齐 /api/hooks：body 形状+值域（automationConfig.ts fail-loud 400）→ root 必填
    //    400 → 信任锚 404 → 真写（canonical + tmp+rename 原子写）。写完回 settings 归一值，
    //    UI 保存后再 GET 回读对账。
    if (path === '/api/automation') {
      const rawBody = await readJsonBody(req)
      const validated = validateAutomationSettingsBody(rawBody)
      if (!validated.ok) return sendJson(res, 400, { ok: false, error: validated.error })
      const root = typeof (rawBody as Record<string, unknown>).root === 'string'
        ? (rawBody as Record<string, unknown>).root as string
        : ''
      if (!root) {
        return sendJson(res, 400, { ok: false, error: 'root 必填' })
      }
      // 信任锚：同 /api/hooks、/api/loops/level 共用的「两侧规范化再比较」模式。
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      try {
        writeAutomationSettings(root, validated.value)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
      return sendJson(res, 200, { ok: true, settings: validated.value })
    }

    // ── workflow 编辑器（GOAL E8）：POST /api/workflows/:name —— 新建/覆盖 ──
    const mWfPost = /^\/api\/workflows\/([^/]+)$/.exec(path)
    if (mWfPost) {
      const segment = mWfPost[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 workflow 路径' })
      const wfName = decodeURIComponent(segment)
      // 防路径穿越（同 GET /api/workflows/:name、/api/afk/<name>/log、/api/afk/<name>/cancel、
      // /api/afk/<name>/retry 共用的 name 校验模式）：写端点比读端点更需要这道门——不挡住的话，
      // 恶意 name 能让 writeWorkflowForApi 内部的 join(dir, `${name}.yaml`) 写到
      // .pipeline/workflows/ 之外的任意文件。必须先于下面的 'default' 检查执行。
      if (!isWorkflowName(wfName)) {
        return sendJson(res, 400, { ok: false, error: '非法 workflow 名（允许中文、字母、数字、- 与 _；不允许空格、点或路径符号）' })
      }
      const rawBody = await readJsonBody(req)
      // 同 /api/change/<name>/transition 共用的 body 形状校验：空/非对象 body（如空字符串
      // JSON.parse 失败后 readJsonBody 回落的 undefined）若不提前拦，下面的属性访问会直接
      // 抛 TypeError，被最外层 handler.catch 兜成 500——本文件其余写端点（/api/loops/level、
      // /api/afk/<name>/cancel、/api/afk/<name>/retry、/api/change/<name>/transition）都对此
      // 有前置校验，这里补齐保持一致（清晰的 400 而非属性访问抛错的 500）。
      if (typeof rawBody !== 'object' || rawBody === null) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const body = rawBody as Record<string, unknown>
      if (body.name !== wfName) {
        return sendJson(res, 400, { ok: false, error: 'URL workflow name 必须与 body.name 完全一致' })
      }
      const root = typeof body.root === 'string' ? body.root : ''
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      let workflow: WorkflowDef
      try {
        // `root` is the HTTP envelope's trust anchor, not part of WorkflowDef. Preserve every
        // other key across the decoder boundary so compileWorkflow can reject unknown DTO fields
        // instead of this adapter silently projecting them away before validation.
        const workflowInput = Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== 'root'),
        )
        // 'default' 是项目覆盖文件的存储键：按 default 契约（七阶段 + effective-phase-skills）解码与校验。
        workflow = decodeWorkflowDef(workflowInput, workflowOrigin(wfName))
      } catch (error) {
        return sendJson(res, 400, { ok: false, errors: [errMsg(error)] })
      }
      const shapeErrors = validateWorkflowForStorage(wfName, workflow)
      if (shapeErrors.length > 0) return sendJson(res, 400, { ok: false, errors: shapeErrors })
      try {
        ensureWorkflowProjectCoordinationPath(rootCheck.anchor)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
      let enteredRegistrySnapshot = false
      try {
        const result = await withTrackRegistryLock(
          rootCheck.anchor.path,
          trackValidationContextFor(rootCheck.anchor),
          async ({ registry }) => {
            enteredRegistrySnapshot = true
            assertWorkflowRootAnchor(rootCheck.anchor)
            const referenceErrors = validateWorkflowTrackReferences(workflow, registry)
            if (referenceErrors.length > 0) return { ok: false as const, errors: referenceErrors }
            return writeWorkflowForApi(rootCheck.anchor, wfName, workflow)
          },
        )
        return sendJson(res, result.ok ? 200 : 400, result)
      } catch (e) {
        // 无法形成 effective registry 快照时不能保存未经引用校验的 workflow。
        return enteredRegistrySnapshot
          ? sendJson(res, 500, { ok: false, error: errMsg(e) })
          : sendJson(res, 400, { ok: false, errors: [errMsg(e)] })
      }
    }

    // ── afk-workbench Task 4：POST /api/afk/:name/cancel —— 取消运行中的 automation 任务
    //    （落 .cancel-requested 标记 + docker kill 容器，见 afk.ts::cancelAfkRun）──

}
