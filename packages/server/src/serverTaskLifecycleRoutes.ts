/**
 * 删除 / 归档 / 取消归档 over HTTP. Every decision — reasons, refusals and records — comes from the shared
 * kernel application, so the Dashboard and the CLI can never disagree, and the server re-checks the reasons
 * under the lock rather than trusting the codes the dialog echoed back. The read is loopback-only like
 * `/history`; the writes pass the same Host + token (+ JSON) gates as every other mutation.
 */
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createTaskLifecycleApplication, USER_MISSING_HINT } from '@tenon/kernel'
import type {
  StateStore, TaskLifecycleApplication, TaskLifecycleAssessOutcome, TaskLifecycleOutcome,
  TaskLifecycleReasonCode, TenonUserResolution,
} from '@tenon/kernel'

const DELETE_FAILED = '删除失败'
/** Fixed 409 body text for every entry that refuses an archived Change. */
export const TASK_ARCHIVED_HTTP_ERROR = '任务已归档，先取消归档'
const REASON_CODES: readonly TaskLifecycleReasonCode[] = [
  'afk-running', 'afk-queued', 'review-pending', 'host-session-live', 'has-dependents', 'owned-by-other',
]

type WorkflowRootCheck =
  | { ok: true; anchor: { path: string } }
  | { ok: false; code: 403 | 404; error: string }

export interface TaskLifecycleRouteDeps {
  readonly app: TaskLifecycleApplication
  readonly viewer: (root: string) => TenonUserResolution
  /** Drop the cached artifact service of a Change whose directory is gone. */
  readonly evictChange: (changeDir: string) => void
}

export interface TaskLifecycleHandlerDeps {
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  readonly workflowRootForRequest: (root: string) => WorkflowRootCheck
  readonly taskLifecycle?: TaskLifecycleRouteDeps
}

/** The archive / unarchive writes are the only handler that reads a body. */
export interface TaskLifecycleBodyDeps extends TaskLifecycleHandlerDeps {
  readonly readJsonBody: (req: IncomingMessage) => Promise<unknown>
}

/**
 * One shared application for the CLI and the server, plus the artifact-service cache eviction a deleted
 * Change needs (its directory is gone, so a cached service would point at nothing).
 */
export function createTaskLifecycleRouteDeps(input: {
  readonly store: StateStore
  readonly clock: () => string
  readonly viewer: (root: string) => TenonUserResolution
  readonly artifactServices: Map<string, unknown>
}): TaskLifecycleRouteDeps {
  return {
    app: createTaskLifecycleApplication({ store: input.store, clock: input.clock, nowMs: () => Date.now() }),
    viewer: input.viewer,
    evictChange: (changeDir) => { input.artifactServices.delete(changeDir) },
  }
}

/** Fixed mapping for every outcome that writes nothing; `null` means the action succeeded. */
function refusalOf(
  outcome: TaskLifecycleOutcome | Extract<TaskLifecycleAssessOutcome, { kind: string }>,
): { status: number; body: Record<string, unknown> } | null {
  switch (outcome.kind) {
    case 'invalid-name':
      return { status: 400, body: { ok: false, code: 'invalid-name', error: '非法 change 名（仅允许 a-z A-Z 0-9 - _，且不能是 archive）' } }
    case 'not-found':
      return { status: 404, body: { ok: false, code: 'task-not-found', error: '找不到该 change（无 canonical/legacy 状态）' } }
    case 'identity-missing':
      return { status: 412, body: { ok: false, code: 'user-missing', error: USER_MISSING_HINT } }
    case 'blocked':
      return { status: 409, body: { ok: false, code: 'task-blocked', error: '任务被阻止', reasons: outcome.reasons } }
    case 'confirmation-required':
      return { status: 409, body: { ok: false, code: 'confirmation-required', error: '需要确认', reasons: outcome.reasons } }
    case 'archive-store-corrupt':
      return { status: 409, body: { ok: false, code: 'archive-store-corrupt', error: `归档记录损坏: ${outcome.path}` } }
    case 'delete-failed':
      return { status: 500, body: { ok: false, code: 'delete-failed', error: DELETE_FAILED } }
    default:
      return null
  }
}

function codesOf(values: readonly unknown[]): readonly TaskLifecycleReasonCode[] | null {
  const codes: TaskLifecycleReasonCode[] = []
  for (const value of values) {
    const code = REASON_CODES.find((known) => known === value)
    if (code === undefined) return null
    codes.push(code)
  }
  return codes
}

export async function handleTaskLifecycleGet(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: TaskLifecycleHandlerDeps,
): Promise<boolean> {
  const match = /^\/api\/change\/([^/]+)\/lifecycle$/u.exec(path)
  if (!match || deps.taskLifecycle === undefined) return false
  const { sendJson, workflowRootForRequest, taskLifecycle } = deps
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const action = query.get('action') ?? ''
  if (action !== 'delete' && action !== 'archive') {
    sendJson(res, 400, { ok: false, code: 'invalid-action', error: 'action 须为 delete | archive' })
    return true
  }
  const rootCheck = workflowRootForRequest(query.get('root') ?? '')
  if (!rootCheck.ok) {
    sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
    return true
  }
  const repoRoot = rootCheck.anchor.path
  const assessed = await taskLifecycle.app.assess({
    repoRoot,
    change: decodeURIComponent(match[1] ?? ''),
    action,
    user: taskLifecycle.viewer(repoRoot),
  })
  if ('kind' in assessed) {
    const refusal = refusalOf(assessed)
    sendJson(res, refusal?.status ?? 500, refusal?.body ?? { ok: false, error: DELETE_FAILED })
    return true
  }
  sendJson(res, 200, {
    ok: true,
    action: assessed.action,
    phase: assessed.phase,
    blockers: assessed.blockers,
    confirmations: assessed.confirmations,
  })
  return true
}

export async function handleTaskLifecyclePost(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: TaskLifecycleBodyDeps,
): Promise<boolean> {
  const match = /^\/api\/change\/([^/]+)\/(archive|unarchive)$/u.exec(path)
  if (!match || deps.taskLifecycle === undefined) return false
  const { sendJson, readJsonBody, workflowRootForRequest, taskLifecycle } = deps
  const body = await readJsonBody(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
    return true
  }
  const input = body as Record<string, unknown>
  const raw = input.acknowledged
  const acknowledged = raw === undefined ? [] : Array.isArray(raw) ? codesOf(raw) : null
  if (acknowledged === null) {
    sendJson(res, 400, { ok: false, error: 'acknowledged 须为已知原因码数组' })
    return true
  }
  const rootCheck = workflowRootForRequest(typeof input.root === 'string' ? input.root : '')
  if (!rootCheck.ok) {
    sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
    return true
  }
  const repoRoot = rootCheck.anchor.path
  const change = decodeURIComponent(match[1] ?? '')
  const command = { repoRoot, change, user: taskLifecycle.viewer(repoRoot), channel: 'dashboard' as const }
  const outcome = match[2] === 'archive'
    ? await taskLifecycle.app.archive({ ...command, acknowledged })
    : await taskLifecycle.app.unarchive(command)
  const refusal = refusalOf(outcome)
  if (refusal !== null) {
    sendJson(res, refusal.status, refusal.body)
    return true
  }
  if (outcome.kind === 'archived') {
    sendJson(res, 200, {
      ok: true, changed: outcome.changed, archived_at: outcome.entry.archivedAt, phase: outcome.entry.phase,
    })
    return true
  }
  sendJson(res, outcome.kind === 'unarchived' ? 200 : 500, outcome.kind === 'unarchived'
    ? { ok: true, changed: outcome.changed }
    : { ok: false, code: 'delete-failed', error: DELETE_FAILED })
  return true
}

export async function handleTaskLifecycleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: TaskLifecycleHandlerDeps,
): Promise<boolean> {
  const match = /^\/api\/change\/([^/]+)$/u.exec(path)
  if (!match || deps.taskLifecycle === undefined) return false
  const { sendJson, workflowRootForRequest, taskLifecycle } = deps
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const csv = query.get('acknowledged') ?? ''
  const acknowledged = csv === '' ? [] : codesOf(csv.split(','))
  if (acknowledged === null) {
    sendJson(res, 400, { ok: false, error: 'acknowledged 须为已知原因码列表' })
    return true
  }
  const rootCheck = workflowRootForRequest(query.get('root') ?? '')
  if (!rootCheck.ok) {
    sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
    return true
  }
  const repoRoot = rootCheck.anchor.path
  const change = decodeURIComponent(match[1] ?? '')
  const outcome = await taskLifecycle.app.delete({
    repoRoot, change, user: taskLifecycle.viewer(repoRoot), channel: 'dashboard', acknowledged,
  })
  const refusal = refusalOf(outcome)
  if (refusal !== null) {
    sendJson(res, refusal.status, refusal.body)
    return true
  }
  if (outcome.kind !== 'deleted') {
    sendJson(res, 500, { ok: false, code: 'delete-failed', error: DELETE_FAILED })
    return true
  }
  taskLifecycle.evictChange(join(repoRoot, 'openspec', 'changes', change))
  sendJson(res, 200, {
    ok: true, removed: outcome.removed, uncommittedDeletions: outcome.uncommittedDeletions,
  })
  return true
}
