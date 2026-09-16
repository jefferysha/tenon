import type { FieldRef, FieldType } from './types.js'
import type { TrackPredicate } from './predicates.js'
import type { WorkflowParseCursor as Cursor } from './parse-document-contract.js'

export function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim()
  if (trimmed === '[]') return []
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error(`workflow 解析错误：期望 [a, b] 形态的单行列表，实际 '${raw}'`)
  }
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** `{ a: x, b: [c, d] }` 单行 flow map：值是标量或单行列表；重复键 fail-loud。 */
export function parseInlineMap(raw: string): Record<string, string | string[]> {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error(`workflow 解析错误：期望 { a: b } 形态的单行映射，实际 '${raw}'`)
  }
  const entries: string[] = []
  let depth = 0
  let current = ''
  for (const char of trimmed.slice(1, -1)) {
    if (char === '[') depth++
    if (char === ']') depth--
    if (char === ',' && depth === 0) { entries.push(current); current = ''; continue }
    current += char
  }
  if (current.trim() !== '') entries.push(current)
  const out: Record<string, string | string[]> = {}
  for (const entry of entries) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(entry)
    if (!match || match[2] === '') throw new Error(`workflow 解析错误：映射项 '${entry.trim()}' 非法`)
    const key = match[1] ?? ''
    if (Object.hasOwn(out, key)) throw new Error(`workflow 解析错误：映射键 '${key}' 重复`)
    const value = match[2] ?? ''
    out[key] = value.startsWith('[') ? parseInlineList(value) : value
  }
  return out
}

export function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** `prompt: |-` 的窄 literal-block 解析。内容固定比键多 2 空格；serializer 也只写这一种形态。 */
export function parsePromptBlock(cur: Cursor, keyIndent: number): string {
  const contentIndent = keyIndent + 2
  const out: string[] = []
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    // serializer 会给 literal block 的空行也写足缩进；无缩进空行属于字段间空白，不吞进 prompt。
    if (line.trim() === '' && line.length < contentIndent) break
    if (indentOf(line) < contentIndent) break
    out.push(line.slice(contentIndent))
    cur.i++
  }
  if (out.length === 0) throw new Error('workflow 解析错误：prompt: |- 后必须有缩进内容行')
  return out.join('\n')
}

export function parseFieldRefBlock(cur: Cursor, baseIndent: number): FieldRef[] {
  const refs: FieldRef[] = []
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) < baseIndent) break
    const fieldMatch = /^\s*-\s+field:\s*(\S+)\s*$/.exec(line)
    if (!fieldMatch) break
    cur.i++
    const typeLine = cur.lines[cur.i] ?? ''
    const typeMatch = /^\s*type:\s*(string|file_path|boolean)\s*$/.exec(typeLine)
    if (!typeMatch) throw new Error(`workflow 解析错误：field '${fieldMatch[1]}' 缺 type`)
    cur.i++
    refs.push({ field: fieldMatch[1] ?? '', type: typeMatch[1] as FieldType })
  }
  return refs
}

/** Parse the closed track predicate nested under a guard or edge action. */
export function parseWhenBlock(cur: Cursor, whenIndent: number): TrackPredicate {
  while (cur.i < cur.lines.length && (cur.lines[cur.i] ?? '').trim() === '') cur.i++
  const line = cur.lines[cur.i] ?? ''
  if (indentOf(line) <= whenIndent) {
    throw new Error('workflow 解析错误：when 块缺 track_in/track_not_in 谓词行')
  }
  const m = /^\s*(track_in|track_not_in):\s*(\[.*\])\s*$/.exec(line)
  if (!m) throw new Error(`workflow 解析错误：when 谓词只支持 'track_in: [..]' 或 'track_not_in: [..]'，实际 '${line.trim()}'`)
  cur.i++
  return { kind: m[1] === 'track_in' ? 'track-in' : 'track-not-in', values: parseInlineList(m[2] ?? '') }
}
