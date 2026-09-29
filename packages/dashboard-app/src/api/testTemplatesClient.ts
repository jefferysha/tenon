/**
 * 测试模板库（服务端路径仍是 /api/test-directions）：读全量（内建 + 自定义）。Dashboard 只读，
 * 不改模板；响应经严格解码，展示的每个字段都校验过类型，形状不合整份拒绝。
 */
import { ApiError, isAbortError } from './transport'
import { decodeArray, record } from './governanceBaseDecoders'
import { decodeTestInput, decodeTestMetric, decodeTestOutput } from './governanceRuleDecoders'
import type { WbTestInput, WbTestMetric, WbTestOutput } from './governanceTypes'

export interface TestTemplateDefinition {
  readonly id: string
  readonly label: string
  readonly command: string
  readonly cwd?: string
  readonly timeout_s?: number
  readonly scope?: 'full' | 'known'
  readonly metrics_path?: string
  readonly pass?: { readonly exit_code?: number; readonly metrics?: readonly WbTestMetric[] }
  readonly inputs?: readonly WbTestInput[]
  readonly outputs?: readonly WbTestOutput[]
}

export interface TestTemplate {
  readonly id: string
  readonly label: string
  readonly source: 'builtin' | 'custom'
  readonly definition: TestTemplateDefinition
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function decodeDefinition(value: unknown): TestTemplateDefinition | null {
  const def = record(value)
  if (!def || typeof def.id !== 'string' || def.id === '' || typeof def.label !== 'string' || def.label === ''
    || typeof def.command !== 'string' || def.command === '') return null
  if (def.cwd !== undefined && typeof def.cwd !== 'string') return null
  if (def.timeout_s !== undefined && (!integer(def.timeout_s) || def.timeout_s < 0)) return null
  if (def.scope !== undefined && def.scope !== 'full' && def.scope !== 'known') return null
  if (def.metrics_path !== undefined && typeof def.metrics_path !== 'string') return null
  let pass: TestTemplateDefinition['pass']
  if (def.pass !== undefined) {
    const raw = record(def.pass)
    if (!raw) return null
    if (raw.exit_code !== undefined && !integer(raw.exit_code)) return null
    const metrics = raw.metrics === undefined ? undefined : decodeArray(raw.metrics, decodeTestMetric)
    if (metrics === null) return null
    pass = { ...(raw.exit_code === undefined ? {} : { exit_code: raw.exit_code }), ...(metrics === undefined ? {} : { metrics }) }
  }
  const inputs = def.inputs === undefined ? undefined : decodeArray(def.inputs, decodeTestInput)
  const outputs = def.outputs === undefined ? undefined : decodeArray(def.outputs, decodeTestOutput)
  if (inputs === null || outputs === null) return null
  return {
    id: def.id,
    label: def.label,
    command: def.command,
    ...(def.cwd === undefined ? {} : { cwd: def.cwd }),
    ...(def.timeout_s === undefined ? {} : { timeout_s: def.timeout_s as number }),
    ...(def.scope === undefined ? {} : { scope: def.scope }),
    ...(def.metrics_path === undefined ? {} : { metrics_path: def.metrics_path }),
    ...(pass === undefined ? {} : { pass }),
    ...(inputs === undefined ? {} : { inputs }),
    ...(outputs === undefined ? {} : { outputs }),
  }
}

export function decodeTemplate(value: unknown): TestTemplate | null {
  const item = record(value)
  if (!item || typeof item.id !== 'string' || typeof item.label !== 'string'
    || (item.source !== 'builtin' && item.source !== 'custom')) return null
  const definition = decodeDefinition(item.definition)
  if (definition === null || definition.id !== item.id) return null
  return { id: item.id, label: item.label, source: item.source, definition }
}

export async function fetchTestTemplates(signal?: AbortSignal): Promise<readonly TestTemplate[]> {
  let response: Response
  try {
    response = await fetch('/api/test-directions', { signal })
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
  const envelope = record(body)
  if (!response.ok) {
    const detail = envelope !== null && typeof envelope.error === 'string' ? envelope.error : ''
    throw new ApiError(detail, response.status, detail !== '')
  }
  if (envelope === null || envelope.ok !== true) throw new ApiError('invalid response', response.status)
  const templates = decodeArray(envelope.directions, decodeTemplate)
  if (templates === null) throw new ApiError('invalid response', response.status)
  return templates
}
