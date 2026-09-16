/**
 * 条目的语义校验（解析已经保证了语法与枚举）。许可证门禁在这里：不可再分发或需署名的条目必须写 notice，
 * 所以 UI 和指令文件永远能展示「仅链接 / 署名」的依据。
 */
import { RESOURCE_ID, type ResourceEntry } from './types.js'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const HTTPS = /^https:\/\/[^\s]+$/

function isDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** fileName 是条目文件名（带或不带 .yaml）；id 必须与文件名一致。 */
export function validateResourceEntry(entry: ResourceEntry, fileName: string): string[] {
  const errors: string[] = []
  if (!RESOURCE_ID.test(entry.id)) errors.push(`id 必须匹配 ${RESOURCE_ID.source}`)
  const stem = fileName.endsWith('.yaml') ? fileName.slice(0, -5) : fileName
  if (stem !== '' && entry.id !== stem) errors.push('id 必须与文件名一致')
  if (!HTTPS.test(entry.license.url)) errors.push('license.url 必须是 https 链接')
  for (const [key, value] of Object.entries(entry.links)) {
    if (!HTTPS.test(value)) errors.push(`links.${key} 必须是 https 链接`)
  }
  if (entry.links.home === undefined && entry.links.docs === undefined && entry.links.source === undefined) {
    errors.push('links 至少需要 home、docs 或 source')
  }
  if ((entry.license.attribution || !entry.license.redistributable) && (entry.license.notice ?? '') === '') {
    errors.push('license.notice 必填')
  }
  if ((entry.category === 'state' || entry.category === 'styling') && (entry.use ?? '') === '') errors.push('use 必填')
  if (entry.category === 'design-md' && entry.links.design_md === undefined) errors.push('links.design_md 必填')
  if (!isDate(entry.verified_at)) errors.push('verified_at 必须是日期')
  return errors
}
