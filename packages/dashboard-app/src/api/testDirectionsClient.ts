/**
 * 测试方向库：读全量（内建 + 自定义），写只到 custom。错误文案直接来自 server 的 400 体。
 */
import { ApiError, getToken, isAbortError } from './transport'
import type { WbStepTest } from './governanceTypes'

export interface TestDirection {
  readonly id: string
  readonly label: string
  readonly source: 'builtin' | 'custom'
  readonly yaml: string
  readonly definition: Omit<WbStepTest, 'id' | 'direction' | 'required' | 'keep_runs'> & { id: string; label: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function send(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, init)
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
  if (!isRecord(body) || body.ok !== true) throw new ApiError('invalid response', response.status)
  return body
}

function decodeDirection(value: unknown): TestDirection | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string'
    || (value.source !== 'builtin' && value.source !== 'custom')
    || typeof value.yaml !== 'string' || !isRecord(value.definition)) return null
  return {
    id: value.id,
    label: value.label,
    source: value.source,
    yaml: value.yaml,
    definition: value.definition as TestDirection['definition'],
  }
}

export async function fetchTestDirections(signal?: AbortSignal): Promise<readonly TestDirection[]> {
  const body = await send('/api/test-directions', { signal })
  if (!Array.isArray(body.directions)) throw new ApiError('invalid response')
  const directions: TestDirection[] = []
  for (const entry of body.directions) {
    const decoded = decodeDirection(entry)
    if (decoded === null) throw new ApiError('invalid response')
    directions.push(decoded)
  }
  return directions
}

export async function putTestDirection(id: string, yaml: string): Promise<TestDirection> {
  const body = await send(`/api/test-directions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/yaml; charset=utf-8', Authorization: `Bearer ${getToken()}` },
    body: yaml,
  })
  const decoded = decodeDirection(body.direction)
  if (decoded === null) throw new ApiError('invalid response')
  return decoded
}

export async function deleteTestDirection(id: string): Promise<void> {
  await send(`/api/test-directions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getToken()}` },
  })
}
