import { ApiError, getToken } from './transport'

/** GET /api/workflows/:name/yaml —— 工作流 YAML 原文（内建模板 / 项目文件）。 */
export async function fetchWorkflowYaml(name: string, root: string, signal?: AbortSignal): Promise<string> {
  let response: Response
  try {
    response = await fetch(`/api/workflows/${encodeURIComponent(name)}/yaml?root=${encodeURIComponent(root)}`, {
      headers: { Accept: 'text/yaml' },
      signal,
    })
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) throw new ApiError('workflow YAML 获取失败', response.status)
  return response.text()
}

export type PutWorkflowYamlResult =
  | { ok: true; name: string }
  | { ok: false; status: number; errors: string[] }

/** PUT /api/workflows/:name/yaml —— 导入原文；服务端解析 + 校验后才落盘，失败返回错误列表。 */
export async function putWorkflowYaml(name: string, root: string, text: string): Promise<PutWorkflowYamlResult> {
  let response: Response
  try {
    response = await fetch(`/api/workflows/${encodeURIComponent(name)}/yaml?root=${encodeURIComponent(root)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/yaml; charset=utf-8', Authorization: `Bearer ${getToken()}` },
      body: text,
    })
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error))
  }
  let body: unknown = null
  try { body = await response.json() } catch { /* 非 JSON 体走状态码 */ }
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : null
  if (response.ok && record?.ok === true && typeof record.name === 'string') return { ok: true, name: record.name }
  const errors = Array.isArray(record?.errors)
    ? record.errors.filter((item): item is string => typeof item === 'string')
    : typeof record?.error === 'string' ? [record.error] : []
  return { ok: false, status: response.status, errors }
}
