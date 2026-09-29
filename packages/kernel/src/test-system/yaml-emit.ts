/**
 * 与 yaml-subset.ts 配对的规范化写出：块式映射与序列、固定两空格缩进、键序即对象键序。
 * 字符串能裸写且不会被读成别的类型时裸写，否则写成 JSON 双引号（同时也是合法 YAML）。
 * 相同数据恒得相同字节——测试计划的摘要建立在这一点上。
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | readonly YamlValue[]
  | { readonly [key: string]: YamlValue | undefined }

const PLAIN_FIRST = /^[A-Za-z0-9_/.\u0080-￿]/u
const RESERVED_PLAIN = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|no|on|off|Yes|No|On|Off|YES|NO|ON|OFF)$/
const NUMBER_LIKE = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$|^0x|^0o|^\.inf|^\.nan/i
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/

function plainSafe(value: string): boolean {
  return value !== ''
    && value === value.trim()
    && PLAIN_FIRST.test(value)
    && !/[\n\r\t"'[\]{},]/.test(value)
    && !value.includes(': ')
    && !value.includes(' #')
    && !value.endsWith(':')
    && !RESERVED_PLAIN.test(value)
    && !NUMBER_LIKE.test(value)
    && !DATE_LIKE.test(value)
}

export function formatYamlScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`yaml-emit: 非有限数字 ${String(value)}`)
    return String(value)
  }
  return plainSafe(value) ? value : JSON.stringify(value)
}

function isSeq(value: YamlValue): value is readonly YamlValue[] {
  return Array.isArray(value)
}

function isMap(value: YamlValue): value is { readonly [key: string]: YamlValue | undefined } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entries(value: { readonly [key: string]: YamlValue | undefined }): Array<[string, YamlValue]> {
  const out: Array<[string, YamlValue]> = []
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`yaml-emit: 键 '${key}' 不能裸写`)
    out.push([key, item])
  }
  return out
}

function emitEntries(value: { readonly [key: string]: YamlValue | undefined }, pad: string): string[] {
  const lines: string[] = []
  for (const [key, item] of entries(value)) {
    if (isSeq(item)) {
      if (item.length === 0) lines.push(`${pad}${key}: []`)
      else lines.push(`${pad}${key}:`, ...emitItems(item, `${pad}  `))
    } else if (isMap(item)) {
      if (entries(item).length === 0) lines.push(`${pad}${key}: {}`)
      else lines.push(`${pad}${key}:`, ...emitEntries(item, `${pad}  `))
    } else {
      lines.push(`${pad}${key}: ${formatYamlScalar(item)}`)
    }
  }
  return lines
}

function emitItems(items: readonly YamlValue[], pad: string): string[] {
  const lines: string[] = []
  for (const item of items) {
    if (isSeq(item)) throw new Error('yaml-emit: 不支持序列直接嵌套序列')
    if (isMap(item)) {
      const body = emitEntries(item, `${pad}  `)
      const first = body[0]
      if (first === undefined) lines.push(`${pad}- {}`)
      else lines.push(`${pad}- ${first.slice(pad.length + 2)}`, ...body.slice(1))
      continue
    }
    lines.push(`${pad}- ${formatYamlScalar(item)}`)
  }
  return lines
}

/** 顶层必须是映射。输出以换行结尾。 */
export function emitYaml(value: { readonly [key: string]: YamlValue | undefined }): string {
  return `${emitEntries(value, '').join('\n')}\n`
}
