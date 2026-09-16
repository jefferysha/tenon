/**
 * 资源目录路由。路由表只各加一行分派：GET 在这里做 Host 守卫；PUT / DELETE / POST 的 Host 守卫与
 * token 鉴权由路由表在分派前完成。返回 null = 非本模块路由。
 *
 * 目录是全局的（不带 root）：内建条目由 kernel 按 payload 摘要同步，自定义条目写在同一个 config 根下。
 */
import type { IncomingMessage } from 'node:http'
import {
  RESOURCE_ENTRY_MAX_BYTES, RESOURCE_ID, ResourceStoreError, copyResource, deleteCustomResource,
  loadResourceCatalog, readResourceFile, resourceStoreRoot, writeCustomResource,
  type ResourceEntry, type ResourceSource,
} from '@tenon/kernel'
import { fetchDesignSeed, httpsDesignSeedFetch, writeDesignSeed, type DesignSeedFetch } from './designSeed.js'
import { repoRootForSkills } from './serverSupport.js'
import type { ServerPaths } from './types.js'
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'

export interface ResourceRouteResult { readonly status: number; readonly body: unknown }

export interface ResourceRouteDeps {
  readonly isLocalHost: (host: string | undefined, port: number) => boolean
  readonly boundPort: () => number
  readonly paths: ServerPaths
  readonly readJsonBody?: (req: IncomingMessage) => Promise<unknown>
  /** 内建条目的 payload 根；缺省为本 server 所在插件根目录。 */
  readonly payloadRoot?: string
  /** 项目根必须已在机器级注册表里；未注入时 DESIGN.md 起步端点直接 404。 */
  readonly workflowRootForRequest?: (root: string) => { ok: true; anchor: WorkflowRootAnchor } | { ok: false; code: number; error: string }
  /** DESIGN.md 起步内容的抓取器；缺省走 https。 */
  readonly designSeedFetch?: DesignSeedFetch
}

const SEED = '/api/design/seed'

const ROOT = '/api/resources'

const failure = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): ResourceRouteResult =>
  ({ status, body: { ok: false, code, error, ...extra } })

const STATUS: Record<ResourceStoreError['code'], number> = {
  invalid: 400,
  'builtin-readonly': 409,
  conflict: 409,
  'not-found': 404,
  duplicate: 409,
}

function storeFailure(error: unknown): ResourceRouteResult {
  if (error instanceof ResourceStoreError) {
    return failure(STATUS[error.code], error.code, error.message, error.errors.length > 0 ? { errors: error.errors } : {})
  }
  return failure(500, 'store-failed', error instanceof Error ? error.message : String(error))
}

const dto = (entry: ResourceEntry, source: ResourceSource, revision: string): Record<string, unknown> =>
  ({ ...entry, source, revision })

function options(deps: ResourceRouteDeps): { payloadRoot: string; configRoot: string } {
  return { payloadRoot: deps.payloadRoot ?? repoRootForSkills(), configRoot: deps.paths.configRoot }
}

const storeRoot = (deps: ResourceRouteDeps): string => resourceStoreRoot(deps.paths.configRoot)

/** 路径尾段即资源 id；不合法 id 在任何 fs 访问之前就被挡掉。 */
function idFrom(path: string): string | null {
  const rest = path.slice(ROOT.length + 1)
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }
  return RESOURCE_ID.test(decoded) ? decoded : null
}

export function resolveResourceGet(req: IncomingMessage, path: string, deps: ResourceRouteDeps): Promise<ResourceRouteResult> | null {
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null
  return (async () => {
    if (!deps.isLocalHost(req.headers.host, deps.boundPort())) return failure(403, 'host-denied', 'Host header 不合法')
    try {
      if (path === ROOT) {
        const catalog = await loadResourceCatalog(options(deps))
        return {
          status: 200,
          body: {
            schema_version: 'resource-catalog/v1',
            sync: catalog.sync,
            entries: catalog.resources.map((item) => dto(item.entry, item.source, item.revision)),
            errors: catalog.errors,
          },
        }
      }
      const id = idFrom(path)
      if (id === null) return failure(404, 'not-found', '未知资源')
      await loadResourceCatalog(options(deps))
      const file = await readResourceFile(storeRoot(deps), id)
      if (!file) return failure(404, 'not-found', `未知资源：${id}`)
      return { status: 200, body: { ok: true, entry: dto(file.stored.entry, file.stored.source, file.stored.revision), yaml: file.yaml } }
    } catch (error) {
      return storeFailure(error)
    }
  })()
}

function body(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = Object.fromEntries(Object.entries(value))
  return Object.keys(record).every((key) => key === 'yaml' || key === 'revision') ? record : null
}

async function put(req: IncomingMessage, id: string, deps: ResourceRouteDeps): Promise<ResourceRouteResult> {
  // 传输层在 64 KiB 处就把请求体丢掉（readJsonBody 返回 undefined），所以超限要在读之前按 content-length 判。
  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
  if (Number.isFinite(declared) && declared > RESOURCE_ENTRY_MAX_BYTES) {
    return failure(413, 'too-large', `条目超过 ${RESOURCE_ENTRY_MAX_BYTES} 字节`)
  }
  const parsed = body(deps.readJsonBody ? await deps.readJsonBody(req) : undefined)
  if (!parsed || typeof parsed.yaml !== 'string') return failure(400, 'invalid', '请求体须含 yaml')
  if (parsed.revision !== undefined && typeof parsed.revision !== 'string') return failure(400, 'invalid', 'revision 必须是字符串')
  await loadResourceCatalog(options(deps))
  const stored = await writeCustomResource(storeRoot(deps), id, parsed.yaml, parsed.revision)
  return { status: 200, body: { ok: true, entry: dto(stored.entry, stored.source, stored.revision) } }
}

const SEED_STATUS = { 'not-design-md': 400, exists: 409, 'fetch-failed': 502 } as const

async function seed(req: IncomingMessage, deps: ResourceRouteDeps): Promise<ResourceRouteResult> {
  const parsed = deps.readJsonBody ? await deps.readJsonBody(req) : undefined
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : null
  if (!record || typeof record.root !== 'string' || typeof record.resource !== 'string'
    || Object.keys(record).some((key) => key !== 'root' && key !== 'resource')) {
    return failure(400, 'invalid', '请求体须含 root、resource')
  }
  const checked = deps.workflowRootForRequest?.(record.root)
  if (!checked) return failure(404, 'root-not-registered', 'root 未在机器级项目注册表中')
  if (!checked.ok) return { status: checked.code, body: { ok: false, error: checked.error } }
  if (!RESOURCE_ID.test(record.resource)) return failure(404, 'not-found', `未知资源：${record.resource}`)
  await loadResourceCatalog(options(deps))
  const file = await readResourceFile(storeRoot(deps), record.resource)
  if (!file) return failure(404, 'not-found', `未知资源：${record.resource}`)
  const fetched = await fetchDesignSeed(file.stored.entry, deps.designSeedFetch ?? httpsDesignSeedFetch)
  if (!fetched.ok) return failure(SEED_STATUS[fetched.code], fetched.code, fetched.error)
  const written = writeDesignSeed(record.root, fetched.text)
  return written.ok
    ? { status: 200, body: { ok: true, path: written.path, bytes: written.bytes } }
    : failure(SEED_STATUS[written.code], written.code, written.error)
}

export function resolveResourceMutation(
  req: IncomingMessage,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  deps: ResourceRouteDeps,
): Promise<ResourceRouteResult> | null {
  if (method === 'POST' && path === SEED) {
    return (async () => {
      try {
        return await seed(req, deps)
      } catch (error) {
        return storeFailure(error)
      }
    })()
  }
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null
  return (async () => {
    try {
      if (method === 'POST' && path.endsWith('/copy')) {
        const id = idFrom(path.slice(0, -'/copy'.length))
        if (id === null) return failure(404, 'not-found', '未知资源')
        await loadResourceCatalog(options(deps))
        return { status: 200, body: { ok: true, id: await copyResource(storeRoot(deps), id) } }
      }
      const id = idFrom(path)
      if (id === null) return failure(404, 'not-found', '未知资源')
      if (method === 'PUT') return await put(req, id, deps)
      if (method === 'DELETE') {
        const revision = new URL(req.url ?? '/', 'http://localhost').searchParams.get('revision') ?? undefined
        await loadResourceCatalog(options(deps))
        await deleteCustomResource(storeRoot(deps), id, revision)
        return { status: 200, body: { ok: true } }
      }
      return failure(404, 'not-found', '未知端点')
    } catch (error) {
      return storeFailure(error)
    }
  })()
}
