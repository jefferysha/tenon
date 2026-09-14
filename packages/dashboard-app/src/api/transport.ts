declare global {
  interface Window {
    __TENON_DASHBOARD_TOKEN__?: string
  }
}

export function getToken(): string {
  if (typeof window === 'undefined') return ''
  return window.__TENON_DASHBOARD_TOKEN__ ?? ''
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly hasServerDetail = false,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'AbortError'
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

/**
 * Convert transport facts into reader-facing copy at the rendering boundary.
 *
 * Api clients may retain server detail in `ApiError.message` for diagnostics and
 * programmatic callers, but the Dashboard must not render endpoint-authored or
 * server-authored prose in the wrong locale.
 */
export function formatApiError(
  error: unknown,
  t: Translate,
  options: { exposeServerDetail?: boolean } = {},
): string {
  if (error instanceof ApiError) {
    if (error.status === undefined && error.message === 'snapshot response is invalid') {
      return t('common.invalid_response')
    }
    if (error.status === undefined) return t('common.network_error')
    if (error.status >= 400) {
      return options.exposeServerDetail && error.hasServerDetail
        ? error.message
        : t('common.request_http_error', { status: error.status })
    }
    return t('common.invalid_response')
  }
  return t('common.network_error')
}

/** Format server-authored prose that is not carried by an HTTP error envelope. */
export function formatServerProse(
  value: unknown,
  t: Translate,
  options: { exposeServerDetail?: boolean; fallback?: string } = {},
): string {
  if (options.exposeServerDetail && typeof value === 'string' && value.trim() !== '') return value
  return options.fallback ?? t('common.request_failed')
}

export function wrapNetwork(error: unknown): never {
  if (isAbortError(error)) throw error
  throw new ApiError(`网络错误：${error instanceof Error ? error.message : String(error)}`)
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ApiError('', response.status)
  }
}

export async function throwApiError(response: Response, fallback: string): Promise<never> {
  let detail = ''
  let code: string | undefined
  try {
    const body = await readJson(response)
    if (isRecord(body)) {
      if (typeof body.error === 'string') detail = body.error
      if (typeof body.code === 'string') code = body.code
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    // A response without a JSON envelope falls back to the endpoint-specific message.
  }
  throw new ApiError(detail || `${fallback}（${response.status}）`, response.status, detail !== '', code)
}

export async function throwDetailedApiError(response: Response, fallback: string): Promise<never> {
  let detail = ''
  try {
    const body = await readJson(response)
    if (isRecord(body)) {
      if (stringArray(body.detail) && body.detail.length > 1) detail = body.detail.join('；')
      else if (typeof body.error === 'string') detail = body.error
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    // A response without a JSON envelope falls back to the endpoint-specific message.
  }
  throw new ApiError(detail || `${fallback}（${response.status}）`, response.status, detail !== '')
}

export async function throwListApiError(response: Response, fallback: string): Promise<never> {
  let detail = ''
  try {
    const body = await readJson(response)
    if (isRecord(body)) {
      if (stringArray(body.errors) && body.errors.length > 0) detail = body.errors.join('；')
      else if (typeof body.error === 'string') detail = body.error
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    // A response without a JSON envelope falls back to the endpoint-specific message.
  }
  throw new ApiError(detail || `${fallback}（${response.status}）`, response.status, detail !== '')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

export function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

export function recordOfStrings(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

export function recordOfBooleans(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'boolean')
}
