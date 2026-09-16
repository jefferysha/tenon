/**
 * 目录筛选谓词：CLI 与 Dashboard 共用同一份实现（Dashboard 经 `@tenon/kernel/resources/query` 直接 import，
 * 所以本文件只 import 类型，不拉任何运行时依赖）。
 *
 * 空 frameworks / styling 表示「适用任意」，因此筛选命中一切取值。
 */
import {
  RESOURCE_CATEGORIES,
  type ResourceCategory, type ResourceEntry, type ResourceFramework, type ResourceLicenseMode, type ResourceStyling,
} from './types.js'

// Dashboard 只 import 本子路径，枚举与条目类型从这里转出（types.js 是无依赖叶子，浏览器可安全打包）。
export {
  RESOURCE_CATEGORIES, RESOURCE_COMMERCIAL, RESOURCE_FRAMEWORKS, RESOURCE_LINK_KEYS, RESOURCE_STYLING,
} from './types.js'
export type {
  ResourceCategory, ResourceCommercial, ResourceEntry, ResourceFramework, ResourceLicense, ResourceLicenseMode,
  ResourceLinkKey, ResourceStyling,
} from './types.js'

export interface ResourceQuery {
  category?: ResourceCategory
  framework?: ResourceFramework
  styling?: ResourceStyling
  license?: ResourceLicenseMode
  text?: string
}

export function licenseModes(entry: ResourceEntry): readonly ResourceLicenseMode[] {
  const modes: ResourceLicenseMode[] = [entry.license.redistributable ? 'redistributable' : 'link-only']
  if (entry.license.attribution) modes.push('attribution')
  return modes
}

function matchesText(entry: ResourceEntry, text: string): boolean {
  const needle = text.trim().toLowerCase()
  if (needle === '') return true
  return `${entry.id} ${entry.name} ${entry.use ?? ''}`.toLowerCase().includes(needle)
}

function matches(entry: ResourceEntry, query: ResourceQuery): boolean {
  if (query.category !== undefined && entry.category !== query.category) return false
  if (query.framework !== undefined && entry.frameworks.length > 0 && !entry.frameworks.includes(query.framework)) return false
  if (query.styling !== undefined && entry.styling.length > 0 && !entry.styling.includes(query.styling)) return false
  if (query.license !== undefined && !licenseModes(entry).includes(query.license)) return false
  return matchesText(entry, query.text ?? '')
}

/** 稳定顺序：先分类表顺序，再按 name 升序（同名按 id）。 */
export function filterResources<T extends { entry: ResourceEntry }>(items: readonly T[], query: ResourceQuery): T[] {
  return items
    .filter((item) => matches(item.entry, query))
    .sort((a, b) => {
      const byCategory = RESOURCE_CATEGORIES.indexOf(a.entry.category) - RESOURCE_CATEGORIES.indexOf(b.entry.category)
      if (byCategory !== 0) return byCategory
      const byName = a.entry.name.localeCompare(b.entry.name, 'en')
      return byName !== 0 ? byName : a.entry.id.localeCompare(b.entry.id, 'en')
    })
}
