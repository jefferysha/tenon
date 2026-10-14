/**
 * 目录文本按行切分与按行区间替换（catalog-patch.ts 用）。每行的行尾（`\n`、`\r\n` 或没有）随行保留，
 * 新增的行沿用原文的换行风格；原文没有结尾换行时，改完仍然没有。
 * 行号从 1 起，与 yaml-subset 的节点行号同一口径；区间用 0 起的行下标、右开。
 */

export interface Segment {
  readonly text: string
  /** `\n`、`\r\n`，或最后一行没有换行时为空串。 */
  readonly eol: string
}

/** 在 [start, end) 上替换成 lines；start === end 即在该位置插入，lines 为空即删除。 */
export interface LineEdit {
  readonly start: number
  readonly end: number
  readonly lines: readonly string[]
}

export function splitSegments(text: string): Segment[] {
  const out: Segment[] = []
  let from = 0
  while (from < text.length) {
    const newline = text.indexOf('\n', from)
    if (newline < 0) {
      out.push({ text: text.slice(from), eol: '' })
      break
    }
    const crlf = newline > from && text[newline - 1] === '\r'
    out.push({ text: text.slice(from, crlf ? newline - 1 : newline), eol: crlf ? '\r\n' : '\n' })
    from = newline + 1
  }
  return out
}

export function applyLineEdits(segments: readonly Segment[], edits: readonly LineEdit[]): string {
  const dominant = segments.find((segment) => segment.eol !== '')?.eol ?? '\n'
  const sorted = [...edits].sort((left, right) => left.start - right.start || left.end - right.end)
  const out: Segment[] = []
  let cursor = 0
  for (const edit of sorted) {
    if (edit.start < cursor) throw new Error(`目录改动区间重叠（第 ${edit.start + 1} 行附近）`)
    for (const segment of segments.slice(cursor, edit.start)) out.push(segment)
    for (const line of edit.lines) out.push({ text: line, eol: dominant })
    cursor = edit.end
  }
  for (const segment of segments.slice(cursor)) out.push(segment)
  const unterminated = segments.at(-1)?.eol === ''
  return out
    .map((segment, index) => {
      if (!unterminated) return segment.text + segment.eol
      return segment.text + (index === out.length - 1 ? '' : segment.eol === '' ? dominant : segment.eol)
    })
    .join('')
}

export function isBlankOrComment(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

export function leadingSpaces(text: string): number {
  return text.length - text.trimStart().length
}

/** 键开始的列：`  - id: x` 是 `id` 的列（跳过 `- ` 与其后的空格），没有短横线时就是缩进。 */
export function contentColumn(text: string): number {
  const indent = leadingSpaces(text)
  const rest = text.slice(indent)
  if (rest !== '-' && !rest.startsWith('- ')) return indent
  let column = indent + 1
  while (text[column] === ' ') column++
  return column
}

/** 这一行是不是序列项（`- ` 开头）。 */
export function isDashLine(text: string): boolean {
  return /^ *-(?: |$)/.test(text)
}

/**
 * 节点最后一行有内容的行号（1 起、含）：从 `from` 起、到 `limit`（下一个同级节点的起始行，不含）前，
 * 去掉尾部的空行与整行注释——它们属于下一个节点。
 */
export function lastContentLine(segments: readonly Segment[], from: number, limit: number): number {
  for (let line = Math.min(limit - 1, segments.length); line > from; line--) {
    if (!isBlankOrComment(segments[line - 1]?.text ?? '')) return line
  }
  return from
}
