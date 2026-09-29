/**
 * 键序无关的规范 JSON：对象按键排序、数组保序、undefined 成员省略（与 JSON.stringify 同口径）。
 * 测试声明摘要、目录摘要、策略摘要与运行记录哈希链共用这一份，任何两处算出的摘要可直接比较。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
