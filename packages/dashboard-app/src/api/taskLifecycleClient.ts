/**
 * 删除 / 归档 / 取消归档 client. Reasons always come from the server, which re-checks them under the lock;
 * the dialog echoes back exactly the codes it displayed, so a task that started running between the two
 * calls is refused instead of acted on.
 */
import { ApiError, getToken, isRecord, readJson, wrapNetwork } from './transport'

export type TaskLifecycleAction = 'delete' | 'archive'
export type TaskReasonCode =
  | 'afk-running' | 'afk-queued' | 'review-pending' | 'host-session-live' | 'has-dependents' | 'owned-by-other'

export interface TaskReason {
  readonly code: TaskReasonCode
  readonly detail?: string
}

export interface TaskLifecycleView {
  readonly action: TaskLifecycleAction
  readonly phase: string
  readonly blockers: readonly TaskReason[]
  readonly confirmations: readonly TaskReason[]
  /** 仅删除：git 能否找回该目录；null = 探测失败，按不可恢复对待。 */
  readonly recoverable?: boolean | null
}

export interface TaskArchiveResult {
  readonly changed: boolean
  readonly archivedAt: string
  readonly phase: string
}

export interface TaskDeleteResult {
  readonly removed: readonly string[]
  readonly uncommittedDeletions: number | null
}

const REASON_CODES: readonly TaskReasonCode[] = [
  'afk-running', 'afk-queued', 'review-pending', 'host-session-live', 'has-dependents', 'owned-by-other',
]

/** A refusal that carries the reasons the server re-checked, so the dialog can show the fresh list. */
export class TaskLifecycleRefusal extends ApiError {
  constructor(message: string, status: number, code: string, readonly reasons: readonly TaskReason[]) {
    super(message, status, true, code)
    this.name = 'TaskLifecycleRefusal'
  }
}

/** Reads the body once: a reason-carrying 409 becomes a refusal, anything else the usual ApiError. */
async function throwLifecycleError(response: Response, fallback: string): Promise<never> {
  let body: unknown
  try {
    body = await readJson(response)
  } catch {
    throw new ApiError(`${fallback}（${response.status}）`, response.status)
  }
  const detail = isRecord(body) && typeof body.error === 'string' ? body.error : ''
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined
  const reasons = isRecord(body) ? decodeReasons(body.reasons) : null
  if (code !== undefined && reasons !== null) {
    throw new TaskLifecycleRefusal(detail || fallback, response.status, code, reasons)
  }
  throw new ApiError(detail || `${fallback}（${response.status}）`, response.status, detail !== '', code)
}

function decodeReason(value: unknown): TaskReason | null {
  if (!isRecord(value)) return null
  const code = REASON_CODES.find((known) => known === value.code)
  if (code === undefined) return null
  if (value.detail !== undefined && typeof value.detail !== 'string') return null
  return value.detail === undefined ? { code } : { code, detail: value.detail }
}

function decodeReasons(value: unknown): readonly TaskReason[] | null {
  if (!Array.isArray(value)) return null
  const reasons = value.map(decodeReason)
  return reasons.some((reason) => reason === null) ? null : (reasons as TaskReason[])
}

function decodeView(value: unknown): TaskLifecycleView | null {
  if (!isRecord(value) || value.ok !== true || typeof value.phase !== 'string') return null
  if (value.action !== 'delete' && value.action !== 'archive') return null
  const blockers = decodeReasons(value.blockers)
  const confirmations = decodeReasons(value.confirmations)
  if (blockers === null || confirmations === null) return null
  if (value.recoverable !== undefined && value.recoverable !== null && typeof value.recoverable !== 'boolean') return null
  return {
    action: value.action, phase: value.phase, blockers, confirmations,
    ...(value.recoverable === undefined ? {} : { recoverable: value.recoverable }),
  }
}

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` }
}

export async function fetchTaskLifecycle(
  root: string,
  change: string,
  action: TaskLifecycleAction,
  signal?: AbortSignal,
): Promise<TaskLifecycleView> {
  let response: Response
  const query = `root=${encodeURIComponent(root)}&action=${action}`
  try {
    response = await fetch(`/api/change/${encodeURIComponent(change)}/lifecycle?${query}`, {
      headers: { Accept: 'application/json' }, signal,
    })
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwLifecycleError(response, '任务操作原因获取失败')
  const value = decodeView(await readJson(response))
  if (!value) throw new ApiError('任务操作原因响应格式无效', response.status)
  return value
}

export async function archiveTask(
  input: { root: string; change: string; acknowledged: readonly TaskReasonCode[] },
): Promise<TaskArchiveResult> {
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(input.change)}/archive`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ root: input.root, acknowledged: input.acknowledged }),
    })
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwLifecycleError(response, '归档失败')
  const value = await readJson(response)
  if (!isRecord(value) || value.ok !== true || typeof value.changed !== 'boolean'
    || typeof value.archived_at !== 'string' || typeof value.phase !== 'string') {
    throw new ApiError('归档响应格式无效', response.status)
  }
  return { changed: value.changed, archivedAt: value.archived_at, phase: value.phase }
}

export async function unarchiveTask(input: { root: string; change: string }): Promise<{ changed: boolean }> {
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(input.change)}/unarchive`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ root: input.root }),
    })
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwLifecycleError(response, '取消归档失败')
  const value = await readJson(response)
  if (!isRecord(value) || value.ok !== true || typeof value.changed !== 'boolean') {
    throw new ApiError('取消归档响应格式无效', response.status)
  }
  return { changed: value.changed }
}

export async function deleteTask(
  input: { root: string; change: string; acknowledged: readonly TaskReasonCode[] },
): Promise<TaskDeleteResult> {
  let response: Response
  const acknowledged = input.acknowledged.length === 0 ? '' : `&acknowledged=${input.acknowledged.join(',')}`
  try {
    response = await fetch(
      `/api/change/${encodeURIComponent(input.change)}?root=${encodeURIComponent(input.root)}${acknowledged}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${getToken()}` } },
    )
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwLifecycleError(response, '删除失败')
  const value = await readJson(response)
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.removed)
    || !value.removed.every((entry): entry is string => typeof entry === 'string')) {
    throw new ApiError('删除响应格式无效', response.status)
  }
  const count = value.uncommittedDeletions
  if (count !== null && !(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) {
    throw new ApiError('删除响应格式无效', response.status)
  }
  return { removed: value.removed, uncommittedDeletions: count }
}
