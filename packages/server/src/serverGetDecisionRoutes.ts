import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  projectPendingDecisions,
  readCurrentRunRevision,
  readInteractionProjection,
  readSkillInvocationEventsForApplication,
  stateStorageExistsSync,
  type TransitionRecordStore,
  type StateStore,
} from '@tenon/kernel'
import { readDecisionAudit } from './decisionAudit.js'

export interface DecisionRouteDeps {
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  readonly clock?: () => string
  readonly store: StateStore
  readonly recordStore: TransitionRecordStore
  readonly workflowRootForRequest: (root: string) => { ok: true; anchor: { path: string } } | { ok: false; code: 403 | 404; error: string }
}

function validName(name: string): boolean {
  return name !== '' && /^[A-Za-z0-9_-]+$/.test(name) && !name.includes('..')
}

/** Read-only decision projection. It never starts a Skill, creates a prompt, or calls a model. */
export async function handleGetDecisionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: DecisionRouteDeps,
): Promise<boolean> {
  const match = /^\/api\/change\/([^/]+)\/pending-decisions$/.exec(path)
  const auditMatch = /^\/api\/change\/([^/]+)\/decision-audit$/.exec(path)
  if (match === null && auditMatch === null) return false
  const name = decodeURIComponent((match ?? auditMatch)?.[1] ?? '')
  if (!validName(name)) return deps.sendJson(res, 400, { ok: false, error: '非法 change 名' }), true
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const root = query.get('root') ?? ''
  const checked = deps.workflowRootForRequest(root)
  if (!checked.ok) return deps.sendJson(res, checked.code, { ok: false, error: checked.error }), true
  const dir = join(checked.anchor.path, 'openspec', 'changes', name)
  if (!stateStorageExistsSync(dir)) return deps.sendJson(res, 400, { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' }), true
  try {
    if (auditMatch !== null) return deps.sendJson(res, 200, { schemaVersion: 'decision-audit/v1', items: await readDecisionAudit(dir) }), true
    const current = await readCurrentRunRevision(dir)
    const state = current?.state ?? await deps.store.read(dir)
    const interactions = await readInteractionProjection(dir)
    const invocations = await readSkillInvocationEventsForApplication(dir)
    const head = current?.state.runMetadata?.transitionHead
    const transitions = current?.state.runMetadata !== undefined && head !== undefined
      ? await deps.recordStore.readChain(dir, current.state.runMetadata.transitionSequence, head, current.state.runMetadata.runId)
      : []
    const view = projectPendingDecisions({ change: name, state, revision: current?.revision, ...(deps.clock === undefined ? {} : { now: deps.clock() }), interactions: interactions.kind === 'valid' ? interactions.events : [], invocations, transitions })
    return deps.sendJson(res, 200, view), true
  } catch (error) {
    return deps.sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }), true
  }
}
