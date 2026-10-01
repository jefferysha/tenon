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

/** A test-plan waiver frozen in the review request: approving the review approves it. */
export interface PendingWaiver {
  readonly key: string
  readonly reason: string
}

/** A protected test-configuration change (catalog, baseline, known failures, project workflow) frozen in the review request. */
export interface PendingProtectedChange {
  readonly path: string
  readonly kind: 'catalog' | 'baseline' | 'known-failures' | 'workflow'
  readonly status: 'added' | 'modified' | 'deleted'
  readonly digest: string
  /** `outside-command`: changed after the Tenon command that last wrote it. */
  readonly origin: 'pending' | 'outside-command'
}

export interface PendingDecisionView {
  readonly schemaVersion: 'pending-decision-view/v1'
  readonly revision: number | null
  readonly items: readonly PendingDecision[]
  /** Waivers that approving the pending review approves (empty when none / no pending review). */
  readonly waivers: readonly PendingWaiver[]
  /** Protected test-configuration changes that approving the pending review approves (empty when none). */
  readonly protectedChanges: readonly PendingProtectedChange[]
}

export type WaiverSkipReason = 'missing' | 'reason-changed' | 'already-approved'

export interface ReviewAcknowledgeResponse {
  readonly ok: true
  readonly ref: string
  readonly changed: boolean
  readonly idempotent: boolean
  readonly channel: 'dashboard'
  /** What the approval did to the waivers frozen in the request. */
  readonly waivers: {
    readonly approved: readonly string[]
    readonly skipped: readonly { readonly key: string; readonly why: WaiverSkipReason }[]
  }
  /** What the approval did to the protected configuration changes frozen in the request. */
  readonly protectedChanges: { readonly approved: readonly string[] }
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

function decodeWaiver(value: unknown): PendingWaiver | null {
  return isRecord(value) && isString(value.key) && value.key !== '' && isString(value.reason) ? { key: value.key, reason: value.reason } : null
}

/** A server without waiver support omits the list; a present but malformed list rejects the response. */
function decodeWaivers(value: unknown): readonly PendingWaiver[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const waivers = value.map(decodeWaiver)
  return waivers.some((waiver) => waiver === null) ? null : waivers as PendingWaiver[]
}

const PROTECTED_KINDS: readonly string[] = ['catalog', 'baseline', 'known-failures', 'workflow']
const PROTECTED_STATUSES: readonly string[] = ['added', 'modified', 'deleted']

function decodeProtected(value: unknown): PendingProtectedChange | null {
  if (!isRecord(value) || !isString(value.path) || value.path === '' || !isString(value.kind) || !PROTECTED_KINDS.includes(value.kind)) return null
  if (!isString(value.status) || !PROTECTED_STATUSES.includes(value.status) || !isString(value.digest)) return null
  if (value.origin !== 'pending' && value.origin !== 'outside-command') return null
  return {
    path: value.path, kind: value.kind as PendingProtectedChange['kind'], status: value.status as PendingProtectedChange['status'],
    digest: value.digest, origin: value.origin,
  }
}

/** A server without protected-change support omits the list; a present but malformed list rejects the response. */
function decodeProtectedList(value: unknown): readonly PendingProtectedChange[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const items = value.map(decodeProtected)
  return items.some((item) => item === null) ? null : items as PendingProtectedChange[]
}

function decodeView(value: unknown): PendingDecisionView | null {
  if (!isRecord(value) || value.schemaVersion !== 'pending-decision-view/v1' || !isNullableRevision(value.revision) || !Array.isArray(value.items)) return null
  const items = value.items.map(decodeItem)
  if (items.some((item) => item === null)) return null
  const waivers = decodeWaivers(value.waivers)
  const protectedChanges = decodeProtectedList(value.protectedChanges)
  if (waivers === null || protectedChanges === null) return null
  return { schemaVersion: value.schemaVersion, revision: value.revision, items: items as PendingDecision[], waivers, protectedChanges }
}

function isSkipReason(value: unknown): value is WaiverSkipReason {
  return value === 'missing' || value === 'reason-changed' || value === 'already-approved'
}

function decodeOutcome(value: unknown): ReviewAcknowledgeResponse['waivers'] | null {
  if (value === undefined) return { approved: [], skipped: [] }
  if (!isRecord(value) || !Array.isArray(value.approved) || !value.approved.every(isString) || !Array.isArray(value.skipped)) return null
  const skipped: { key: string; why: WaiverSkipReason }[] = []
  for (const item of value.skipped) {
    if (!isRecord(item) || !isString(item.key) || !isSkipReason(item.why)) return null
    skipped.push({ key: item.key, why: item.why })
  }
  return { approved: value.approved, skipped }
}

function decodeAcknowledge(value: unknown): ReviewAcknowledgeResponse | null {
  if (!isRecord(value) || value.ok !== true || !isString(value.ref) || typeof value.changed !== 'boolean' || typeof value.idempotent !== 'boolean' || value.channel !== 'dashboard') return null
  const waivers = decodeOutcome(value.waivers)
  const approvedProtected = isRecord(value.protectedChanges) && Array.isArray(value.protectedChanges.approved) && value.protectedChanges.approved.every(isString)
    ? value.protectedChanges.approved
    : []
  return waivers === null ? null : {
    ok: true, ref: value.ref, changed: value.changed, idempotent: value.idempotent, channel: 'dashboard', waivers,
    protectedChanges: { approved: approvedProtected },
  }
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

/** Request header that carries the proof-of-presence nonce on the approval. */
export const PRESENCE_HEADER = 'X-Tenon-Presence'

/**
 * Step one of a human approval: the server issues a short-lived, single-use nonce bound to this
 * session, change, ref and revision.  Call it from the click that confirms the approval, never ahead
 * of time: the nonce is what proves a person acted on this page for this exact review.
 */
async function requestPresenceNonce(input: { root: string; change: string; ref: string; expectedRevision: number }): Promise<string> {
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(input.change)}/decisions/presence`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ root: input.root, ref: input.ref, expected_revision: input.expectedRevision }),
    })
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwApiError(response, '复核确认失败')
  const body = await readJson(response)
  if (!isRecord(body) || body.ok !== true || !isString(body.nonce) || body.nonce === '') throw new ApiError('在场证明响应格式无效', response.status)
  return body.nonce
}

export async function postReviewAcknowledge(input: { root: string; change: string; ref: string; expectedRevision: number }): Promise<ReviewAcknowledgeResponse> {
  const nonce = await requestPresenceNonce(input)
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(input.change)}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, [PRESENCE_HEADER]: nonce },
      body: JSON.stringify({ root: input.root, ref: input.ref, expected_revision: input.expectedRevision, idempotency_key: reviewIdempotencyKey(input.ref, input.expectedRevision) }),
    })
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwApiError(response, '复核确认失败')
  const value = decodeAcknowledge(await readJson(response))
  if (!value) throw new ApiError('复核确认响应格式无效', response.status)
  return value
}
