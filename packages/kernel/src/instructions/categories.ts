/** 模板块分类：固定集合，数组顺序即拼合顺序（状态管理 / 样式渲染在各前端块之后）。 */
export const INSTRUCTION_CATEGORIES = [
  'common', 'frontend', 'state', 'styling', 'backend', 'mobile', 'system', 'api', 'database',
] as const
export type InstructionCategory = (typeof INSTRUCTION_CATEGORIES)[number]

export const TEMPLATE_SOURCES = ['builtin', 'custom'] as const
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number]

export interface TemplateRef { source: TemplateSource; category: InstructionCategory; id: string }

/** 资源目录分类（design-resources 的目录条目 category），前端块用 `catalog` 声明引用哪些。 */
export const CATALOG_CATEGORIES = ['component-lib', 'blocks', 'template', 'icons', 'design-md', 'state', 'styling'] as const
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number]

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isTemplateId(value: string): boolean {
  return TEMPLATE_ID.test(value)
}

export function isInstructionCategory(value: string): value is InstructionCategory {
  return (INSTRUCTION_CATEGORIES as readonly string[]).includes(value)
}

export function isTemplateSource(value: string): value is TemplateSource {
  return (TEMPLATE_SOURCES as readonly string[]).includes(value)
}

export function isCatalogCategory(value: string): value is CatalogCategory {
  return (CATALOG_CATEGORIES as readonly string[]).includes(value)
}

/** 块正文首个标题的级别：状态管理 / 样式嵌在前端章节里，用 `###`；其余 `##`。 */
export function categoryHeadingLevel(category: InstructionCategory): 2 | 3 {
  return category === 'state' || category === 'styling' ? 3 : 2
}
