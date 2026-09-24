
export function slugifyStageName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

export async function readErrorDetail(response: Response): Promise<string> {
  try {
    const error = field(await response.json(), 'error')
    return typeof error === 'string' ? error : ''
  } catch {
    return ''
  }
}

export async function readSaveErrors(
  response: Response,
  unauthorizedMessage: string,
  localizedFallback: string,
  exposeServerDetail: boolean,
): Promise<string[]> {
  if (response.status === 401) return [unauthorizedMessage]
  try {
    const body: unknown = await response.json()
    if (!exposeServerDetail) return [localizedFallback]
    const errors = field(body, 'errors')
    if (Array.isArray(errors)) {
      const strings = errors.filter((error): error is string => typeof error === 'string')
      if (strings.length > 0) return strings
    }
    const error = field(body, 'error')
    if (typeof error === 'string') return [error]
  } catch { /* use the localized status fallback */ }
  return [localizedFallback]
}

export interface WorkflowDeleteErrorEnvelope {
  error?: string
  code?: 'WORKFLOW_REFERENCED' | 'WORKFLOW_REFERENCE_SCAN_FAILED' | 'WORKFLOW_DELETE_STALE'
  references: Array<{
    kind: 'track-default' | 'track-allowed' | 'active-change' | 'loop-binding' | 'policy-template-recommended'
    source: string
  }>
  blockers: Array<{ source: string; detail: string }>
}

export function decodeWorkflowDeleteSuccess(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return body.ok === true && Object.keys(body).length === 1
}

const WORKFLOW_REFERENCE_KINDS = new Set([
  'track-default',
  'track-allowed',
  'active-change',
  'loop-binding',
  'policy-template-recommended',
])

function decodeReferences(value: unknown): WorkflowDeleteErrorEnvelope['references'] | null {
  if (!Array.isArray(value)) return null
  const references: WorkflowDeleteErrorEnvelope['references'] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    if (
      typeof entry.kind !== 'string'
      || !WORKFLOW_REFERENCE_KINDS.has(entry.kind)
      || typeof entry.source !== 'string'
    ) return null
    references.push({
      kind: entry.kind as WorkflowDeleteErrorEnvelope['references'][number]['kind'],
      source: entry.source,
    })
  }
  return references
}

function decodeBlockers(value: unknown): WorkflowDeleteErrorEnvelope['blockers'] | null {
  if (!Array.isArray(value)) return null
  const blockers: WorkflowDeleteErrorEnvelope['blockers'] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    if (typeof entry.source !== 'string' || typeof entry.detail !== 'string') return null
    blockers.push({ source: entry.source, detail: entry.detail })
  }
  return blockers
}

export function decodeWorkflowDeleteError(value: unknown): WorkflowDeleteErrorEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (body.ok !== false) return null
  if (body.error !== undefined && typeof body.error !== 'string') return null

  if (body.code === undefined) {
    if (
      typeof body.error !== 'string'
      || body.workflow !== undefined
      || body.references !== undefined
      || body.blockers !== undefined
    ) return null
    return { error: body.error, references: [], blockers: [] }
  }

  if (typeof body.workflow !== 'string') return null
  if (body.code === 'WORKFLOW_REFERENCED') {
    const references = decodeReferences(body.references)
    if (references === null || body.blockers !== undefined) return null
    return {
      code: body.code,
      ...(body.error === undefined ? {} : { error: body.error }),
      references,
      blockers: [],
    }
  }
  if (body.code === 'WORKFLOW_REFERENCE_SCAN_FAILED') {
    const references = decodeReferences(body.references)
    const blockers = decodeBlockers(body.blockers)
    if (references === null || blockers === null) return null
    return {
      code: body.code,
      ...(body.error === undefined ? {} : { error: body.error }),
      references,
      blockers,
    }
  }
  if (body.code === 'WORKFLOW_DELETE_STALE') {
    if (
      typeof body.error !== 'string'
      || body.references !== undefined
      || body.blockers !== undefined
    ) return null
    return { code: body.code, error: body.error, references: [], blockers: [] }
  }
  return null
}

export type WorkflowDeleteResponse =
  | { kind: 'success' }
  | { kind: 'error'; body: WorkflowDeleteErrorEnvelope }
  | { kind: 'invalid' }

export async function readWorkflowDeleteResponse(response: Response): Promise<WorkflowDeleteResponse> {
  try {
    const value: unknown = await response.json()
    if (response.ok) {
      return decodeWorkflowDeleteSuccess(value) ? { kind: 'success' } : { kind: 'invalid' }
    }
    const body = decodeWorkflowDeleteError(value)
    return body === null ? { kind: 'invalid' } : { kind: 'error', body }
  } catch {
    return { kind: 'invalid' }
  }
}

export interface WorkflowReferenceEntry {
  kind: 'track' | 'loop' | 'template'
  name: string
}

/** 服务端引用清单（`change:x` / `track:x` / `loop:x` / `template:x`）→ 引用它的任务名与其它引用，各自去重。 */
export function splitWorkflowReferences(
  references: ReadonlyArray<{ kind: string; source: string }>,
): { tasks: string[]; references: WorkflowReferenceEntry[] } {
  const tasks: string[] = []
  const others: WorkflowReferenceEntry[] = []
  for (const { kind, source } of references) {
    const name = source.slice(source.indexOf(':') + 1)
    if (kind === 'active-change') {
      if (!tasks.includes(name)) tasks.push(name)
      continue
    }
    const category = kind === 'loop-binding' ? 'loop' : kind === 'policy-template-recommended' ? 'template' : 'track'
    if (!others.some((entry) => entry.kind === category && entry.name === name)) others.push({ kind: category, name })
  }
  return { tasks, references: others }
}
