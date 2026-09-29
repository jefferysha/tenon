/**
 * 模板表单的草稿与校验（纯函数）。规则与 kernel `instructions/block.ts` 对齐，只挑表单能当场说清的几条：
 * 名称必填且 ≤ 80、状态管理 / 样式必须选框架、正文首行是分类对应级别的标题、没有一级标题、占位符都能解析。
 * 其余（frontmatter 细节、受管块标记）交给服务端报错。
 */
import type { TemplateBlock, TemplateCategory } from '../api/instructionsDecoders'
import { headingLevel, requiresFrameworks } from './templateText'

export interface TemplateDraft {
  readonly title: string
  readonly category: TemplateCategory
  readonly frameworks: readonly string[]
  readonly body: string
}

export type TemplateField = 'title' | 'id' | 'frameworks' | 'body'

/** 一个字段的错误：词典键后缀（`library.form.<key>`）+ 插值；`required` 只在字段被动过之后显示。 */
export interface FieldError { readonly key: string; readonly vars?: Record<string, string>; readonly required?: boolean }
export type TemplateErrors = Partial<Record<TemplateField, FieldError>>

export const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const PLACEHOLDER = /(\\)?\{\{([^{}]*)\}\}/gu
const FENCE = /^ {0,3}(```|~~~)/u

/** 模板正文里能用的占位符：项目名、骨架目录表、块变量、块声明的资源目录分类。 */
export function knownPlaceholders(block: TemplateBlock | null): string[] {
  return [
    'project.name', 'directories',
    ...(block?.variables ?? []).map((variable) => variable.key),
    ...(block?.catalog ?? []).map((category) => `catalog.${category}`),
    ...(block?.catalog_ref ? ['catalog.ref'] : []),
  ]
}

function bodyError(body: string, category: TemplateCategory, known: ReadonlySet<string> | null): FieldError | undefined {
  const lines = body.split('\n')
  const first = lines.find((line) => line.trim() !== '')
  if (first === undefined) return { key: 'required', required: true }
  // ## 与 ### 都接受：保存时标题级别会按分类对齐（templateText.alignHeading）。
  if (!/^#{2,3} /u.test(first)) return { key: 'body_heading', vars: { level: '#'.repeat(headingLevel(category)) } }
  let fenced = false
  for (const line of lines) {
    if (FENCE.test(line)) { fenced = !fenced; continue }
    if (!fenced && line.startsWith('# ')) return { key: 'body_h1' }
    if (known === null) continue
    for (const match of line.matchAll(PLACEHOLDER)) {
      const name = match[2] ?? ''
      if (match[1] === undefined && !known.has(name)) return { key: 'body_placeholder', vars: { name: `{{${name}}}` } }
    }
  }
  return undefined
}

/**
 * 校验草稿。`id` 只在新建时传（已存在的模板改不了标识）；`known` = null 表示块本身解析失败、占位符不查。
 * `takenIds` 是同分类下已有的自定义模板标识。
 */
export function validateTemplateDraft(
  draft: TemplateDraft,
  options: { known: ReadonlySet<string> | null; id?: string; takenIds?: ReadonlySet<string> },
): TemplateErrors {
  const errors: TemplateErrors = {}
  const title = draft.title.trim()
  if (title === '') errors.title = { key: 'required', required: true }
  else if (title.length > 80) errors.title = { key: 'title_too_long' }
  if (options.id !== undefined) {
    if (options.id === '') errors.id = { key: 'required', required: true }
    else if (!TEMPLATE_ID.test(options.id)) errors.id = { key: 'id_invalid' }
    else if (options.takenIds?.has(options.id) === true) errors.id = { key: 'id_duplicate' }
  }
  if (requiresFrameworks(draft.category) && draft.frameworks.length === 0) errors.frameworks = { key: 'frameworks_required' }
  const body = bodyError(draft.body, draft.category, options.known)
  if (body !== undefined) errors.body = body
  return errors
}

export const hasErrors = (errors: TemplateErrors): boolean => Object.keys(errors).length > 0

/** 名称 → 候选标识：ASCII 字母数字保留，其余连成 -；全是中文时为空（由用户自己填）。 */
export function slugOf(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64).replace(/-+$/u, '')
}

/** 新建时的起始正文：分类级别的标题 + 一条空列表项。 */
export function starterBody(category: TemplateCategory, categoryLabel: string): string {
  return `${'#'.repeat(headingLevel(category))} ${categoryLabel}\n\n- \n`
}
