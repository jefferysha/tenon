import { appendFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acknowledgeReview,
  executeReviewAcknowledgeCommand,
  parseReviewMarker,
  projectPendingDecisions,
  readCurrentRunRevision,
  readReviewGateBinding,
  reviewGateBindingMatches,
  reviewGateEvent,
  createInteractionEventRecorder,
  reviewAcknowledgedInteractionDraft,
  REVIEW_MARKER_FILE,
  stateStorageExistsSync,
  type DecisionCommandResult,
} from '@tenon/kernel'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PostRouteDeps } from './serverPostRoutes.js'

const DECISION_IDEMPOTENCY_FILE = '.pipeline-decision-idempotency.jsonl'
const DECISION_IDEMPOTENCY_MAX_BYTES = 1024 * 1024

type DecisionIdempotencyRecord = {
  readonly key: string
  readonly ref: string
  readonly expectedRevision: number | null
  readonly channel: 'dashboard'
  /** Stable digest of the complete command payload (legacy records may omit it). */
  readonly payloadDigest?: string
  readonly acknowledgedAt: string
  readonly outcome?: 'rejected'
  readonly error?: string
  readonly code?: string
}

type DecisionRouteDeps = Pick<PostRouteDeps, 'sendJson' | 'readJsonBody' | 'isRegisteredRoot' | 'store' | 'clock' | 'history'>

function isDecisionIdempotencyRecord(value: unknown): value is DecisionIdempotencyRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.key === 'string'
    && typeof record.ref === 'string'
    && (typeof record.expectedRevision === 'number' || record.expectedRevision === null)
    && record.channel === 'dashboard'
    && (record.payloadDigest === undefined || typeof record.payloadDigest === 'string')
    && typeof record.acknowledgedAt === 'string'
    && (record.outcome === undefined || record.outcome === 'rejected')
    && (record.error === undefined || typeof record.error === 'string')
    && (record.code === undefined || typeof record.code === 'string')
}

function commandPayloadDigest(ref: string, expectedRevision: number | null, channel: 'dashboard'): string {
  // The route accepts only review/dashboard commands today; keep the digest explicit so future
  // command kinds/channels cannot accidentally replay under the same idempotency key.
  return `${channel}\0${ref}\0${expectedRevision === null ? 'null' : expectedRevision}`
}

async function readDecisionIdempotency(changeDir: string): Promise<readonly DecisionIdempotencyRecord[]> {
  try {
    const raw = await readFile(join(changeDir, DECISION_IDEMPOTENCY_FILE), 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > DECISION_IDEMPOTENCY_MAX_BYTES) {
      throw new Error('decision idempotency record exceeds size limit')
    }
    if (raw === '') return []
    if (!raw.endsWith('\n')) throw new Error('decision idempotency record is truncated')
    return raw.split('\n').filter(Boolean).map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isDecisionIdempotencyRecord(parsed)) throw new Error('decision idempotency record is invalid')
      return parsed
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function appendDecisionIdempotency(changeDir: string, record: DecisionIdempotencyRecord): Promise<void> {
  await appendFile(join(changeDir, DECISION_IDEMPOTENCY_FILE), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
}

/** Handle Dashboard review decisions; returns false when the path belongs to another route. */
export async function handlePostDecisionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: DecisionRouteDeps,
): Promise<boolean> {
  const match = /^\/api\/change\/([^/]+)\/decisions$/.exec(path)
  if (!match) return false
  const { readJsonBody, sendJson, isRegisteredRoot, store, clock, history } = deps
  const body = await readJsonBody(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
    return true
  }
  const input = body as Record<string, unknown>
  const root = typeof input.root === 'string' ? input.root : ''
  const ref = typeof input.ref === 'string' ? input.ref : ''
  const expectedRevision = typeof input.expected_revision === 'number' ? input.expected_revision : null
  const idempotencyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key : ''
  if (!root || !ref || expectedRevision === null || !idempotencyKey) {
    sendJson(res, 400, { ok: false, error: 'root / ref / expected_revision / idempotency_key 为必填' })
    return true
  }
  if (!isRegisteredRoot(root)) {
    sendJson(res, 404, { ok: false, error: 'root 非已知 Project（未注册或不可信）' })
    return true
  }
  const name = decodeURIComponent(match[1] ?? '')
  if (!/^[A-Za-z0-9_-]+$/.test(name) || name.includes('..')) {
    sendJson(res, 400, { ok: false, error: '非法 change 名' })
    return true
  }
  const dir = join(root, 'openspec', 'changes', name)
  if (!stateStorageExistsSync(dir)) {
    sendJson(res, 400, { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' })
    return true
  }
  try {
    const outcome = await applyDecision({ dir, root, name, ref, expectedRevision, idempotencyKey, store, clock, history })
    if (!outcome.result.ok) {
      sendJson(res, 409, { ok: false, error: outcome.result.message, code: outcome.result.code })
      return true
    }
    sendJson(res, 200, {
      ok: true, ref, changed: !outcome.result.idempotent, idempotent: outcome.result.idempotent,
      channel: 'dashboard', deferred: outcome.deferred,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : message === 'decision revision conflict' ? 'revision-conflict' : 'review-approval-required'
    const status = ['revision-conflict', 'decision-ref-mismatch', 'idempotency-conflict', 'decision-not-pending', 'review-approval-required'].includes(code) ? 409 : 500
    sendJson(res, status, { ok: false, error: message, code })
  }
  return true
}

async function applyDecision(input: {
  readonly dir: string
  readonly root: string
  readonly name: string
  readonly ref: string
  readonly expectedRevision: number
  readonly idempotencyKey: string
  readonly store: PostRouteDeps['store']
  readonly clock: () => string
  readonly history: PostRouteDeps['history']
}): Promise<{ readonly result: DecisionCommandResult; readonly deferred: readonly string[] }> {
  const preflight = await input.store.read(input.dir)
  const view = projectPendingDecisions({ change: input.name, state: preflight })
  const item = view.items.find((candidate) => candidate.ref.id === input.ref)
  const priorForKey = item === undefined
    ? (await readDecisionIdempotency(input.dir)).find((record) => record.key === input.idempotencyKey)
    : undefined
  if ((item === undefined || item.type !== 'review') && priorForKey === undefined) {
    return { result: { ok: false, code: 'decision-not-pending', message: 'decision is no longer pending' }, deferred: [] }
  }
  const phase = item?.anchor.phase ?? String(preflight.fields.review_gate_phase ?? '')
  const event = item?.anchor.event ?? reviewGateEvent(preflight)
  let deferred: readonly string[] = []
  const payloadDigest = commandPayloadDigest(input.ref, input.expectedRevision, 'dashboard')
  const command = await executeReviewAcknowledgeCommand({
    withLock: (fn) => input.store.withLock(input.dir, fn),
    readState: () => input.store.read(input.dir),
    readRevision: async () => (await readCurrentRunRevision(input.dir))?.revision ?? null,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
    checkIdempotency: async (key) => {
      const prior = (await readDecisionIdempotency(input.dir)).find((record) => record.key === key)
      if (prior === undefined) return 'missing'
      const priorDigest = prior.payloadDigest ?? commandPayloadDigest(prior.ref, prior.expectedRevision, prior.channel)
      if (priorDigest !== payloadDigest) return 'conflict'
      return prior.outcome === 'rejected' ? 'rejected' : 'replay'
    },
    rememberIdempotencyKey: async (key) => appendDecisionIdempotency(input.dir, {
      key, ref: input.ref, expectedRevision: input.expectedRevision, channel: 'dashboard', payloadDigest, acknowledgedAt: input.clock(),
    }),
    phase, event, acknowledgedAt: input.clock(), via: 'dashboard',
    rejectedCode: 'review-approval-required',
    bindingMatches: async (state) => reviewGateBindingMatches(await readReviewGateBinding(input.dir), state, phase, event),
    recordRejected: async (state, reason) => {
      await appendDecisionIdempotency(input.dir, { key: input.idempotencyKey, ref: input.ref, expectedRevision: input.expectedRevision, channel: 'dashboard', payloadDigest, acknowledgedAt: input.clock(), outcome: 'rejected', error: reason, code: reason.includes('revision') ? 'revision-conflict' : 'review-approval-required' })
      const current = await readCurrentRunRevision(input.dir)
      if (current !== undefined) {
        try {
          await createInteractionEventRecorder().recordUnderLock(input.dir, reviewAcknowledgedInteractionDraft({
            change: input.name, state, revision: current, beforeRevision: current, phase, event,
            requestedAt: String(state.fields.review_requested_at ?? ''), acknowledgedAt: input.clock(), rejected: true,
            surface: 'dashboard', actor: 'system', workflow: String(state.fields.workflow || 'default'),
            workflowHash: current.state.runMetadata?.workflowPlanFingerprint ?? '0'.repeat(64),
            track: String(state.fields.track || 'backend'),
            trackKind: ['chat', 'simple', 'pm', 'frontend', 'backend'].includes(String(state.fields.track)) ? 'built-in' : 'custom',
            workflowMode: 'default',
            pipelineStage: ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'].includes(phase) ? phase as never : 'custom',
          }))
        } catch {
          // Canonical rejection and durable idempotency remain authoritative if projection fails.
        }
      }
    },
    commit: async (state, acknowledgedAt) => {
      const before = await readCurrentRunRevision(input.dir)
      const acknowledged = await acknowledgeReview({
        state, phase, event, acknowledgedAt, bindingMatches: true, via: 'dashboard',
        writeState: async (patch) => { await input.store.writeUnderLock(input.dir, { ...state, fields: { ...state.fields, ...patch } }, { kind: 'set-many' }) },
        recordInteraction: async ({ state: interactionState, acknowledgedAt: at, rejected }) => {
          const after = await readCurrentRunRevision(input.dir)
          if (before !== undefined && after !== undefined) await createInteractionEventRecorder().recordUnderLock(input.dir, reviewAcknowledgedInteractionDraft({
            change: input.name, state: interactionState, revision: after, beforeRevision: before, phase, event,
            requestedAt: String(state.fields.review_requested_at ?? ''), acknowledgedAt: at, rejected, surface: 'dashboard', actor: 'system',
            workflow: String(interactionState.fields.workflow || 'default'), workflowHash: after.state.runMetadata?.workflowPlanFingerprint ?? '0'.repeat(64),
            track: String(interactionState.fields.track || 'backend'), trackKind: 'built-in', workflowMode: 'default', pipelineStage: phase as never,
          }))
        },
        recordHistory: async ({ acknowledgedAt: at }) => input.history.append(input.dir, { ts: at, kind: 'tool', raw: `review:acknowledge via=dashboard phase=${phase} event=${event}` }),
        recordRejectedAcknowledgement: async ({ acknowledgedAt: at }) => input.history.append(input.dir, { ts: at, kind: 'tool', raw: `review:acknowledge-rejected via=dashboard phase=${phase} event=${event}` }),
        clearMarker: async () => {
          const marker = join(input.root, REVIEW_MARKER_FILE)
          try { const receipt = parseReviewMarker(await readFile(marker, 'utf8')); if (receipt?.changeName !== input.name || receipt.event !== event) return false; await unlink(marker); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
        },
      })
      deferred = acknowledged.deferred
      return { deferred }
    },
  })
  if (!command.ok) {
    const code = command.code === 'invalid-input' ? 'invalid-command' : command.code
    return { result: { ok: false, code, message: command.message }, deferred }
  }
  const ref = item?.ref ?? { id: input.ref, kind: 'review' as const, change: input.name, anchor: `${phase}:${event}`, revision: input.expectedRevision }
  return { result: { ok: true, idempotent: command.idempotent, ref }, deferred }
}
