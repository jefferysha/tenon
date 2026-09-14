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
  classifyInteractionWorkflowIdentity,
  createInteractionEvent,
  REVIEW_MARKER_FILE,
  stateStorageExistsSync,
  type DecisionCommandResult,
  isReviewDecisionIdempotencyRecord,
  REVIEW_DECISION_IDEMPOTENCY_FILE,
  REVIEW_DECISION_IDEMPOTENCY_MAX_BYTES,
  reviewDecisionPayloadDigest,
  type ReviewDecisionIdempotencyRecord,
} from '@tenon/kernel'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PostRouteDeps } from './serverPostRoutes.js'
import { readPendingDecisionProjection } from './decisionProjection.js'

type DecisionRouteDeps = Pick<PostRouteDeps, 'sendJson' | 'readJsonBody' | 'isRegisteredRoot' | 'store' | 'clock' | 'history' | 'recordStore'>

async function readDecisionIdempotency(changeDir: string): Promise<readonly ReviewDecisionIdempotencyRecord[]> {
  try {
    const raw = await readFile(join(changeDir, REVIEW_DECISION_IDEMPOTENCY_FILE), 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > REVIEW_DECISION_IDEMPOTENCY_MAX_BYTES) {
      throw new Error('decision idempotency record exceeds size limit')
    }
    if (raw === '') return []
    if (!raw.endsWith('\n')) throw new Error('decision idempotency record is truncated')
    return raw.split('\n').filter(Boolean).map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isReviewDecisionIdempotencyRecord(parsed)) throw new Error('decision idempotency record is invalid')
      return parsed
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function appendDecisionIdempotency(changeDir: string, record: ReviewDecisionIdempotencyRecord): Promise<void> {
  await appendFile(join(changeDir, REVIEW_DECISION_IDEMPOTENCY_FILE), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
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
    const outcome = await applyDecision({ dir, root, name, ref, expectedRevision, idempotencyKey, store, recordStore: deps.recordStore, clock, history })
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
      ? error.code : undefined
    const status = code !== undefined && ['revision-conflict', 'decision-ref-mismatch', 'idempotency-conflict', 'decision-not-pending', 'review-approval-required'].includes(code) ? 409 : 500
    sendJson(res, status, { ok: false, error: message, ...(code === undefined ? {} : { code }) })
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
  readonly recordStore?: import('@tenon/kernel').TransitionRecordStore
  readonly clock: () => string
  readonly history: PostRouteDeps['history']
}): Promise<{ readonly result: DecisionCommandResult; readonly deferred: readonly string[] }> {
  const preflight = await input.store.read(input.dir)
  const view = await readPendingDecisionProjection({
    change: input.name, dir: input.dir, store: input.store, recordStore: input.recordStore,
  })
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
  const payloadDigest = reviewDecisionPayloadDigest(input.ref, input.expectedRevision, 'dashboard')
  const command = await executeReviewAcknowledgeCommand({
    withLock: (fn) => input.store.withLock(input.dir, fn),
    readState: () => input.store.read(input.dir),
    readRevision: async () => (await readCurrentRunRevision(input.dir))?.revision ?? null,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
    checkIdempotency: async (key) => {
      const prior = (await readDecisionIdempotency(input.dir)).find((record) => record.key === key)
      if (prior === undefined) return 'missing'
      const priorDigest = prior.payloadDigest ?? reviewDecisionPayloadDigest(prior.ref, prior.expectedRevision, prior.channel)
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
            ...classifyInteractionWorkflowIdentity({
              workflow: String(state.fields.workflow || 'default'),
              track: String(state.fields.track || 'backend'),
              step: phase,
            }),
          }))
        } catch {
          // Canonical rejection and durable idempotency remain authoritative if projection fails.
        }
      }
    },
    commit: async (state, acknowledgedAt) => {
      const before = await readCurrentRunRevision(input.dir)
      if (before === undefined) throw new Error('interaction projection 缺 canonical run/workflow/state anchor')
      const workflow = String(state.fields.workflow || 'default')
      const track = String(state.fields.track || 'backend')
      // Validate the exact custom/default identity while the Change lock is held and before
      // writeState. The actual event is encoded again after the canonical revision advances.
      createInteractionEvent({
        ...reviewAcknowledgedInteractionDraft({
          change: input.name, state, revision: before, beforeRevision: before,
          phase, event, requestedAt: String(state.fields.review_requested_at || ''),
          acknowledgedAt, surface: 'dashboard', actor: 'system', workflow,
          workflowHash: before.state.runMetadata?.workflowPlanFingerprint ?? '0'.repeat(64),
          track, ...classifyInteractionWorkflowIdentity({ workflow, track, step: phase }),
        }), sequence: 1, previousEventHash: null,
      })
      const acknowledged = await acknowledgeReview({
        state, phase, event, acknowledgedAt, bindingMatches: true, via: 'dashboard',
        writeState: async (patch) => { await input.store.writeUnderLock(input.dir, { ...state, fields: { ...state.fields, ...patch } }, { kind: 'set-many' }) },
        recordInteraction: async ({ state: interactionState, acknowledgedAt: at, rejected }) => {
          const after = await readCurrentRunRevision(input.dir)
          if (before !== undefined && after !== undefined) await createInteractionEventRecorder().recordUnderLock(input.dir, reviewAcknowledgedInteractionDraft({
            change: input.name, state: interactionState, revision: after, beforeRevision: before, phase, event,
            requestedAt: String(state.fields.review_requested_at ?? ''), acknowledgedAt: at, rejected, surface: 'dashboard', actor: 'system',
            workflow: String(interactionState.fields.workflow || 'default'), workflowHash: after.state.runMetadata?.workflowPlanFingerprint ?? '0'.repeat(64),
            track: String(interactionState.fields.track || 'backend'),
            ...classifyInteractionWorkflowIdentity({
              workflow: String(interactionState.fields.workflow || 'default'),
              track: String(interactionState.fields.track || 'backend'),
              step: phase,
            }),
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
