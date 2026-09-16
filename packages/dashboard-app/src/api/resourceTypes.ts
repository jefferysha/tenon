/**
 * 资源目录接口的闭合解码器：多键、缺键、枚举越界一律返回 null。
 * 形状与 server `serverResourceRoutes.ts` 的响应逐字段对应。
 */
import { RESOURCE_CATEGORIES, RESOURCE_FRAMEWORKS, RESOURCE_LINK_KEYS, RESOURCE_STYLING } from '@tenon/kernel/resources/query'
import type { ResourceCategory, ResourceEntry, ResourceFramework, ResourceLinkKey, ResourceStyling } from '@tenon/kernel/resources/query'
import { isRecord, stringArray } from './transport'

export type { ResourceCategory, ResourceEntry, ResourceFramework, ResourceLinkKey, ResourceStyling }
export { RESOURCE_CATEGORIES, RESOURCE_FRAMEWORKS, RESOURCE_LINK_KEYS, RESOURCE_STYLING }

export type ResourceSource = 'builtin' | 'custom'
export interface ResourceDto { entry: ResourceEntry; source: ResourceSource; revision: string }
export interface ResourceFileError { file: string; source: ResourceSource; errors: string[] }
export interface ResourceCatalogList { entries: ResourceDto[]; errors: ResourceFileError[] }
export interface ResourceDocument { entry: ResourceEntry; source: ResourceSource; revision: string; yaml: string }

const COMMERCIAL = ['free', 'freemium', 'paid'] as const

function enumList<T extends string>(value: unknown, values: readonly T[]): T[] | null {
  if (!stringArray(value)) return null
  return value.every((item) => (values as readonly string[]).includes(item)) ? (value as T[]) : null
}

function links(value: unknown): Partial<Record<ResourceLinkKey, string>> | null {
  if (!isRecord(value)) return null
  const out: Partial<Record<ResourceLinkKey, string>> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!(RESOURCE_LINK_KEYS as readonly string[]).includes(key) || typeof item !== 'string') return null
    out[key as ResourceLinkKey] = item
  }
  return out
}

function license(value: unknown): ResourceEntry['license'] | null {
  if (!isRecord(value)) return null
  const { spdx, url, redistributable, attribution, commercial, notice } = value
  if (typeof spdx !== 'string' || typeof url !== 'string') return null
  if (typeof redistributable !== 'boolean' || typeof attribution !== 'boolean') return null
  if (typeof commercial !== 'string' || !(COMMERCIAL as readonly string[]).includes(commercial)) return null
  if (notice !== undefined && typeof notice !== 'string') return null
  return {
    spdx, url, redistributable, attribution,
    commercial: commercial as ResourceEntry['license']['commercial'],
    ...(typeof notice === 'string' ? { notice } : {}),
  }
}

export function decodeResourceEntry(value: unknown): ResourceEntry | null {
  if (!isRecord(value)) return null
  const frameworks = enumList<ResourceFramework>(value.frameworks, RESOURCE_FRAMEWORKS)
  const styling = enumList<ResourceStyling>(value.styling, RESOURCE_STYLING)
  const parsedLicense = license(value.license)
  const parsedLinks = links(value.links)
  const install = stringArray(value.install) ? value.install : null
  const skills = stringArray(value.skills) ? value.skills : null
  if (value.schema !== 'tenon-resource/v1' || typeof value.id !== 'string' || typeof value.name !== 'string') return null
  if (typeof value.category !== 'string' || !(RESOURCE_CATEGORIES as readonly string[]).includes(value.category)) return null
  if (frameworks === null || styling === null || parsedLicense === null || parsedLinks === null) return null
  if (install === null || skills === null || typeof value.baseline !== 'boolean' || typeof value.verified_at !== 'string') return null
  if (value.use !== undefined && typeof value.use !== 'string') return null
  return {
    schema: 'tenon-resource/v1',
    id: value.id,
    name: value.name,
    category: value.category as ResourceCategory,
    frameworks,
    styling,
    ...(typeof value.use === 'string' ? { use: value.use } : {}),
    baseline: value.baseline,
    license: parsedLicense,
    install,
    skills,
    links: parsedLinks,
    verified_at: value.verified_at,
  }
}

function dto(value: unknown): ResourceDto | null {
  if (!isRecord(value)) return null
  const entry = decodeResourceEntry(value)
  if (entry === null) return null
  if (value.source !== 'builtin' && value.source !== 'custom') return null
  if (typeof value.revision !== 'string') return null
  return { entry, source: value.source, revision: value.revision }
}

function fileError(value: unknown): ResourceFileError | null {
  if (!isRecord(value) || typeof value.file !== 'string') return null
  if (value.source !== 'builtin' && value.source !== 'custom') return null
  return stringArray(value.errors) ? { file: value.file, source: value.source, errors: value.errors } : null
}

export function decodeResourceList(value: unknown): ResourceCatalogList | null {
  if (!isRecord(value) || value.schema_version !== 'resource-catalog/v1') return null
  if (!Array.isArray(value.entries) || !Array.isArray(value.errors)) return null
  const entries = value.entries.map(dto)
  const errors = value.errors.map(fileError)
  if (entries.some((item) => item === null) || errors.some((item) => item === null)) return null
  return { entries: entries as ResourceDto[], errors: errors as ResourceFileError[] }
}

export function decodeResourceDocument(value: unknown): ResourceDocument | null {
  if (!isRecord(value) || value.ok !== true || typeof value.yaml !== 'string') return null
  const parsed = dto(value.entry)
  return parsed === null ? null : { ...parsed, yaml: value.yaml }
}

export function decodeResourceSaved(value: unknown): ResourceDto | null {
  return isRecord(value) && value.ok === true ? dto(value.entry) : null
}

export function decodeResourceCopied(value: unknown): { id: string } | null {
  return isRecord(value) && value.ok === true && typeof value.id === 'string' ? { id: value.id } : null
}

export function decodeResourceOk(value: unknown): { ok: true } | null {
  return isRecord(value) && value.ok === true ? { ok: true } : null
}
