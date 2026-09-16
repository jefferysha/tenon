/**
 * 条目的规范写法：键序固定、两空格缩进、LF、单个结尾换行。
 * 解析 → 序列化 → 解析逐字节稳定，所以 Dashboard 保存后的文件与手写的内建文件长得一样。
 */
import { RESOURCE_LINK_KEYS, type ResourceEntry } from './types.js'

/** 裸标量的安全条件：不含 `: `、不以特殊字符开头、不与 YAML 的真假值或数字混淆。 */
function needsQuote(value: string): boolean {
  return value === ''
    || value !== value.trim()
    || value.includes(': ')
    || value.endsWith(':')
    || /["\\]/.test(value)
    || /^[-?:,[\]{}&*!|>'%@`#]/.test(value)
    || /^(true|false|null|~)$/i.test(value)
    || /^-?\d+(?:\.\d+)?$/.test(value)
}

export function serializeResourceScalar(value: string): string {
  return needsQuote(value) ? JSON.stringify(value) : value
}

const inline = (items: readonly string[]): string => `[${items.join(', ')}]`

export function serializeResourceEntry(entry: ResourceEntry): string {
  const lines = [
    `schema: ${entry.schema}`,
    `id: ${serializeResourceScalar(entry.id)}`,
    `name: ${serializeResourceScalar(entry.name)}`,
    `category: ${entry.category}`,
    `frameworks: ${inline(entry.frameworks)}`,
    `styling: ${inline(entry.styling)}`,
  ]
  if (entry.use !== undefined) lines.push(`use: ${serializeResourceScalar(entry.use)}`)
  lines.push(`baseline: ${entry.baseline ? 'true' : 'false'}`)
  lines.push('license:')
  lines.push(`  spdx: ${serializeResourceScalar(entry.license.spdx)}`)
  lines.push(`  url: ${serializeResourceScalar(entry.license.url)}`)
  lines.push(`  redistributable: ${entry.license.redistributable ? 'true' : 'false'}`)
  lines.push(`  attribution: ${entry.license.attribution ? 'true' : 'false'}`)
  lines.push(`  commercial: ${entry.license.commercial}`)
  if (entry.license.notice !== undefined) lines.push(`  notice: ${serializeResourceScalar(entry.license.notice)}`)
  if (entry.install.length === 0) lines.push('install: []')
  else {
    lines.push('install:')
    for (const item of entry.install) lines.push(`  - ${serializeResourceScalar(item)}`)
  }
  lines.push(`skills: ${inline(entry.skills)}`)
  lines.push('links:')
  for (const key of RESOURCE_LINK_KEYS) {
    const value = entry.links[key]
    if (value !== undefined) lines.push(`  ${key}: ${serializeResourceScalar(value)}`)
  }
  lines.push(`verified_at: ${entry.verified_at}`)
  return `${lines.join('\n')}\n`
}
