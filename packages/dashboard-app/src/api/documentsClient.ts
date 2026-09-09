import { ApiError, isAbortError } from './transport'

export interface DocumentRead {
  readonly path: string
  readonly text: string
  readonly bytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * GET /api/documents/read —— 工作台读取阶段输入 / 产出文件的唯一入口。只读；root 必须是已登记项目，
 * path 是项目根相对路径（server 端限定在根内、拒绝符号链接、256KB 上限）。
 */
export async function fetchDocument(root: string, path: string, signal?: AbortSignal): Promise<DocumentRead> {
  const query = new URLSearchParams({ root, path })
  let response: Response
  try {
    response = await fetch(`/api/documents/read?${query.toString()}`, { signal })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ApiError('network error')
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.error === 'string' ? body.error : ''
    throw new ApiError(detail, response.status, detail !== '')
  }
  if (!isRecord(body) || body.ok !== true || typeof body.text !== 'string' || typeof body.path !== 'string' || typeof body.bytes !== 'number') {
    throw new ApiError('invalid response', response.status)
  }
  return { path: body.path, text: body.text, bytes: body.bytes }
}
