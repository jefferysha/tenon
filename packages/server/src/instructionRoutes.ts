/**
 * 指令模板与指令文件路由。路由表只各加一行分派：GET 在这里做 Host 守卫；POST / PUT / DELETE 的 Host 守卫与
 * token 鉴权由路由表在分派前完成（POST 表同时要求 application/json）。返回 null = 非本模块路由。
 */
import type { IncomingMessage } from 'node:http'
import { INSTRUCTION_BLOCK_MAX_BYTES, NO_CATALOG, syncBuiltinLibraries, type BuiltinSyncResult } from '@tenon/kernel'
import {
  composeFromRequest, copyTemplate, deleteCustomTemplate, listTemplates, parseTemplateRef, readTemplate,
  templateLibraryAnchor, writeCustomTemplate, type LibraryResult,
} from './instructionLibrary.js'
import { trustedFsFailure } from './instructionTrustedFs.js'
import { repoRootForSkills } from './serverSupport.js'
import { readTextBody } from './serverWorkflowYamlRoutes.js'
import type { ServerPaths } from './types.js'

export type RouteResult = LibraryResult

export interface InstructionRouteDeps {
  readonly isLocalHost: (host: string | undefined, port: number) => boolean
  readonly boundPort: () => number
  readonly paths: ServerPaths
  readonly readJsonBody?: (req: IncomingMessage) => Promise<unknown>
  /** 内建库的 payload 根；缺省为本 server 所在插件根目录。 */
  readonly payloadRoot?: string
}

const TEMPLATES = '/api/instruction-templates'

const failure = (status: number, code: string, error: string): RouteResult => ({ status, body: { ok: false, code, error } })

async function syncTemplates(deps: InstructionRouteDeps): Promise<BuiltinSyncResult | null> {
  const results = await syncBuiltinLibraries(deps.payloadRoot ?? repoRootForSkills(), deps.paths.configRoot)
  return results.find((result) => result.id === 'instruction-templates') ?? null
}

function guarded(run: () => RouteResult): RouteResult {
  try {
    return run()
  } catch (error) {
    return trustedFsFailure(error)
  }
}

function segments(path: string): string[] {
  try {
    return path.slice(TEMPLATES.length + 1).split('/').map((segment) => decodeURIComponent(segment))
  } catch {
    return []
  }
}

export function resolveInstructionGet(req: IncomingMessage, path: string, deps: InstructionRouteDeps): Promise<RouteResult> | null {
  if (path !== TEMPLATES && !path.startsWith(`${TEMPLATES}/`)) return null
  return (async () => {
    if (!deps.isLocalHost(req.headers.host, deps.boundPort())) return failure(403, 'host-denied', 'Host header 不合法')
    const sync = await syncTemplates(deps)
    return guarded(() => {
      const anchor = templateLibraryAnchor(deps.paths.configRoot)
      if (path === TEMPLATES) return { status: 200, body: { ok: true, sync, templates: listTemplates(anchor) } }
      const [source = '', category = '', id = '', ...rest] = segments(path)
      const ref = rest.length === 0 ? parseTemplateRef(source, category, id) : null
      return ref ? readTemplate(anchor, ref) : failure(400, 'invalid-template-ref', '模板路径不合法')
    })
  })()
}

function contentType(req: IncomingMessage): string {
  return (String(req.headers['content-type'] ?? '').split(';', 1)[0] ?? '').trim().toLowerCase()
}

async function putTemplate(req: IncomingMessage, path: string, deps: InstructionRouteDeps): Promise<RouteResult> {
  const [source = '', category = '', id = '', ...rest] = segments(path)
  const ref = rest.length === 0 ? parseTemplateRef(source, category, id) : null
  if (!ref) return failure(400, 'invalid-template-ref', '模板路径不合法')
  if (ref.source === 'builtin') return failure(409, 'template-builtin-readonly', '内建模板只读')
  if (contentType(req) !== 'text/markdown') return failure(400, 'content-type', '模板保存要求 Content-Type: text/markdown')
  const ifMatch = req.headers['if-match']
  if (typeof ifMatch !== 'string' || ifMatch === '') return failure(428, 'if-match-required', '缺少 If-Match')
  const text = await readTextBody(req, INSTRUCTION_BLOCK_MAX_BYTES)
  if (text === null) return failure(413, 'too-large', `模板超过 ${INSTRUCTION_BLOCK_MAX_BYTES} 字节`)
  return guarded(() => writeCustomTemplate(templateLibraryAnchor(deps.paths.configRoot), ref.category, ref.id, text, ifMatch))
}

async function postCopy(req: IncomingMessage, deps: InstructionRouteDeps): Promise<RouteResult> {
  const body = deps.readJsonBody ? await deps.readJsonBody(req) : undefined
  const request = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : null
  const from = request && typeof request.from === 'object' && request.from !== null ? Object.fromEntries(Object.entries(request.from)) : null
  const ref = from ? parseTemplateRef(String(from.source), String(from.category), String(from.id)) : null
  const id = typeof request?.id === 'string' ? request.id : ''
  if (!request || Object.keys(request).some((key) => key !== 'from' && key !== 'id') || !ref || parseTemplateRef('custom', ref.category, id) === null) {
    return failure(400, 'invalid-template-ref', '复制请求不合法')
  }
  await syncTemplates(deps)
  return guarded(() => copyTemplate(templateLibraryAnchor(deps.paths.configRoot), ref, id))
}

async function postCompose(req: IncomingMessage, deps: InstructionRouteDeps): Promise<RouteResult> {
  const body = deps.readJsonBody ? await deps.readJsonBody(req) : undefined
  await syncTemplates(deps)
  return guarded(() => composeFromRequest(templateLibraryAnchor(deps.paths.configRoot), body, NO_CATALOG))
}

function deleteTemplate(req: IncomingMessage, path: string, deps: InstructionRouteDeps): RouteResult {
  const [source = '', category = '', id = '', ...rest] = segments(path)
  const ref = rest.length === 0 ? parseTemplateRef(source, category, id) : null
  if (!ref) return failure(400, 'invalid-template-ref', '模板路径不合法')
  if (ref.source === 'builtin') return failure(409, 'template-builtin-readonly', '内建模板只读')
  const digest = new URL(req.url ?? '/', 'http://localhost').searchParams.get('digest') ?? ''
  if (digest === '') return failure(428, 'if-match-required', '缺少 digest')
  return guarded(() => deleteCustomTemplate(templateLibraryAnchor(deps.paths.configRoot), ref.category, ref.id, digest))
}

export function resolveInstructionMutation(
  req: IncomingMessage,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  deps: InstructionRouteDeps,
): Promise<RouteResult> | null {
  if (!path.startsWith(`${TEMPLATES}/`)) return null
  if (method === 'POST' && path === `${TEMPLATES}/copy`) return postCopy(req, deps)
  if (method === 'POST' && path === `${TEMPLATES}/compose`) return postCompose(req, deps)
  if (method === 'PUT') return putTemplate(req, path, deps)
  if (method === 'DELETE') return Promise.resolve(deleteTemplate(req, path, deps))
  return Promise.resolve(failure(404, 'not-found', '未知端点'))
}
