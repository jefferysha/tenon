import type { IncomingMessage } from 'node:http'
import {
  DEFAULT_WORKFLOW_SOURCE,
  builtinWorkflow,
  parseWorkflow,
  serializeWorkflow,
  validateWorkflowForStorage,
  validateWorkflowTrackReferences,
  isDefaultWorkflowName,
  withTrackRegistryLock,
  type TrackValidationContext,
  type WorkflowDef,
} from '@tenon/kernel'
import { missingWorkflowAgents } from './agentReferences.js'
import type { ServerPaths } from './types.js'
import { isWorkflowName } from './workflowTrustedFs.js'
import {
  assertWorkflowRootAnchor,
  ensureWorkflowProjectCoordinationPath,
  readWorkflowForApi,
  readWorkflowSourceForApi,
  writeWorkflowForApi,
  WorkflowNotFoundError,
  type WorkflowRootAnchor,
} from './workflows.js'

/** 与 GET /api/documents/read 同一上限：一份 workflow YAML 不该超过 256KB。 */
export const WORKFLOW_YAML_MAX_BYTES = 256 * 1024

export type YamlRouteResult =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'yaml'; readonly status: 200; readonly text: string }

export interface WorkflowYamlGetDeps {
  readonly workflowRootForRequest: (root: string) => { ok: true; anchor: WorkflowRootAnchor } | { ok: false; code: number; error: string }
  readonly errMsg: (error: unknown) => string
}

const YAML_ROUTE = /^\/api\/workflows\/([^/]+)\/yaml$/

export function matchWorkflowYamlRoute(path: string): string | null {
  const match = YAML_ROUTE.exec(path)
  const segment = match?.[1]
  return segment === undefined ? null : decodeURIComponent(segment)
}

/**
 * GET /api/workflows/:name/yaml —— 导出原文。
 *   · 自定义 / default 覆盖：项目文件原文（受信读，同 readWorkflowForApi 的 fd 边界）；
 *   · default 无覆盖：内建模板源；内建 simple：serializeWorkflow。
 * 返回 null = 非本路由。
 */
export function resolveWorkflowYamlGet(req: IncomingMessage, path: string, deps: WorkflowYamlGetDeps): YamlRouteResult | null {
  const name = matchWorkflowYamlRoute(path)
  if (name === null) return null
  if (!isWorkflowName(name)) return { kind: 'json', status: 400, body: { ok: false, error: '非法 workflow 名（允许中文、字母、数字、- 与 _；不允许空格、点或路径符号）' } }
  const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
  const rootCheck = deps.workflowRootForRequest(root)
  if (!rootCheck.ok) return { kind: 'json', status: rootCheck.code, body: { ok: false, error: rootCheck.error } }
  const builtin = builtinWorkflow(name)
  if (builtin !== null) return { kind: 'yaml', status: 200, text: serializeWorkflow(builtin) }
  try {
    return { kind: 'yaml', status: 200, text: readWorkflowSourceForApi(rootCheck.anchor, name) }
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      if (isDefaultWorkflowName(name)) return { kind: 'yaml', status: 200, text: DEFAULT_WORKFLOW_SOURCE }
      return { kind: 'json', status: 404, body: { ok: false, error: deps.errMsg(error) } }
    }
    return { kind: 'json', status: 500, body: { ok: false, error: deps.errMsg(error) } }
  }
}

export function readTextBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (value: string | null): void => { if (!done) { done = true; resolve(value) } }
    const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
    if (Number.isFinite(declared) && declared > maxBytes) return finish(null)
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buffer.byteLength
      if (size > maxBytes) { finish(null); req.destroy(); return }
      chunks.push(buffer)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
  })
}

export interface WorkflowYamlPutDeps extends WorkflowYamlGetDeps {
  readonly trackValidationContextFor: (anchor: WorkflowRootAnchor) => TrackValidationContext
  /** 全局产品路径；保存前校验工作流引用的 agent 是否都在库里。 */
  readonly paths: ServerPaths
}

/**
 * PUT /api/workflows/:name/yaml —— 导入原文：解析 → 契约校验（default 走 default 契约）→ name 一致 →
 * track 引用校验 → 原子落盘。任一步失败都不写文件。鉴权与 Host 守卫由调用方（mutation 路由表）完成。
 */
export async function handleWorkflowYamlPut(req: IncomingMessage, name: string, deps: WorkflowYamlPutDeps): Promise<{ status: number; body: unknown }> {
  if (!isWorkflowName(name)) return { status: 400, body: { ok: false, error: '非法 workflow 名（允许中文、字母、数字、- 与 _；不允许空格、点或路径符号）' } }
  if (builtinWorkflow(name) !== null) return { status: 409, body: { ok: false, error: `内建 workflow '${name}' 不可覆盖` } }
  const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
  const rootCheck = deps.workflowRootForRequest(root)
  if (!rootCheck.ok) return { status: rootCheck.code, body: { ok: false, error: rootCheck.error } }
  const text = await readTextBody(req, WORKFLOW_YAML_MAX_BYTES)
  if (text === null) return { status: 413, body: { ok: false, error: `workflow YAML 超过 ${WORKFLOW_YAML_MAX_BYTES} 字节上限` } }
  if (text.trim() === '') return { status: 400, body: { ok: false, errors: ['workflow YAML 为空'] } }
  let workflow: WorkflowDef
  try {
    workflow = parseWorkflow(text)
  } catch (error) {
    return { status: 400, body: { ok: false, errors: [deps.errMsg(error)] } }
  }
  const errors = validateWorkflowForStorage(name, workflow)
  if (workflow.name !== name) errors.unshift(`workflow name '${workflow.name}' 必须与 URL 中的 '${name}' 一致`)
  // 工作流引用的每个 agent 都必须在库里；保存之后才发现缺 agent，任务就建不起来了。
  for (const missing of await missingWorkflowAgents(deps.paths, workflow)) {
    errors.push(`工作流引用了 agent 库中不存在的 '${missing}'`)
  }
  if (errors.length > 0) return { status: 400, body: { ok: false, errors } }
  try {
    ensureWorkflowProjectCoordinationPath(rootCheck.anchor)
  } catch (error) {
    return { status: 500, body: { ok: false, error: deps.errMsg(error) } }
  }
  let enteredRegistrySnapshot = false
  try {
    const result = await withTrackRegistryLock(
      rootCheck.anchor.path,
      deps.trackValidationContextFor(rootCheck.anchor),
      async ({ registry }) => {
        enteredRegistrySnapshot = true
        assertWorkflowRootAnchor(rootCheck.anchor)
        const referenceErrors = validateWorkflowTrackReferences(workflow, registry)
        if (referenceErrors.length > 0) return { ok: false as const, errors: referenceErrors }
        return writeWorkflowForApi(rootCheck.anchor, name, workflow)
      },
    )
    return { status: result.ok ? 200 : 400, body: result.ok ? { ok: true, name } : result }
  } catch (error) {
    return enteredRegistrySnapshot
      ? { status: 500, body: { ok: false, error: deps.errMsg(error) } }
      : { status: 400, body: { ok: false, errors: [deps.errMsg(error)] } }
  }
}

/** default 的项目覆盖读取器：无覆盖返回 null；供 resolveEffectiveWorkflowPlan 的 default 分支使用。 */
export function readDefaultOverride(anchor: WorkflowRootAnchor): WorkflowDef | null {
  try {
    return readWorkflowForApi(anchor, 'default')
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return null
    throw error
  }
}
