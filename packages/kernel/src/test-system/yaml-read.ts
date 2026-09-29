/**
 * 在 yaml-subset 的节点树上做带行号的形状校验。解码器把问题逐条收进 IssueSink 而不是遇错即停，
 * 这样一次校验能列出目录里的全部错误（`catalog.yaml:<行>: …`）。
 */
import type { YamlMap, YamlNode, YamlScalarValue } from './yaml-subset.js'

export interface DecodeIssue {
  readonly line: number
  readonly message: string
}

export class IssueSink {
  readonly issues: DecodeIssue[] = []
  add(line: number, message: string): undefined {
    this.issues.push({ line, message })
    return undefined
  }
}

export function formatIssue(file: string, issue: DecodeIssue): string {
  return `${file}:${issue.line}: ${issue.message}`
}

export function asMap(node: YamlNode | undefined, sink: IssueSink, what: string, line = 1): YamlMap | undefined {
  if (node === undefined) return sink.add(line, `${what} 缺失`)
  if (node.kind !== 'map') return sink.add(node.line, `${what} 必须是映射`)
  return node
}

export function asSeq(node: YamlNode | undefined, sink: IssueSink, what: string): readonly YamlNode[] | undefined {
  if (node === undefined) return undefined
  if (node.kind === 'scalar' && node.value === null && !node.quoted) return []
  if (node.kind !== 'seq') return sink.add(node.line, `${what} 必须是列表`)
  return node.items
}

export function checkKeys(map: YamlMap, allowed: readonly string[], sink: IssueSink, what: string): void {
  for (const entry of map.entries) {
    if (!allowed.includes(entry.key)) {
      sink.add(entry.line, `${what} 不认识键 '${entry.key}'（可用：${allowed.join('/')}）`)
    }
  }
}

export function field(map: YamlMap, key: string): YamlNode | undefined {
  return map.entries.find((entry) => entry.key === key)?.value
}

function scalar(node: YamlNode | undefined): YamlScalarValue | undefined {
  return node?.kind === 'scalar' ? node.value : undefined
}

export interface StringRule {
  readonly pattern?: RegExp
  readonly maxBytes?: number
  readonly singleLine?: boolean
  readonly hint?: string
}

export function str(node: YamlNode | undefined, sink: IssueSink, what: string, line: number, rule: StringRule = {}): string | undefined {
  if (node === undefined) return sink.add(line, `${what} 缺失`)
  const value = scalar(node)
  if (typeof value !== 'string' || value === '') return sink.add(node.line, `${what} 必须是非空字符串`)
  if (rule.singleLine !== false && /[\r\n\0]/.test(value)) return sink.add(node.line, `${what} 必须是单行`)
  if (rule.maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > rule.maxBytes) {
    return sink.add(node.line, `${what} 超过 ${rule.maxBytes} 字节`)
  }
  if (rule.pattern !== undefined && !rule.pattern.test(value)) {
    return sink.add(node.line, `${what} '${value}' 非法${rule.hint === undefined ? '' : `（${rule.hint}）`}`)
  }
  return value
}

export function optionalStr(node: YamlNode | undefined, sink: IssueSink, what: string, rule: StringRule = {}): string | undefined {
  return node === undefined ? undefined : str(node, sink, what, node.line, rule)
}

export function int(node: YamlNode | undefined, sink: IssueSink, what: string, lo: number, hi: number): number | undefined {
  if (node === undefined) return undefined
  const value = scalar(node)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    return sink.add(node.line, `${what} 必须是 ${lo}–${hi} 的整数`)
  }
  return value
}

export function num(node: YamlNode | undefined, sink: IssueSink, what: string, lo = -Infinity, hi = Infinity): number | undefined {
  if (node === undefined) return undefined
  const value = scalar(node)
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) {
    const range = Number.isFinite(lo) && Number.isFinite(hi) ? ` ${lo}–${hi} 的` : '有限'
    return sink.add(node.line, `${what} 必须是${range}数字`)
  }
  return value
}

export function bool(node: YamlNode | undefined, sink: IssueSink, what: string): boolean | undefined {
  if (node === undefined) return undefined
  const value = scalar(node)
  if (typeof value !== 'boolean') return sink.add(node.line, `${what} 必须是 true 或 false`)
  return value
}

export function oneOf<T extends string>(
  node: YamlNode | undefined,
  sink: IssueSink,
  what: string,
  guard: (value: unknown) => value is T,
  closed: readonly string[],
): T | undefined {
  if (node === undefined) return undefined
  const value = scalar(node)
  if (!guard(value)) return sink.add(node.line, `${what} '${String(value)}' 不在闭集（${closed.join('/')}）`)
  return value
}

/** 字符串列表；每项按 rule 校验，重复项报错。缺省返回空列表。 */
export function strList(node: YamlNode | undefined, sink: IssueSink, what: string, rule: StringRule = {}): string[] {
  const items = asSeq(node, sink, what)
  if (items === undefined) return []
  const out: string[] = []
  for (const item of items) {
    const value = str(item, sink, `${what} 的一项`, item.line, rule)
    if (value === undefined) continue
    if (out.includes(value)) {
      sink.add(item.line, `${what} 重复列出 '${value}'`)
      continue
    }
    out.push(value)
  }
  return out
}
