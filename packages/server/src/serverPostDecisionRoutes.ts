import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  clearReviewMarkerFor,
  createInteractionEventRecorder,
  createReviewDecisionLedger,
  executeReviewAcknowledge,
  nodeReviewDecisionLedgerFs,
  readCurrentRunRevision,
  resolveStep,
  resolveWorkflowName,
  stateStorageExistsSync,
  type PipelineState,
  type ReviewAcknowledgeResult,
} from '@tenon/kernel'
import type { PostRouteDeps } from './serverPostRoutes.js'
import { readPendingDecisionProjection, readReviewBindingSafely } from './decisionProjection.js'
import { resolveSnapshotTrack } from './skillRuns.js'
import { resolveSnapshotEffectivePlan } from './workflowSnapshot.js'

type DecisionRouteDeps = Pick<PostRouteDeps, 'sendJson' | 'readJsonBody' | 'isRegisteredRoot' | 'store' | 'clock' | 'history' | 'recordStore'>

/** Fixed 500 text: filesystem codes and paths never reach the client. */
export const DECISION_COMMAND_FAILED = '决策命令处理失败'

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/** Outgoing events of a review-gated step in the Change's bound effective workflow. */
function reviewExitsFor(root: string, state: PipelineState, phase: string): readonly string[] | null {
  const workflowName = resolveWorkflowName(state)
  const metadata = state.runMetadata
  const plan = resolveSnapshotEffectivePlan(root, workflowName, {
    documentProfile: metadata?.documentProfile,
    documentGovernanceFingerprint: metadata?.documentGovernanceFingerprint,
    workflowPlanFingerprint: metadata?.workflowPlanFingerprint,
    workflowPlanSnapshot: metadata?.workflowPlanSnapshot,
  }, undefined, resolveSnapshotTrack(root, scalar(state, 'track'), workflowName))
  const step = resolveStep(plan.workflow, phase)
  if (!step || step.gate !== 'review') return null
  return step.transitions.map((transition) => transition.event)
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
  const { readJsonBody, sendJson, isRegisteredRoot } = deps
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
  let result: ReviewAcknowledgeResult
  try {
    result = await acknowledgeFromDashboard({ deps, root, dir, name, ref, expectedRevision, idempotencyKey })
  } catch {
    sendJson(res, 500, { ok: false, error: DECISION_COMMAND_FAILED })
    return true
  }
  if (!result.ok) {
    sendJson(res, 409, { ok: false, error: result.message, code: result.code })
    return true
  }
  sendJson(res, 200, {
    ok: true, code: result.code, ref, changed: result.changed, idempotent: result.idempotent,
    channel: 'dashboard', deferred: result.deferred,
  })
  return true
}

function acknowledgeFromDashboard(input: {
  readonly deps: DecisionRouteDeps
  readonly root: string
  readonly dir: string
  readonly name: string
  readonly ref: string
  readonly expectedRevision: number
  readonly idempotencyKey: string
}): Promise<ReviewAcknowledgeResult> {
  const { deps, root, dir, name } = input
  const recorder = createInteractionEventRecorder()
  return executeReviewAcknowledge({
    change: name,
    command: { channel: 'dashboard', ref: input.ref, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey },
    withLock: (fn) => deps.store.withLock(dir, fn),
    readState: () => deps.store.read(dir),
    readRevision: () => readCurrentRunRevision(dir),
    readBinding: () => readReviewBindingSafely(dir),
    ledger: createReviewDecisionLedger(dir, nodeReviewDecisionLedgerFs),
    reviewExits: async (state, phase) => reviewExitsFor(root, state, phase),
    // GET and POST build the projection through the same reader, so a GET ref resolves here.
    refIsLive: async (ref) => {
      const view = await readPendingDecisionProjection({ change: name, dir, store: deps.store, recordStore: deps.recordStore })
      return view.items.some((item) => item.type === 'review' && item.ref.id === ref
        && (item.status === 'pending' || item.status === 'answered'))
    },
    clock: deps.clock,
    writeState: async (state) => {
      await deps.store.writeUnderLock(dir, state, { kind: 'set-many' })
    },
    recordInteraction: async (draft) => {
      await recorder.recordUnderLock(dir, draft)
    },
    appendHistory: (entry) => deps.history.append(dir, entry),
    clearMarker: (event) => clearReviewMarkerFor(root, name, event),
  })
}
