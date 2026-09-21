/**
 * agent 库：读全量（内建 + 自定义），写只到 custom。错误文案直接来自 server 的 4xx 体——
 * 解析器已经说清楚哪一行不对，前端不再翻译一遍。
 */
import { ApiError, getToken, isAbortError } from './transport'

export interface AgentSummary {
  readonly name: string
  readonly source: 'builtin' | 'custom'
  readonly description: string
  readonly skills: readonly string[]
  readonly tools: readonly string[]
  readonly model?: string
  readonly hosts?: readonly string[]
  readonly digest: string
  readonly error?: string
}

export interface AgentReference {
  readonly workflow: string
  readonly track: string | null
  readonly step: string
  readonly label: string
  readonly role: 'executor' | 'reviewer'
}

export interface AgentDocument {
  readonly name: string
  readonly source: 'builtin' | 'custom'
  readonly content: string
  readonly digest: string
  readonly references: readonly AgentReference[]
}

/** DELETE 被引用时的 409：把引用位置带回来，详情页逐行列出。 */
export class AgentReferencedError extends ApiError {
  readonly references: readonly AgentReference[]
  constructor(message: string, references: readonly AgentReference[]) {
    super(message, 409, true)
    this.name = 'AgentReferencedError'
    this.references = references
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

function decodeReference(value: unknown): AgentReference | null {
  if (!isRecord(value) || typeof value.workflow !== 'string' || typeof value.step !== 'string'
    || typeof value.label !== 'string' || (value.role !== 'executor' && value.role !== 'reviewer')
    || (value.track !== null && typeof value.track !== 'string')) return null
  return { workflow: value.workflow, track: value.track, step: value.step, label: value.label, role: value.role }
}

function decodeReferences(value: unknown): readonly AgentReference[] | null {
  if (!Array.isArray(value)) return null
  const references: AgentReference[] = []
  for (const item of value) {
    const decoded = decodeReference(item)
    if (decoded === null) return null
    references.push(decoded)
  }
  return references
}

async function send(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ApiError('network error')
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.error === 'string' ? body.error : ''
    const references = isRecord(body) ? decodeReferences(body.references) : null
    if (references !== null) throw new AgentReferencedError(detail, references)
    throw new ApiError(detail, response.status, detail !== '')
  }
  if (!isRecord(body)) throw new ApiError('invalid response', response.status)
  return body
}

function decodeSummary(value: unknown): AgentSummary | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.description !== 'string'
    || typeof value.digest !== 'string'
    || (value.source !== 'builtin' && value.source !== 'custom')) return null
  const skills = strings(value.skills)
  const tools = strings(value.tools)
  if (skills === null || tools === null) return null
  if (value.model !== undefined && typeof value.model !== 'string') return null
  if (value.hosts !== undefined && strings(value.hosts) === null) return null
  if (value.error !== undefined && typeof value.error !== 'string') return null
  return {
    name: value.name,
    source: value.source,
    description: value.description,
    skills,
    tools,
    digest: value.digest,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.hosts === undefined ? {} : { hosts: strings(value.hosts) as readonly string[] }),
    ...(value.error === undefined ? {} : { error: value.error }),
  }
}

export async function fetchAgents(signal?: AbortSignal): Promise<readonly AgentSummary[]> {
  const body = await send('/api/agents', { signal })
  if (!Array.isArray(body.agents)) throw new ApiError('invalid response')
  const agents: AgentSummary[] = []
  for (const entry of body.agents) {
    const decoded = decodeSummary(entry)
    if (decoded === null) throw new ApiError('invalid response')
    agents.push(decoded)
  }
  return agents
}

export async function fetchAgent(name: string, signal?: AbortSignal): Promise<AgentDocument> {
  const body = await send(`/api/agents/${encodeURIComponent(name)}`, { signal })
  const references = decodeReferences(body.references)
  if (typeof body.name !== 'string' || typeof body.content !== 'string' || typeof body.digest !== 'string'
    || (body.source !== 'builtin' && body.source !== 'custom') || references === null) {
    throw new ApiError('invalid response')
  }
  return { name: body.name, source: body.source, content: body.content, digest: body.digest, references }
}

const write = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
  body: JSON.stringify(payload),
})

export async function createAgent(name: string, content: string): Promise<void> {
  await send('/api/agents', write('POST', { name, content }))
}

export async function copyAgent(from: string, name: string): Promise<void> {
  await send(`/api/agents/${encodeURIComponent(from)}/copy`, write('POST', { name }))
}

export async function saveAgent(name: string, content: string, digest: string): Promise<void> {
  await send(`/api/agents/${encodeURIComponent(name)}`, write('PUT', { content, digest }))
}

export async function deleteAgent(name: string, digest: string): Promise<void> {
  await send(`/api/agents/${encodeURIComponent(name)}?digest=${encodeURIComponent(digest)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getToken()}` },
  })
}
