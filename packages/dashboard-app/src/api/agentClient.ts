/**
 * agent 库：读全量（官方 + 自定义，带 root 时再加项目层），写只到自定义或项目层。新建在终端
 * （`tenon agent new`），这里没有新建。错误文案直接来自 server 的 4xx 体——解析器已经说清楚哪一行不对，
 * 前端不再翻译一遍。
 */
import { ApiError, getToken, isAbortError } from './transport'

export type AgentSource = 'builtin' | 'custom' | 'project'
export type AgentRole = 'executor' | 'reviewer'

export interface AgentSummary {
  readonly name: string
  readonly source: AgentSource
  /** 解析失败的条目没有身份。 */
  readonly role?: AgentRole
  readonly roleInferred?: boolean
  readonly version?: string
  readonly description: string
  readonly skills: readonly string[]
  readonly tools: readonly string[]
  readonly model?: string
  readonly hosts?: readonly string[]
  readonly digest: string
  /** 同名项目级 agent 生效，本条（自定义）不参与解析。 */
  readonly shadowedBy?: 'project'
  readonly error?: string
}

export interface AgentReference {
  readonly workflow: string
  readonly track: string | null
  readonly step: string
  readonly label: string
  readonly role: AgentRole
}

export interface AgentRun {
  readonly change: string
  readonly step: string
  readonly role: AgentRole
  readonly status: 'running' | 'finished'
  readonly result: 'pass' | 'fail' | 'done' | 'failed' | null
  readonly findings: number
  readonly startedAt: string
  readonly finishedAt: string | null
  /** 宿主用的子代理类型（`tenon-<name>` = 专属子代理）；旧记录没有。 */
  readonly subagent: string | null
}

export interface AgentDocument {
  readonly name: string
  readonly source: AgentSource
  readonly content: string
  readonly digest: string
  readonly references: readonly AgentReference[]
  readonly runs: readonly AgentRun[]
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

const isSource = (value: unknown): value is AgentSource => value === 'builtin' || value === 'custom' || value === 'project'
const isRole = (value: unknown): value is AgentRole => value === 'executor' || value === 'reviewer'

function decodeReference(value: unknown): AgentReference | null {
  if (!isRecord(value) || typeof value.workflow !== 'string' || typeof value.step !== 'string'
    || typeof value.label !== 'string' || !isRole(value.role)
    || (value.track !== null && typeof value.track !== 'string')) return null
  return { workflow: value.workflow, track: value.track, step: value.step, label: value.label, role: value.role }
}

function decodeList<T>(value: unknown, decode: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null
  const items: T[] = []
  for (const item of value) {
    const decoded = decode(item)
    if (decoded === null) return null
    items.push(decoded)
  }
  return items
}

const RESULTS = ['pass', 'fail', 'done', 'failed'] as const

function decodeRun(value: unknown): AgentRun | null {
  if (!isRecord(value) || typeof value.change !== 'string' || typeof value.step !== 'string' || !isRole(value.role)
    || (value.status !== 'running' && value.status !== 'finished') || typeof value.findings !== 'number'
    || typeof value.started_at !== 'string' || (value.finished_at !== null && typeof value.finished_at !== 'string')) return null
  const result = RESULTS.find((item) => item === value.result) ?? null
  if (value.result !== null && result === null) return null
  const subagent = isRecord(value.subagent) && typeof value.subagent.type === 'string' ? value.subagent.type : null
  return {
    change: value.change,
    step: value.step,
    role: value.role,
    status: value.status,
    result,
    findings: value.findings,
    startedAt: value.started_at,
    finishedAt: value.finished_at,
    subagent,
  }
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
    const references = isRecord(body) ? decodeList(body.references, decodeReference) : null
    if (references !== null) throw new AgentReferencedError(detail, references)
    throw new ApiError(detail, response.status, detail !== '')
  }
  if (!isRecord(body)) throw new ApiError('invalid response', response.status)
  return body
}

function decodeSummary(value: unknown): AgentSummary | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.description !== 'string'
    || typeof value.digest !== 'string' || !isSource(value.source)) return null
  const skills = strings(value.skills)
  const tools = strings(value.tools)
  if (skills === null || tools === null) return null
  if (value.role !== undefined && !isRole(value.role)) return null
  if (value.version !== undefined && typeof value.version !== 'string') return null
  if (value.model !== undefined && typeof value.model !== 'string') return null
  if (value.hosts !== undefined && strings(value.hosts) === null) return null
  if (value.error !== undefined && typeof value.error !== 'string') return null
  return {
    name: value.name,
    source: value.source,
    ...(isRole(value.role) ? { role: value.role } : {}),
    ...(value.role_inferred === true ? { roleInferred: true } : {}),
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    description: value.description,
    skills,
    tools,
    digest: value.digest,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.hosts === undefined ? {} : { hosts: strings(value.hosts) as readonly string[] }),
    ...(value.shadowed_by === 'project' ? { shadowedBy: 'project' as const } : {}),
    ...(value.error === undefined ? {} : { error: value.error }),
  }
}

/** `?root=` 只在选中了项目时带上；空串 = 只有全局两层。 */
const withRoot = (url: string, root: string): string =>
  root === '' ? url : `${url}${url.includes('?') ? '&' : '?'}root=${encodeURIComponent(root)}`

export async function fetchAgents(signal?: AbortSignal, root = ''): Promise<readonly AgentSummary[]> {
  const body = await send(withRoot('/api/agents', root), { signal })
  const agents = decodeList(body.agents, decodeSummary)
  if (agents === null) throw new ApiError('invalid response')
  return agents
}

export async function fetchAgent(name: string, signal?: AbortSignal, root = ''): Promise<AgentDocument> {
  const body = await send(withRoot(`/api/agents/${encodeURIComponent(name)}`, root), { signal })
  const references = decodeList(body.references, decodeReference)
  const runs = body.runs === undefined ? [] : decodeList(body.runs, decodeRun)
  if (typeof body.name !== 'string' || typeof body.content !== 'string' || typeof body.digest !== 'string'
    || !isSource(body.source) || references === null || runs === null) {
    throw new ApiError('invalid response')
  }
  return { name: body.name, source: body.source, content: body.content, digest: body.digest, references, runs }
}

const write = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
  body: JSON.stringify(payload),
})

/** 复制为自定义：来源可以是任何一层（带 root 时项目层也可见）。 */
export async function copyAgent(from: string, name: string, root = ''): Promise<void> {
  await send(`/api/agents/${encodeURIComponent(from)}/copy`, write('POST', { name, ...(root === '' ? {} : { root }) }))
}

/** 保存正文：自定义或项目层；项目层带 root。 */
export async function saveAgent(name: string, content: string, digest: string, source: AgentSource = 'custom', root = ''): Promise<void> {
  await send(`/api/agents/${encodeURIComponent(name)}`, write('PUT', {
    content, digest, ...(source === 'project' ? { source, root } : {}),
  }))
}

export async function deleteAgent(name: string, digest: string, source: AgentSource = 'custom', root = ''): Promise<void> {
  const scope = source === 'project' ? `&source=project&root=${encodeURIComponent(root)}` : ''
  await send(`/api/agents/${encodeURIComponent(name)}?digest=${encodeURIComponent(digest)}${scope}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getToken()}` },
  })
}
