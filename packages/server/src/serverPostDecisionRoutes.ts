import { appendFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acknowledgeReview,
  createDecisionCommandAdapter,
  parseReviewMarker,
  projectPendingDecisions,
  readCurrentRunRevision,
  readReviewGateBinding,
  reviewGateBindingMatches,
  reviewGateEvent,
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
  readonly acknowledgedAt: string
}

type DecisionRouteDeps = Pick<PostRouteDeps, 'sendJson' | 'readJsonBody' | 'isRegisteredRoot' | 'store' | 'clock' | 'history'>

function isDecisionIdempotencyRecord(value: unknown): value is DecisionIdempotencyRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.key === 'string'
    && typeof record.ref === 'string'
    && (typeof record.expectedRevision === 'number' || record.expectedRevision === null)
    && record.channel === 'dashboard'
    && typeof record.acknowledgedAt === 'string'
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
    sendJson(res, 409, { ok: false, error: message, code })
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
  let deferred: readonly string[] = []
  let result: DecisionCommandResult | undefined
  await input.store.withLock(input.dir, async () => {
    const records = await readDecisionIdempotency(input.dir)
    const prior = records.find((record) => record.key === input.idempotencyKey)
    if (prior !== undefined && (prior.ref !== input.ref || prior.expectedRevision !== input.expectedRevision)) {
      throw Object.assign(new Error('idempotency key is already bound to another decision'), { code: 'decision-ref-mismatch' })
    }
    if (prior !== undefined) {
      result = { ok: true, idempotent: true, ref: { id: prior.ref, kind: 'review', change: input.name, anchor: '', revision: prior.expectedRevision } }
      return
    }
    const lockedRevision = await readCurrentRunRevision(input.dir)
    const locked = lockedRevision?.state ?? await input.store.read(input.dir)
    const view = projectPendingDecisions({ change: input.name, state: locked, revision: lockedRevision?.revision })
    const item = view.items.find((candidate) => candidate.ref.id === input.ref)
    if (item === undefined) throw Object.assign(new Error('decision is no longer pending'), { code: 'decision-not-pending' })
    const adapter = createDecisionCommandAdapter({
      readRevision: async () => (await readCurrentRunRevision(input.dir))?.revision ?? null,
      hasIdempotencyKey: async () => false,
      rememberIdempotencyKey: async (key) => appendDecisionIdempotency(input.dir, {
        key, ref: input.ref, expectedRevision: input.expectedRevision, channel: 'dashboard', acknowledgedAt: input.clock(),
      }),
      isPending: async (decisionRef) => projectPendingDecisions({
        change: input.name, state: await input.store.read(input.dir), revision: lockedRevision?.revision,
      }).items.some((candidate) => candidate.ref.id === decisionRef.id && candidate.type === 'review' && candidate.status === 'pending'),
      apply: async ({ ref: decisionRef }) => {
        const current = await readCurrentRunRevision(input.dir)
        const state = current?.state ?? await input.store.read(input.dir)
        const currentItem = projectPendingDecisions({ change: input.name, state, revision: current?.revision }).items.find((candidate) => candidate.ref.id === decisionRef.id)
        if (currentItem === undefined || currentItem.type !== 'review') throw new Error('decision is no longer pending')
        const phase = currentItem.anchor.phase ?? ''
        const event = currentItem.anchor.event ?? reviewGateEvent(state)
        const binding = await readReviewGateBinding(input.dir)
        const acknowledged = await acknowledgeReview({
          state, phase, event, acknowledgedAt: input.clock(),
          bindingMatches: reviewGateBindingMatches(binding, state, phase, event), via: 'dashboard',
          writeState: async (patch) => {
            await input.store.writeUnderLock(input.dir, { ...state, fields: { ...state.fields, ...patch } }, { kind: 'set-many' })
          },
          recordHistory: async ({ acknowledgedAt, phase: acknowledgedPhase, event: acknowledgedEvent }) => input.history.append(input.dir, {
            ts: acknowledgedAt, kind: 'tool', raw: `review:acknowledge via=dashboard phase=${acknowledgedPhase} event=${acknowledgedEvent}`,
          }),
          recordRejectedAcknowledgement: async ({ acknowledgedAt, phase: rejectedPhase, event: rejectedEvent }) => input.history.append(input.dir, {
            ts: acknowledgedAt, kind: 'tool', raw: `review:acknowledge-rejected via=dashboard phase=${rejectedPhase} event=${rejectedEvent}`,
          }),
          clearMarker: async () => {
            const marker = join(input.root, REVIEW_MARKER_FILE)
            try {
              const markerReceipt = parseReviewMarker(await readFile(marker, 'utf8'))
              if (markerReceipt?.changeName !== input.name || markerReceipt.event !== event) return false
              await unlink(marker)
              return true
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
              return false
            }
          },
        })
        deferred = acknowledged.deferred
      },
    })
    result = await adapter.execute({ ref: item.ref, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey, channel: 'dashboard' })
  })
  if (result === undefined) throw new Error('decision command did not produce a result')
  return { result, deferred }
}
