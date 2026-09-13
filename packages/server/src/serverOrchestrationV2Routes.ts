import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  ORCHESTRATION_MAX_EVENTS,
  decodeBoardCommandV2,
  type BoardCommandV2,
  type BoardEventV2,
  type BoardSnapshotV2,
  type LedgerAppendResult,
  type OrchestrationLedger,
} from '@tenon/kernel'
import { tokenFromHeaders, tokensMatch } from './token.js'
import type { WorkflowRootAnchor } from './workflows.js'
import type { ExecutionRuntimeResultV2 } from '@tenon/automation'

type WorkflowRootCheck =
  | { readonly ok: true; readonly anchor: WorkflowRootAnchor }
  | { readonly ok: false; readonly code: 403 | 404; readonly error: string }

export interface OrchestrationV2RouteResult {
  readonly status: number
  readonly body: unknown
}

export interface OrchestrationV2RouteDeps {
  readonly ledger: OrchestrationLedger
  readonly workflowRootForRequest: (root: string) => WorkflowRootCheck
  readonly clock?: () => string
  readonly streamPollIntervalMs?: number
  readonly streamHeartbeatMs?: number
  /** Shared production runtime entry; absent in read-only test harnesses. */
  readonly runChange?: (changeDir: string) => Promise<ExecutionRuntimeResultV2>
  /** Planner-owned explicit freeze seam; payload must contain a complete pipeline. */
  readonly freezePipeline?: (changeDir: string, pipeline: unknown) => Promise<BoardSnapshotV2>
  /** Planner-owned freeze boundary. The callback must assess and materialize before appending. */
  readonly freezeWorkflow?: (changeDir: string, input: FreezeWorkflowInputV2) => Promise<BoardSnapshotV2>
}

export interface FreezeWorkflowInputV2 {
  readonly request: unknown
  readonly context: unknown
  readonly catalog: unknown
  readonly workflow_definition: unknown
  readonly workflow_track: unknown
  readonly workflow_blueprint_mapping?: unknown
  readonly assessment_id?: unknown
  readonly graph_id?: unknown
  readonly plan_revision_id?: unknown
}

export interface OrchestrationV2HttpRouteDeps extends OrchestrationV2RouteDeps {
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void
  readonly readJsonBody?: (req: IncomingMessage) => Promise<unknown>
  readonly token?: string
  readonly isLocalHost?: (host: string | undefined, port: number) => boolean
  readonly boundPort?: () => number
}

const CHANGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const CURSOR = /^(?:0|[1-9][0-9]{0,9})$/u
const MAX_CURSOR = 2_048
const MAX_LIMIT = 200
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u

function failure(status: number, code: string, error: string, extra: Record<string, unknown> = {}): OrchestrationV2RouteResult {
  return { status, body: { ok: false, code, error, ...extra } }
}

function validChangeId(value: string): boolean {
  return value !== '.' && value !== '..' && CHANGE_ID.test(value) && !value.includes('/') && !value.includes('\\')
}

function changeDir(anchor: WorkflowRootAnchor, changeId: string): string {
  return join(anchor.path, 'openspec', 'changes', changeId)
}

function rootCheck(deps: OrchestrationV2RouteDeps, root: string): Extract<WorkflowRootCheck, { readonly ok: true }> | OrchestrationV2RouteResult {
  if (root === '') return failure(400, 'ORCHESTRATION_V2_ROOT_REQUIRED', '缺少 root 参数')
  let checked: WorkflowRootCheck
  try { checked = deps.workflowRootForRequest(root) } catch {
    return failure(403, 'ORCHESTRATION_V2_ROOT_FORBIDDEN', 'root 不可信')
  }
  if (!checked.ok) {
    return failure(checked.code, checked.code === 404 ? 'ORCHESTRATION_V2_ROOT_NOT_REGISTERED' : 'ORCHESTRATION_V2_ROOT_FORBIDDEN', checked.code === 404 ? 'root 未注册' : 'root 不可信')
  }
  return checked
}

function parseChange(path: string): { kind: 'change' | 'events' | 'stream' | 'commands' | 'metrics' | 'run' | 'freeze'; changeId: string } | OrchestrationV2RouteResult | null {
  const match = /^\/api\/orchestration\/changes\/([^/]+)(?:\/(events|stream|commands|metrics|run|freeze-pipeline))?$/.exec(path)
  if (!match) return null
  const encoded = match[1]
  if (encoded === undefined) return failure(400, 'ORCHESTRATION_V2_CHANGE_INVALID', '非法 change 路径')
  let changeId: string
  try { changeId = decodeURIComponent(encoded) } catch { return failure(400, 'ORCHESTRATION_V2_CHANGE_INVALID', '非法 change 路径') }
  if (!validChangeId(changeId)) return failure(400, 'ORCHESTRATION_V2_CHANGE_INVALID', '非法 change 名')
  const suffix = match[2]
  return { kind: suffix === 'events' ? 'events' : suffix === 'stream' ? 'stream' : suffix === 'commands' ? 'commands' : suffix === 'metrics' ? 'metrics' : suffix === 'run' ? 'run' : suffix === 'freeze-pipeline' ? 'freeze' : 'change', changeId }
}

function parseCursor(value: string | null, label: string): number | OrchestrationV2RouteResult {
  if (value === null || value === '') return 0
  if (!CURSOR.test(value)) return failure(400, 'ORCHESTRATION_V2_CURSOR_INVALID', `${label} 必须是非负整数`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number > MAX_CURSOR) return failure(413, 'ORCHESTRATION_V2_CURSOR_LIMIT_EXCEEDED', `${label} 超出安全上限`)
  return number
}

function parseLimit(value: string | null): number | OrchestrationV2RouteResult {
  if (value === null || value === '') return MAX_LIMIT
  const parsed = parseCursor(value, 'limit')
  if (typeof parsed !== 'number') return parsed
  if (parsed === 0) return failure(400, 'ORCHESTRATION_V2_LIMIT_INVALID', 'limit 必须大于 0')
  return Math.min(parsed, MAX_LIMIT)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRootFromBody(body: unknown): string | OrchestrationV2RouteResult {
  if (!isRecord(body) || typeof body.root !== 'string') return failure(400, 'ORCHESTRATION_V2_BODY_INVALID', '请求必须包含 root')
  if (body.root.length > 4_096) return failure(413, 'ORCHESTRATION_V2_BODY_LIMIT_EXCEEDED', 'root 超出安全上限')
  return body.root
}

function commandFromBody(body: unknown, changeId: string): { root: string; command: BoardCommandV2 } | OrchestrationV2RouteResult {
  if (!isRecord(body)) return failure(400, 'ORCHESTRATION_V2_COMMAND_INVALID', 'command body 必须是对象')
  const keys = Object.keys(body).sort()
  if (keys.join(',') !== 'command,root') return failure(400, 'ORCHESTRATION_V2_COMMAND_INVALID', 'command body 字段不符合契约')
  const root = readRootFromBody(body)
  if (typeof root !== 'string') return root
  const decoded = decodeBoardCommandV2(body.command)
  if (!decoded.ok) return failure(400, 'ORCHESTRATION_V2_COMMAND_INVALID', 'command schema 无效', { errors: decoded.errors.map((error) => ({ path: error.path, code: error.code })) })
  if (decoded.value.change_id !== changeId) return failure(422, 'ORCHESTRATION_V2_CHANGE_MISMATCH', 'command change 与路径不一致')
  return { root, command: decoded.value }
}

function mapAppendFailure(result: Extract<LedgerAppendResult, { kind: 'rejected' }>, snapshot: BoardSnapshotV2 | undefined): OrchestrationV2RouteResult {
  const rejection = result.rejection
  const status = rejection.code === 'revision-conflict' || rejection.code === 'idempotency-conflict' || rejection.code === 'terminal-state' || rejection.code === 'lease-mismatch'
    ? 409
    : rejection.code === 'not-found' ? 404
      : rejection.code === 'missing-evidence' || rejection.code === 'policy-blocked' ? 422
        : 400
  const code = rejection.code === 'revision-conflict'
    ? 'ORCHESTRATION_V2_REVISION_CONFLICT'
    : rejection.code === 'idempotency-conflict'
      ? 'ORCHESTRATION_V2_IDEMPOTENCY_CONFLICT'
      : `ORCHESTRATION_V2_${rejection.code.replaceAll('-', '_').toUpperCase()}`
  return failure(status, code, rejection.code === 'revision-conflict' ? 'revision conflict' : rejection.code === 'idempotency-conflict' ? 'idempotency conflict' : 'orchestration command rejected', {
    reason_code: rejection.reason_code,
    next_actions: rejection.next_actions,
    ...(snapshot ? { current_revision: snapshot.revision, snapshot } : {}),
  })
}

export async function resolveOrchestrationV2GetRoute(rawUrl: string, path: string, deps: OrchestrationV2RouteDeps): Promise<OrchestrationV2RouteResult | null> {
  const parsed = parseChange(path)
  if (parsed === null) return null
  if (typeof parsed !== 'object' || 'status' in parsed) return parsed as OrchestrationV2RouteResult
  const params = new URL(rawUrl, 'http://localhost').searchParams
  const root = rootCheck(deps, params.get('root') ?? '')
  if ('status' in root) return root
  const dir = changeDir(root.anchor, parsed.changeId)
  try {
    if (parsed.kind === 'change' || parsed.kind === 'stream') {
      const snapshot = await deps.ledger.readSnapshot(dir)
      if (!snapshot) return failure(404, 'ORCHESTRATION_V2_CHANGE_NOT_FOUND', '找不到该 orchestration change')
      return { status: 200, body: { ok: true, snapshot } }
    }
    if (parsed.kind === 'events') {
      const after = parseCursor(params.get('after_revision'), 'after_revision')
      if (typeof after !== 'number') return after
      const limit = parseLimit(params.get('limit'))
      if (typeof limit !== 'number') return limit
      const snapshot = await deps.ledger.readSnapshot(dir)
      if (!snapshot) return failure(404, 'ORCHESTRATION_V2_CHANGE_NOT_FOUND', '找不到该 orchestration change')
      const events = (await deps.ledger.readEvents(dir, { fromRevision: after + 1, toRevision: snapshot.revision })).slice(0, limit)
      return {
        status: 200,
        body: {
          ok: true,
          events,
          from_revision: events[0]?.revision ?? after + 1,
          to_revision: events.at(-1)?.revision ?? after,
          current_revision: snapshot.revision,
        },
      }
    }
    if (parsed.kind === 'metrics') {
      const snapshot = await deps.ledger.readSnapshot(dir)
      if (!snapshot) return failure(404, 'ORCHESTRATION_V2_CHANGE_NOT_FOUND', '找不到该 orchestration change')
      return { status: 200, body: {
        ok: true, schema_version: 'orchestration-metrics/v1', project_id: snapshot.project_id, change_id: snapshot.change_id,
        revision: snapshot.revision, status: snapshot.status,
        work_items: { total: snapshot.work_items.length, completed: snapshot.work_items.filter((item) => item.status === 'completed').length, blocked: snapshot.work_items.filter((item) => item.status === 'blocked').length, failed: snapshot.work_items.filter((item) => item.status === 'failed').length },
        runs: { total: snapshot.runs.length, active: snapshot.runs.filter((run) => run.status === 'claimed' || run.status === 'running').length, retries: snapshot.runs.filter((run) => run.attempt > 1).length },
        results: { total: snapshot.results.length, validated: snapshot.results.filter((result) => result.contract_status === 'validated').length },
        validations: { total: snapshot.validations.length, passed: snapshot.validations.filter((report) => report.status === 'pass').length, failed: snapshot.validations.filter((report) => report.status === 'fail').length },
        gates: { total: snapshot.gates.length, passed: snapshot.gates.filter((gate) => gate.status === 'passed' || gate.status === 'waived').length, pending: snapshot.gates.filter((gate) => gate.status === 'pending').length },
        leases: { total: snapshot.leases.length, active: snapshot.leases.filter((lease) => lease.status === 'active' || lease.status === 'renewed').length, expired: snapshot.leases.filter((lease) => lease.status === 'expired').length },
        blockers: snapshot.blockers.length,
      } }
    }
    return failure(405, 'ORCHESTRATION_V2_METHOD_NOT_ALLOWED', 'commands 仅支持 POST')
  } catch {
    return failure(500, 'ORCHESTRATION_V2_READ_FAILED', 'orchestration 数据读取失败')
  }
}

export async function resolveOrchestrationV2PostRoute(path: string, body: unknown, deps: OrchestrationV2RouteDeps): Promise<OrchestrationV2RouteResult | null> {
  if (path === '/api/orchestration/changes') {
    if (!isRecord(body)) return failure(400, 'ORCHESTRATION_V2_BODY_INVALID', '请求 body 必须是对象')
    const keys = Object.keys(body).sort()
    if (!['change_id', 'correlation_id', 'project_id', 'root'].every((key) => keys.includes(key)) || keys.some((key) => !['change_id', 'correlation_id', 'project_id', 'root', 'updated_at'].includes(key))) {
      return failure(400, 'ORCHESTRATION_V2_BODY_INVALID', '创建请求字段不符合契约')
    }
    if (typeof body.root !== 'string' || typeof body.project_id !== 'string' || typeof body.change_id !== 'string' || typeof body.correlation_id !== 'string') return failure(400, 'ORCHESTRATION_V2_BODY_INVALID', '创建请求身份字段无效')
    if (!validChangeId(body.change_id) || !PROJECT_ID.test(body.project_id) || !PROJECT_ID.test(body.correlation_id)) return failure(400, 'ORCHESTRATION_V2_IDENTITY_INVALID', '创建请求身份不安全')
    if (body.updated_at !== undefined && (typeof body.updated_at !== 'string' || !UTC.test(body.updated_at))) return failure(400, 'ORCHESTRATION_V2_TIME_INVALID', 'updated_at 必须为 UTC')
    const root = rootCheck(deps, body.root)
    if ('status' in root) return root
    try {
      const snapshot = await deps.ledger.initialize(changeDir(root.anchor, body.change_id), {
        project_id: body.project_id,
        change_id: body.change_id,
        correlation_id: body.correlation_id,
        ...(body.updated_at === undefined ? {} : { updated_at: body.updated_at }),
      })
      return { status: 201, body: { ok: true, created: snapshot.revision === 0, snapshot } }
    } catch {
      return failure(500, 'ORCHESTRATION_V2_INITIALIZE_FAILED', 'orchestration change 初始化失败')
    }
  }
  const parsed = parseChange(path)
  if (parsed === null) return null
  if (typeof parsed !== 'object' || 'status' in parsed) return parsed as OrchestrationV2RouteResult
  if (parsed.kind === 'run') {
    if (deps.runChange === undefined) return failure(503, 'ORCHESTRATION_V2_RUNTIME_UNAVAILABLE', 'production orchestration runtime unavailable')
    if (!isRecord(body)) return failure(400, 'ORCHESTRATION_V2_BODY_INVALID', 'run body 必须是对象')
    const root = readRootFromBody(body)
    if (typeof root !== 'string') return root
    const checked = rootCheck(deps, root)
    if ('status' in checked) return checked
    try {
      const result = await deps.runChange(changeDir(checked.anchor, parsed.changeId))
      return { status: result.ok ? 200 : 422, body: { ok: result.ok, snapshot: result.snapshot, diagnostics: result.diagnostics } }
    } catch { return failure(500, 'ORCHESTRATION_V2_RUNTIME_FAILED', 'production orchestration run failed') }
  }
  if (parsed.kind === 'freeze') {
    if (deps.freezeWorkflow === undefined && deps.freezePipeline === undefined) return failure(503, 'ORCHESTRATION_V2_FREEZE_UNAVAILABLE', 'production pipeline freezer unavailable')
    if (!isRecord(body) || body.root === undefined) return failure(400, 'ORCHESTRATION_V2_FREEZE_BODY_INVALID', 'freeze-pipeline body 必须包含 root')
    const root = readRootFromBody(body)
    if (typeof root !== 'string') return root
    const checked = rootCheck(deps, root)
    if ('status' in checked) return checked
    try {
      let snapshot: BoardSnapshotV2
      if (deps.freezeWorkflow !== undefined && body.pipeline === undefined) {
        const required = ['request', 'context', 'catalog', 'workflow_definition', 'workflow_track', 'workflow_blueprint_mapping'] as const
        if (required.some((key) => body[key] === undefined)) return failure(400, 'ORCHESTRATION_V2_FREEZE_BODY_INVALID', 'freeze-pipeline body 必须包含 request、context、catalog、workflow_definition、workflow_track、workflow_blueprint_mapping')
        const allowed = new Set(['root', 'request', 'context', 'catalog', 'workflow_definition', 'workflow_track', 'workflow_blueprint_mapping', 'assessment_id', 'graph_id', 'plan_revision_id'])
        if (Object.keys(body).some((key) => !allowed.has(key))) return failure(400, 'ORCHESTRATION_V2_FREEZE_BODY_INVALID', 'freeze-pipeline body 含未知字段')
        snapshot = await deps.freezeWorkflow(changeDir(checked.anchor, parsed.changeId), {
          request: body.request, context: body.context, catalog: body.catalog,
          workflow_definition: body.workflow_definition, workflow_track: body.workflow_track,
          ...(body.workflow_blueprint_mapping === undefined ? {} : { workflow_blueprint_mapping: body.workflow_blueprint_mapping }),
          ...(body.assessment_id === undefined ? {} : { assessment_id: body.assessment_id }),
          ...(body.graph_id === undefined ? {} : { graph_id: body.graph_id }),
          ...(body.plan_revision_id === undefined ? {} : { plan_revision_id: body.plan_revision_id }),
        })
      } else {
        if (deps.freezePipeline === undefined) return failure(503, 'ORCHESTRATION_V2_FREEZE_PIPELINE_UNAVAILABLE', 'explicit pipeline freeze unavailable')
        if (body.pipeline === undefined) return failure(400, 'ORCHESTRATION_V2_FREEZE_BODY_INVALID', 'freeze-pipeline body 必须包含完整 pipeline')
        snapshot = await deps.freezePipeline(changeDir(checked.anchor, parsed.changeId), body.pipeline)
      }
      return { status: 200, body: { ok: true, snapshot } }
    } catch (error) {
      return failure(422, 'ORCHESTRATION_V2_FREEZE_REJECTED', error instanceof Error ? error.message : 'pipeline freeze rejected')
    }
  }
  if (parsed.kind !== 'commands') return failure(405, 'ORCHESTRATION_V2_METHOD_NOT_ALLOWED', '该 orchestration 路径仅支持 GET')
  const parsedBody = commandFromBody(body, parsed.changeId)
  if ('status' in parsedBody) return parsedBody
  const root = rootCheck(deps, parsedBody.root)
  if ('status' in root) return root
  try {
    const result = await deps.ledger.append(changeDir(root.anchor, parsed.changeId), parsedBody.command)
    if (result.kind === 'committed' || result.kind === 'replayed') return { status: 200, body: { ok: true, replayed: result.replayed, event: result.event, snapshot: result.snapshot } }
    const current = await deps.ledger.readSnapshot(changeDir(root.anchor, parsed.changeId))
    return mapAppendFailure(result, current)
  } catch {
    return failure(500, 'ORCHESTRATION_V2_WRITE_FAILED', 'orchestration command 写入失败')
  }
}

function authorized(req: IncomingMessage, deps: OrchestrationV2HttpRouteDeps, requireToken = false): OrchestrationV2RouteResult | null {
  if (deps.isLocalHost && !deps.isLocalHost(req.headers.host, deps.boundPort?.() ?? 0)) return failure(403, 'ORCHESTRATION_V2_HOST_FORBIDDEN', 'Host header 不合法')
  if (requireToken && deps.token !== undefined) {
    const provided = tokenFromHeaders(req.headers) ?? new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined
    if (!provided || !tokensMatch(provided, deps.token)) return failure(401, 'ORCHESTRATION_V2_UNAUTHORIZED', '缺少或无效 token')
  }
  return null
}

function writeSse(res: ServerResponse, event: string, data: unknown, id?: number): void {
  const payload = JSON.stringify(data).replaceAll('\n', '\ndata: ')
  res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${payload}\n\n`)
}

async function handleStream(req: IncomingMessage, res: ServerResponse, parsed: { changeId: string }, rawUrl: string, deps: OrchestrationV2HttpRouteDeps): Promise<void> {
  const params = new URL(rawUrl, 'http://localhost').searchParams
  const cursorRaw = params.get('after_revision') ?? (typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : null)
  const cursor = parseCursor(cursorRaw, 'after_revision')
  if (typeof cursor !== 'number') {
    deps.sendJson(res, cursor.status, cursor.body)
    return
  }
  const root = rootCheck(deps, params.get('root') ?? '')
  if ('status' in root) { deps.sendJson(res, root.status, root.body); return }
  const dir = changeDir(root.anchor, parsed.changeId)
  let snapshot: BoardSnapshotV2 | undefined
  try { snapshot = await deps.ledger.readSnapshot(dir) } catch {
    deps.sendJson(res, 500, failure(500, 'ORCHESTRATION_V2_READ_FAILED', 'orchestration 数据读取失败').body)
    return
  }
  if (!snapshot) { deps.sendJson(res, 404, failure(404, 'ORCHESTRATION_V2_CHANGE_NOT_FOUND', '找不到该 orchestration change').body); return }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  // Send a current projection first, then replay the caller's cursor range. Consumers must
  // apply snapshots/events by monotonic revision (discarding frames at or below their cursor),
  // which preserves both a fast board paint and an auditable event stream on reconnect.
  let revision = snapshot.revision
  writeSse(res, 'snapshot', { ok: true, snapshot }, snapshot.revision)
  let replay: readonly BoardEventV2[] = []
  try {
    replay = await deps.ledger.readEvents(dir, { fromRevision: cursor + 1, toRevision: snapshot.revision })
  } catch {
    res.write(': orchestration replay unavailable\n\n')
  }
  for (const event of replay.slice(0, ORCHESTRATION_MAX_EVENTS)) { writeSse(res, 'event', event, event.revision); revision = event.revision }
  const interval = Math.max(100, Math.min(deps.streamPollIntervalMs ?? 1_000, 30_000))
  const heartbeat = Math.max(interval, Math.min(deps.streamHeartbeatMs ?? 15_000, 120_000))
  let lastBeat = Date.now()
  const timer = setInterval(() => {
    void (async () => {
      try {
        const current = await deps.ledger.readSnapshot(dir)
        if (!current) return
        if (current.revision > revision) {
          const events = await deps.ledger.readEvents(dir, { fromRevision: revision + 1, toRevision: current.revision })
          for (const event of events.slice(0, ORCHESTRATION_MAX_EVENTS)) { writeSse(res, 'event', event, event.revision); revision = event.revision }
          lastBeat = Date.now()
        } else if (Date.now() - lastBeat >= heartbeat) {
          res.write(': ping\n\n'); lastBeat = Date.now()
        }
      } catch { /* next poll can recover; never leak filesystem details over SSE */ }
    })()
  }, interval)
  timer.unref?.()
  req.on('close', () => clearInterval(timer))
}

export async function handleOrchestrationV2GetRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: OrchestrationV2HttpRouteDeps): Promise<boolean> {
  const parsed = parseChange(path)
  if (parsed === null) return false
  const authError = authorized(req, deps)
  if (authError) { deps.sendJson(res, authError.status, authError.body); return true }
  if (typeof parsed !== 'object' || 'status' in parsed) { const result = parsed as OrchestrationV2RouteResult; deps.sendJson(res, result.status, result.body); return true }
  if (parsed.kind === 'stream') { await handleStream(req, res, parsed, req.url ?? '/', deps); return true }
  const result = await resolveOrchestrationV2GetRoute(req.url ?? '/', path, deps)
  if (result) deps.sendJson(res, result.status, result.body)
  return true
}

export async function handleOrchestrationV2PostRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: OrchestrationV2HttpRouteDeps): Promise<boolean> {
  if (path !== '/api/orchestration/changes' && !/^\/api\/orchestration\/changes\/[^/]+\/(commands|run|freeze-pipeline)$/.test(path)) return false
  if (deps.readJsonBody === undefined) { deps.sendJson(res, 500, failure(500, 'ORCHESTRATION_V2_BODY_READER_UNAVAILABLE', 'orchestration body reader unavailable').body); return true }
  const body = await deps.readJsonBody(req)
  const result = await resolveOrchestrationV2PostRoute(path, body, deps)
  if (result) deps.sendJson(res, result.status, result.body)
  return true
}
