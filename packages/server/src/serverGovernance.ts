import { mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { join, resolve as resolvePath } from 'node:path'
import {
  BuiltinTrackDeleteError,
  BuiltinTrackPolicyError,
  ChangeScanFailedError,
  mutateTrackRegistry,
  RegistryRevisionConflictError,
  TrackAlreadyExistsError,
  TrackNotFoundError,
  TrackReferencedError,
  TrackReferencesInvalidatedError,
  type ChangeRefScan,
  type StateStore,
  type TrackRegistry,
  type TrackValidationContext,
} from '@tenon/kernel'
import { cliExitHttpStatus, parsePipelineCliJson, type PipelineCliRunner } from './operations.js'
import { dedupeRoots } from './snapshot.js'
import {
  assertWorkflowRootAnchor,
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  ensureWorkflowProjectCoordinationPath,
  readWorkflowForApi,
  type WorkflowRootAnchor,
} from './workflows.js'
import { errMsg } from './serverSupport.js'
import { projectFileExists } from './projectCapabilities.js'

/** 工作流路由的存储锚：root 为空 = 全局存储（首次使用时建目录并捕获锚），否则 = 已注册项目。 */
export type WorkflowStoreCheck =
  | { ok: true; anchor: WorkflowRootAnchor; global: boolean }
  | { ok: false; code: 403 | 404; error: string }

export interface ServerGovernanceOptions {
  registry: () => string[]
  /** 全局工作流存储根（产品 configRoot/workflows）：目录形状同项目，`.pipeline/workflows/*.yaml`。 */
  globalWorkflowRoot: string
  store: StateStore
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
  trackSkillProfiles: ReadonlySet<string>
  operationsAvailable: boolean
  operationRunner: PipelineCliRunner
}

export function createServerGovernance(options: ServerGovernanceOptions) {
  const { registry, globalWorkflowRoot, store, sendJson, trackSkillProfiles, operationsAvailable, operationRunner } = options
function trackRegistryBody(trackRegistry: TrackRegistry): Record<string, unknown> {
  return {
    ok: true,
    revision: trackRegistry.revision,
    source: trackRegistry.source,
    tracks: trackRegistry.ordered,
  }
}

async function scanActiveTrackChanges(root: string): Promise<ChangeRefScan> {
  const changesRoot = join(root, 'openspec', 'changes')
  let entries
  try {
    entries = await readdir(changesRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { refs: [], unreadable: [] }
    return { refs: [], unreadable: [`<changes-root>: ${errMsg(error)}`] }
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => entry.name)
    .sort()
  const refs: Array<{ name: string; track: string; workflow: string }> = []
  const unreadable: string[] = []
  for (const name of names) {
    try {
      const state = await store.read(join(changesRoot, name))
      const track = state.fields.track
      const workflow = state.fields.workflow
      refs.push({
        name,
        track: Array.isArray(track) ? track.join(',') : (track ?? ''),
        workflow: Array.isArray(workflow) ? workflow.join(',') : (workflow ?? ''),
      })
    } catch {
      unreadable.push(name)
    }
  }
  return { refs, unreadable }
}

function sendTrackError(res: ServerResponse, error: unknown): void {
  if (error instanceof RegistryRevisionConflictError) {
    return sendJson(res, 409, {
      ok: false, code: 'TRACK_REVISION_CONFLICT', error: error.message,
      expected: error.expected, actual: error.actual,
    })
  }
  if (error instanceof TrackReferencedError) {
    return sendJson(res, 409, { ok: false, code: 'TRACK_REFERENCED', error: error.message, references: error.references })
  }
  if (error instanceof TrackReferencesInvalidatedError) {
    return sendJson(res, 409, { ok: false, code: 'TRACK_REFERENCES_INVALIDATED', error: error.message, references: error.offending })
  }
  if (error instanceof ChangeScanFailedError) {
    return sendJson(res, 409, { ok: false, code: 'TRACK_REFERENCE_SCAN_FAILED', error: error.message, blockers: error.unreadable })
  }
  if (error instanceof TrackAlreadyExistsError) {
    return sendJson(res, 409, { ok: false, code: 'TRACK_ALREADY_EXISTS', error: error.message })
  }
  if (error instanceof TrackNotFoundError) {
    return sendJson(res, 404, { ok: false, code: 'TRACK_NOT_FOUND', error: error.message })
  }
  if (error instanceof BuiltinTrackDeleteError || error instanceof BuiltinTrackPolicyError) {
    return sendJson(res, 400, { ok: false, code: 'TRACK_BUILTIN_LOCKED', error: error.message })
  }
  const message = errMsg(error)
  if (message.startsWith('mutateTrackRegistry: next 未过完整校验')) {
    return sendJson(res, 400, { ok: false, code: 'TRACK_INVALID', error: message })
  }
  return sendJson(res, 500, { ok: false, error: message })
}

async function mutateTrackForApi<T>(
  anchor: WorkflowRootAnchor,
  expectedRevision: string,
  mutate: Parameters<typeof mutateTrackRegistry<T>>[2],
): Promise<ReturnType<typeof mutateTrackRegistry<T>>> {
  assertWorkflowRootAnchor(anchor)
  ensureWorkflowProjectCoordinationPath(anchor)
  return mutateTrackRegistry(anchor.path, trackValidationContextFor(anchor), async (snapshot) => {
    if (snapshot.registry.revision !== expectedRevision) {
      throw new RegistryRevisionConflictError(expectedRevision, snapshot.registry.revision)
    }
    return mutate(snapshot)
  })
}

const fileExists = projectFileExists

// 信任锚单源：19 处「两侧规范化再比较」的唯一落点——注册表条目经 dedupeRoots 已 resolve
// （且过滤空条目，防 resolvePath('')=cwd 混入可信集），提交的 root 此处同样 resolvePath，
// 两侧规范化后再比对，防止「同一路径的非规范写法（如结尾多一个斜杠）」被误判为未注册。
// 纯读谓词：判定失败后的响应（404 + 各自 error 文案）仍由调用点自持——transition 端点的
// 文案与其余 18 处不同，收敛响应会破坏行为保持。
const isRegisteredRoot = (root: string): boolean =>
  dedupeRoots(registry()).includes(resolvePath(root))

async function executeOperation(
  res: ServerResponse,
  root: string,
  args: readonly string[],
): Promise<void> {
  if (!operationsAvailable) {
    return sendJson(res, 503, { ok: false, error: 'Operations 未接线：Tenon CLI bundle 不存在' })
  }
  if (!root || !isRegisteredRoot(root)) {
    return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
  }
  try {
    const result = await operationRunner(resolvePath(root), args)
    return sendJson(res, cliExitHttpStatus(result.exitCode), {
      ok: result.exitCode === 0,
      exit_code: result.exitCode,
      command: ['pipeline', ...args],
      result: parsePipelineCliJson(result.stdout),
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
    })
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: errMsg(error) })
  }
}

// workflow CRUD 的注册根是能力锚，不是每请求可重新学习的 pathname。启动时先捕获当下已注册、
// 且确为非 symlink 目录的 inode。CLI `tenon init` 会直接原子更新同一机器级注册表，因而
// server 也允许一个*尚未有锚的、当前仍在可信注册表中的*根在首个 workflow 请求时作一次 TOFU
// 捕获；捕获成功后永不重建锚。这样既支持运行中 dashboard 发现 CLI 新建项目，也不会在已经
// 绑定的 root 被换位后把新 pathname 重新认作可信。
const workflowRootAnchors = new Map<string, WorkflowRootAnchor>()
try {
  for (const root of dedupeRoots(registry())) {
    try { workflowRootAnchors.set(root, captureWorkflowRootAnchor(root)) } catch { /* 陈旧/不安全条目隔离 */ }
  }
} catch {
  // 注册表读取本就具 best-effort 语义；读取失败时 workflow CRUD 没有锚，统一 fail-closed。
}

type WorkflowRootCheck =
  | { ok: true; anchor: WorkflowRootAnchor }
  | { ok: false; code: 403 | 404; error: string }

const workflowRootForRequest = (root: string): WorkflowRootCheck => {
  const normalized = resolvePath(root)
  if (!dedupeRoots(registry()).includes(normalized)) {
    const stale = workflowRootAnchors.get(normalized)
    if (stale) {
      closeWorkflowRootAnchor(stale)
      workflowRootAnchors.delete(normalized)
    }
    return { ok: false, code: 404, error: 'root 未在机器级项目注册表中' }
  }
  const anchor = workflowRootAnchors.get(normalized)
  if (!anchor) {
    try {
      const captured = captureWorkflowRootAnchor(normalized)
      workflowRootAnchors.set(normalized, captured)
      return { ok: true, anchor: captured }
    } catch (e) {
      return { ok: false, code: 403, error: errMsg(e) }
    }
  }
  try {
    assertWorkflowRootAnchor(anchor)
    return { ok: true, anchor }
  } catch (e) {
    return { ok: false, code: 403, error: errMsg(e) }
  }
}

let globalAnchor: WorkflowRootAnchor | null = null
const globalWorkflowStore = (): WorkflowStoreCheck => {
  try {
    if (globalAnchor === null) {
      mkdirSync(join(globalWorkflowRoot, '.pipeline', 'workflows'), { recursive: true })
      globalAnchor = captureWorkflowRootAnchor(globalWorkflowRoot)
    } else {
      assertWorkflowRootAnchor(globalAnchor)
    }
    return { ok: true, anchor: globalAnchor, global: true }
  } catch (e) {
    return { ok: false, code: 403, error: errMsg(e) }
  }
}
const workflowStoreForRequest = (root: string): WorkflowStoreCheck => {
  if (root === '') return globalWorkflowStore()
  const checked = workflowRootForRequest(root)
  return checked.ok ? { ok: true, anchor: checked.anchor, global: false } : checked
}

const trackValidationContextFor = (anchor: WorkflowRootAnchor): TrackValidationContext => ({
  workflowExists: (id) => {
    if (id === 'default') return true
    try {
      readWorkflowForApi(anchor, id)
      return true
    } catch {
      return false
    }
  },
  skillProfiles: trackSkillProfiles,
})

let boundPort = 0


  return {
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
  }
}
