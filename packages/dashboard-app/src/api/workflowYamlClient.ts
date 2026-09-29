import { ApiError } from './transport'

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
