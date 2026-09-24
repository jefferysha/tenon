/**
 * 指令模板与指令文件路由。路由表只各加一行分派：GET 在这里做 Host 守卫；POST / PUT / DELETE 的 Host 守卫与
 * token 鉴权由路由表在分派前完成（POST 表同时要求 application/json）。返回 null = 非本模块路由。
 *
 * 写端点还要求本机有声明身份：缺身份 412，任何文件都不动；落盘成功后按 design §3.1 追加一行 audit.jsonl。
 * 只读（GET、preview、compose）与 dry run 不需要身份。
 */
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import {
  INSTRUCTION_BLOCK_MAX_BYTES, NO_CATALOG, loadResourceCatalog, resourceCatalogLookup, syncBuiltinLibraries,
  type BuiltinSyncResult, type CatalogLookup, type RecordActor,
} from '@tenon/kernel'
import {
  IDENTITY_REQUIRED, auditActor, recordInstructionAudit, type InstructionAuditAction, type ResolveInstructionUser,
} from './instructionAudit.js'
import {
  composeFromRequest, copyTemplate, deleteCustomTemplate, listTemplates, parseTemplateRef, readTemplate,
  templateLibraryAnchor, writeCustomTemplate, type LibraryResult,
} from './instructionLibrary.js'
import {
  applyInstructions, deleteInstructionTarget, previewInstructionApply, readInstructionTargets, type InstructionScope,
} from './instructionFiles.js'
import { trustedFsFailure } from './instructionTrustedFs.js'
import { readProjectClients, writeProjectClients } from './projectClients.js'
import { handleProjectCreate, runGitCommand, type GitRunner } from './projectCreate.js'
import { repoRootForSkills } from './serverSupport.js'
import { readTextBody } from './serverWorkflowYamlRoutes.js'
import type { ServerPaths } from './types.js'
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'

export type RouteResult = LibraryResult

export interface InstructionRouteDeps {
  readonly isLocalHost: (host: string | undefined, port: number) => boolean
  readonly boundPort: () => number
  readonly paths: ServerPaths
  readonly readJsonBody?: (req: IncomingMessage) => Promise<unknown>
  readonly workflowRootForRequest?: (root: string) => { ok: true; anchor: WorkflowRootAnchor } | { ok: false; code: number; error: string }
  /** 用户级指令文件所在的宿主 home；缺省为产品路径的 homeDir。 */
  readonly hostHome?: string
  /** 注册项目时写入的 inode 锚表（POST 路由表提供）。 */
  readonly workflowRootAnchors?: Map<string, WorkflowRootAnchor>
  readonly runGit?: GitRunner
  /** 内建库的 payload 根；缺省为本 server 所在插件根目录。 */
  readonly payloadRoot?: string
  /** 请求 root 上的声明身份（路由表注入）；写端点据此记作者。 */
  readonly resolveUser?: ResolveInstructionUser
}

const TEMPLATES = '/api/instruction-templates'
const INSTRUCTIONS = '/api/instructions'
const PROJECT_CLIENTS = '/api/projects/clients'

/** root 为空 = 用户级；否则必须是已注册项目根。 */
function scopeFor(root: string, deps: InstructionRouteDeps): InstructionScope | RouteResult {
  if (root === '') return { level: 'user', homeDir: deps.hostHome ?? deps.paths.homeDir, env: process.env, platform: process.platform }
  const checked = deps.workflowRootForRequest?.(root)
  if (!checked) return failure(404, 'root-not-registered', 'root 未在机器级项目注册表中')
  return checked.ok ? { level: 'project', anchor: checked.anchor } : { status: checked.code, body: { ok: false, error: checked.error } }
}

const isScope = (value: InstructionScope | RouteResult): value is InstructionScope => 'level' in value

/** 写端点的作者；模板库是用户级，所以 root 传空串。 */
const actorFor = (deps: InstructionRouteDeps, root: string): RecordActor | RouteResult =>
  auditActor(deps.resolveUser, root) ?? IDENTITY_REQUIRED

const isActor = (value: RecordActor | RouteResult): value is RecordActor => 'trust' in value

function audit(
  deps: InstructionRouteDeps, actor: RecordActor, action: InstructionAuditAction, target: string, before: string, after: string,
): void {
  recordInstructionAudit(deps.paths.configRoot, { actor, action, target, digest_before: before, digest_after: after })
}

/** 200 响应里的 digest；没有该字段（删除到文件消失）时按缺失记。 */
function digestOf(result: RouteResult): string {
  const body = result.body as { digest?: unknown } | null
  return typeof body?.digest === 'string' ? body.digest : 'absent'
}

const instructionTarget = (root: string, id: string): string => (root === '' ? `user/${id}` : join(root, id))

function objectBody(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = Object.fromEntries(Object.entries(value))
  return Object.keys(record).every((key) => keys.includes(key)) ? record : null
}

async function postInstructions(req: IncomingMessage, action: 'preview' | 'apply', deps: InstructionRouteDeps): Promise<RouteResult> {
  const body = objectBody(deps.readJsonBody ? await deps.readJsonBody(req) : undefined, ['root', 'text', 'targets'])
  if (!body || typeof body.root !== 'string' || !Array.isArray(body.targets)) return failure(400, 'invalid', '请求体须含 root、text、targets')
  const scope = scopeFor(body.root, deps)
  if (!isScope(scope)) return scope
  if (action === 'preview') {
    const ids = body.targets.filter((item): item is string => typeof item === 'string')
    if (ids.length !== body.targets.length) return failure(400, 'invalid-target', 'targets 必须是文件 id 列表')
    return previewInstructionApply(scope, body.text, ids)
  }
  const targets = body.targets.map((item) => objectBody(item, ['id', 'base_digest']))
    .map((item) => (item && typeof item.id === 'string' && typeof item.base_digest === 'string' ? { id: item.id, base_digest: item.base_digest } : null))
  if (targets.some((item) => item === null)) return failure(400, 'invalid-target', 'targets 必须是 { id, base_digest } 列表')
  const planned = targets.filter((item): item is { id: string; base_digest: string } => item !== null)
  const actor = actorFor(deps, body.root)
  if (!isActor(actor)) return actor
  const applied = applyInstructions(scope, body.text, planned)
  if (applied.status === 200) {
    const root = body.root
    for (const file of (applied.body as { files: readonly { id: string; digest: string }[] }).files) {
      const before = planned.find((item) => item.id === file.id)?.base_digest ?? 'absent'
      audit(deps, actor, 'instruction-apply', instructionTarget(root, file.id), before, file.digest)
    }
  }
  return applied
}

function deleteInstructions(req: IncomingMessage, deps: InstructionRouteDeps): RouteResult {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const root = query.get('root') ?? ''
  const scope = scopeFor(root, deps)
  if (!isScope(scope)) return scope
  const target = query.get('target') ?? ''
  const digest = query.get('digest') ?? ''
  if (target === '' || digest === '') return failure(400, 'invalid-target', '缺少 target 或 digest')
  const actor = actorFor(deps, root)
  if (!isActor(actor)) return actor
  const removed = deleteInstructionTarget(scope, target, digest)
  if (removed.status === 200) audit(deps, actor, 'instruction-delete', instructionTarget(root, target), digest, digestOf(removed))
  return removed
}

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

/** 项目客户端只在已注册项目上有意义：root 必须非空且过注册表锚。 */
function projectAnchor(root: string, deps: InstructionRouteDeps): { anchor: WorkflowRootAnchor } | RouteResult {
  if (root === '') return failure(400, 'invalid', '缺少 root')
  const scope = scopeFor(root, deps)
  if (!isScope(scope)) return scope
  return scope.level === 'project' ? { anchor: scope.anchor } : failure(400, 'invalid', '缺少 root')
}

function getProjectClients(req: IncomingMessage, deps: InstructionRouteDeps): RouteResult {
  const located = projectAnchor(new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? '', deps)
  if (!('anchor' in located)) return located
  return guarded(() => {
    const read = readProjectClients(located.anchor)
    return read.ok
      ? { status: 200, body: { enabled: read.enabled, source: read.source } }
      : failure(read.status, read.code, read.error)
  })
}

async function postProjectClients(req: IncomingMessage, deps: InstructionRouteDeps): Promise<RouteResult> {
  const body = objectBody(deps.readJsonBody ? await deps.readJsonBody(req) : undefined, ['root', 'enabled'])
  if (!body || typeof body.root !== 'string') return failure(400, 'invalid', '请求体须含 root、enabled')
  const root = body.root
  const located = projectAnchor(root, deps)
  if (!('anchor' in located)) return located
  const actor = actorFor(deps, root)
  if (!isActor(actor)) return actor
  return guarded(() => {
    const written = writeProjectClients(located.anchor, body.enabled)
    if (!written.ok) {
      return { status: written.status, body: { ok: false, code: written.code, error: written.error, ...(written.unknown ? { unknown: written.unknown } : {}) } }
    }
    audit(deps, actor, 'project-clients', join(root, '.tenon', 'clients.json'), written.digest_before, written.digest)
    return { status: 200, body: { enabled: written.enabled, source: 'file' } }
  })
}

export function resolveInstructionGet(req: IncomingMessage, path: string, deps: InstructionRouteDeps): Promise<RouteResult> | null {
  if (path === PROJECT_CLIENTS) {
    if (!deps.isLocalHost(req.headers.host, deps.boundPort())) return Promise.resolve(failure(403, 'host-denied', 'Host header 不合法'))
    return Promise.resolve(getProjectClients(req, deps))
  }
  if (path === INSTRUCTIONS) {
    if (!deps.isLocalHost(req.headers.host, deps.boundPort())) return Promise.resolve(failure(403, 'host-denied', 'Host header 不合法'))
    const scope = scopeFor(new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? '', deps)
    return Promise.resolve(isScope(scope) ? readInstructionTargets(scope) : scope)
  }
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
  const actor = actorFor(deps, '')
  if (!isActor(actor)) return actor
  const saved = guarded(() => writeCustomTemplate(templateLibraryAnchor(deps.paths.configRoot), ref.category, ref.id, text, ifMatch))
  if (saved.status === 200) audit(deps, actor, 'template-save', `custom/${ref.category}/${ref.id}`, ifMatch, digestOf(saved))
  return saved
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
  const actor = actorFor(deps, '')
  if (!isActor(actor)) return actor
  await syncTemplates(deps)
  const copied = guarded(() => copyTemplate(templateLibraryAnchor(deps.paths.configRoot), ref, id))
  if (copied.status === 200) audit(deps, actor, 'template-copy', `custom/${ref.category}/${id}`, 'absent', digestOf(copied))
  return copied
}

/** 资源目录读不出来时按「没有目录」拼（资源行整行省略），拼合本身不因目录故障失败。 */
async function resourceLookup(deps: InstructionRouteDeps): Promise<CatalogLookup> {
  try {
    const catalog = await loadResourceCatalog({
      payloadRoot: deps.payloadRoot ?? repoRootForSkills(),
      configRoot: deps.paths.configRoot,
    })
    return resourceCatalogLookup(catalog.resources.map((item) => item.entry))
  } catch {
    return NO_CATALOG
  }
}

async function postCompose(req: IncomingMessage, deps: InstructionRouteDeps): Promise<RouteResult> {
  const body = deps.readJsonBody ? await deps.readJsonBody(req) : undefined
  await syncTemplates(deps)
  const catalog = await resourceLookup(deps)
  return guarded(() => composeFromRequest(templateLibraryAnchor(deps.paths.configRoot), body, catalog))
}

function deleteTemplate(req: IncomingMessage, path: string, deps: InstructionRouteDeps): RouteResult {
  const [source = '', category = '', id = '', ...rest] = segments(path)
  const ref = rest.length === 0 ? parseTemplateRef(source, category, id) : null
  if (!ref) return failure(400, 'invalid-template-ref', '模板路径不合法')
  if (ref.source === 'builtin') return failure(409, 'template-builtin-readonly', '内建模板只读')
  const digest = new URL(req.url ?? '/', 'http://localhost').searchParams.get('digest') ?? ''
  if (digest === '') return failure(428, 'if-match-required', '缺少 digest')
  const actor = actorFor(deps, '')
  if (!isActor(actor)) return actor
  const removed = guarded(() => deleteCustomTemplate(templateLibraryAnchor(deps.paths.configRoot), ref.category, ref.id, digest))
  if (removed.status === 200) audit(deps, actor, 'template-delete', `custom/${ref.category}/${ref.id}`, digest, 'absent')
  return removed
}

export function resolveInstructionMutation(
  req: IncomingMessage,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  deps: InstructionRouteDeps,
): Promise<RouteResult> | null {
  if (method === 'POST' && path === '/api/projects/create') {
    return (async () => {
      if (!deps.workflowRootAnchors) return failure(404, 'not-found', '未知端点')
      const body = deps.readJsonBody ? await deps.readJsonBody(req) : undefined
      return handleProjectCreate(body, {
        paths: deps.paths, workflowRootAnchors: deps.workflowRootAnchors, runGit: deps.runGit ?? runGitCommand,
        actor: auditActor(deps.resolveUser, ''),
      })
    })()
  }
  if (method === 'POST' && path === PROJECT_CLIENTS) return postProjectClients(req, deps)
  if (method === 'POST' && path === `${INSTRUCTIONS}/preview`) return postInstructions(req, 'preview', deps)
  if (method === 'POST' && path === `${INSTRUCTIONS}/apply`) return postInstructions(req, 'apply', deps)
  if (method === 'DELETE' && path === INSTRUCTIONS) return Promise.resolve(deleteInstructions(req, deps))
  if (!path.startsWith(`${TEMPLATES}/`)) return null
  if (method === 'POST' && path === `${TEMPLATES}/copy`) return postCopy(req, deps)
  if (method === 'POST' && path === `${TEMPLATES}/compose`) return postCompose(req, deps)
  if (method === 'PUT') return putTemplate(req, path, deps)
  if (method === 'DELETE') return Promise.resolve(deleteTemplate(req, path, deps))
  return Promise.resolve(failure(404, 'not-found', '未知端点'))
}
