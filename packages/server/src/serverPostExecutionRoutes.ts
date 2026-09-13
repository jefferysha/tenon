import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
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
  requireTrackForRoot,
  stateStorageExistsSync,
  validateWorkflow,
  validateWorkflowTrackReferences,
  withTrackRegistryLock,
  acknowledgeReview,
  createDecisionCommandAdapter,
  projectPendingDecisions,
  readCurrentRunRevision,
  readReviewGateBinding,
  reviewGateBindingMatches,
  reviewGateEvent,
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
import type { PostRouteDeps } from './serverPostRoutes.js'
import { readAnchoredChange } from './serverTaskPlanRoutes.js'
import {
  applyTaskRunOperationForChange,
  resolveTaskRunOperation,
  TaskRunOperationConflictError,
} from './serverTaskRunOperations.js'

// Idempotency is transport protection only; canonical review receipt remains the source of truth.
const decisionIdempotency = new Map<string, { readonly ref: string; readonly acknowledgedAt: string }>()

export async function handlePostExecutionRoutes(
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
      let track: TrackDefinition
      try {
        const rawTrack = await store.get(dir, 'track')
        const trackId = Array.isArray(rawTrack) ? rawTrack.join(',') : (rawTrack ?? '')
        const trackCtx: TrackValidationContext = {
          workflowExists: (id) => {
            if (id === 'default') return true
            try {
              return loadWorkflow(root, id) !== null
            } catch {
              return false
            }
          },
          skillProfiles: trackSkillProfiles,
        }
        track = requireTrackForRoot(loadTrackRegistry(root, trackCtx), trackId, root)
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: errMsg(e) })
      }
      const result = await enqueueAfkRun(store, dir, clock, {
        automationEligible: track.policyProfile.automationEligible,
        trackLabel: track.label,
      })
      return sendJson(res, result.ok ? 200 : 400, result)
    }

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

    if (path === '/api/tracks') {
      const rawBody = await readJsonBody(req)
      if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const trackBody = rawBody as Record<string, unknown>
      const root = typeof trackBody.root === 'string' ? trackBody.root : ''
      const revision = typeof trackBody.revision === 'string' ? trackBody.revision : ''
      const track = trackBody.track
      if (revision === '' || typeof track !== 'object' || track === null || Array.isArray(track)) {
        return sendJson(res, 400, { ok: false, error: 'revision 与 track 对象为必填' })
      }
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      try {
        const mutation = await mutateTrackForApi(rootCheck.anchor, revision, async ({ config }) => ({
          next: createTrack(config, track as CreateTrackSpec),
          result: undefined,
        }))
        return sendJson(res, 200, trackRegistryBody(mutation.registry))
      } catch (error) {
        return sendTrackError(res, error)
      }
    }

    const mDecision = /^\/api\/change\/([^/]+)\/decisions$/.exec(path)
    if (mDecision) {
      const body = await readJsonBody(req)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const b = body as Record<string, unknown>
      const root = typeof b.root === 'string' ? b.root : ''
      const ref = typeof b.ref === 'string' ? b.ref : ''
      const expectedRevision = typeof b.expected_revision === 'number' ? b.expected_revision : null
      const idempotencyKey = typeof b.idempotency_key === 'string' ? b.idempotency_key : ''
      if (!root || !ref || expectedRevision === null || !idempotencyKey) return sendJson(res, 400, { ok: false, error: 'root / ref / expected_revision / idempotency_key 为必填' })
      if (!isRegisteredRoot(root)) return sendJson(res, 404, { ok: false, error: 'root 非已知 Project（未注册或不可信）' })
      const name = decodeURIComponent(mDecision[1] ?? '')
      if (!/^[A-Za-z0-9_-]+$/.test(name) || name.includes('..')) return sendJson(res, 400, { ok: false, error: '非法 change 名' })
      const dir = join(root, 'openspec', 'changes', name)
      if (!stateStorageExistsSync(dir)) return sendJson(res, 400, { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' })
      try {
        const idempotencyScope = `${root}\0${name}\0${idempotencyKey}`
        const prior = decisionIdempotency.get(idempotencyScope)
        if (prior !== undefined) return sendJson(res, 200, { ok: true, ref: prior.ref, changed: false, idempotent: true, channel: 'dashboard' })
        let deferred: readonly string[] = []
        const adapter = createDecisionCommandAdapter({
          readRevision: async () => (await readCurrentRunRevision(dir))?.revision ?? null,
          hasIdempotencyKey: async (key) => decisionIdempotency.has(idempotencyScope.replace(idempotencyKey, key)),
          rememberIdempotencyKey: async (key) => {
            if (decisionIdempotency.size >= 4096) decisionIdempotency.clear()
            decisionIdempotency.set(idempotencyScope.replace(idempotencyKey, key), { ref, acknowledgedAt: clock() })
          },
          isPending: async (decisionRef) => {
            const current = await readCurrentRunRevision(dir)
            const state = current?.state ?? await store.read(dir)
            return projectPendingDecisions({ change: name, state, revision: current?.revision }).items.some((item) => item.ref.id === decisionRef.id && item.type === 'review' && item.status === 'pending')
          },
          apply: async ({ ref: decisionRef }) => store.withLock(dir, async () => {
            const lockedRevision = await readCurrentRunRevision(dir)
            if ((lockedRevision?.revision ?? null) !== expectedRevision) throw new Error('decision revision conflict')
            const locked = await store.read(dir)
            const item = projectPendingDecisions({ change: name, state: locked, revision: lockedRevision?.revision }).items.find((candidate) => candidate.ref.id === decisionRef.id)
            if (item === undefined || item.type !== 'review') throw new Error('decision is no longer pending')
            const phase = item.anchor.phase ?? ''
            const event = item.anchor.event ?? reviewGateEvent(locked)
            const binding = await readReviewGateBinding(dir)
            const acknowledged = await acknowledgeReview({
              state: locked, phase, event, acknowledgedAt: clock(), bindingMatches: reviewGateBindingMatches(binding, locked, phase, event), via: 'dashboard',
              writeState: async (patch) => { await store.writeUnderLock(dir, { ...locked, fields: { ...locked.fields, ...patch } }, { kind: 'set-many' }) },
              recordHistory: async ({ acknowledgedAt, phase: acknowledgedPhase, event: acknowledgedEvent }) => history.append(dir, { ts: acknowledgedAt, kind: 'tool', raw: `review:acknowledge via=dashboard phase=${acknowledgedPhase} event=${acknowledgedEvent}` }),
            })
            deferred = acknowledged.deferred
          }),
        })
        const current = await readCurrentRunRevision(dir)
        const state = current?.state ?? await store.read(dir)
        const item = projectPendingDecisions({ change: name, state, revision: current?.revision }).items.find((candidate) => candidate.ref.id === ref)
        if (item === undefined) return sendJson(res, 409, { ok: false, error: 'decision is no longer pending', code: 'decision-not-pending' })
        const result = await adapter.execute({ ref: item.ref, expectedRevision, idempotencyKey, channel: 'dashboard' })
        if (!result.ok) return sendJson(res, 409, { ok: false, error: result.message, code: result.code })
        return sendJson(res, 200, { ok: true, ref, changed: !result.idempotent, idempotent: result.idempotent, channel: 'dashboard', deferred })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(res, 409, { ok: false, error: message, code: message === 'decision revision conflict' ? 'revision-conflict' : 'review-approval-required' })
      }
    }

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
    if (!isRegisteredRoot(root)) {
      return sendJson(res, 404, { ok: false, error: 'root 非已知 Project（未注册或不可信）' })
    }
    const segment = mTr[1]
    if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
    const name = decodeURIComponent(segment)
    const loadEffectiveTrackRegistry = () => loadTrackRegistry(root, {
      workflowExists: (workflowId) => {
        if (workflowId === 'default') return true
        try { return loadWorkflow(root, workflowId) !== null } catch { return false }
      },
      skillProfiles: trackSkillProfiles,
    })
    const outcome = await performTransition(
      {
        store,
        runRepo,
        flow,
        clock,
        fileExists,
        gitHeadSha,
        workspaceFingerprint,
        history,
        breadcrumb,
        resolveTrackPolicy: (trackId) => requireTrackForRoot(loadEffectiveTrackRegistry(), trackId, root).policyProfile,
        resolveTrack: (trackId) => requireTrackForRoot(loadEffectiveTrackRegistry(), trackId, root),
        skillResolver: loadedManifest
          ? createEffectiveSkillResolver({
              registry: loadEffectiveTrackRegistry,
              manifest: loadedManifest,
            })
          : undefined,
      },
      root,
      name,
      event,
    )
    return sendJson(res, outcome.code, outcome.body)
}
