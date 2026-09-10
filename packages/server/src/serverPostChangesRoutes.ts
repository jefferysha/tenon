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
  effectiveWorkflowPlanBinding,
  listAutomationPolicyTemplates,
  loadEffectiveWorkflowPlan,
  loadTrackRegistry,
  loadWorkflow,
  requireTrackForRoot,
  stateStorageExistsSync,
  validateWorkflow,
  validateWorkflowTrackReferences,
  workflowPlanSnapshot,
  withTrackRegistryLock,
  PIPELINE_SELECTION_SCHEMA,
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

export async function handlePostChangesRoutes(
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
    if (path === '/api/projects') {
      const body = await readJsonBody(req)
      const rawRoot = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).root : undefined
      let pendingAnchor: WorkflowRootAnchor | undefined
      if (typeof rawRoot === 'string' && rawRoot) {
        try {
          pendingAnchor = captureWorkflowRootAnchor(rawRoot)
        } catch (e) {
          // projects.ts 历来用 stat 跟随 symlink；workflow 能力锚必须更严：最终词法段本身若是
          // symlink，不能先把它写进注册表再在业务请求上学习其目标 inode。
          try {
            if (lstatSync(resolvePath(rawRoot)).isSymbolicLink()) {
              return sendJson(res, 400, { ok: false, error: `registered root 不得是 symlink：${resolvePath(rawRoot)}` })
            }
          } catch {
            // 不存在/不可访问/非目录继续交给 projects.ts，以保持既有 404 文案与状态码。
          }
        }
      }
      const result = await addProjectToRegistry(paths.registryPath, rawRoot)
      if (!result.ok) {
        if (pendingAnchor) closeWorkflowRootAnchor(pendingAnchor)
        return sendJson(res, result.code, { ok: false, error: result.error })
      }
      if (!pendingAnchor || pendingAnchor.path !== result.root) {
        if (pendingAnchor) closeWorkflowRootAnchor(pendingAnchor)
        await removeProjectFromRegistry(paths.registryPath, result.root).catch(() => undefined)
        return sendJson(res, 400, { ok: false, error: 'registered root 在注册期间未能建立稳定 inode 锚' })
      }
      try {
        assertWorkflowRootAnchor(pendingAnchor)
      } catch (e) {
        closeWorkflowRootAnchor(pendingAnchor)
        await removeProjectFromRegistry(paths.registryPath, result.root).catch(() => undefined)
        return sendJson(res, 400, { ok: false, error: errMsg(e) })
      }
      const previous = workflowRootAnchors.get(result.root)
      if (previous) closeWorkflowRootAnchor(previous)
      workflowRootAnchors.set(result.root, pendingAnchor)
      return sendJson(res, 200, { ok: true, root: result.root })
    }

    // ── G18：POST /api/changes —— tenon init 的 HTTP 化 ──
    //    校验序全部先于任何落盘（同 cli/commands/init.ts 的"先校验后写"纪律）：body 形状 →
    //    root 信任锚（本端点要求已注册）→ name 字符集 → track 枚举 → workflow 真加载校验。
    //    preset 固定 'full'（dashboard 语境无 preset 选择需求，YAGNI）；history 记账对齐
    //    cli/commands/init.ts（G19① 升级收编）：kind=init 单行，best-effort——失败仅 WARN，
    //    绝不影响主写已成功的 200。
    if (path === '/api/changes') {
      const rawBody = await readJsonBody(req)
      if (typeof rawBody !== 'object' || rawBody === null) {
        return sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
      }
      const b = rawBody as Record<string, unknown>
      const root = typeof b.root === 'string' ? b.root : ''
      const rootCheck = workflowRootForRequest(root)
      if (!rootCheck.ok) return sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
      const name = typeof b.name === 'string' ? b.name : ''
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        return sendJson(res, 400, { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' })
      }
      const taskPrompt = parseChangeTaskPrompt(b.task_prompt)
      if (!taskPrompt.ok) return sendJson(res, 400, { ok: false, error: taskPrompt.error })
      const activation = parseChangeSessionActivation(b.activate_session, taskPrompt.value !== null)
      if (!activation.ok) return sendJson(res, 400, { ok: false, error: activation.error })
      // track/workflow 绑定改走 Track Registry（GOAL.md 清单 T · R2）：缺省仍是不可删内建轨 'chat'；
      // 按 root 现载 registry（缺 tracks.yaml → 内建 Track，requireTrack 与旧 TRACKS 枚举校验等价），
      // 再校验「该 track 是否允许该 workflow」（assertWorkflowAllowed）。全部先于任何落盘。
      const trackId = typeof b.track === 'string' && b.track ? b.track : 'chat'
      const workflowRaw = typeof b.workflow === 'string' && b.workflow ? b.workflow : ''
      const pipelineRaw = typeof b.pipeline_id === 'string' && b.pipeline_id ? b.pipeline_id : ''
      try {
        ensureWorkflowProjectCoordinationPath(rootCheck.anchor)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }

      type CreateChangeOutcome =
        | { readonly ok: true; readonly created: string; readonly taskPromptSaved: boolean; readonly pipelineId: string }
        | { readonly ok: false; readonly code: 400 | 404 | 500; readonly error: string }
      let outcome: CreateChangeOutcome
      try {
        outcome = await withTrackRegistryLock(
          rootCheck.anchor.path,
          trackValidationContextFor(rootCheck.anchor),
          async ({ registry }): Promise<CreateChangeOutcome> => {
            assertWorkflowRootAnchor(rootCheck.anchor)
            let track: TrackDefinition
            let workflowId: string
            try {
              track = requireTrackForRoot(registry, trackId, rootCheck.anchor.path, workflowRaw || undefined)
              workflowId = workflowRaw || track.workflow.default
              assertWorkflowAllowed(track, workflowId)
              const expectedPipelineId = `${workflowId}:${track.id}:main`
              if (pipelineRaw !== '' && pipelineRaw !== expectedPipelineId) {
                throw new Error(`pipeline '${pipelineRaw}' 与 workflow/track 绑定不一致（期望 ${expectedPipelineId}）`)
              }
            } catch (e) {
              return { ok: false, code: 400, error: errMsg(e) }
            }
            const selectedPipelineId = pipelineRaw || `${workflowId}:${track.id}:main`

            let initialWorkflow: {
              workflow: string
              phase: string
              openspecContract?: boolean
              documentContract?: boolean
              documentProfile?: 'legacy-full' | 'document-v1'
              documentGovernanceFingerprint?: string
              workflowPlanFingerprint?: string
              workflowPlanSnapshot?: ReturnType<typeof workflowPlanSnapshot>
            }
            let plan
            try {
              plan = loadEffectiveWorkflowPlan(rootCheck.anchor.path, workflowId, track)
            } catch (e) {
              return { ok: false, code: 404, error: errMsg(e) }
            }
            if (plan.capabilities.execution.model === 'step-graph') {
              let workflow: WorkflowDef
              try {
                workflow = builtinWorkflow(workflowId) ?? readWorkflowForApi(rootCheck.anchor, workflowId)
              } catch (e) {
                return e instanceof WorkflowNotFoundError
                  ? { ok: false, code: 404, error: `workflow '${workflowId}' 未找到（期望 .pipeline/workflows/${workflowId}.yaml）` }
                  : { ok: false, code: 400, error: errMsg(e) }
              }
              const referenceErrors = validateWorkflowTrackReferences(workflow, registry)
              if (referenceErrors.length > 0) {
                return { ok: false, code: 400, error: referenceErrors.join('；') }
              }
            }
            const first = plan.workflow.steps[0]
            if (first === undefined) {
              return { ok: false, code: 400, error: `workflow '${workflowId}' 未声明任何 step` }
            }
            initialWorkflow = {
              workflow: workflowId,
              phase: first.id,
              ...effectiveWorkflowPlanBinding(plan),
              workflowPlanSnapshot: workflowPlanSnapshot(plan),
              ...(plan.capabilities.documents.policy?.id === 'openspec-v1' ? { openspecContract: true } : {}),
              ...(plan.capabilities.documents.policy?.id === 'document-v1' ? { documentContract: true } : {}),
            }

            try {
              // project registry 锁保持到 state 独占发布完成；DELETE 持同锁扫描，二者不再有
              // “workflow 已校验但引用尚未落盘”的窗口。
              const initResult = await runRepo.initChange({
                repoRoot: root, name, track: track.id, reviewSeed: track.policyProfile.reviewSeed,
                preset: 'full', clock, initialWorkflow,
                initialFiles: [{
                  relativePath: '.pipeline-selection.json',
                  content: `${JSON.stringify({
                    schema_version: PIPELINE_SELECTION_SCHEMA,
                    pipeline_id: selectedPipelineId,
                    pipeline_version: '1',
                    workflow_id: workflowId,
                    workflow_fingerprint: plan.workflowFingerprint,
                    track_id: track.id,
                    track_revision: registry.revision,
                    source: pipelineRaw === '' ? 'automatic' : 'user',
                    selected_at: clock(),
                  }, null, 2)}\n`,
                }],
              })
              if (taskPrompt.value !== null) {
                try {
                  await writeChangeTaskPrompt(initResult.changeDir, taskPrompt.value)
                } catch (error) {
                  return {
                    ok: false,
                    code: 500,
                    error: `Change 已创建，但任务提示词未保存：${errMsg(error)}`,
                  }
                }
              }
              return {
                ok: true,
                created: initResult.changeDir,
                taskPromptSaved: taskPrompt.value !== null,
                pipelineId: selectedPipelineId,
              }
            } catch (e) {
              return { ok: false, code: 400, error: errMsg(e) }
            }
          },
        )
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: errMsg(e) })
      }
      if (!outcome.ok) return sendJson(res, outcome.code, { ok: false, error: outcome.error })
      const created = outcome.created
      // best-effort（CONTRACT §1 语义同 CLI recordHistory）：server 全源无 console，WARN 走
      // stderr——daemon 日志可见且不污染任何 HTTP 响应。
      try {
        await history.append(created, { ts: clock(), kind: 'init' })
      } catch (e) {
        process.stderr.write(`WARN: history 写入失败: ${errMsg(e)}\n`)
      }
      const session = activation.value
        ? await activateChangeSession({
          available: operationsAvailable,
          runner: operationRunner,
          repoRoot: rootCheck.anchor.path,
          changeName: name,
        })
        : notRequestedSessionActivation()
      return sendJson(res, 200, {
        ok: true,
        name,
        path: created,
        task_prompt_saved: outcome.taskPromptSaved,
        pipeline_id: outcome.pipelineId,
        session,
      })
    }

    // ── M3 config 写端点：全机唯一 manifest.yaml，无 root/name（不是按 Project 分立的资源）──

}
