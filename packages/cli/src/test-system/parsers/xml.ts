/**
 * 够用的 XML 解析：JUnit 与 Cobertura 报告只需要元素树、属性与文本。不做 DTD / 命名空间 / 外部实体；
 * 迭代实现（不递归），深度与节点数有上限，报告是不可信输入。
 */

export interface XmlElement {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: XmlElement[]
  /** 元素自身的文本与 CDATA（不含子元素文本）。 */
  text: string
}

const MAX_DEPTH = 256
const MAX_NODES = 2_000_000

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return safeCodePoint(Number.parseInt(body.slice(2), 16)) ?? whole
    if (body.startsWith('#')) return safeCodePoint(Number.parseInt(body.slice(1), 10)) ?? whole
    return ENTITIES[body] ?? whole
  })
}

function safeCodePoint(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined
  return String.fromCodePoint(code)
}

export class XmlError extends Error {}

const NAME_START = /[A-Za-z_:]/
const NAME_CHAR = /[A-Za-z0-9_:.-]/

interface Cursor {
  readonly text: string
  index: number
}

function skipSpaces(cursor: Cursor): void {
  while (cursor.index < cursor.text.length && /\s/.test(cursor.text.charAt(cursor.index))) cursor.index++
}

function readName(cursor: Cursor): string {
  const start = cursor.index
  if (!NAME_START.test(cursor.text.charAt(cursor.index))) throw new XmlError(`位置 ${cursor.index} 处缺少名字`)
  while (cursor.index < cursor.text.length && NAME_CHAR.test(cursor.text.charAt(cursor.index))) cursor.index++
  return cursor.text.slice(start, cursor.index)
}

function readAttributes(cursor: Cursor): { attrs: Record<string, string>; selfClosing: boolean } {
  const attrs: Record<string, string> = {}
  for (;;) {
    skipSpaces(cursor)
    const char = cursor.text.charAt(cursor.index)
    if (char === '>') { cursor.index++; return { attrs, selfClosing: false } }
    if (char === '/' && cursor.text.charAt(cursor.index + 1) === '>') { cursor.index += 2; return { attrs, selfClosing: true } }
    if (char === '') throw new XmlError('标签没有结束')
    const name = readName(cursor)
    skipSpaces(cursor)
    if (cursor.text.charAt(cursor.index) !== '=') throw new XmlError(`属性 ${name} 缺少 =`)
    cursor.index++
    skipSpaces(cursor)
    const quote = cursor.text.charAt(cursor.index)
    if (quote !== '"' && quote !== "'") throw new XmlError(`属性 ${name} 缺少引号`)
    const end = cursor.text.indexOf(quote, cursor.index + 1)
    if (end < 0) throw new XmlError(`属性 ${name} 的引号没有闭合`)
    attrs[name] = decodeEntities(cursor.text.slice(cursor.index + 1, end))
    cursor.index = end + 1
  }
}

/** 解析单根 XML 文档，返回根元素。语法错误抛 XmlError。 */
export function parseXml(text: string): XmlElement {
  const cursor: Cursor = { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, index: 0 }
  const stack: XmlElement[] = []
  let root: XmlElement | undefined
  let nodes = 0
  while (cursor.index < cursor.text.length) {
    const next = cursor.text.indexOf('<', cursor.index)
    const top = stack.at(-1)
    if (next < 0) {
      if (top !== undefined) throw new XmlError(`元素 ${top.name} 没有闭合`)
      break
    }
    if (next > cursor.index && top !== undefined) top.text += decodeEntities(cursor.text.slice(cursor.index, next))
    cursor.index = next
    if (cursor.text.startsWith('<!--', cursor.index)) {
      const end = cursor.text.indexOf('-->', cursor.index + 4)
      if (end < 0) throw new XmlError('注释没有闭合')
      cursor.index = end + 3
      continue
    }
    if (cursor.text.startsWith('<![CDATA[', cursor.index)) {
      const end = cursor.text.indexOf(']]>', cursor.index + 9)
      if (end < 0 || top === undefined) throw new XmlError('CDATA 位置或闭合非法')
      top.text += cursor.text.slice(cursor.index + 9, end)
      cursor.index = end + 3
      continue
    }
    if (cursor.text.startsWith('<?', cursor.index)) {
      const end = cursor.text.indexOf('?>', cursor.index + 2)
      if (end < 0) throw new XmlError('处理指令没有闭合')
      cursor.index = end + 2
      continue
    }
    if (cursor.text.startsWith('<!', cursor.index)) {
      const end = cursor.text.indexOf('>', cursor.index + 2)
      if (end < 0) throw new XmlError('声明没有闭合')
      cursor.index = end + 1
      continue
    }
    if (cursor.text.startsWith('</', cursor.index)) {
      cursor.index += 2
      const name = readName(cursor)
      skipSpaces(cursor)
      if (cursor.text.charAt(cursor.index) !== '>') throw new XmlError(`结束标签 ${name} 缺少 >`)
      cursor.index++
      if (top === undefined || top.name !== name) throw new XmlError(`结束标签 ${name} 与开始标签不匹配`)
      stack.pop()
      continue
    }
    cursor.index++
    const name = readName(cursor)
    const { attrs, selfClosing } = readAttributes(cursor)
    nodes++
    if (nodes > MAX_NODES) throw new XmlError('元素数量超过上限')
    const element: XmlElement = { name, attrs, children: [], text: '' }
    if (top === undefined) {
      if (root !== undefined) throw new XmlError('文档有多个根元素')
      root = element
    } else {
      top.children.push(element)
    }
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new XmlError('元素嵌套过深')
      stack.push(element)
    }
  }
  if (stack.length > 0) throw new XmlError(`元素 ${stack.at(-1)?.name ?? '?'} 没有闭合`)
  if (root === undefined) throw new XmlError('文档没有根元素')
  return root
}

export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name)
}

/** 深度优先遍历所有后代（先序）。 */
export function descendants(element: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const pending: XmlElement[] = [...element.children].reverse()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    out.push(current)
    for (let index = current.children.length - 1; index >= 0; index--) {
      const child = current.children[index]
      if (child !== undefined) pending.push(child)
    }
  }
  return out
}
