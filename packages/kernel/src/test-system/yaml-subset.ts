/**
 * 测试目录 / 测试计划 / 已知失败清单共用的 YAML 子集解析器（kernel 零第三方依赖），每个节点带行号，
 * 让校验错误能落到 `catalog.yaml:<行>`。
 *
 * 支持：块式映射、块式序列（含 `- key: v` 起头的映射项）、单行流式 `[a, b]` 与 `{ a: 1, b: [c] }`
 * （可嵌套）、单双引号标量、裸标量（null / 布尔 / 数字按 YAML 1.2 core 解析，其余为字符串）、整行注释
 * 与值后 ` #` 注释、首行 `---`。
 * 不支持并按行号报错：tab 缩进、跨行流式集合、多行块标量（`|`、`>`）、锚点 / 别名 / 标签、重复键、
 * 含 `: ` 的裸标量（标准 YAML 同样拒绝）。
 */

export type YamlScalarValue = string | number | boolean | null

export interface YamlScalar {
  readonly kind: 'scalar'
  readonly line: number
  readonly value: YamlScalarValue
  readonly quoted: boolean
}

export interface YamlSeq {
  readonly kind: 'seq'
  readonly line: number
  readonly items: readonly YamlNode[]
}

export interface YamlMapEntry {
  readonly key: string
  readonly line: number
  readonly value: YamlNode
}

export interface YamlMap {
  readonly kind: 'map'
  readonly line: number
  readonly entries: readonly YamlMapEntry[]
}

export type YamlNode = YamlScalar | YamlSeq | YamlMap

export class YamlSubsetError extends Error {
  readonly line: number
  constructor(line: number, detail: string) {
    super(`第 ${line} 行：${detail}`)
    this.name = 'YamlSubsetError'
    this.line = line
  }
}

interface Token {
  readonly line: number
  readonly indent: number
  readonly content: string
}

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ ]+(.*))?$/
const FLOW_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const INT_RE = /^[-+]?\d+$/
const FLOAT_RE = /^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const lines = text.split('\n')
  let sawContent = false
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? '').replace(/\r$/, '')
    const lineNo = index + 1
    if (line.trim() === '') continue
    const indentText = /^[ \t]*/.exec(line)?.[0] ?? ''
    if (indentText.includes('\t')) throw new YamlSubsetError(lineNo, '缩进不允许 tab')
    const content = line.slice(indentText.length).trimEnd()
    if (content.startsWith('#')) continue
    if (!sawContent && content === '---') { sawContent = true; continue }
    sawContent = true
    if (content === '...' || content === '---') throw new YamlSubsetError(lineNo, '不支持多文档')
    tokens.push({ line: lineNo, indent: indentText.length, content })
  }
  return tokens
}

function resolvePlain(raw: string): YamlScalarValue {
  if (raw === '' || raw === '~' || /^(?:null|Null|NULL)$/.test(raw)) return null
  if (/^(?:true|True|TRUE)$/.test(raw)) return true
  if (/^(?:false|False|FALSE)$/.test(raw)) return false
  if (INT_RE.test(raw) || FLOAT_RE.test(raw)) {
    const value = Number(raw)
    if (Number.isFinite(value)) return value
  }
  return raw
}

function restIsComment(rest: string, line: number): void {
  if (rest.trim() === '') return
  if (/^\s+#/.test(rest)) return
  throw new YamlSubsetError(line, `值后面有多余内容 '${rest.trim()}'`)
}

/** 从 start 处读一个带引号的标量，返回值与结束位置（结束引号之后）。 */
function readQuoted(text: string, start: number, line: number): { readonly value: string; readonly end: number } {
  const quote = text[start]
  if (quote === '"') {
    let index = start + 1
    while (index < text.length) {
      const char = text[index]
      if (char === '\\') { index += 2; continue }
      if (char === '"') break
      index++
    }
    if (index >= text.length) throw new YamlSubsetError(line, '双引号标量未闭合（不支持跨行）')
    let value: unknown
    try {
      value = JSON.parse(text.slice(start, index + 1))
    } catch {
      throw new YamlSubsetError(line, '双引号标量含非法转义')
    }
    if (typeof value !== 'string') throw new YamlSubsetError(line, '双引号标量非法')
    return { value, end: index + 1 }
  }
  let index = start + 1
  let value = ''
  while (index < text.length) {
    const char = text[index]
    if (char === "'") {
      if (text[index + 1] === "'") { value += "'"; index += 2; continue }
      return { value, end: index + 1 }
    }
    value += char ?? ''
    index++
  }
  throw new YamlSubsetError(line, '单引号标量未闭合（不支持跨行）')
}

class FlowReader {
  index = 0
  constructor(private readonly text: string, private readonly line: number) {}

  private skipSpace(): void {
    while (this.text[this.index] === ' ') this.index++
  }

  private fail(detail: string): never {
    throw new YamlSubsetError(this.line, detail)
  }

  value(context: 'seq' | 'map'): YamlNode {
    this.skipSpace()
    if (this.index >= this.text.length) this.fail('流式集合未闭合（必须写在一行）')
    const char = this.text[this.index]
    if (char === '[') return this.seq()
    if (char === '{') return this.map()
    if (char === '"' || char === "'") {
      const quoted = readQuoted(this.text, this.index, this.line)
      this.index = quoted.end
      return { kind: 'scalar', line: this.line, value: quoted.value, quoted: true }
    }
    const stop = context === 'seq' ? /[,\]]/ : /[,}]/
    const start = this.index
    while (this.index < this.text.length && !stop.test(this.text[this.index] ?? '')) {
      if ('[]{}'.includes(this.text[this.index] ?? '')) this.fail('流式集合里的裸标量不能含括号；请加引号')
      this.index++
    }
    const raw = this.text.slice(start, this.index).trim()
    if (raw === '') this.fail('流式集合里有空项')
    if (/^[&*!|>]/.test(raw)) this.fail(`不支持的 YAML 写法 '${raw}'`)
    return { kind: 'scalar', line: this.line, value: resolvePlain(raw), quoted: false }
  }

  private seq(): YamlSeq {
    this.index++
    const items: YamlNode[] = []
    this.skipSpace()
    if (this.text[this.index] === ']') { this.index++; return { kind: 'seq', line: this.line, items } }
    for (;;) {
      items.push(this.value('seq'))
      this.skipSpace()
      const char = this.text[this.index]
      if (char === ',') { this.index++; continue }
      if (char === ']') { this.index++; return { kind: 'seq', line: this.line, items } }
      this.fail('流式列表未闭合（必须写在一行）')
    }
  }

  private map(): YamlMap {
    this.index++
    const entries: YamlMapEntry[] = []
    this.skipSpace()
    if (this.text[this.index] === '}') { this.index++; return { kind: 'map', line: this.line, entries } }
    for (;;) {
      this.skipSpace()
      const colon = this.text.indexOf(':', this.index)
      if (colon < 0) this.fail('流式映射缺少 key: value')
      const key = this.text.slice(this.index, colon).trim()
      if (!FLOW_KEY_RE.test(key)) this.fail(`流式映射的键 '${key}' 非法`)
      if (entries.some((entry) => entry.key === key)) this.fail(`键 '${key}' 重复`)
      this.index = colon + 1
      const next = this.text[this.index]
      if (next !== ' ' && next !== ',' && next !== '}') this.fail(`键 '${key}' 的冒号后必须有空格`)
      this.skipSpace()
      const empty = this.text[this.index] === ',' || this.text[this.index] === '}'
      const value: YamlNode = empty ? { kind: 'scalar', line: this.line, value: null, quoted: false } : this.value('map')
      entries.push({ key, line: this.line, value })
      this.skipSpace()
      const char = this.text[this.index]
      if (char === ',') { this.index++; continue }
      if (char === '}') { this.index++; return { kind: 'map', line: this.line, entries } }
      this.fail('流式映射未闭合（必须写在一行）')
    }
  }
}

/** 一个值位置上的内联内容（键后或 `- ` 后）；空串表示下面跟嵌套块。 */
function parseInline(raw: string, line: number): YamlNode {
  const text = raw.trimStart()
  const first = text[0]
  if (first === '[' || first === '{') {
    const reader = new FlowReader(text, line)
    const node = reader.value(first === '[' ? 'seq' : 'map')
    restIsComment(text.slice(reader.index), line)
    return node
  }
  if (first === '"' || first === "'") {
    const quoted = readQuoted(text, 0, line)
    restIsComment(text.slice(quoted.end), line)
    return { kind: 'scalar', line, value: quoted.value, quoted: true }
  }
  if (first === '|' || first === '>') throw new YamlSubsetError(line, '不支持多行块标量；命令与路径请写成单行')
  if (first === '&' || first === '*' || first === '!') throw new YamlSubsetError(line, '不支持锚点、别名与标签')
  const comment = /\s#/.exec(text)
  const plain = (comment === null ? text : text.slice(0, comment.index)).trim()
  if (plain.includes(': ') || plain.endsWith(':')) throw new YamlSubsetError(line, `值 '${plain}' 含 ': '，请加引号`)
  return { kind: 'scalar', line, value: resolvePlain(plain), quoted: false }
}

function isDash(token: Token): boolean {
  return token.content === '-' || token.content.startsWith('- ')
}

class BlockParser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  document(): YamlNode {
    const first = this.tokens[0]
    if (first === undefined) return { kind: 'scalar', line: 1, value: null, quoted: false }
    if (first.indent !== 0) throw new YamlSubsetError(first.line, '顶层内容必须从第 0 列开始')
    const node = this.block(0)
    const extra = this.tokens[this.pos]
    if (extra !== undefined) throw new YamlSubsetError(extra.line, '缩进与所在块不一致')
    return node
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private block(indent: number): YamlNode {
    const token = this.peek()
    if (token === undefined) throw new Error('yaml-subset: block() 需要当前行')
    if (isDash(token)) return this.seq(indent)
    if (KEY_RE.test(token.content)) return this.map(indent)
    this.pos++
    const node = parseInline(token.content, token.line)
    if (node.kind === 'scalar' && !node.quoted && typeof node.value === 'string' && this.peek()?.indent === indent) {
      throw new YamlSubsetError(token.line, `期望 'key: value'，实际 '${token.content}'`)
    }
    return node
  }

  /** 键后为空时的嵌套值：更深缩进的块，或与键同列的块式序列；都没有则为 null。 */
  private nested(keyIndent: number, line: number): YamlNode {
    const next = this.peek()
    if (next !== undefined && next.indent > keyIndent) return this.block(next.indent)
    if (next !== undefined && next.indent === keyIndent && isDash(next)) return this.seq(keyIndent)
    return { kind: 'scalar', line, value: null, quoted: false }
  }

  private map(indent: number, first?: Token): YamlMap {
    const entries: YamlMapEntry[] = []
    let line = first?.line ?? this.peek()?.line ?? 1
    let pending: Token | undefined = first
    for (;;) {
      const token = pending ?? this.peek()
      if (token === undefined || token.indent < indent) break
      if (token.indent > indent) throw new YamlSubsetError(token.line, '缩进与所在映射不一致')
      if (isDash(token)) break
      const match = KEY_RE.exec(token.content)
      if (!match) throw new YamlSubsetError(token.line, `期望 'key: value'，实际 '${token.content}'`)
      if (pending === undefined) this.pos++
      pending = undefined
      if (entries.length === 0) line = token.line
      const key = match[1] ?? ''
      if (entries.some((entry) => entry.key === key)) throw new YamlSubsetError(token.line, `键 '${key}' 重复`)
      const rest = match[2] ?? ''
      const value = rest.trim() === '' || rest.trimStart().startsWith('#')
        ? this.nested(indent, token.line)
        : parseInline(rest, token.line)
      entries.push({ key, line: token.line, value })
    }
    return { kind: 'map', line, entries }
  }

  private seq(indent: number): YamlSeq {
    const items: YamlNode[] = []
    const line = this.peek()?.line ?? 1
    for (;;) {
      const token = this.peek()
      if (token === undefined || token.indent < indent) break
      if (token.indent > indent) throw new YamlSubsetError(token.line, '缩进与所在列表不一致')
      if (!isDash(token)) break
      this.pos++
      const after = token.content.slice(1)
      const body = after.trimStart()
      if (body === '' || body.startsWith('#')) {
        items.push(this.nested(indent, token.line))
        continue
      }
      if (body.startsWith('- ') || body === '-') throw new YamlSubsetError(token.line, '不支持嵌套的 `- -` 列表')
      if (KEY_RE.test(body)) {
        const itemIndent = indent + 1 + (after.length - body.length)
        items.push(this.map(itemIndent, { line: token.line, indent: itemIndent, content: body }))
        continue
      }
      items.push(parseInline(body, token.line))
    }
    return { kind: 'seq', line, items }
  }
}

export function parseYamlSubset(text: string): YamlNode {
  return new BlockParser(tokenize(text)).document()
}
