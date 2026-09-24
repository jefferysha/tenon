/**
 * 指令模板库（/api/instruction-templates）、指令文件（/api/instructions）、项目客户端（/api/projects/clients）
 * 与新建项目（/api/projects/create）客户端。
 * 写请求带 Bearer token；失败统一抛 InstructionApiError（保留 server 的 code、错误列表与冲突摘要，供页面按码展示）。
 */
import {
  decodeComposeResult, decodeDigest, decodeInstructionApply, decodeInstructionDelete, decodeInstructionPreview,
  decodeInstructionState, decodeProjectClients, decodeProjectCreatePlan, decodeProjectCreated, decodeTemplateDocument, decodeTemplateList,
  type AppliedFile, type ComposeResult, type InstructionPreviewFile, type InstructionState, type ProjectClients, type ProjectCreatePlan,
  type ProjectCreated, type TemplateCategory, type TemplateDocument, type TemplateList, type TemplateRef,
} from './instructionsDecoders'
import { ApiError, getToken, isRecord, readJson, stringArray, wrapNetwork } from './transport'

export class InstructionApiError extends ApiError {
  constructor(
    message: string,
    status: number | undefined,
    hasServerDetail: boolean,
    code: string | undefined,
    public readonly errors: readonly string[] = [],
    public readonly id?: string,
    public readonly digest?: string,
    public readonly step?: string,
  ) {
    super(message, status, hasServerDetail, code)
    this.name = 'InstructionApiError'
  }
}

export async function throwInstructionError(response: Response, fallback: string): Promise<never> {
  let body: unknown = null
  try {
    body = await readJson(response)
  } catch {
    // 非 JSON 响应只保留状态码。
  }
  const record = isRecord(body) ? body : {}
  const errors = stringArray(record.errors) ? record.errors : []
  const detail = typeof record.error === 'string' ? record.error : errors.join('；')
  throw new InstructionApiError(
    detail || `${fallback}（${response.status}）`,
    response.status,
    detail !== '',
    typeof record.code === 'string' ? record.code : undefined,
    errors,
    typeof record.id === 'string' ? record.id : undefined,
    typeof record.digest === 'string' ? record.digest : undefined,
    typeof record.step === 'string' ? record.step : undefined,
  )
}

async function send<T>(input: string, init: RequestInit, decode: (value: unknown) => T | null, fallback: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwInstructionError(response, fallback)
  const decoded = decode(await readJson(response))
  if (decoded === null) throw new InstructionApiError(`${fallback}：响应形状无效`, response.status, false, undefined)
  return decoded
}

const jsonHeaders = (): Record<string, string> => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` })
const templatePath = (ref: TemplateRef): string =>
  `/api/instruction-templates/${ref.source}/${ref.category}/${encodeURIComponent(ref.id)}`

export function fetchTemplates(signal?: AbortSignal): Promise<TemplateList> {
  return send('/api/instruction-templates', { headers: { Accept: 'application/json' }, signal }, decodeTemplateList, '模板列表获取失败')
}

export function fetchTemplate(ref: TemplateRef, signal?: AbortSignal): Promise<TemplateDocument> {
  return send(templatePath(ref), { headers: { Accept: 'application/json' }, signal }, decodeTemplateDocument, '模板获取失败')
}

/** 保存自定义模板；ifMatch 为最后看到的摘要，新建时为 `absent`。返回新摘要。 */
export function saveTemplate(category: TemplateCategory, id: string, text: string, ifMatch: string): Promise<string> {
  return send(templatePath({ source: 'custom', category, id }), {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'If-Match': ifMatch, Authorization: `Bearer ${getToken()}` },
    body: text,
  }, decodeDigest, '模板保存失败')
}

export async function deleteTemplate(category: TemplateCategory, id: string, digest: string): Promise<void> {
  await send(`${templatePath({ source: 'custom', category, id })}?digest=${encodeURIComponent(digest)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getToken()}` },
  }, (value) => (isRecord(value) && value.ok === true && Object.keys(value).length === 1 ? true : null), '模板删除失败')
}

export interface ComposeSelectionInput extends TemplateRef {
  values: Record<string, string>
  catalog?: Record<string, string[]>
}

export function composeInstructions(projectName: string, selections: readonly ComposeSelectionInput[]): Promise<ComposeResult> {
  return send('/api/instruction-templates/compose', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ project_name: projectName, selections }),
  }, decodeComposeResult, '模板拼合失败')
}

/** root 为空 = 用户级。 */
export function fetchInstructions(root: string, signal?: AbortSignal): Promise<InstructionState> {
  return send(`/api/instructions?root=${encodeURIComponent(root)}`, { headers: { Accept: 'application/json' }, signal }, decodeInstructionState, '指令文件获取失败')
}

export function fetchProjectClients(root: string, signal?: AbortSignal): Promise<ProjectClients> {
  return send(`/api/projects/clients?root=${encodeURIComponent(root)}`, { headers: { Accept: 'application/json' }, signal }, decodeProjectClients, '客户端获取失败')
}

/** 整份写入项目启用的客户端（`.tenon/clients.json`）；返回 server 规范化（去重排序）后的集合。 */
export function saveProjectClients(root: string, enabled: readonly string[]): Promise<ProjectClients> {
  return send('/api/projects/clients', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ root, enabled }) }, decodeProjectClients, '客户端保存失败')
}

export function previewInstructions(root: string, text: string, targets: readonly string[]): Promise<InstructionPreviewFile[]> {
  return send('/api/instructions/preview', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ root, text, targets }) }, decodeInstructionPreview, '预览失败')
}

export function applyInstructions(root: string, text: string, targets: readonly { id: string; base_digest: string }[]): Promise<AppliedFile[]> {
  return send('/api/instructions/apply', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ root, text, targets }) }, decodeInstructionApply, '应用失败')
}

export function deleteInstruction(root: string, target: string, digest: string): Promise<'removed' | 'managed-kept'> {
  const query = `root=${encodeURIComponent(root)}&target=${encodeURIComponent(target)}&digest=${encodeURIComponent(digest)}`
  return send(`/api/instructions?${query}`, { method: 'DELETE', headers: { Authorization: `Bearer ${getToken()}` } }, decodeInstructionDelete, '删除失败')
}

/** references：只写一行 `@AGENTS.md` 的文件；append：保留原文、把正文接在后面的文件。 */
export interface ProjectInstructionsInput {
  text: string
  targets: string[]
  base_digests: Record<string, string>
  references?: string[]
  append?: string[]
}

/** clients：记入项目 `.tenon/clients.json` 的客户端 id；省略 = 不写。 */
export type ProjectCreateInput =
  | { mode: 'empty'; parent: string; name: string; directories: string[]; instructions: ProjectInstructionsInput | null; clients?: string[] }
  | { mode: 'existing'; path: string; instructions: ProjectInstructionsInput | null; clients?: string[]; git_init?: boolean }

export function planProjectCreate(input: ProjectCreateInput): Promise<ProjectCreatePlan> {
  return send('/api/projects/create', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ...input, dry_run: true }) }, decodeProjectCreatePlan, '新建项目预览失败')
}

export function createProject(input: ProjectCreateInput): Promise<ProjectCreated> {
  return send('/api/projects/create', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ...input, dry_run: false }) }, decodeProjectCreated, '新建项目失败')
}
