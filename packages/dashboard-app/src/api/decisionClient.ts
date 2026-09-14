import { ApiError, getToken, isRecord, readJson, throwApiError, wrapNetwork } from './transport'

export type DecisionKind = 'review' | 'skill-question' | 'afk'
export type DecisionStatus = 'pending' | 'answered' | 'consumed' | 'superseded' | 'expired' | 'unknown'
export type DecisionChannel = 'terminal' | 'dashboard' | 'automation' | 'delegated' | 'unknown'

export interface PendingDecision {
  readonly ref: { readonly id: string; readonly kind: DecisionKind; readonly change: string; readonly anchor: string; readonly revision: number | null }
  readonly type: DecisionKind
  readonly status: DecisionStatus
  readonly anchor: { readonly phase?: string; readonly event?: string; readonly invocationId?: string; readonly questionId?: string }
  readonly revision: number | null
  readonly evidence: readonly string[]
  readonly source: DecisionChannel
  readonly channel: DecisionChannel
  readonly command: 'review-acknowledge' | 'skill-answer'
}

export interface PendingDecisionView {
  readonly schemaVersion: 'pending-decision-view/v1'
  readonly revision: number | null
  readonly items: readonly PendingDecision[]
}

export interface ReviewAcknowledgeResponse {
  readonly ok: true
  readonly ref: string
  readonly changed: boolean
  readonly idempotent: boolean
  readonly channel: 'dashboard'
}

function isString(value: unknown): value is string { return typeof value === 'string' }
function isDecisionKind(value: unknown): value is DecisionKind { return value === 'review' || value === 'skill-question' || value === 'afk' }
function isStatus(value: unknown): value is DecisionStatus {
  return value === 'pending' || value === 'answered' || value === 'consumed' || value === 'superseded' || value === 'expired' || value === 'unknown'
}
function isChannel(value: unknown): value is DecisionChannel {
  return value === 'terminal' || value === 'dashboard' || value === 'automation' || value === 'delegated' || value === 'unknown'
}
function isNullableRevision(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) }
/** Kernel ref ids are `decision:<16 hex>`; the cap keeps the derived idempotency key bounded. */
export const DECISION_REF_ID_MAX_LENGTH = 128
function isRefId(value: unknown): value is string { return isString(value) && value.length > 0 && value.length <= DECISION_REF_ID_MAX_LENGTH }
function decodeItem(value: unknown): PendingDecision | null {
  if (!isRecord(value) || !isRecord(value.ref) || !isRecord(value.anchor)) return null
  if (!isRefId(value.ref.id) || !isDecisionKind(value.ref.kind) || !isString(value.ref.change) || !isString(value.ref.anchor) || !isNullableRevision(value.ref.revision)) return null
  if (!isDecisionKind(value.type) || !isStatus(value.status) || !isNullableRevision(value.revision) || !Array.isArray(value.evidence) || !value.evidence.every(isString)) return null
  if (!isChannel(value.source) || !isChannel(value.channel)) return null
  if (value.command !== 'review-acknowledge' && value.command !== 'skill-answer') return null
  const anchor: { phase?: string; event?: string; invocationId?: string; questionId?: string } = {}
  for (const key of ['phase', 'event', 'invocationId', 'questionId'] as const) if (value.anchor[key] !== undefined) {
    if (!isString(value.anchor[key])) return null
    anchor[key] = value.anchor[key]
  }
  return {
    ref: { id: value.ref.id, kind: value.ref.kind, change: value.ref.change, anchor: value.ref.anchor, revision: value.ref.revision },
    type: value.type,
    status: value.status,
    anchor,
    revision: value.revision,
    evidence: value.evidence,
    source: value.source as PendingDecision['source'],
    channel: value.channel,
    command: value.command,
  }
}

function decodeView(value: unknown): PendingDecisionView | null {
  if (!isRecord(value) || value.schemaVersion !== 'pending-decision-view/v1' || !isNullableRevision(value.revision) || !Array.isArray(value.items)) return null
  const items = value.items.map(decodeItem)
  if (items.some((item) => item === null)) return null
  return { schemaVersion: value.schemaVersion, revision: value.revision, items: items as PendingDecision[] }
}

function decodeAcknowledge(value: unknown): ReviewAcknowledgeResponse | null {
  return isRecord(value) && value.ok === true && isString(value.ref) && typeof value.changed === 'boolean' && typeof value.idempotent === 'boolean' && value.channel === 'dashboard'
    ? { ok: true, ref: value.ref, changed: value.changed, idempotent: value.idempotent, channel: 'dashboard' }
    : null
}

export async function fetchPendingDecisions(root: string, change: string, signal?: AbortSignal): Promise<PendingDecisionView> {
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(change)}/pending-decisions?root=${encodeURIComponent(root)}`, { headers: { Accept: 'application/json' }, signal })
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwApiError(response, '待决策获取失败')
  const value = decodeView(await readJson(response))
  if (!value) throw new ApiError('待决策响应格式无效', response.status)
  return value
}

/**
 * The key is a lossless base64url encoding of ref + revision, so a retry of the same decision at the
 * same revision replays the stored result, while a refreshed revision is a distinct command. The
 * alphabet stays within `[A-Za-z0-9_-]`.
 */
export function reviewIdempotencyKey(ref: string, expectedRevision: number): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(`${ref}\n${expectedRevision}`)) binary += String.fromCharCode(byte)
  return `dashboard-review-${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

export async function postReviewAcknowledge(input: { root: string; change: string; ref: string; expectedRevision: number }): Promise<ReviewAcknowledgeResponse> {
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(input.change)}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ root: input.root, ref: input.ref, expected_revision: input.expectedRevision, idempotency_key: reviewIdempotencyKey(input.ref, input.expectedRevision) }),
    })
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwApiError(response, '复核确认失败')
  const value = decodeAcknowledge(await readJson(response))
  if (!value) throw new ApiError('复核确认响应格式无效', response.status)
  return value
}
