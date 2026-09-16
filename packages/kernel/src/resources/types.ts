/**
 * 资源目录条目：一个前端开源资源（组件库 / 区块 / 模板 / 图标 / 动画 / 动效组件 / DESIGN.md / 状态管理 / 样式）的
 * 元信息与许可证事实。目录只收录信息与链接，键集合封闭，任何字段都装不下代码或图标本体。
 *
 * 分类集合同时是指令模板块的 `catalog:` 取值（instructions/categories.ts 复用本常量），两边永远是同一张表。
 */
export const RESOURCE_CATEGORIES = [
  'component-lib', 'blocks', 'template', 'icons', 'animation', 'motion-components', 'design-md', 'state', 'styling',
] as const
export const RESOURCE_FRAMEWORKS = [
  'web', 'react', 'next', 'vue', 'nuxt', 'angular', 'svelte', 'react-native', 'flutter', 'swiftui', 'compose',
] as const
export const RESOURCE_STYLING = [
  'tailwind', 'css', 'css-modules', 'sass', 'less', 'css-in-js', 'vanilla-extract', 'unocss', 'panda', 'native',
] as const
export const RESOURCE_LINK_KEYS = ['home', 'docs', 'source', 'registry', 'preview', 'design_md', 'mcp', 'llms_txt'] as const
export const RESOURCE_COMMERCIAL = ['free', 'freemium', 'paid'] as const

export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number]
export type ResourceFramework = (typeof RESOURCE_FRAMEWORKS)[number]
export type ResourceStyling = (typeof RESOURCE_STYLING)[number]
export type ResourceLinkKey = (typeof RESOURCE_LINK_KEYS)[number]
export type ResourceCommercial = (typeof RESOURCE_COMMERCIAL)[number]

export const RESOURCE_SCHEMA = 'tenon-resource/v1'
export const RESOURCE_ENTRY_MAX_BYTES = 64 * 1024
export const RESOURCE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/

export interface ResourceLicense {
  /** SPDX 表达式，或非开源许可的 LicenseRef-*。 */
  readonly spdx: string
  readonly url: string
  /** 是否允许再分发其源码 / 图标本体；false 的条目只给链接。 */
  readonly redistributable: boolean
  readonly attribution: boolean
  readonly commercial: ResourceCommercial
  /** attribution 或 !redistributable 时必填。 */
  readonly notice?: string
}

export interface ResourceEntry {
  readonly schema: typeof RESOURCE_SCHEMA
  readonly id: string
  readonly name: string
  readonly category: ResourceCategory
  /** 空数组 = 适用任意框架。 */
  readonly frameworks: readonly ResourceFramework[]
  /** 空数组 = 适用任意样式方案。 */
  readonly styling: readonly ResourceStyling[]
  /** state / styling 必填。 */
  readonly use?: string
  /** 命中框架时总是写进前端块，用户不能取消。 */
  readonly baseline: boolean
  readonly license: ResourceLicense
  readonly install: readonly string[]
  /** 使用该资源前先加载的上游技能 id。 */
  readonly skills: readonly string[]
  readonly links: Readonly<Partial<Record<ResourceLinkKey, string>>>
  readonly verified_at: string
}

export type ResourceSource = 'builtin' | 'custom'
export interface StoredResource { readonly entry: ResourceEntry; readonly source: ResourceSource; readonly revision: string }
export interface ResourceFileError { readonly file: string; readonly source: ResourceSource; readonly errors: readonly string[] }
export type ResourceLicenseMode = 'redistributable' | 'link-only' | 'attribution'

export function isResourceCategory(value: string): value is ResourceCategory {
  return (RESOURCE_CATEGORIES as readonly string[]).includes(value)
}

export function isResourceFramework(value: string): value is ResourceFramework {
  return (RESOURCE_FRAMEWORKS as readonly string[]).includes(value)
}

export function isResourceStyling(value: string): value is ResourceStyling {
  return (RESOURCE_STYLING as readonly string[]).includes(value)
}
