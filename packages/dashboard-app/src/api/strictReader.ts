/**
 * 严格解码的小工具：读到不合形状的值立即抛 Mismatch，`guard` 把它收成 null。
 * 未声明的多余键被忽略（服务端可以向后兼容地加字段），声明过的键必须在且类型正确。
 */

class Mismatch extends Error {}

export function bad(): never {
  throw new Mismatch('shape')
}

export function rec(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad()
  return value as Record<string, unknown>
}

export function str(value: unknown): string {
  if (typeof value !== 'string') bad()
  return value
}

export function nstr(value: unknown): string | null {
  return value === null ? null : str(value)
}

export function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad()
  return value
}

export function nnum(value: unknown): number | null {
  return value === null ? null : num(value)
}

export function int(value: unknown): number {
  const n = num(value)
  if (!Number.isInteger(n) || n < 0) bad()
  return n
}

export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') bad()
  return value
}

export function arr<T>(value: unknown, each: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) bad()
  return value.map(each)
}

export function strs(value: unknown): string[] {
  return arr(value, str)
}

/** 缺省（undefined）→ undefined；出现则必须合形。 */
export function opt<T>(value: unknown, read: (item: unknown) => T): T | undefined {
  return value === undefined ? undefined : read(value)
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) bad()
  return value as T
}

/** 把「读」函数变成「解码」函数：形状不合返回 null，其它异常照常抛。 */
export function guard<T>(read: (value: unknown) => T): (value: unknown) => T | null {
  return (value) => {
    try {
      return read(value)
    } catch (error) {
      if (error instanceof Mismatch) return null
      throw error
    }
  }
}

/** 仅当 value 不是 undefined 时才带这个键（保持 exactOptional 风格的对象形状）。 */
export function maybe<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}
