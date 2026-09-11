import type {
  ChangeHistoryEntry,
  CreatedChange,
  WbHooksConfig,
  WbRouterPreview,
  WbSkillEntry,
  WbTrackDefinition, WbSkillFiles, WbSkillFile,
} from './governanceTypes'
import {
  decodeCreatedChange,
  decodeHistory,
  decodeHooksConfig,
  decodeNames,
  decodeRoot,
  decodeRouterPreview,
  isPromptSkipKeyword,
} from './governanceDecoders'
import { decodeSkillFile, decodeSkillFiles, decodeSkillsRegistry, decodeWorkflowDefinition } from './governanceSchema'
import type { WbWorkflowDef, WbWorkflowSource } from './governanceTypes'
import { ApiError, getToken, readJson, throwApiError, wrapNetwork } from './transport'

async function readOrThrow<T>(
  response: Response,
  decode: (value: unknown) => T | null,
  invalidMessage: string,
): Promise<T> {
  let body: unknown
  try {
    body = await readJson(response)
  } catch {
    throw new ApiError(invalidMessage, response.status)
  }
  const decoded = decode(body)
  if (!decoded) throw new ApiError(invalidMessage, response.status)
  return decoded
}

export async function registerProject(root: string): Promise<{ root: string }> {
  let response: Response
  try {
    response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ root }),
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '注册项目失败')
  return readOrThrow(response, decodeRoot, '注册项目响应形状无效')
}

export async function unregisterProject(root: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/projects?root=${encodeURIComponent(root)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getToken()}` },
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '注销项目失败')
}

export interface WorkflowIndex {
  /** 自定义工作流名（不含 default）。 */
  names: string[]
  /** default 当前来源：全局覆盖 → global，项目覆盖 → project。旧 server 不带该字段 → builtin。 */
  defaultSource: WbWorkflowSource
}

function decodeWorkflowIndex(value: unknown): WorkflowIndex | null {
  const names = decodeNames(value)
  if (names === null) return null
  const body = value as Record<string, unknown>
  const source = typeof body.default === 'object' && body.default !== null ? (body.default as Record<string, unknown>).source : undefined
  if (source !== undefined && source !== 'builtin' && source !== 'project' && source !== 'global') return null
  return { names, defaultSource: source ?? 'builtin' }
}

export async function fetchWorkflowIndex(root: string): Promise<WorkflowIndex> {
  let response: Response
  try {
    response = await fetch(`/api/workflows?root=${encodeURIComponent(root)}`, {
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, 'workflow 列表获取失败')
  return readOrThrow(response, decodeWorkflowIndex, 'workflow 列表响应形状无效')
}

export async function fetchWorkflowNames(root: string): Promise<string[]> {
  return (await fetchWorkflowIndex(root)).names
}

export async function fetchHooksConfig(root: string): Promise<WbHooksConfig> {
  let response: Response
  try {
    response = await fetch(`/api/hooks?root=${encodeURIComponent(root)}`, {
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '钩子配置获取失败')
  return readOrThrow(response, decodeHooksConfig, '钩子配置响应形状无效')
}

export async function postHookToggle(input: {
  root: string
  hook: string
  phase: string
  enabled: boolean
}): Promise<void> {
  let response: Response
  try {
    response = await fetch('/api/hooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(input),
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '钩子开关写回失败')
}

export async function postPromptRoutingBypass(
  root: string,
  promptSkipKeyword: string,
): Promise<string> {
  let response: Response
  try {
    response = await fetch('/api/hooks/prompt-routing-bypass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ root, prompt_skip_keyword: promptSkipKeyword }),
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '单轮旁路词写回失败')
  const body = await readJson(response)
  if (typeof body !== 'object' || body === null
    || !isPromptSkipKeyword((body as Record<string, unknown>).prompt_skip_keyword)) {
    throw new ApiError('单轮旁路词响应形状无效', response.status)
  }
  return (body as { prompt_skip_keyword: string }).prompt_skip_keyword
}

export async function getHistory(name: string, root: string): Promise<ChangeHistoryEntry[]> {
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(name)}/history?root=${encodeURIComponent(root)}`, {
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '历史获取失败')
  return readOrThrow(response, decodeHistory, '历史响应形状无效')
}

export async function postRouterPreview(
  root: string,
  prompt: string,
  draftTrack?: WbTrackDefinition,
): Promise<WbRouterPreview> {
  let response: Response
  try {
    response = await fetch('/api/router/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ root, prompt, ...(draftTrack === undefined ? {} : { draft_track: draftTrack }) }),
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '路由预览失败')
  return readOrThrow(response, decodeRouterPreview, '路由预览响应形状无效')
}

export async function postCreateChange(input: {
  root: string
  name: string
  track: string
  workflow: string
  pipeline_id?: string
  task_prompt?: string
  activate_session?: boolean
}): Promise<CreatedChange> {
  let response: Response
  try {
    response = await fetch('/api/changes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(input),
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, 'Change 创建失败')
  return readOrThrow(response, decodeCreatedChange, 'Change 创建响应形状无效')
}

export async function fetchSkillsRegistry(): Promise<WbSkillEntry[]> {
  let response: Response
  try {
    response = await fetch('/api/skills/registry', { headers: { Accept: 'application/json' } })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '技能库获取失败')
  return readOrThrow(response, decodeSkillsRegistry, '技能库响应形状无效')
}

export async function fetchWorkflow(name: string, root: string): Promise<WbWorkflowDef> {
  let response: Response
  try {
    response = await fetch(`/api/workflows/${encodeURIComponent(name)}?root=${encodeURIComponent(root)}`, {
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, 'workflow 获取失败')
  const body = await readOrThrow(response, decodeWorkflowDefinition, 'workflow 响应形状无效')
  if (body.name !== name) throw new ApiError('workflow 响应身份无效', response.status)
  return body
}

export function fetchConfig(root: string): Promise<Response> {
  return fetch(`/api/config?root=${encodeURIComponent(root)}`, { headers: { Accept: 'application/json' } })
}

export function postWorkflowDef(name: string, payload: Record<string, unknown>): Promise<Response> {
  // source / effectiveIo / branches 是读接口附带的投影，不属于定义 DTO；server 的闭合解码器会拒绝未知键。
  const { source: _source, effectiveIo: _effectiveIo, branches: _branches, ...definition } = payload
  return fetch(`/api/workflows/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(definition),
  })
}

export function deleteWorkflowDef(name: string, root: string): Promise<Response> {
  return fetch(`/api/workflows/${encodeURIComponent(name)}?root=${encodeURIComponent(root)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getToken()}` },
  })
}

export function postMandatorySkills(input: {
  phase: string
  track: string
  skills: string[]
  root: string
  /**
   * 调用方读到这份 cell 时的 config revision（乐观并发用）。
   * ⚠️ 现状：server 的 /api/config/mandatory-skills 只取 phase/track/skills，本字段被忽略
   * ——真正的 CAS 拒写要等后端补 revision 比对（见 server/src/config.ts:validateMandatorySkillsBody）。
   * 先发出去是为了让前端不再持有版本却不发；前端已按 409 分支准备好冲突反馈与重载路径。
   */
  revision?: string
}): Promise<Response> {
  return fetch('/api/config/mandatory-skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(input),
  })
}

export function postTrackDefinition(input: {
  root: string
  revision: string
  track: WbTrackDefinition
}): Promise<Response> {
  const { builtin: _builtin, ...track } = input.track
  return fetch('/api/tracks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ root: input.root, revision: input.revision, track }),
  })
}

export function patchTrackDefinition(
  root: string,
  revision: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return fetch(`/api/tracks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ root, revision, patch }),
  })
}

export function deleteTrackDefinition(root: string, revision: string, id: string): Promise<Response> {
  return fetch(
    `/api/tracks/${encodeURIComponent(id)}?root=${encodeURIComponent(root)}&revision=${encodeURIComponent(revision)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${getToken()}` } },
  )
}

/** 某技能目录的文件清单（GET /api/skills/:name/files）。 */
export async function fetchSkillFiles(name: string): Promise<WbSkillFiles> {
  let response: Response
  try {
    response = await fetch(`/api/skills/${encodeURIComponent(name)}/files`, { headers: { Accept: 'application/json' } })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '技能文件清单获取失败')
  return readOrThrow(response, decodeSkillFiles, '技能文件清单响应形状无效')
}

/** 技能目录内一个文本文件（GET /api/skills/:name/file?path=）。 */
export async function fetchSkillFile(name: string, path: string): Promise<WbSkillFile> {
  let response: Response
  try {
    response = await fetch(`/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`, { headers: { Accept: 'application/json' } })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '技能文件获取失败')
  return readOrThrow(response, decodeSkillFile, '技能文件响应形状无效')
}
