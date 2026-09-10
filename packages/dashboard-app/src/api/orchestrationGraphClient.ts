import { ApiError, isRecord, readJson, wrapNetwork } from './transport'

export const ORCHESTRATION_NODE_KINDS = [
  'workflow', 'change', 'phase', 'task', 'document', 'review', 'session',
] as const
export const ORCHESTRATION_EDGE_KINDS = [
  'governs', 'contains', 'transitions', 'produces', 'reviews', 'executes',
] as const
export const MAX_ORCHESTRATION_NODES = 512
export const MAX_ORCHESTRATION_EDGES = 1024
export const MAX_ORCHESTRATION_NODE_ID_LENGTH = 2048
export const MAX_ORCHESTRATION_EDGE_ID_LENGTH = 4096
export const ORCHESTRATION_NODE_STATUSES = [
  'current', 'changed', 'missing', 'invalid', 'unavailable',
  'done', 'pending', 'failed', 'active', 'pass', 'fail', 'handled', 'skipped', 'in_progress',
  'recorded', 'unread', 'stale',
] as const
export const ORCHESTRATION_IMPLEMENTED_CAPABILITIES = [
  'workflow', 'change', 'phase', 'task', 'document', 'review', 'active-session',
] as const
export const ORCHESTRATION_DEFERRED_CAPABILITIES = [
  'agent', 'historical-session-turn', 'acceptance-criteria',
  'task-dependencies', 'write-orchestration', 'live-refresh',
] as const
export const ORCHESTRATION_GRAPH_ERROR_CODES = [
  'ORCHESTRATION_ROOT_REQUIRED',
  'ORCHESTRATION_ROOT_NOT_REGISTERED',
  'ORCHESTRATION_ROOT_FORBIDDEN',
  'ORCHESTRATION_CHANGE_INVALID',
  'ORCHESTRATION_CHANGE_NOT_FOUND',
  'ORCHESTRATION_CHANGE_FORBIDDEN',
  'ORCHESTRATION_CHANGE_UNREADABLE',
  'ORCHESTRATION_DEFINITION_FORBIDDEN',
  'ORCHESTRATION_DEFINITION_UNREADABLE',
  'ORCHESTRATION_GRAPH_LIMIT_EXCEEDED',
] as const

export type OrchestrationNodeKind = (typeof ORCHESTRATION_NODE_KINDS)[number]
export type OrchestrationEdgeKind = (typeof ORCHESTRATION_EDGE_KINDS)[number]
export type OrchestrationGraphErrorCode = (typeof ORCHESTRATION_GRAPH_ERROR_CODES)[number]

export interface OrchestrationNode {
  readonly id: string
  readonly kind: OrchestrationNodeKind
  readonly label: string
  readonly status: string | null
  readonly metadata: readonly { readonly key: string; readonly value: string }[]
}

export interface OrchestrationEdge {
  readonly id: string
  readonly kind: OrchestrationEdgeKind
  readonly source: string
  readonly target: string
  readonly label: string
}

export interface OrchestrationGraph {
  readonly schema: 'tenon-orchestration-graph/v1'
  readonly scope: { readonly root: string; readonly change: string }
  readonly coverage: {
    readonly implemented: readonly string[]
    readonly deferred: readonly string[]
  }
  readonly nodes: readonly OrchestrationNode[]
  readonly edges: readonly OrchestrationEdge[]
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length
    && actual.every((key, index) => key === [...keys].sort()[index])
}

function closedUniqueStrings(value: unknown, allowed: readonly string[]): value is string[] {
  return Array.isArray(value)
    && new Set(value).size === value.length
    && value.every((item) =>
      typeof item === 'string' && allowed.some((candidate) => candidate === item))
}

function nodeKind(value: unknown): value is OrchestrationNodeKind {
  return typeof value === 'string'
    && ORCHESTRATION_NODE_KINDS.some((candidate) => candidate === value)
}

function edgeKind(value: unknown): value is OrchestrationEdgeKind {
  return typeof value === 'string'
    && ORCHESTRATION_EDGE_KINDS.some((candidate) => candidate === value)
}

function nodeStatus(value: unknown): value is string | null {
  return value === null
    || (typeof value === 'string'
      && ORCHESTRATION_NODE_STATUSES.some((candidate) => candidate === value))
}

function graphErrorCode(value: unknown): value is OrchestrationGraphErrorCode {
  return typeof value === 'string'
    && ORCHESTRATION_GRAPH_ERROR_CODES.some((candidate) => candidate === value)
}

const METADATA_KEYS_BY_KIND: Record<OrchestrationNodeKind, readonly string[]> = {
  workflow: ['execution_model', 'frozen_fingerprint', 'current_fingerprint'],
  change: ['phase', 'track', 'preset'],
  phase: ['phase_id', 'order', 'gate'],
  task: ['phase'],
  document: ['required_read', 'producer_count'],
  review: ['field'],
  session: ['heartbeat_at', 'expires_at'],
}

const SAFE_COORDINATE = /^[a-zA-Z0-9_-]+$/
const REVIEW_FIELDS = new Set([
  'pre_verify_review_result',
  'agent_review_result',
  'codex_review_result',
])

function safeInteger(value: string, minimum: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum
}

function isoTimestamp(value: string): boolean {
  const calendar = /^(\d{4})-(\d{2})-(\d{2})T.+(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (calendar === null || Number.isNaN(Date.parse(value))) return false
  const year = Number(calendar[1])
  const month = Number(calendar[2])
  const day = Number(calendar[3])
  const parsed = new Date(0)
  parsed.setUTCFullYear(year, month - 1, day)
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

function boundedDisplayValue(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function metadataValue(key: string, value: string): boolean {
  if (key === 'execution_model') return value === 'phase-manifest' || value === 'step-graph'
  if (key === 'frozen_fingerprint' || key === 'current_fingerprint') return /^[a-f0-9]{12}$/.test(value)
  if (key === 'phase' || key === 'phase_id' || key === 'track') return SAFE_COORDINATE.test(value)
  if (key === 'preset') return boundedDisplayValue(value)
  if (key === 'order') return safeInteger(value, 1)
  if (key === 'gate') return ['none', 'review', 'auto'].includes(value)
  if (key === 'required_read') return value === 'true' || value === 'false'
  if (key === 'producer_count') return safeInteger(value, 0)
  if (key === 'field') return REVIEW_FIELDS.has(value)
  if (key === 'heartbeat_at' || key === 'expires_at') return isoTimestamp(value)
  return false
}

export class OrchestrationGraphApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    public readonly code?: OrchestrationGraphErrorCode,
  ) {
    super(message, status)
    this.name = 'OrchestrationGraphApiError'
  }
}

export function decodeOrchestrationGraph(value: unknown): OrchestrationGraph | null {
  if (!isRecord(value)
    || !exactKeys(value, ['schema', 'scope', 'coverage', 'nodes', 'edges'])
    || value.schema !== 'tenon-orchestration-graph/v1'
    || !isRecord(value.scope)
    || !exactKeys(value.scope, ['root', 'change'])
    || typeof value.scope.root !== 'string'
    || typeof value.scope.change !== 'string'
    || value.scope.change === ''
    || !isRecord(value.coverage)
    || !exactKeys(value.coverage, ['implemented', 'deferred'])
    || !closedUniqueStrings(value.coverage.implemented, ORCHESTRATION_IMPLEMENTED_CAPABILITIES)
    || !closedUniqueStrings(value.coverage.deferred, ORCHESTRATION_DEFERRED_CAPABILITIES)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || value.nodes.length > MAX_ORCHESTRATION_NODES
    || value.edges.length > MAX_ORCHESTRATION_EDGES
  ) return null

  const nodes: OrchestrationNode[] = []
  const ids = new Set<string>()
  for (const raw of value.nodes) {
    if (!isRecord(raw)
      || !exactKeys(raw, ['id', 'kind', 'label', 'status', 'metadata'])
      || typeof raw.id !== 'string'
      || raw.id === ''
      || raw.id.length > MAX_ORCHESTRATION_NODE_ID_LENGTH
      || ids.has(raw.id)
      || !nodeKind(raw.kind)
      || typeof raw.label !== 'string'
      || !boundedDisplayValue(raw.label)
      || !nodeStatus(raw.status)
      || !Array.isArray(raw.metadata)
    ) return null
    const metadata: Array<{ key: string; value: string }> = []
    const metadataKeys = new Set<string>()
    for (const item of raw.metadata) {
      if (!isRecord(item)
        || !exactKeys(item, ['key', 'value'])
        || typeof item.key !== 'string'
        || item.key === ''
        || metadataKeys.has(item.key)
        || !METADATA_KEYS_BY_KIND[raw.kind].some((candidate) => candidate === item.key)
        || typeof item.value !== 'string'
        || !metadataValue(item.key, item.value)
      ) return null
      metadataKeys.add(item.key)
      metadata.push({ key: item.key, value: item.value })
    }
    ids.add(raw.id)
    nodes.push({
      id: raw.id,
      kind: raw.kind,
      label: raw.label,
      status: raw.status,
      metadata,
    })
  }

  const edges: OrchestrationEdge[] = []
  const edgeIds = new Set<string>()
  for (const raw of value.edges) {
    if (!isRecord(raw)
      || !exactKeys(raw, ['id', 'kind', 'source', 'target', 'label'])
      || typeof raw.id !== 'string'
      || raw.id === ''
      || raw.id.length > MAX_ORCHESTRATION_EDGE_ID_LENGTH
      || edgeIds.has(raw.id)
      || !edgeKind(raw.kind)
      || typeof raw.source !== 'string'
      || !ids.has(raw.source)
      || typeof raw.target !== 'string'
      || !ids.has(raw.target)
      || typeof raw.label !== 'string'
      || !boundedDisplayValue(raw.label)
    ) return null
    edgeIds.add(raw.id)
    edges.push({
      id: raw.id,
      kind: raw.kind,
      source: raw.source,
      target: raw.target,
      label: raw.label,
    })
  }

  return {
    schema: value.schema,
    scope: { root: value.scope.root, change: value.scope.change },
    coverage: {
      implemented: value.coverage.implemented,
      deferred: value.coverage.deferred,
    },
    nodes,
    edges,
  }
}

export async function fetchOrchestrationGraph(
  root: string,
  change: string,
  signal?: AbortSignal,
): Promise<OrchestrationGraph> {
  const params = new URLSearchParams({ root, change })
  let response: Response
  try {
    response = await fetch(`/api/orchestration-graph?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal,
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) {
    let message = `编排图获取失败（${response.status}）`
    let code: OrchestrationGraphErrorCode | undefined
    try {
      const body = await readJson(response)
      if (isRecord(body)) {
        if (typeof body.error === 'string' && body.error !== '') message = body.error
        if (graphErrorCode(body.code)) code = body.code
      }
    } catch {
      // Old Servers may return a non-JSON 404 for an unknown endpoint.
    }
    throw new OrchestrationGraphApiError(message, response.status, code)
  }
  const decoded = decodeOrchestrationGraph(await readJson(response))
  if (decoded === null) throw new ApiError('编排图响应形状无效', response.status)
  if (decoded.scope.root !== root || decoded.scope.change !== change) {
    throw new ApiError('编排图响应 scope 与请求不一致', response.status)
  }
  return decoded
}
