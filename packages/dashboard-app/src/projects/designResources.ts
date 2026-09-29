/**
 * 新建项目「资源」步骤的纯逻辑：从资源目录里挑前端模板能引用的设计资源（组件库 / 图标 / DESIGN.md），
 * 每类最多一个。组件库与图标要写进前端模板的 `{{catalog.*}}` 行，所以默认只列与所选前端框架相交的条目（可切「全部」浏览，
 * 不相交的不能加入），且只有选了前端模板才可选；DESIGN.md 另有「取到项目根」的创建步骤，不依赖模板。
 */
import type { TemplateSummary } from '../api/instructionsDecoders'
import type { ResourceEntry } from '../api/resourceTypes'

export const DESIGN_CATEGORIES = ['component-lib', 'icons', 'design-md'] as const
export type DesignCategory = (typeof DESIGN_CATEGORIES)[number]

/** 每类选中的条目 id。 */
export type ResourcePicks = Readonly<Partial<Record<DesignCategory, string>>>

/** 已加入的前端模板声明的框架（去重）。 */
export function frontendFrameworks(templates: readonly TemplateSummary[], selected: readonly { category: string; id: string; source: string }[]): string[] {
  return [...new Set(selected
    .filter((item) => item.category === 'frontend')
    .flatMap((item) => templates.find((row) => row.source === item.source && row.category === item.category && row.id === item.id)?.frameworks ?? []))]
}

/** 组件库 / 图标只在选了前端模板时可选。 */
export const needsFrontend = (category: DesignCategory): boolean => category !== 'design-md'

/** 条目能不能被选：组件库 / 图标要与所选前端框架相交（空 frameworks = 任意）；DESIGN.md 只要有 https 起步链接。 */
export function fitsResource(entry: ResourceEntry, frameworks: readonly string[]): boolean {
  if (entry.category === 'design-md') return entry.links.design_md?.startsWith('https://') === true
  return frameworks.length > 0 && (entry.frameworks.length === 0 || entry.frameworks.some((framework) => frameworks.includes(framework)))
}

const byName = (a: ResourceEntry, b: ResourceEntry): number => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en')

/** 一类里可选的条目，按名称排序。 */
export function availableResources(entries: readonly ResourceEntry[], category: DesignCategory, frameworks: readonly string[]): ResourceEntry[] {
  return entries.filter((entry) => entry.category === category && fitsResource(entry, frameworks)).sort(byName)
}

/**
 * 「资源」步骤左列：默认只列可选的；`showAll` 列出该类的全部条目（可选的在前，其余在后，各自按名称）。
 * DESIGN.md 没有框架之分，始终只列有起步链接的条目。
 */
export function listResources(entries: readonly ResourceEntry[], category: DesignCategory, frameworks: readonly string[], showAll: boolean): ResourceEntry[] {
  const fit = availableResources(entries, category, frameworks)
  if (!showAll || !needsFrontend(category)) return fit
  return [...fit, ...entries.filter((entry) => entry.category === category && !fitsResource(entry, frameworks)).sort(byName)]
}

/** 只保留仍然可选的选择（换了前端模板之后，不再相交的组件库 / 图标自动失效）。 */
export function effectivePicks(picks: ResourcePicks, entries: readonly ResourceEntry[], frameworks: readonly string[]): ResourcePicks {
  const out: Partial<Record<DesignCategory, string>> = {}
  for (const category of DESIGN_CATEGORIES) {
    const id = picks[category]
    if (id !== undefined && availableResources(entries, category, frameworks).some((entry) => entry.id === id)) out[category] = id
  }
  return out
}

/** 一个模板块声明了哪些资源分类，就把对应的选择交给它拼进 `{{catalog.*}}`；没有交集返回 undefined。 */
export function catalogFor(picks: ResourcePicks, declared: readonly string[]): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {}
  for (const category of DESIGN_CATEGORIES) {
    const id = picks[category]
    if (id !== undefined && declared.includes(category)) out[category] = [id]
  }
  return Object.keys(out).length === 0 ? undefined : out
}
