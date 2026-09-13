import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acknowledgeReview,
  createInteractionEventRecorder,
  createDecisionCommandAdapter,
  parseReviewMarker,
  projectPendingDecisions,
  readCurrentRunRevision,
  readReviewGateBinding,
  reviewGateBindingMatches,
  reviewGateEvent,
  REVIEW_MARKER_FILE,
  stateStorageExistsSync,
  readSkillInvocationEventsForApplication,
  type DecisionCommandResult,
} from '@tenon/kernel'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PostRouteDeps } from './serverPostRoutes.js'
import { appendDecisionAuditUnderLock, readDecisionAudit } from './decisionAudit.js'
import { appendDecisionIdempotency, readDecisionIdempotency } from './decisionIdempotency.js'
import { applyInvocationDecision } from './serverInvocationDecision.js'
import { reviewInteractionDraft } from './decisionInteraction.js'

type DecisionRouteDeps = Pick<PostRouteDeps, 'sendJson' | 'readJsonBody' | 'isRegisteredRoot' | 'store' | 'clock' | 'history'>

/** Handle Dashboard review decisions; returns false when the path belongs to another route. */
export async function handlePostDecisionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: DecisionRouteDeps,
): Promise<boolean> {
  const modeMatch = /^\/api\/change\/([^/]+)\/decision-mode$/.exec(path)
  const securityMatch = /^\/api\/change\/([^/]+)\/pending-decision-security$/.exec(path)
  const match = /^\/api\/change\/([^/]+)\/decisions$/.exec(path)
  if (!match && !modeMatch && !securityMatch) return false
  const { readJsonBody, sendJson, isRegisteredRoot, store, clock, history } = deps
  const body = await readJsonBody(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
    return true
  }
  const input = body as Record<string, unknown>
  const root = typeof input.root === 'string' ? input.root : ''
  const auditName = decodeURIComponent((modeMatch ?? securityMatch)?.[1] ?? '')
  if (modeMatch || securityMatch) {
    if (!root || !isRegisteredRoot(root) || !/^[A-Za-z0-9_-]+$/.test(auditName)) {
      sendJson(res, 400, { ok: false, error: 'root 或 change 名非法' })
      return true
    }
    const dir = join(root, 'openspec', 'changes', auditName)
    if (!stateStorageExistsSync(dir)) {
      sendJson(res, 400, { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' })
      return true
    }
    try {
      if (modeMatch) {
        const from = input.from === 'hitl' || input.from === 'afk' ? input.from : undefined
        const to = input.to === 'hitl' || input.to === 'afk' ? input.to : undefined
        const actor = input.actor === 'automation' ? 'automation' : input.actor === 'user' ? 'user' : undefined
        const expectedRevision = typeof input.expected_revision === 'number' ? input.expected_revision : undefined
        const idempotencyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key : ''
        if (from === undefined || to === undefined || actor === undefined || expectedRevision === undefined || idempotencyKey === '') {
          sendJson(res, 400, { ok: false, error: 'from / to / actor / expected_revision / idempotency_key 为必填' })
          return true
        }
        await store.withLock(dir, async () => {
          const current = await readCurrentRunRevision(dir)
          if (current?.revision !== expectedRevision) throw Object.assign(new Error('decision revision conflict'), { code: 'revision-conflict' })
          const records = await readDecisionAudit(dir)
          const prior = records.find((record) => record.type === 'decision-mode-switched' && record.idempotencyKey === idempotencyKey)
          if (prior !== undefined) return
          const strategy = to === 'afk' ? 'afk' : input.recommended_defaults === true ? 'recommended-defaults' : 'interactive'
          await appendDecisionAuditUnderLock(dir, { version: 1, type: 'decision-mode-switched', from, to, strategy, actor, occurredAt: clock(), expectedRevision, idempotencyKey })
        })
        sendJson(res, 200, { ok: true, changed: true, channel: 'dashboard', event: 'decision-mode-switched' })
        return true
      }
      const pendingDecisionId = typeof input.pending_decision_id === 'string' ? input.pending_decision_id : ''
      const operation = input.operation === 'read-token' || input.operation === 'local-api-call' ? input.operation : undefined
      const channel = input.channel === 'terminal' || input.channel === 'dashboard' || input.channel === 'hook' || input.channel === 'automation' ? input.channel : undefined
      const idempotencyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key : ''
      const tokenDigest = input.token_digest === null
        ? null
        : typeof input.token_digest === 'string' && /^[a-f0-9]{64}$/.test(input.token_digest)
          ? input.token_digest
          : undefined
      if (!pendingDecisionId || operation === undefined || channel === undefined || !idempotencyKey) {
        sendJson(res, 400, { ok: false, error: 'pending_decision_id / operation / channel / idempotency_key 为必填' })
        return true
      }
      if (tokenDigest === undefined) {
        sendJson(res, 400, { ok: false, error: 'token_digest 必须为 null 或 64 位小写十六进制摘要' })
        return true
      }
      await store.withLock(dir, async () => {
        const records = await readDecisionAudit(dir)
        const prior = records.find((record) => record.type === 'pending-decision-self-approval-suspected' && record.idempotencyKey === idempotencyKey)
        if (prior !== undefined) return
        await appendDecisionAuditUnderLock(dir, {
          version: 1, type: 'pending-decision-self-approval-suspected', pendingDecisionId,
          channel, operation, tokenDigest, observedAt: clock(), severity: 'warning', idempotencyKey,
        })
      })
      sendJson(res, 200, { ok: true, changed: true, channel: 'dashboard', event: 'pending-decision-self-approval-suspected' })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'decision-audit-failed'
      sendJson(res, code === 'revision-conflict' ? 409 : 400, { ok: false, error: message, code })
      return true
    }
  }
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
  const name = decodeURIComponent(match?.[1] ?? '')
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
    const current = await readCurrentRunRevision(dir)
    const state = current?.state ?? await store.read(dir)
    const invocations = await readSkillInvocationEventsForApplication(dir).catch(() => [])
    const item = projectPendingDecisions({ change: name, state, revision: current?.revision, invocations }).items.find((candidate) => candidate.ref.id === ref)
    const outcome = item?.type === 'skill-question' || item?.type === 'afk'
      ? await applyInvocationDecision({
        dir, name, ref, expectedRevision, idempotencyKey,
        answer: Array.isArray(input.answer) ? input.answer.filter((value): value is string => typeof value === 'string') : [],
        clock, kind: item.type,
      })
      : await applyDecision({ dir, root, name, ref, expectedRevision, idempotencyKey, store, clock, history })
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
      if (prior.outcome === 'rejected') {
        throw Object.assign(new Error(prior.error ?? 'review approval was rejected'), { code: prior.code ?? 'review-approval-required' })
      }
      result = { ok: true, idempotent: true, ref: { id: prior.ref, kind: 'review', change: input.name, anchor: '', revision: prior.expectedRevision } }
      return
    }
    const lockedRevision = await readCurrentRunRevision(input.dir)
    const locked = lockedRevision?.state ?? await input.store.read(input.dir)
    const view = projectPendingDecisions({ change: input.name, state: locked, revision: lockedRevision?.revision, now: input.clock() })
    const item = view.items.find((candidate) => candidate.ref.id === input.ref)
    if (item === undefined) throw Object.assign(new Error('decision is no longer pending'), { code: 'decision-not-pending' })
    const adapter = createDecisionCommandAdapter({
      readRevision: async () => (await readCurrentRunRevision(input.dir))?.revision ?? null,
      hasIdempotencyKey: async () => false,
      rememberIdempotencyKey: async (key) => appendDecisionIdempotency(input.dir, {
        key, ref: input.ref, expectedRevision: input.expectedRevision, channel: 'dashboard', acknowledgedAt: input.clock(),
      }),
        isPending: async (decisionRef) => projectPendingDecisions({
        change: input.name, state: await input.store.read(input.dir), revision: lockedRevision?.revision, now: input.clock(),
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
          recordInteraction: lockedRevision === undefined ? undefined : async ({ state: interactionState, acknowledgedAt, rejected }) => {
            const after = await readCurrentRunRevision(input.dir)
            const draft = reviewInteractionDraft({
              change: input.name, state: interactionState, revision: after ?? lockedRevision,
              beforeRevision: lockedRevision, phase, event, acknowledgedAt, rejected,
            })
            if (draft !== undefined) await createInteractionEventRecorder().recordUnderLock(input.dir, draft)
          },
          recordHistory: async ({ acknowledgedAt, phase: acknowledgedPhase, event: acknowledgedEvent, rejected }) => input.history.append(input.dir, {
            ts: acknowledgedAt, kind: 'tool', raw: `review:${rejected ? 'acknowledge-rejected' : 'acknowledge'} via=dashboard phase=${acknowledgedPhase} event=${acknowledgedEvent}`,
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
    try {
      result = await adapter.execute({ ref: item.ref, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey, channel: 'dashboard' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'review-approval-required'
      await appendDecisionIdempotency(input.dir, {
        key: input.idempotencyKey, ref: input.ref, expectedRevision: input.expectedRevision,
        channel: 'dashboard', acknowledgedAt: input.clock(), outcome: 'rejected', error: message, code,
      })
      throw error
    }
  })
  if (result === undefined) throw new Error('decision command did not produce a result')
  return { result, deferred }
}
