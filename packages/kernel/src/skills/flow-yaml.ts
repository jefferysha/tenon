import { required } from '../required.js'

/**
 * `templates/skill-sources.yaml` 与 `skills/sources.yaml` 共用的窄 flow YAML 原语：
 * 一行一个 `key: { field: value, ... }`，只做文本切分，不做 schema 校验。
 */

/** 去掉整行注释和 ` #` 之后的行尾注释。 */
export function stripFlowComment(line: string): string {
  const t = line.trimStart()
  if (t.startsWith('#')) return ''
  const m = line.match(/^(.*?)\s#/)
  return (m ? required(m[1]) : line).trimEnd()
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  for (const ch of s) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === sep) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

export function unquoteFlowValue(value: string): string {
  const s = value.trim()
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1)
  }
  return s
}

/** 解析 `{ ... }` 内部；缺冒号或字段重复时用 `onError` 构造调用方自己的错误类型。 */
export function parseFlowBody(body: string, onError: (message: string) => Error): Map<string, string> {
  const fields = new Map<string, string>()
  for (const rawPair of splitTopLevel(body, ',')) {
    const pair = rawPair.trim()
    if (pair === '') continue
    const colon = pair.indexOf(':')
    if (colon <= 0) throw onError(`字段 '${pair}' 缺 'key: value' 冒号`)
    const key = pair.slice(0, colon).trim()
    const value = unquoteFlowValue(pair.slice(colon + 1))
    if (fields.has(key)) throw onError(`字段 '${key}' 重复`)
    fields.set(key, value)
  }
  return fields
}
