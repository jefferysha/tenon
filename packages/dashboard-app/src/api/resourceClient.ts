/**
 * 资源目录（/api/resources）客户端。写请求带 Bearer token；失败统一抛 ResourceApiError
 * （保留 server 的 code 与错误列表，页面按码展示）。
 */
import {
  decodeResourceCopied, decodeResourceDocument, decodeResourceList, decodeResourceOk, decodeResourceSaved,
  type ResourceCatalogList, type ResourceDocument, type ResourceDto,
} from './resourceTypes'
import { ApiError, getToken, isRecord, readJson, stringArray, wrapNetwork } from './transport'

export class ResourceApiError extends ApiError {
  constructor(
    message: string,
    status: number | undefined,
    hasServerDetail: boolean,
    code: string | undefined,
    public readonly errors: readonly string[] = [],
  ) {
    super(message, status, hasServerDetail, code)
    this.name = 'ResourceApiError'
  }
}

async function throwResourceError(response: Response, fallback: string): Promise<never> {
  let body: unknown = null
  try {
    body = await readJson(response)
  } catch {
    // 非 JSON 响应只保留状态码。
  }
  const record = isRecord(body) ? body : {}
  const errors = stringArray(record.errors) ? record.errors : []
  const detail = typeof record.error === 'string' ? record.error : errors.join('；')
  throw new ResourceApiError(
    detail || `${fallback}（${response.status}）`,
    response.status,
    detail !== '',
    typeof record.code === 'string' ? record.code : undefined,
    errors,
  )
}

async function send<T>(input: string, init: RequestInit, decode: (value: unknown) => T | null, fallback: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwResourceError(response, fallback)
  const decoded = decode(await readJson(response))
  if (decoded === null) throw new ResourceApiError(`${fallback}：响应形状无效`, response.status, false, undefined)
  return decoded
}

const jsonHeaders = (): Record<string, string> => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` })
const resourcePath = (id: string): string => `/api/resources/${encodeURIComponent(id)}`

export function fetchResources(signal?: AbortSignal): Promise<ResourceCatalogList> {
  return send('/api/resources', { headers: { Accept: 'application/json' }, signal }, decodeResourceList, '资源目录获取失败')
}

export function fetchResource(id: string, signal?: AbortSignal): Promise<ResourceDocument> {
  return send(resourcePath(id), { headers: { Accept: 'application/json' }, signal }, decodeResourceDocument, '资源获取失败')
}

/** 新建或更新自定义条目；revision 是最后看到的版本，新建时省略。 */
export function saveResource(id: string, yaml: string, revision?: string): Promise<ResourceDto> {
  return send(resourcePath(id), {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(revision === undefined ? { yaml } : { yaml, revision }),
  }, decodeResourceSaved, '资源保存失败')
}

export function copyResource(id: string): Promise<{ id: string }> {
  return send(`${resourcePath(id)}/copy`, { method: 'POST', headers: jsonHeaders(), body: '{}' }, decodeResourceCopied, '资源复制失败')
}

export function deleteResource(id: string, revision: string): Promise<{ ok: true }> {
  return send(`${resourcePath(id)}?revision=${encodeURIComponent(revision)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getToken()}` },
  }, decodeResourceOk, '资源删除失败')
}

/** 词典键后缀（`resources.errors.<key>`）。 */
export function resourceErrorKey(error: unknown): string {
  if (!(error instanceof ResourceApiError)) return 'unknown'
  const code = error.code ?? ''
  if (code === '') return 'unknown'
  return code.replace(/-/gu, '_')
}
