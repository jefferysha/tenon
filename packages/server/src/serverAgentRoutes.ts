/**
 * agent 库路由。路由表只各加一行分派：GET 在这里做 Host 守卫；POST / PUT / DELETE 的 Host 守卫与
 * token 鉴权由路由表在分派前完成。返回 null = 非本模块路由。
 *
 * 库是全局的（不带 root）：内建 agent 由 kernel 按 payload 摘要同步，自定义 agent 写在同一个 config 根下。
 * 删除前扫全部工作流的引用；已经开始的任务用的是自己的冻结副本，删库不影响它们。
 */
import type { IncomingMessage } from 'node:http'
import {
  AGENT_FILE_MAX_BYTES, AGENT_NAME_RE, AgentStoreError,
  agentStoreRoot, deleteCustomAgent, loadAgentLibrary, writeCustomAgent,
  type AgentEntry,
} from '@tenon/kernel'
import { agentReferences, type AgentReference } from './agentReferences.js'
import { repoRootForSkills } from './serverSupport.js'
import type { ServerPaths } from './types.js'

export interface AgentRouteResult { readonly status: number; readonly body: unknown }

export interface AgentRouteDeps {
  readonly isLocalHost: (host: string | undefined, port: number) => boolean
  readonly boundPort: () => number
  readonly paths: ServerPaths
  readonly readJsonBody?: (req: IncomingMessage) => Promise<unknown>
  /** 内建 agent 的 payload 根；缺省为本 server 所在插件根目录。 */
  readonly payloadRoot?: string
}

const ROOT = '/api/agents'

const failure = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): AgentRouteResult =>
  ({ status, body: { ok: false, code, error, ...extra } })

const STATUS: Record<AgentStoreError['code'], number> = {
  'agent-invalid': 400,
  'agent-missing': 404,
  'agent-conflict': 409,
  'agent-exists': 409,
  'agent-builtin-readonly': 403,
  'agent-stale': 409,
}

function storeFailure(error: unknown): AgentRouteResult {
  if (error instanceof AgentStoreError) return failure(STATUS[error.code], error.code, error.message)
  return failure(500, 'store-failed', error instanceof Error ? error.message : String(error))
}

function options(deps: AgentRouteDeps): { payloadRoot: string; configRoot: string } {
  return { payloadRoot: deps.payloadRoot ?? repoRootForSkills(), configRoot: deps.paths.configRoot }
}

const storeRoot = (deps: AgentRouteDeps): string => agentStoreRoot(deps.paths.configRoot)

/** 摘要视图：正文不进列表，前端按需取单个 agent。 */
function summary(entry: AgentEntry): Record<string, unknown> {
  const definition = entry.definition
  return {
    name: entry.name,
    source: entry.source,
    description: definition?.description ?? '',
    skills: definition?.skills ?? [],
    tools: definition?.tools ?? [],
    ...(definition?.model === undefined ? {} : { model: definition.model }),
    ...(definition?.hosts === undefined ? {} : { hosts: definition.hosts }),
    digest: entry.digest,
    ...(entry.error === undefined ? {} : { error: entry.error }),
  }
}

/** 路径尾段即 agent 名；不合法名在任何 fs 访问之前就被挡掉。 */
function nameFrom(path: string): string | null {
  const rest = path.slice(ROOT.length + 1)
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }
  return AGENT_NAME_RE.test(decoded) ? decoded : null
}

export function resolveAgentGet(
  req: IncomingMessage,
  path: string,
  deps: AgentRouteDeps,
): Promise<AgentRouteResult> | null {
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null
  return (async () => {
    if (!deps.isLocalHost(req.headers.host, deps.boundPort())) return failure(403, 'host-denied', 'Host header 不合法')
    try {
      const library = await loadAgentLibrary(options(deps))
      if (path === ROOT) {
        return { status: 200, body: { sync: library.sync, agents: library.entries.map(summary) } }
      }
      const name = nameFrom(path)
      if (name === null) return failure(400, 'agent-invalid', 'agent 名称非法')
      const entry = library.entries.find((candidate) => candidate.name === name)
      if (entry === undefined) return failure(404, 'agent-missing', `agent 库中不存在 '${name}'`)
      return {
        status: 200,
        body: {
          name: entry.name,
          source: entry.source,
          content: entry.content,
          digest: entry.digest,
          references: agentReferences(deps.paths, name),
          ...(entry.error === undefined ? {} : { error: entry.error }),
        },
      }
    } catch (error) {
      return storeFailure(error)
    }
  })()
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const parsed = Object.fromEntries(Object.entries(value))
  return Object.keys(parsed).every((key) => allowed.includes(key)) ? parsed : null
}

async function create(req: IncomingMessage, deps: AgentRouteDeps): Promise<AgentRouteResult> {
  const parsed = record(deps.readJsonBody ? await deps.readJsonBody(req) : undefined, ['name', 'content'])
  if (!parsed || typeof parsed.name !== 'string' || typeof parsed.content !== 'string') {
    return failure(400, 'agent-invalid', '请求体须含 name、content')
  }
  await loadAgentLibrary(options(deps))
  const entry = await writeCustomAgent(storeRoot(deps), parsed.name, parsed.content, { create: true })
  return { status: 201, body: { ok: true, agent: summary(entry) } }
}

async function copy(req: IncomingMessage, from: string, deps: AgentRouteDeps): Promise<AgentRouteResult> {
  const parsed = record(deps.readJsonBody ? await deps.readJsonBody(req) : undefined, ['name'])
  if (!parsed || typeof parsed.name !== 'string') return failure(400, 'agent-invalid', '请求体须含 name')
  const library = await loadAgentLibrary(options(deps))
  const source = library.entries.find((candidate) => candidate.name === from)
  if (source === undefined) return failure(404, 'agent-missing', `agent 库中不存在 '${from}'`)
  const content = source.content.replace(/^name: .*$/mu, `name: ${parsed.name}`)
  const entry = await writeCustomAgent(storeRoot(deps), parsed.name, content, { create: true })
  return { status: 201, body: { ok: true, agent: summary(entry) } }
}

async function update(req: IncomingMessage, name: string, deps: AgentRouteDeps): Promise<AgentRouteResult> {
  // 传输层在上限处就把请求体丢掉，所以超限要在读之前按 content-length 判。
  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
  if (Number.isFinite(declared) && declared > AGENT_FILE_MAX_BYTES) {
    return failure(413, 'too-large', `agent 文件超过 ${AGENT_FILE_MAX_BYTES} 字节`)
  }
  const parsed = record(deps.readJsonBody ? await deps.readJsonBody(req) : undefined, ['content', 'digest'])
  if (!parsed || typeof parsed.content !== 'string') return failure(400, 'agent-invalid', '请求体须含 content')
  if (parsed.digest !== undefined && typeof parsed.digest !== 'string') {
    return failure(400, 'agent-invalid', 'digest 必须是字符串')
  }
  await loadAgentLibrary(options(deps))
  const entry = await writeCustomAgent(storeRoot(deps), name, parsed.content, {
    ...(parsed.digest === undefined ? {} : { digest: parsed.digest }),
  })
  return { status: 200, body: { ok: true, agent: summary(entry) } }
}

async function remove(req: IncomingMessage, name: string, deps: AgentRouteDeps): Promise<AgentRouteResult> {
  const library = await loadAgentLibrary(options(deps))
  // 内建只读先判：内建 agent 被默认工作流引用是常态，不该先报「被引用」再报「只读」。
  const entry = library.entries.find((candidate) => candidate.name === name)
  if (entry === undefined) return failure(404, 'agent-missing', `agent 库中不存在 '${name}'`)
  if (entry.source === 'builtin') return failure(403, 'agent-builtin-readonly', '内置 agent 只读')
  const references: readonly AgentReference[] = agentReferences(deps.paths, name)
  if (references.length > 0) {
    return failure(409, 'agent-referenced', 'agent 被工作流引用', { references })
  }
  const digest = new URL(req.url ?? '/', 'http://localhost').searchParams.get('digest') ?? undefined
  await deleteCustomAgent(storeRoot(deps), name, digest)
  return { status: 200, body: { ok: true } }
}

export function resolveAgentMutation(
  req: IncomingMessage,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  deps: AgentRouteDeps,
): Promise<AgentRouteResult> | null {
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null
  return (async () => {
    try {
      if (method === 'POST' && path === ROOT) return await create(req, deps)
      if (method === 'POST' && path.endsWith('/copy')) {
        const from = nameFrom(path.slice(0, -'/copy'.length))
        if (from === null) return failure(400, 'agent-invalid', 'agent 名称非法')
        return await copy(req, from, deps)
      }
      const name = nameFrom(path)
      if (name === null) return failure(400, 'agent-invalid', 'agent 名称非法')
      if (method === 'PUT') return await update(req, name, deps)
      if (method === 'DELETE') return await remove(req, name, deps)
      return failure(404, 'not-found', '未知端点')
    } catch (error) {
      return storeFailure(error)
    }
  })()
}
