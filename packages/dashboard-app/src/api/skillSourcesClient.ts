import { ApiError, readJson, throwApiError, wrapNetwork } from './transport'

export type SkillSourceStatus = 'changed' | 'unchanged' | 'failed' | 'bundled'
export type SkillFailureReason =
  | 'unreachable' | 'removed' | 'renamed' | 'invalid-content' | 'too-large' | 'license-missing' | 'license-mismatch'

/** One row of `GET /api/skills/sources` (server `UpstreamSkillView`). */
export interface SkillSourceRow {
  readonly id: string
  readonly origin: 'tenon' | 'upstream'
  readonly status: SkillSourceStatus
  readonly repo?: string
  readonly path?: string
  readonly commit?: string
  readonly previousCommit?: string | null
  readonly license?: 'MIT' | 'Apache-2.0'
  readonly fetchedAt?: string
  readonly reason?: SkillFailureReason
  readonly detail?: string
  readonly sourceUrl?: string
  readonly commitUrl?: string
  readonly compareUrl?: string
}

export interface SkillSourcesDto {
  readonly updatedAt: string | null
  readonly lastRunAt: string | null
  readonly rows: readonly SkillSourceRow[]
}

const STATUSES: ReadonlySet<unknown> = new Set(['changed', 'unchanged', 'failed', 'bundled'])
const REASONS: ReadonlySet<unknown> = new Set([
  'unreachable', 'removed', 'renamed', 'invalid-content', 'too-large', 'license-missing', 'license-mismatch',
])
const ROW_KEYS: ReadonlySet<string> = new Set([
  'id', 'origin', 'status', 'repo', 'path', 'commit', 'previousCommit', 'license', 'fetchedAt',
  'reason', 'detail', 'sourceUrl', 'commitUrl', 'compareUrl',
])
const OPTIONAL_STRINGS = ['repo', 'path', 'commit', 'fetchedAt', 'detail'] as const
const URL_KEYS = ['sourceUrl', 'commitUrl', 'compareUrl'] as const

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function decodeRow(value: unknown): SkillSourceRow | null {
  const item = record(value)
  if (item === null || Object.keys(item).some((key) => !ROW_KEYS.has(key))) return null
  if (typeof item.id !== 'string' || (item.origin !== 'tenon' && item.origin !== 'upstream') || !STATUSES.has(item.status)) return null
  if (OPTIONAL_STRINGS.some((key) => item[key] !== undefined && typeof item[key] !== 'string')) return null
  if (URL_KEYS.some((key) => item[key] !== undefined && (typeof item[key] !== 'string' || !String(item[key]).startsWith('https://github.com/')))) return null
  if (item.previousCommit !== undefined && item.previousCommit !== null && typeof item.previousCommit !== 'string') return null
  if (item.license !== undefined && item.license !== 'MIT' && item.license !== 'Apache-2.0') return null
  if (item.reason !== undefined && !REASONS.has(item.reason)) return null
  return item as unknown as SkillSourceRow
}

/** Strict decoder: any unknown key, bad enum or wrongly typed field rejects the whole body. */
export function decodeSkillSources(value: unknown): SkillSourcesDto | null {
  const body = record(value)
  if (body === null || !Array.isArray(body.rows)) return null
  const updatedAt = body.updatedAt
  const lastRunAt = body.lastRunAt
  if ((updatedAt !== null && typeof updatedAt !== 'string') || (lastRunAt !== null && typeof lastRunAt !== 'string')) return null
  const rows: SkillSourceRow[] = []
  for (const raw of body.rows) {
    const row = decodeRow(raw)
    if (row === null) return null
    rows.push(row)
  }
  return { updatedAt, lastRunAt, rows }
}

export async function fetchSkillSources(): Promise<SkillSourcesDto> {
  let response: Response
  try {
    response = await fetch('/api/skills/sources', { headers: { Accept: 'application/json' } })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '技能来源读取失败')
  let body: unknown
  try {
    body = await readJson(response)
  } catch {
    throw new ApiError('技能来源响应形状无效', response.status)
  }
  const decoded = decodeSkillSources(body)
  if (decoded === null) throw new ApiError('技能来源响应形状无效', response.status)
  return decoded
}
