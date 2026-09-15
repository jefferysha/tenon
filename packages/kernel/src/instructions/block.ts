/**
 * 模板块文件解析：固定行语法的 frontmatter + Markdown 正文（kernel 无 YAML 依赖，键集合封闭）。
 *
 * ```md
 * ---
 * id: typescript-react
 * category: frontend
 * title: TypeScript + React
 * frameworks: [react]
 * directory: frontend/
 * directory_label: 前端工程根目录
 * catalog: [component-lib, icons, design-md]
 * variables:
 *   - key: component.soft
 *     default: 200
 * ---
 * ## 前端（TypeScript + React）
 * ```
 *
 * 正文里的 `{{name}}` 必须能解析（块变量、project.name、directories、catalog.*），围栏代码里同样替换；
 * 字面量写 `\{{`。
 */
import {
  categoryHeadingLevel, isCatalogCategory, isInstructionCategory, isTemplateId,
  type CatalogCategory, type InstructionCategory,
} from './categories.js'
import { MANAGED_MARKER_LINE } from './managed-blocks.js'

export const INSTRUCTION_BLOCK_MAX_BYTES = 64 * 1024

export interface InstructionVariable { key: string; default?: string }

export interface InstructionBlock {
  id: string
  category: InstructionCategory
  title: string
  frameworks: readonly string[]
  directory?: string
  directoryLabel?: string
  catalog: readonly CatalogCategory[]
  catalogRef?: string
  variables: readonly InstructionVariable[]
  body: string
}

export interface BlockError {
  code: 'frontmatter' | 'unknown-key' | 'id-mismatch' | 'category-mismatch' | 'heading'
    | 'unknown-placeholder' | 'managed-marker' | 'too-large'
  line?: number
  detail: string
}

const KNOWN_KEYS = new Set(['id', 'category', 'title', 'frameworks', 'directory', 'directory_label', 'catalog', 'catalog_ref', 'variables'])
const VARIABLE_KEY = /^[a-z][a-z0-9_.-]{0,47}$/
const LIST_ITEM = /^[a-z0-9-]+$/
const DIRECTORY = /^[a-z0-9._-]+\/$/
const CATALOG_REF = /^[a-z0-9][a-z0-9-]{0,63}$/
const PLACEHOLDER = /\\?\{\{([^{}]*)\}\}|\\?\{\{/g
const FENCE = /^ {0,3}(```|~~~)/

/** 一行 `{{…}}` 占位符（跳过 `\{{` 转义）；name 为 null 表示 `{{` 没有构成合法占位符。 */
export function placeholdersIn(line: string): { name: string | null; index: number; length: number }[] {
  const found: { name: string | null; index: number; length: number }[] = []
  for (const match of line.matchAll(PLACEHOLDER)) {
    if (match[0].startsWith('\\')) continue
    const name = match[1]
    found.push({ name: name !== undefined && /^[a-z][a-z0-9_.-]*$/.test(name) ? name : null, index: match.index, length: match[0].length })
  }
  return found
}

function scalar(raw: string): string | null {
  const value = raw.trim()
  if (!value.startsWith('"')) return value
  if (value.length < 2 || !value.endsWith('"')) return null
  const inner = value.slice(1, -1)
  if (/(^|[^\\])"/.test(inner)) return null
  return inner.replace(/\\(["\\])/g, '$1')
}

function flowList(raw: string): string[] | null {
  const value = raw.trim()
  if (!value.startsWith('[') || !value.endsWith(']')) return null
  const inner = value.slice(1, -1).trim()
  if (inner === '') return []
  const items = inner.split(',').map((item) => item.trim())
  return items.every((item) => LIST_ITEM.test(item)) ? items : null
}

interface Frontmatter { values: Map<string, { raw: string; line: number }>; variables: InstructionVariable[]; bodyStart: number }

function readFrontmatter(lines: readonly string[], errors: BlockError[]): Frontmatter | null {
  if (lines[0] !== '---') {
    errors.push({ code: 'frontmatter', line: 1, detail: '文件必须以 --- 开头' })
    return null
  }
  const close = lines.indexOf('---', 1)
  if (close < 0) {
    errors.push({ code: 'frontmatter', line: 1, detail: 'frontmatter 缺少结束的 ---' })
    return null
  }
  const values = new Map<string, { raw: string; line: number }>()
  const variables: InstructionVariable[] = []
  let inVariables = false
  for (let index = 1; index < close; index += 1) {
    const text = lines[index] ?? ''
    const line = index + 1
    if (text.trim() === '') continue
    const item = /^ {2}- key: (.*)$/.exec(text)
    const itemDefault = /^ {4}default: (.*)$/.exec(text)
    if (inVariables && item) {
      const key = scalar(item[1] ?? '') ?? ''
      if (!VARIABLE_KEY.test(key)) errors.push({ code: 'frontmatter', line, detail: `变量名不合法：${key}` })
      else if (variables.some((variable) => variable.key === key)) errors.push({ code: 'frontmatter', line, detail: `变量重复：${key}` })
      variables.push({ key })
      continue
    }
    if (inVariables && itemDefault) {
      const last = variables.at(-1)
      const value = scalar(itemDefault[1] ?? '')
      if (!last || last.default !== undefined || value === null) errors.push({ code: 'frontmatter', line, detail: 'default 必须紧跟在 - key 之后且只能出现一次' })
      else last.default = value
      continue
    }
    const pair = /^([a-z_]+):(?: (.*))?$/.exec(text)
    if (!pair) {
      errors.push({ code: 'frontmatter', line, detail: `无法解析的行：${text}` })
      continue
    }
    const key = pair[1] ?? ''
    inVariables = key === 'variables'
    if (!KNOWN_KEYS.has(key)) {
      errors.push({ code: 'unknown-key', line, detail: `未知键：${key}` })
      continue
    }
    if (values.has(key)) {
      errors.push({ code: 'frontmatter', line, detail: `键重复：${key}` })
      continue
    }
    if (key === 'variables' && (pair[2] ?? '').trim() !== '') errors.push({ code: 'frontmatter', line, detail: 'variables 的条目写在下一行' })
    values.set(key, { raw: pair[2] ?? '', line })
  }
  return { values, variables, bodyStart: close + 1 }
}

export function parseInstructionBlock(
  text: string,
  expected: { category: InstructionCategory; id: string },
): { ok: true; block: InstructionBlock } | { ok: false; errors: readonly BlockError[] } {
  const errors: BlockError[] = []
  if (new TextEncoder().encode(text).length > INSTRUCTION_BLOCK_MAX_BYTES) {
    return { ok: false, errors: [{ code: 'too-large', detail: `超过 ${INSTRUCTION_BLOCK_MAX_BYTES} 字节` }] }
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const front = readFrontmatter(lines, errors)
  if (!front) return { ok: false, errors }
  const field = (key: string) => front.values.get(key)
  const required = (key: string): string => {
    const entry = field(key)
    const value = entry ? scalar(entry.raw) : null
    if (!value) errors.push({ code: 'frontmatter', line: entry?.line, detail: `缺少 ${key}` })
    return value ?? ''
  }

  const id = required('id')
  if (id && !isTemplateId(id)) errors.push({ code: 'frontmatter', line: field('id')?.line, detail: `id 不合法：${id}` })
  else if (id && id !== expected.id) errors.push({ code: 'id-mismatch', line: field('id')?.line, detail: `id ${id} 与文件名 ${expected.id} 不一致` })
  const categoryText = required('category')
  if (categoryText && categoryText !== expected.category) {
    errors.push({ code: 'category-mismatch', line: field('category')?.line, detail: `category ${categoryText} 与目录 ${expected.category} 不一致` })
  }
  const category = expected.category
  const title = required('title')
  if (title.length > 80) errors.push({ code: 'frontmatter', line: field('title')?.line, detail: 'title 超过 80 字符' })

  const listField = (key: string): string[] => {
    const entry = field(key)
    if (!entry) return []
    const list = flowList(entry.raw)
    if (list === null) errors.push({ code: 'frontmatter', line: entry.line, detail: `${key} 必须是 [a, b] 形式` })
    return list ?? []
  }
  const frameworks = listField('frameworks')
  const frameworkLine = field('frameworks')?.line
  if ((category === 'state' || category === 'styling') && frameworks.length === 0) {
    errors.push({ code: 'frontmatter', line: frameworkLine, detail: `${category} 块必须声明 frameworks` })
  }
  if (field('frameworks') && category !== 'frontend' && category !== 'state' && category !== 'styling') {
    errors.push({ code: 'frontmatter', line: frameworkLine, detail: 'frameworks 只用于前端、状态管理、样式块' })
  }

  const directoryEntry = field('directory')
  const directory = directoryEntry ? scalar(directoryEntry.raw) ?? '' : undefined
  if (directory !== undefined && (!DIRECTORY.test(directory) || directory === './' || directory === '../')) {
    errors.push({ code: 'frontmatter', line: directoryEntry?.line, detail: `directory 必须是单层目录名加 /：${directory}` })
  }
  const labelEntry = field('directory_label')
  const directoryLabel = labelEntry ? scalar(labelEntry.raw) ?? '' : undefined
  if (directory !== undefined && !directoryLabel) errors.push({ code: 'frontmatter', line: directoryEntry?.line, detail: '设置 directory 时必须有 directory_label' })
  if (directory === undefined && labelEntry) errors.push({ code: 'frontmatter', line: labelEntry.line, detail: 'directory_label 需要 directory' })

  const catalog = listField('catalog')
  for (const entry of catalog) {
    if (!isCatalogCategory(entry)) errors.push({ code: 'frontmatter', line: field('catalog')?.line, detail: `未知资源目录分类：${entry}` })
  }
  const refEntry = field('catalog_ref')
  const catalogRef = refEntry ? scalar(refEntry.raw) ?? '' : undefined
  if (catalogRef !== undefined && !CATALOG_REF.test(catalogRef)) errors.push({ code: 'frontmatter', line: refEntry?.line, detail: `catalog_ref 不合法：${catalogRef}` })

  const known = new Set<string>(['project.name', 'directories', ...front.variables.map((variable) => variable.key)])
  for (const entry of catalog) known.add(`catalog.${entry}`)
  if (catalogRef !== undefined) known.add('catalog.ref')
  for (const variable of front.variables) {
    if (variable.key === 'project.name' || variable.key === 'directories' || variable.key.startsWith('catalog.')) {
      errors.push({ code: 'frontmatter', detail: `变量名与内置占位符冲突：${variable.key}` })
    }
  }

  const body = checkBody(lines, front.bodyStart, category, known, errors)
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    block: {
      id, category, title, frameworks,
      ...(directory !== undefined ? { directory, directoryLabel } : {}),
      catalog: catalog.filter(isCatalogCategory),
      ...(catalogRef !== undefined ? { catalogRef } : {}),
      variables: front.variables,
      body,
    },
  }
}

function checkBody(lines: readonly string[], start: number, category: InstructionCategory, known: ReadonlySet<string>, errors: BlockError[]): string {
  const level = categoryHeadingLevel(category)
  const first = lines.findIndex((text, index) => index >= start && text.trim() !== '')
  if (first < 0) {
    errors.push({ code: 'heading', detail: '正文为空' })
    return ''
  }
  if (!(lines[first] ?? '').startsWith(`${'#'.repeat(level)} `)) {
    errors.push({ code: 'heading', line: first + 1, detail: `正文第一行必须是 ${'#'.repeat(level)} 标题` })
  }
  let fenced = false
  for (let index = first; index < lines.length; index += 1) {
    const text = lines[index] ?? ''
    const line = index + 1
    if (FENCE.test(text)) fenced = !fenced
    else if (!fenced && text.startsWith('# ')) errors.push({ code: 'heading', line, detail: '块内不允许一级标题' })
    if (MANAGED_MARKER_LINE.test(text)) errors.push({ code: 'managed-marker', line, detail: '正文不能包含 Tenon 受管块标记行' })
    for (const placeholder of placeholdersIn(text)) {
      if (placeholder.name === null || !known.has(placeholder.name)) {
        errors.push({ code: 'unknown-placeholder', line, detail: `无法解析的占位符：${text.slice(placeholder.index, placeholder.index + placeholder.length)}` })
      }
    }
  }
  return lines.slice(first).join('\n').replace(/\s+$/u, '')
}
