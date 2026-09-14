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
  RegistryReadError,
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
} from '@tenon/kernel'
import { matchesPathGlob } from '@tenon/automation'
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
import {
  buildLoopScopePreviewResponse,
  LoopScopePreviewInputError,
  LoopScopePreviewRootUntrustedError,
  parseLoopScopePreviewRequest,
  readTrustedLoopRegistry,
} from './loopScopePreview.js'
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

import type { PostRouteDeps } from './serverPostRoutes.js'

export async function handlePostOperationsRoutes(
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
  function sendLoopScopeUntrustedRoot(): void {
    sendJson(res, 403, {
      ok: false,
      code: 'LOOP_SCOPE_ROOT_UNTRUSTED',
      error: 'root 信任锚已失效',
    })
  }
    if (path === '/api/loops/scope-preview') {
      const raw = await readJsonBody(req)
      let input
      try {
        input = parseLoopScopePreviewRequest(raw)
      } catch (error) {
        if (!(error instanceof LoopScopePreviewInputError)) throw error
        return sendJson(res, 400, { ok: false, code: 'LOOP_SCOPE_REQUEST_INVALID', error: error.message })
      }
      const rootCheck = workflowRootForRequest(input.root)
      if (!rootCheck.ok) {
        return sendJson(res, rootCheck.code, {
          ok: false,
          code: rootCheck.code === 404 ? 'LOOP_SCOPE_ROOT_NOT_FOUND' : 'LOOP_SCOPE_ROOT_UNTRUSTED',
          error: rootCheck.error,
        })
      }
      let loaded
      try {
        loaded = readTrustedLoopRegistry(rootCheck.anchor)
      } catch (error) {
        if (error instanceof LoopScopePreviewRootUntrustedError) return sendLoopScopeUntrustedRoot()
        if (!(error instanceof RegistryReadError)) throw error
        return sendJson(res, 500, {
          ok: false,
          code: 'LOOP_SCOPE_REGISTRY_READ_FAILED',
          error: 'Loop registry 读取失败',
        })
      }
      if (loaded.data === null || loaded.errors.length > 0) {
        return sendJson(res, 409, {
          ok: false,
          code: 'LOOP_SCOPE_REGISTRY_INVALID',
          error: 'Loop registry 无法形成可信策略',
        })
      }
      const loop = loaded.data.loops.find((candidate) => candidate.id === input.loopId)
      if (loop === undefined) {
        return sendJson(res, 404, {
          ok: false,
          code: 'LOOP_SCOPE_LOOP_NOT_FOUND',
          error: 'Loop 不存在',
        })
      }
      return sendJson(res, 200, buildLoopScopePreviewResponse(loop, input.paths, matchesPathGlob))
    }

    if (path === '/api/router/preview') {
      const raw = await readJsonBody(req)
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const body = raw as Record<string, unknown>
      const root = typeof body.root === 'string' ? body.root : ''
      const prompt = typeof body.prompt === 'string' ? body.prompt : ''
      if (prompt.trim() === '') return sendJson(res, 400, { ok: false, error: 'prompt 不得为空' })
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
        const registry = loadTrackRegistry(rootCheck.anchor.path, trackValidationContextFor(rootCheck.anchor))
        const draft = body.draft_track === undefined ? null : parseRouterDraft(body.draft_track)
        const candidates = draft === null ? registry.ordered : applyRouterDraft(registry.ordered, draft)
        const preview = await previewTrackRouting(prompt, candidates, routerPatternScorer)
        assertWorkflowRootAnchor(rootCheck.anchor)
        return sendJson(res, 200, { ok: true, revision: registry.revision, source: registry.source, ...preview })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: errMsg(error) })
      }
    }

    // ── H11-H14/G2 Operations：HTTP 只负责严格校验 + argv 映射；执行语义复用 built CLI。──
    if (path === '/api/operations/loops/init') {
      const raw = await readJsonBody(req)
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const body = raw as Record<string, unknown>
      const root = typeof body.root === 'string' ? body.root : ''
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const template = typeof body.template === 'string' ? body.template : ''
      const workflow = typeof body.workflow === 'string' && body.workflow.trim() !== '' ? body.workflow.trim() : 'default'
      const runner = typeof body.runner === 'string' && body.runner.trim() !== '' ? body.runner.trim() : 'codex'
      const skillBundle = typeof body.skill_bundle === 'string' ? body.skill_bundle.trim() : ''
      const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) {
        return sendJson(res, 400, { ok: false, error: 'id 须为 2-64 位 kebab-case' })
      }
      if (!listAutomationPolicyTemplates().some((item) => item.id === template)) {
        return sendJson(res, 400, { ok: false, error: 'template 不在版本化 starter 目录中' })
      }
      if (runner !== 'codex' && runner !== 'claude-code') {
        return sendJson(res, 400, { ok: false, error: 'runner 仅允许 codex 或 claude-code' })
      }
      const args = [
        'loops', 'init', '--id', id, '--template', template, '--workflow', workflow,
        ...(skillBundle === '' ? [] : ['--skill-bundle', skillBundle]),
        '--runner', runner,
        ...(goal === '' ? [] : ['--goal', goal]),
        '--yes', '--json',
      ]
      return executeOperation(res, root, args)
    }

    if (path === '/api/operations/loops/run') {
      const raw = await readJsonBody(req)
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const body = raw as Record<string, unknown>
      const root = typeof body.root === 'string' ? body.root : ''
      const selector = typeof body.selector === 'string' ? body.selector.trim() : ''
      const level = typeof body.level === 'string' ? body.level : 'L1'
      const dryRun = body.dry_run !== false
      const commit = body.commit === true
      if (selector === '' || !['L1', 'L2', 'L3'].includes(level)) {
        return sendJson(res, 400, { ok: false, error: 'selector 必填，level 仅允许 L1/L2/L3' })
      }
      if (!dryRun && body.confirm_run !== true) {
        return sendJson(res, 400, { ok: false, error: '真实运行须显式 confirm_run=true' })
      }
      if (!dryRun && level === 'L3' && body.confirm_l3 !== true) {
        return sendJson(res, 400, { ok: false, error: 'L3 自动合并须额外 confirm_l3=true' })
      }
      const args = [
        'loops', 'run', selector,
        ...(dryRun ? ['--dry-run'] : []),
        '--level', level,
        ...(!dryRun && commit ? ['--commit'] : []),
        '--json',
      ]
      return executeOperation(res, root, args)
    }

    if (path === '/api/operations/loops/sync') {
      const raw = await readJsonBody(req)
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const body = raw as Record<string, unknown>
      const root = typeof body.root === 'string' ? body.root : ''
      const loopId = typeof body.loop_id === 'string' ? body.loop_id.trim() : ''
      const mode = body.mode === 'apply' ? 'apply' : body.mode === 'dry-run' ? 'dry-run' : ''
      if (loopId === '' || mode === '') {
        return sendJson(res, 400, { ok: false, error: 'loop_id 必填，mode 仅允许 dry-run/apply' })
      }
      if (mode === 'apply' && body.confirm_apply !== true) {
        return sendJson(res, 400, { ok: false, error: 'sync apply 须显式 confirm_apply=true' })
      }
      const registrySha = typeof body.expected_registry_sha === 'string' ? body.expected_registry_sha.trim() : ''
      const workflowSha = typeof body.expected_workflow_sha === 'string' ? body.expected_workflow_sha.trim() : ''
      const args = [
        'loops', 'sync', loopId, mode === 'apply' ? '--apply' : '--dry-run',
        ...(registrySha === '' ? [] : ['--expected-registry-sha', registrySha]),
        ...(workflowSha === '' ? [] : ['--expected-workflow-sha', workflowSha]),
        '--json',
      ]
      return executeOperation(res, root, args)
    }

    if (path === '/api/operations/triage') {
      const raw = await readJsonBody(req)
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const body = raw as Record<string, unknown>
      const root = typeof body.root === 'string' ? body.root : ''
      const source = body.source === 'git-commits' || body.source === 'loop-run-terminals' ? body.source : ''
      if (source === '') return sendJson(res, 400, { ok: false, error: 'source 仅允许 git-commits/loop-run-terminals' })
      if (body.confirm_apply !== true) {
        return sendJson(res, 400, { ok: false, error: 'triage 会创建 WorkflowRun 并提交 checkpoint，须显式 confirm_apply=true' })
      }
      const positiveInt = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      const args = [
        'triage', source, '--provider', 'codex',
        ...(model === '' ? [] : ['--model', model]),
        '--page-size', String(positiveInt(body.page_size, 20)),
        '--max-pages', String(positiveInt(body.max_pages, 4)),
        '--max-high-candidates', String(positiveInt(body.max_high_candidates, 10)),
        '--json',
      ]
      return executeOperation(res, root, args)
    }

    if (path === '/api/operations/artifact/register') {
      const raw = await readJsonBody(req)
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const body = raw as Record<string, unknown>
      const root = typeof body.root === 'string' ? body.root : ''
      const change = typeof body.change === 'string' ? body.change.trim() : ''
      const field = typeof body.field === 'string' ? body.field.trim() : ''
      const artifactPath = typeof body.path === 'string' ? body.path : ''
      const producer = typeof body.producer === 'string' ? body.producer.trim() : ''
      if (!/^[a-zA-Z0-9_-]+$/.test(change) || field === '' || artifactPath === '' || producer === '') {
        return sendJson(res, 400, { ok: false, error: 'change/field/path/producer 均为必填且 change 名须合法' })
      }
      return executeOperation(res, root, [
        'artifact', 'register', change, field, artifactPath, '--producer', producer,
      ])
    }

    // ── G1 canonical/projection 显式修复面。默认拒绝把 legacy 重新提升为真相源。──
    const projectionMatch = /^\/api\/change\/([^/]+)\/projection$/.exec(path)
    if (projectionMatch) {
      const segment = projectionMatch[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
      const name = decodeURIComponent(segment)
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.includes('..')) {
        return sendJson(res, 400, { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' })
      }
      const raw = await readJsonBody(req)
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const body = raw as Record<string, unknown>
      const root = typeof body.root === 'string' ? body.root : ''
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const dir = join(root, 'openspec', 'changes', name)
      if (!stateStorageExistsSync(dir)) {
        return sendJson(res, 400, { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' })
      }
      try {
        if (body.action === 'repair-projection') {
          const projection = await store.repairProjection(dir, { forceCanonical: body.force_canonical === true })
          return sendJson(res, 200, { ok: true, action: body.action, projection })
        }
        if (body.action === 'import-legacy') {
          if (body.confirm_import !== true) {
            return sendJson(res, 400, { ok: false, error: 'import-legacy 须显式 confirm_import=true' })
          }
          const imported = await store.importLegacyProjection(dir)
          return sendJson(res, 200, {
            ok: true,
            action: body.action,
            projection: imported.projection,
            ignored_protected_fields: imported.ignoredProtectedFields,
          })
        }
        return sendJson(res, 400, { ok: false, error: 'action 仅允许 repair-projection/import-legacy' })
      } catch (error) {
        return sendJson(res, 409, { ok: false, error: errMsg(error) })
      }
    }

    // ── G18：POST /api/projects —— 注册项目进机器级注册表 ──
    //    全仓唯一豁免第四层信任锚的写端点（职责就是把 root 放进注册表，"必须已注册"逻辑
    //    不成立）；补偿校验（路径存在/是目录/规范化判重）在 projects.ts 内完成。

}
