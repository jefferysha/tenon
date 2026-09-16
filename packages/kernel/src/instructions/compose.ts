/**
 * 把选中的模板块拼成一份项目级指令文件。
 *
 * 顺序：通用 → 每个前端块（后接与其 frameworks 相交的状态管理、样式块）→ 后端 → 移动端 → 系统 → 接口约定 → 数据库。
 * 块之间一个空行、LF、单个结尾换行；没有章节编号，任意子集都能直接拼。
 */
import { INSTRUCTION_CATEGORIES, type CatalogCategory, type TemplateRef } from './categories.js'
import { placeholdersIn, type InstructionBlock } from './block.js'

export interface CatalogEntrySummary {
  id: string
  name: string
  category: CatalogCategory
  frameworks: readonly string[]
  license: { spdx: string; redistributable: boolean; attribution: boolean }
  install?: string
  docs_url?: string
}

/** 资源目录查询端口；design-resources 提供实现，未接入时用 NO_CATALOG（资源行整行省略）。 */
export interface CatalogLookup { get(id: string): CatalogEntrySummary | null }

export const NO_CATALOG: CatalogLookup = { get: () => null }

export interface ComposeSelection {
  ref: TemplateRef
  block: InstructionBlock
  values: Readonly<Record<string, string>>
  catalog?: Readonly<Partial<Record<CatalogCategory, readonly string[]>>>
}

export interface ComposeError { code: 'framework-mismatch' | 'missing-value' | 'catalog-category'; ref: TemplateRef; detail: string }

export interface ComposedDirectory { path: string; label: string }

export type ComposeResult =
  | { ok: true; markdown: string; directories: readonly ComposedDirectory[] }
  | { ok: false; errors: readonly ComposeError[] }

function nested(selection: ComposeSelection): boolean {
  return selection.block.category === 'state' || selection.block.category === 'styling'
}

function orderSelections(selections: readonly ComposeSelection[], errors: ComposeError[]): ComposeSelection[] {
  const ordered: ComposeSelection[] = []
  const placed = new Set<ComposeSelection>()
  for (const category of INSTRUCTION_CATEGORIES) {
    if (category === 'state' || category === 'styling') continue
    for (const selection of selections.filter((item) => item.block.category === category)) {
      ordered.push(selection)
      if (category !== 'frontend') continue
      for (const child of ['state', 'styling'] as const) {
        for (const candidate of selections) {
          if (candidate.block.category !== child || placed.has(candidate)) continue
          if (!candidate.block.frameworks.some((framework) => selection.block.frameworks.includes(framework))) continue
          ordered.push(candidate)
          placed.add(candidate)
        }
      }
    }
  }
  for (const selection of selections) {
    if (nested(selection) && !placed.has(selection)) {
      errors.push({
        code: 'framework-mismatch',
        ref: selection.ref,
        detail: `${selection.block.title} 适用于 ${selection.block.frameworks.join(', ')}，没有匹配的前端块`,
      })
    }
  }
  return ordered
}

function resolvedValues(selection: ComposeSelection, errors: ComposeError[]): Map<string, string> {
  const values = new Map<string, string>()
  for (const variable of selection.block.variables) {
    const given = selection.values[variable.key]
    const value = given !== undefined && given.trim() !== '' ? given : variable.default
    if (value === undefined) errors.push({ code: 'missing-value', ref: selection.ref, detail: `缺少变量 ${variable.key}` })
    else values.set(variable.key, value)
  }
  return values
}

function checkCatalog(selection: ComposeSelection, catalog: CatalogLookup, errors: ComposeError[]): void {
  for (const [category, ids] of Object.entries(selection.catalog ?? {})) {
    if (!(selection.block.catalog as readonly string[]).includes(category)) {
      errors.push({ code: 'catalog-category', ref: selection.ref, detail: `${selection.block.title} 未声明资源目录分类 ${category}` })
      continue
    }
    for (const id of ids ?? []) {
      const entry = catalog.get(id)
      if (entry && entry.category !== category) {
        errors.push({ code: 'catalog-category', ref: selection.ref, detail: `${id} 属于 ${entry.category}，不是 ${category}` })
      }
    }
  }
}

function catalogLines(entries: readonly (CatalogEntrySummary | null)[]): string | null {
  const lines: string[] = []
  for (const entry of entries) {
    if (!entry) continue
    const parts: string[] = []
    if (entry.install) parts.push(`安装 \`${entry.install}\``)
    if (entry.docs_url) parts.push(`文档 ${entry.docs_url}`)
    lines.push(`- ${entry.name}（${entry.license.spdx}）${parts.length > 0 ? `· ${parts.join(' · ')}` : ''}`)
    if (entry.license.attribution) lines.push(`- 署名：${entry.name} 需要署名`)
  }
  return lines.length > 0 ? lines.join('\n') : null
}

function directoryTable(directories: readonly ComposedDirectory[]): string | null {
  if (directories.length === 0) return null
  return ['| 目录 | 内容 |', '| --- | --- |', ...directories.map((entry) => `| \`${entry.path}\` | ${entry.label} |`)].join('\n')
}

interface RenderContext { projectName: string; catalog: CatalogLookup; directories: readonly ComposedDirectory[] }

/** 占位符值为 null 时整行省略（无资源条目、无目录）。 */
function resolvePlaceholder(name: string, selection: ComposeSelection, values: ReadonlyMap<string, string>, context: RenderContext): string | null {
  if (name === 'project.name') return context.projectName
  if (name === 'directories') return directoryTable(context.directories)
  if (name === 'catalog.ref') {
    return selection.block.catalogRef === undefined ? null : catalogLines([context.catalog.get(selection.block.catalogRef)])
  }
  if (name.startsWith('catalog.')) {
    const category = name.slice('catalog.'.length) as CatalogCategory
    return catalogLines((selection.catalog?.[category] ?? []).map((id) => context.catalog.get(id)))
  }
  return values.get(name) ?? ''
}

const unescape = (text: string): string => text.replace(/\\\{\{/g, '{{')

function renderBody(selection: ComposeSelection, values: ReadonlyMap<string, string>, context: RenderContext): string {
  const out: string[] = []
  for (const line of selection.block.body.split('\n')) {
    let rendered = ''
    let cursor = 0
    let dropped = false
    for (const placeholder of placeholdersIn(line)) {
      const value = placeholder.name === null ? '' : resolvePlaceholder(placeholder.name, selection, values, context)
      if (value === null) {
        dropped = true
        break
      }
      rendered += unescape(line.slice(cursor, placeholder.index)) + value
      cursor = placeholder.index + placeholder.length
    }
    if (!dropped) out.push(rendered + unescape(line.slice(cursor)))
  }
  return out.join('\n').replace(/\s+$/u, '')
}

export function composeInstructions(input: {
  projectName: string
  selections: readonly ComposeSelection[]
  catalog: CatalogLookup
}): ComposeResult {
  const errors: ComposeError[] = []
  const ordered = orderSelections(input.selections, errors)
  const values = new Map(ordered.map((selection) => [selection, resolvedValues(selection, errors)] as const))
  for (const selection of ordered) checkCatalog(selection, input.catalog, errors)
  if (errors.length > 0) return { ok: false, errors }

  const directories: ComposedDirectory[] = []
  for (const { block } of ordered) {
    if (block.directory === undefined || directories.some((entry) => entry.path === block.directory)) continue
    directories.push({ path: block.directory, label: block.directoryLabel ?? '' })
  }
  const context: RenderContext = { projectName: input.projectName, catalog: input.catalog, directories }
  const bodies = ordered
    .map((selection) => renderBody(selection, values.get(selection) ?? new Map(), context))
    .filter((body) => body !== '')
  return { ok: true, markdown: `${[`# ${input.projectName}`, ...bodies].join('\n\n')}\n`, directories }
}
