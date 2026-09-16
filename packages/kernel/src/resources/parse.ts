/**
 * 资源条目文件解析：固定行语法的 YAML 子集（kernel 无 YAML 依赖），键集合封闭。
 *
 * ```yaml
 * schema: tenon-resource/v1
 * id: react-bits
 * name: React Bits
 * category: motion-components
 * frameworks: [react]
 * styling: [tailwind, css]
 * use: 文字动画、背景与交互动效
 * baseline: true
 * license:
 *   spdx: MIT AND LicenseRef-Commons-Clause
 *   url: https://raw.githubusercontent.com/DavidHDev/react-bits/main/LICENSE.md
 *   redistributable: false
 *   attribution: false
 *   commercial: freemium
 *   notice: 不得出售或再分发组件本身
 * install:
 *   - npx shadcn@latest add https://reactbits.dev/r/<Name>-TS-TW
 * skills: []
 * links:
 *   home: https://reactbits.dev
 * verified_at: 2026-09-15
 * ```
 *
 * 整行 `#` 是注释；标量裸写或双引号（JSON 转义）；`[a, b]` 是裸词内联列表；`install` 用 `- ` 块列表；
 * `license` / `links` 只有一层缩进。其余写法都是错误，并带行号。
 */
import {
  RESOURCE_CATEGORIES, RESOURCE_COMMERCIAL, RESOURCE_ENTRY_MAX_BYTES, RESOURCE_FRAMEWORKS, RESOURCE_LINK_KEYS,
  RESOURCE_SCHEMA, RESOURCE_STYLING, isResourceCategory, isResourceFramework, isResourceStyling,
  type ResourceCommercial, type ResourceEntry, type ResourceLinkKey,
} from './types.js'

export class ResourceParseError extends Error {
  readonly line: number
  constructor(line: number, detail: string) {
    super(`第 ${line} 行：${detail}`)
    this.name = 'ResourceParseError'
    this.line = line
  }
}

const TOP_KEYS = ['schema', 'id', 'name', 'category', 'frameworks', 'styling', 'use', 'baseline', 'license',
  'install', 'skills', 'links', 'verified_at'] as const
const LICENSE_KEYS = ['spdx', 'url', 'redistributable', 'attribution', 'commercial', 'notice'] as const
const TOKEN = /^[a-z0-9][a-z0-9._-]*$/

interface Line { readonly n: number; readonly indent: number; readonly text: string }

function scalar(raw: string, line: number): string {
  if (raw.startsWith('"')) {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new ResourceParseError(line, '双引号标量不是合法字符串')
    }
    if (typeof value !== 'string' || value === '') throw new ResourceParseError(line, '标量不得为空')
    return value
  }
  if (raw === '' || raw !== raw.trim()) throw new ResourceParseError(line, '标量不得为空')
  if (raw.includes('"')) throw new ResourceParseError(line, '含引号的标量必须整体加双引号')
  return raw
}

function boolean_(raw: string, line: number, key: string): boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new ResourceParseError(line, `${key} 只接受 true 或 false`)
}

function inlineList(raw: string, line: number, key: string): string[] {
  if (!raw.startsWith('[') || !raw.endsWith(']')) throw new ResourceParseError(line, `${key} 必须是 [a, b] 列表`)
  const body = raw.slice(1, -1).trim()
  if (body === '') return []
  return body.split(',').map((item) => {
    const token = item.trim()
    if (!TOKEN.test(token)) throw new ResourceParseError(line, `${key} 的列表项只接受裸词：${token}`)
    return token
  })
}

/** 有效行（去掉整行注释与空行），保留原始行号与缩进。 */
function scan(text: string): Line[] {
  return text.split('\n').map((raw, index) => ({
    n: index + 1,
    indent: raw.length - raw.trimStart().length,
    text: raw.trimEnd(),
  })).filter((line) => line.text.trim() !== '' && !line.text.trim().startsWith('#'))
}

function keyValue(line: Line): { key: string; raw: string } {
  const match = /^([a-z][a-z0-9_]*):(?:[ ](.*))?$/.exec(line.text.trim())
  if (!match) throw new ResourceParseError(line.n, `不是 'key: value' 行：${line.text.trim()}`)
  return { key: match[1] ?? '', raw: (match[2] ?? '').trim() }
}

function nested(lines: readonly Line[], start: number, allowed: readonly string[], owner: string): { fields: Map<string, { raw: string; n: number }>; next: number } {
  const fields = new Map<string, { raw: string; n: number }>()
  let index = start
  while (index < lines.length && (lines[index]?.indent ?? 0) > 0) {
    const line = lines[index] as Line
    if (line.indent !== 2) throw new ResourceParseError(line.n, `${owner} 的子键必须缩进 2 空格`)
    const { key, raw } = keyValue(line)
    if (!allowed.includes(key)) throw new ResourceParseError(line.n, `${owner} 出现未知字段 '${key}'`)
    if (fields.has(key)) throw new ResourceParseError(line.n, `${owner} 重复声明 ${key}`)
    if (raw === '') throw new ResourceParseError(line.n, `${owner}.${key} 缺值`)
    fields.set(key, { raw, n: line.n })
    index++
  }
  if (fields.size === 0) throw new ResourceParseError(lines[start - 1]?.n ?? 1, `${owner} 缺子键`)
  return { fields, next: index }
}

function blockList(lines: readonly Line[], start: number, owner: string): { items: string[]; next: number } {
  const items: string[] = []
  let index = start
  while (index < lines.length && (lines[index]?.indent ?? 0) > 0) {
    const line = lines[index] as Line
    if (line.indent !== 2 || !line.text.trim().startsWith('- ')) {
      throw new ResourceParseError(line.n, `${owner} 的列表项必须是缩进 2 空格的 '- ' 行`)
    }
    items.push(scalar(line.text.trim().slice(2).trim(), line.n))
    index++
  }
  return { items, next: index }
}

function commercial(raw: string, line: number): ResourceCommercial {
  if (!(RESOURCE_COMMERCIAL as readonly string[]).includes(raw)) {
    throw new ResourceParseError(line, `license.commercial 只接受：${RESOURCE_COMMERCIAL.join(', ')}`)
  }
  return raw as ResourceCommercial
}

function links(fields: ReadonlyMap<string, { raw: string; n: number }>): Partial<Record<ResourceLinkKey, string>> {
  const result: Partial<Record<ResourceLinkKey, string>> = {}
  for (const key of RESOURCE_LINK_KEYS) {
    const field = fields.get(key)
    if (field) result[key] = scalar(field.raw, field.n)
  }
  return result
}

/** 解析一份条目文件；任何越界写法都抛 ResourceParseError（带行号）。 */
export function parseResourceEntry(text: string): ResourceEntry {
  if (new TextEncoder().encode(text).length > RESOURCE_ENTRY_MAX_BYTES) {
    throw new ResourceParseError(1, `条目超过 ${RESOURCE_ENTRY_MAX_BYTES} 字节`)
  }
  const lines = scan(text)
  const values = new Map<string, { raw: string; n: number }>()
  let licenseFields: ReadonlyMap<string, { raw: string; n: number }> | undefined
  let linkFields: ReadonlyMap<string, { raw: string; n: number }> | undefined
  let install: string[] | undefined
  let index = 0
  while (index < lines.length) {
    const line = lines[index] as Line
    if (line.indent !== 0) throw new ResourceParseError(line.n, '顶层键不得缩进')
    const { key, raw } = keyValue(line)
    if (!(TOP_KEYS as readonly string[]).includes(key)) throw new ResourceParseError(line.n, `出现未知字段 '${key}'`)
    if (values.has(key) || (key === 'license' && licenseFields) || (key === 'links' && linkFields) || (key === 'install' && install)) {
      throw new ResourceParseError(line.n, `重复声明 ${key}`)
    }
    index++
    if (key === 'license' || key === 'links') {
      if (raw !== '') throw new ResourceParseError(line.n, `${key} 必须是缩进块`)
      const block = nested(lines, index, key === 'license' ? LICENSE_KEYS : RESOURCE_LINK_KEYS, key)
      if (key === 'license') licenseFields = block.fields
      else linkFields = block.fields
      index = block.next
      continue
    }
    if (key === 'install') {
      if (raw === '[]') { install = []; continue }
      if (raw !== '') throw new ResourceParseError(line.n, 'install 必须是 - 块列表或 []')
      const block = blockList(lines, index, 'install')
      install = block.items
      index = block.next
      continue
    }
    if (raw === '') throw new ResourceParseError(line.n, `${key} 缺值`)
    values.set(key, { raw, n: line.n })
  }
  return build(values, licenseFields, linkFields, install)
}

function required(values: ReadonlyMap<string, { raw: string; n: number }>, key: string): { raw: string; n: number } {
  const field = values.get(key)
  if (!field) throw new ResourceParseError(1, `缺字段 ${key}`)
  return field
}

function build(
  values: ReadonlyMap<string, { raw: string; n: number }>,
  licenseFields: ReadonlyMap<string, { raw: string; n: number }> | undefined,
  linkFields: ReadonlyMap<string, { raw: string; n: number }> | undefined,
  install: readonly string[] | undefined,
): ResourceEntry {
  if (!licenseFields) throw new ResourceParseError(1, '缺字段 license')
  if (!linkFields) throw new ResourceParseError(1, '缺字段 links')
  if (install === undefined) throw new ResourceParseError(1, '缺字段 install')
  const schema = required(values, 'schema')
  if (scalar(schema.raw, schema.n) !== RESOURCE_SCHEMA) throw new ResourceParseError(schema.n, `schema 必须是 ${RESOURCE_SCHEMA}`)
  const category = required(values, 'category')
  const categoryValue = scalar(category.raw, category.n)
  if (!isResourceCategory(categoryValue)) throw new ResourceParseError(category.n, `category 只接受：${RESOURCE_CATEGORIES.join(', ')}`)
  const frameworks = required(values, 'frameworks')
  const styling = required(values, 'styling')
  const skills = required(values, 'skills')
  const use = values.get('use')
  const baseline = required(values, 'baseline')
  const notice = licenseFields.get('notice')
  for (const key of ['spdx', 'url', 'redistributable', 'attribution', 'commercial'] as const) {
    if (!licenseFields.has(key)) throw new ResourceParseError(1, `缺字段 license.${key}`)
  }
  const spdx = licenseFields.get('spdx') as { raw: string; n: number }
  const url = licenseFields.get('url') as { raw: string; n: number }
  const redistributable = licenseFields.get('redistributable') as { raw: string; n: number }
  const attribution = licenseFields.get('attribution') as { raw: string; n: number }
  const commercialField = licenseFields.get('commercial') as { raw: string; n: number }
  const verifiedAt = required(values, 'verified_at')
  const name = required(values, 'name')
  const id = required(values, 'id')
  return {
    schema: RESOURCE_SCHEMA,
    id: scalar(id.raw, id.n),
    name: scalar(name.raw, name.n),
    category: categoryValue,
    frameworks: inlineList(frameworks.raw, frameworks.n, 'frameworks').map((item) => {
      if (!isResourceFramework(item)) throw new ResourceParseError(frameworks.n, `frameworks 只接受：${RESOURCE_FRAMEWORKS.join(', ')}`)
      return item
    }),
    styling: inlineList(styling.raw, styling.n, 'styling').map((item) => {
      if (!isResourceStyling(item)) throw new ResourceParseError(styling.n, `styling 只接受：${RESOURCE_STYLING.join(', ')}`)
      return item
    }),
    ...(use ? { use: scalar(use.raw, use.n) } : {}),
    baseline: boolean_(baseline.raw, baseline.n, 'baseline'),
    license: {
      spdx: scalar(spdx.raw, spdx.n),
      url: scalar(url.raw, url.n),
      redistributable: boolean_(redistributable.raw, redistributable.n, 'license.redistributable'),
      attribution: boolean_(attribution.raw, attribution.n, 'license.attribution'),
      commercial: commercial(commercialField.raw, commercialField.n),
      ...(notice ? { notice: scalar(notice.raw, notice.n) } : {}),
    },
    install,
    skills: inlineList(skills.raw, skills.n, 'skills'),
    links: links(linkFields),
    verified_at: scalar(verifiedAt.raw, verifiedAt.n),
  }
}
