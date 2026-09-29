/** 解析器读 JSON 报告时的窄化工具：报告是不可信输入，一律先当 unknown 再逐字段收窄。 */

export type JsonRecord = Readonly<Record<string, unknown>>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, reason: `不是合法的 JSON：${error instanceof Error ? error.message.slice(0, 120) : '解析失败'}` }
  }
}
