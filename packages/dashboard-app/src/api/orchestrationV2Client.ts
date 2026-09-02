import type { BoardCommandV2, BoardEventV2, BoardSnapshotV2 } from '@tenon/kernel'
import { ApiError, getToken, isRecord, readJson, throwApiError, wrapNetwork } from './transport'

export interface OrchestrationV2Envelope {
  readonly snapshot: BoardSnapshotV2
  readonly events: readonly BoardEventV2[]
  readonly connected: boolean
  readonly error: ApiError | null
}

export type OrchestrationV2ErrorCode = 'ORCHESTRATION_V2_CHANGE_NOT_FOUND'

export class OrchestrationV2ApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    public readonly code?: OrchestrationV2ErrorCode,
    hasServerDetail = false,
  ) {
    super(message, status, hasServerDetail)
    this.name = 'OrchestrationV2ApiError'
  }
}

function orchestrationV2ErrorCode(value: unknown): value is OrchestrationV2ErrorCode {
  return value === 'ORCHESTRATION_V2_CHANGE_NOT_FOUND'
}

function validSnapshot(value: unknown): value is BoardSnapshotV2 {
  return isRecord(value)
    && value.schema_version === 'board-snapshot/v2'
    && typeof value.change_id === 'string'
    && typeof value.correlation_id === 'string'
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0
    && typeof value.status === 'string'
    && Array.isArray(value.work_items)
    && Array.isArray(value.runs)
    && Array.isArray(value.results)
    && Array.isArray(value.validations)
    && Array.isArray(value.gates)
    && Array.isArray(value.leases)
}

function validEvent(value: unknown): value is BoardEventV2 {
  return isRecord(value)
    && value.schema_version === 'board-event/v2'
    && typeof value.event_id === 'string'
    && typeof value.event_type === 'string'
    && Number.isSafeInteger(value.revision)
}

function apiPath(root: string, change: string, suffix = ''): string {
  return `/api/orchestration/changes/${encodeURIComponent(change)}${suffix}?root=${encodeURIComponent(root)}`
}

export async function fetchOrchestrationV2Snapshot(root: string, change: string, signal?: AbortSignal): Promise<BoardSnapshotV2> {
  let response: Response
  try {
    response = await fetch(apiPath(root, change), { headers: { Accept: 'application/json' }, signal })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) {
    let message = `orchestration 状态获取失败（${response.status}）`
    let code: OrchestrationV2ErrorCode | undefined
    let hasServerDetail = false
    try {
      const body = await readJson(response)
      if (isRecord(body)) {
        if (typeof body.error === 'string' && body.error !== '') {
          message = body.error
          hasServerDetail = true
        }
        if (orchestrationV2ErrorCode(body.code)) code = body.code
      }
    } catch {
      // Older servers may return a non-JSON response for an unavailable route.
    }
    throw new OrchestrationV2ApiError(message, response.status, code, hasServerDetail)
  }
  const body = await readJson(response)
  if (!isRecord(body) || body.ok !== true || !validSnapshot(body.snapshot)) throw new ApiError('orchestration snapshot response is invalid')
  return body.snapshot
}

export async function postOrchestrationV2Control(
  root: string,
  snapshot: BoardSnapshotV2,
  type: 'pause-change' | 'resume-change' | 'cancel-change',
  reason = 'operator-request',
): Promise<BoardSnapshotV2> {
  return postOrchestrationV2Command(root, snapshot, type, type === 'resume-change' ? {} : { reason })
}

export async function postOrchestrationV2Command(
  root: string,
  snapshot: BoardSnapshotV2,
  type: BoardCommandV2['type'],
  payload: Record<string, unknown> = {},
): Promise<BoardSnapshotV2> {
  const nonce = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const command = {
    schema_version: 'board-command/v2', command_id: `dashboard:${type}:${nonce}`, idempotency_key: `dashboard:${type}:${nonce}`,
    expected_revision: snapshot.revision, actor: { kind: 'user' as const, id: 'dashboard' }, issued_at: new Date().toISOString(),
    correlation_id: snapshot.correlation_id, ...(snapshot.event_head_id === undefined ? {} : { causation_id: snapshot.event_head_id }),
    change_id: snapshot.change_id, type, ...payload,
  }
  let response: Response
  try {
    response = await fetch(apiPath(root, snapshot.change_id, '/commands'), {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ root, command }),
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, 'orchestration 控制失败')
  const body = await readJson(response)
  if (!isRecord(body) || body.ok !== true || !validSnapshot(body.snapshot)) throw new ApiError('orchestration control response is invalid')
  return body.snapshot
}

export function parseOrchestrationV2Frame(event: MessageEvent): { kind: 'snapshot'; value: BoardSnapshotV2 } | { kind: 'event'; value: BoardEventV2 } | null {
  if (typeof event.data !== 'string') return null
  try {
    const value: unknown = JSON.parse(event.data)
    if (isRecord(value) && value.ok === true && validSnapshot(value.snapshot)) return { kind: 'snapshot', value: value.snapshot }
    if (validEvent(value)) return { kind: 'event', value }
  } catch {
    return null
  }
  return null
}

export function subscribeOrchestrationV2(
  root: string,
  change: string,
  onFrame: (frame: { kind: 'snapshot'; value: BoardSnapshotV2 } | { kind: 'event'; value: BoardEventV2 }) => void,
  onError?: () => void,
): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const source = new EventSource(`${apiPath(root, change, '/stream')}&after_revision=0`)
  const handle = (event: Event): void => {
    const frame = parseOrchestrationV2Frame(event as MessageEvent)
    if (frame) onFrame(frame)
    else onError?.()
  }
  source.addEventListener('snapshot', handle)
  source.addEventListener('event', handle)
  source.addEventListener('error', () => onError?.())
  return () => {
    source.removeEventListener('snapshot', handle)
    source.removeEventListener('event', handle)
    source.close()
  }
}

export function sortUniqueEvents(events: readonly BoardEventV2[]): readonly BoardEventV2[] {
  const byRevision = new Map<number, BoardEventV2>()
  for (const event of events) if (Number.isSafeInteger(event.revision)) byRevision.set(event.revision, event)
  return [...byRevision.values()].sort((left, right) => right.revision - left.revision).slice(0, 50)
}
