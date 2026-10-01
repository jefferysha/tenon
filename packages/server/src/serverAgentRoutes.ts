/**
 * agent 库路由。路由表只各加一行分派：GET 在这里做 Host 守卫；POST / PUT / DELETE 的 Host 守卫与
 * token 鉴权由路由表在分派前完成。返回 null = 非本模块路由。
 *
 * 官方 / 自定义两层是全局的；带 `root`（已注册项目）时一并读写项目层 `<root>/.tenon/agents`。
 * 页面只展示与编辑正文：新建在终端（`tenon agent new|add`）；这里有复制为自定义、保存正文、删除。
 * 删除前扫全部工作流的引用；已经开始的任务用的是自己的冻结副本，删库不影响它们。
 */
import type { IncomingMessage } from 'node:http'
import {
  AGENT_FILE_MAX_BYTES, AGENT_NAME_RE, AgentStoreError,
  agentScope, agentWorkflowReferences, deleteAgent, effectiveAgent, loadAgentLibrary, renameAgentContent, writeAgent,
  type AgentEntry, type AgentScope,
} from '@tenon/kernel'
import { agentRecentRuns } from './agentRecentRuns.js'
import { repoRootForSkills } from './serverSupport.js'
import type { ServerPaths } from './types.js'
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'

export interface AgentRouteResult { readonly status: number; readonly body: unknown }

type RootCheck = { ok: true; anchor: WorkflowRootAnchor } | { ok: false; code: number; error: string }

export interface AgentRouteDeps {
  readonly isLocalHost: (host: string | undefined, port: number) => boolean
  readonly boundPort: () => number
  readonly paths: ServerPaths
  readonly readJsonBody?: (req: IncomingMessage) => Promise<unknown>
  /** 内建 agent 的 payload 根；缺省为本 server 所在插件根目录。 */
  readonly payloadRoot?: string
  /** 项目根锚（已注册项目）；带 root 的请求据此读写项目层。 */
  readonly workflowRootForRequest?: (root: string) => RootCheck
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

/** 请求里的项目根：空 = 只有全局两层；非空必须是已注册项目。 */
function projectRootOf(root: string, deps: AgentRouteDeps): { readonly root?: string } | AgentRouteResult {
  if (root === '') return {}
  const checked = deps.workflowRootForRequest?.(root)
  if (checked === undefined) return failure(404, 'root-not-registered', 'root 未在机器级项目注册表中')
  return checked.ok ? { root: checked.anchor.path } : failure(checked.code, 'root-invalid', checked.error)
}

const isResult = (value: { readonly root?: string } | AgentRouteResult): value is AgentRouteResult => 'status' in value

function options(deps: AgentRouteDeps, projectRoot?: string): { payloadRoot: string; configRoot: string; projectRoot?: string } {
  return {
    payloadRoot: deps.payloadRoot ?? repoRootForSkills(),
    configRoot: deps.paths.configRoot,
    ...(projectRoot === undefined ? {} : { projectRoot }),
  }
}

/** 摘要视图：正文不进列表，前端按需取单个 agent。 */
function summary(entry: AgentEntry): Record<string, unknown> {
  const definition = entry.definition
  return {
    name: entry.name,
    source: entry.source,
    ...(definition === undefined ? {} : { role: definition.role }),
    ...(definition?.roleInferred === true ? { role_inferred: true } : {}),
    ...(definition?.version === undefined ? {} : { version: definition.version }),
    description: definition?.description ?? '',
    skills: definition?.skills ?? [],
    tools: definition?.tools ?? [],
    ...(definition?.model === undefined ? {} : { model: definition.model }),
    ...(definition?.hosts === undefined ? {} : { hosts: definition.hosts }),
    digest: entry.digest,
    ...(entry.shadowedBy === undefined ? {} : { shadowed_by: entry.shadowedBy }),
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

const queryRoot = (req: IncomingMessage): string =>
  new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''

export function resolveAgentGet(
  req: IncomingMessage,
  path: string,
  deps: AgentRouteDeps,
): Promise<AgentRouteResult> | null {
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null
  return (async () => {
    if (!deps.isLocalHost(req.headers.host, deps.boundPort())) return failure(403, 'host-denied', 'Host header 不合法')
    const located = projectRootOf(queryRoot(req), deps)
    if (isResult(located)) return located
    try {
      const library = await loadAgentLibrary(options(deps, located.root))
      if (path === ROOT) {
        return { status: 200, body: { sync: library.sync, agents: library.entries.map(summary) } }
      }
      const name = nameFrom(path)
      if (name === null) return failure(400, 'agent-invalid', 'agent 名称非法')
      const entry = effectiveAgent(library, name) ?? library.entries.find((candidate) => candidate.name === name)
      if (entry === undefined) return failure(404, 'agent-missing', `agent 库中不存在 '${name}'`)
      return {
        status: 200,
        body: {
          name: entry.name,
          source: entry.source,
          content: entry.content,
          digest: entry.digest,
          references: agentWorkflowReferences({ configRoot: deps.paths.configRoot, ...(located.root === undefined ? {} : { projectRoot: located.root }) }, name),
          runs: located.root === undefined ? [] : await agentRecentRuns(located.root, name),
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

async function copy(req: IncomingMessage, from: string, deps: AgentRouteDeps): Promise<AgentRouteResult> {
  const parsed = record(deps.readJsonBody ? await deps.readJsonBody(req) : undefined, ['name', 'root'])
  if (!parsed || typeof parsed.name !== 'string' || (parsed.root !== undefined && typeof parsed.root !== 'string')) {
    return failure(400, 'agent-invalid', '请求体须含 name')
  }
  const located = projectRootOf(parsed.root ?? '', deps)
  if (isResult(located)) return located
  const library = await loadAgentLibrary(options(deps, located.root))
  const source = effectiveAgent(library, from)
  if (source === undefined) return failure(404, 'agent-missing', `agent 库中不存在 '${from}'`)
  const entry = await writeAgent(agentScope('custom', options(deps)), parsed.name, renameAgentContent(source.content, parsed.name), { create: true })
  return { status: 201, body: { ok: true, agent: summary(entry) } }
}

interface Writable { readonly scope: AgentScope; readonly projectRoot?: string }

/** 可写的那一层：`source: project` 必须带已注册项目的 root；缺省自定义层。 */
function writableScope(parsed: Record<string, unknown>, deps: AgentRouteDeps): Writable | AgentRouteResult {
  if (parsed.source !== undefined && parsed.source !== 'custom' && parsed.source !== 'project') {
    return failure(400, 'agent-invalid', 'source 只能是 custom | project')
  }
  if (parsed.source !== 'project') return { scope: agentScope('custom', options(deps)) }
  const located = projectRootOf(typeof parsed.root === 'string' ? parsed.root : '', deps)
  if (isResult(located)) return located
  if (located.root === undefined) return failure(400, 'agent-invalid', '项目级 agent 需要 root')
  return { scope: agentScope('project', options(deps, located.root)), projectRoot: located.root }
}

const isWritable = (value: Writable | AgentRouteResult): value is Writable => 'scope' in value

async function update(req: IncomingMessage, name: string, deps: AgentRouteDeps): Promise<AgentRouteResult> {
  // 传输层在上限处就把请求体丢掉，所以超限要在读之前按 content-length 判。
  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
  if (Number.isFinite(declared) && declared > AGENT_FILE_MAX_BYTES) {
    return failure(413, 'too-large', `agent 文件超过 ${AGENT_FILE_MAX_BYTES} 字节`)
  }
  const parsed = record(deps.readJsonBody ? await deps.readJsonBody(req) : undefined, ['content', 'digest', 'source', 'root'])
  if (!parsed || typeof parsed.content !== 'string') return failure(400, 'agent-invalid', '请求体须含 content')
  if (parsed.digest !== undefined && typeof parsed.digest !== 'string') {
    return failure(400, 'agent-invalid', 'digest 必须是字符串')
  }
  const writable = writableScope(parsed, deps)
  if (!isWritable(writable)) return writable
  await loadAgentLibrary(options(deps))
  const entry = await writeAgent(writable.scope, name, parsed.content, {
    ...(parsed.digest === undefined ? {} : { digest: parsed.digest }),
  })
  return { status: 200, body: { ok: true, agent: summary(entry) } }
}

async function remove(req: IncomingMessage, name: string, deps: AgentRouteDeps): Promise<AgentRouteResult> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  // 引用要看请求所在项目的工作流库（`root`），与 CLI 在项目里运行 `agent rm` 一致；root 不在注册表里就拒绝。
  const scanned = projectRootOf(query.get('root') ?? '', deps)
  if (isResult(scanned)) return scanned
  const writable = writableScope({ source: query.get('source') ?? undefined, root: query.get('root') ?? undefined }, deps)
  if (!isWritable(writable)) return writable
  const library = await loadAgentLibrary(options(deps, writable.projectRoot))
  // 官方只读先判：官方 agent 被默认工作流引用是常态，不该先报「被引用」再报「只读」。
  const named = library.entries.filter((candidate) => candidate.name === name)
  if (named.length === 0) return failure(404, 'agent-missing', `agent 库中不存在 '${name}'`)
  if (named.some((candidate) => candidate.source === 'builtin')) return failure(403, 'agent-builtin-readonly', '官方 agent 只读')
  const references = agentWorkflowReferences({ configRoot: deps.paths.configRoot, ...(scanned.root === undefined ? {} : { projectRoot: scanned.root }) }, name)
  if (references.length > 0) {
    return failure(409, 'agent-referenced', 'agent 被工作流引用', { references })
  }
  await deleteAgent(writable.scope, name, query.get('digest') ?? undefined)
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
      if (method === 'POST' && path.endsWith('/copy')) {
        const from = nameFrom(path.slice(0, -'/copy'.length))
        if (from === null) return failure(400, 'agent-invalid', 'agent 名称非法')
        return await copy(req, from, deps)
      }
      if (method === 'POST') return failure(404, 'not-found', '新建 agent 在终端：tenon agent new')
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
