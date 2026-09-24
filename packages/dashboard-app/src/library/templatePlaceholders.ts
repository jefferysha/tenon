/**
 * 模板预览里的 `{{name}}` 占位符：不露原始花括号，渲染成一个淡色的占位标记（悬停看原文）。
 * 语法与 kernel `placeholdersIn` 一致：名称 `[a-z][a-z0-9_.-]*`，`\{{` 是转义的字面量。
 * 围栏代码与行内代码里只把花括号换成尖括号（代码节点不能再嵌元素）。
 * Markdown 自己会吃掉 `\{` 的反斜杠，所以渲染前先用 `protectEscapes` 把转义换成私用区哨兵字符。
 */
const ESCAPE = '\uE000'
const PLACEHOLDER = /(\uE000)?\{\{([a-z][a-z0-9_.-]*)\}\}/gu

/** 渲染前调用：`\{{` → 哨兵 + `{{`，插件据此把它当字面量。 */
export function protectEscapes(text: string): string {
  return text.split('\\{{').join(`${ESCAPE}{{`)
}

export const PLACEHOLDER_CLASS = 'rounded-xs bg-fill px-1 font-mono text-[length:max(.9em,13px)] text-text-3'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, string> }
}

type LabelOf = (name: string) => string

function splitText(value: string, labelOf: LabelOf): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  for (const match of value.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0
    const escaped = match[1] === ESCAPE
    const name = match[2] ?? ''
    if (index > last) out.push({ type: 'text', value: value.slice(last, index).split(ESCAPE).join('') })
    out.push(escaped
      ? { type: 'text', value: match[0].slice(1) }
      : {
          type: 'templatePlaceholder',
          data: { hName: 'span', hProperties: { className: PLACEHOLDER_CLASS, title: `{{${name}}}`, 'data-placeholder': name } },
          children: [{ type: 'text', value: labelOf(name) }],
        })
    last = index + match[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last).split(ESCAPE).join('') })
  return out
}

function visit(node: MdNode, labelOf: LabelOf): void {
  if (node.children === undefined) return
  const next: MdNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      next.push(...splitText(child.value, labelOf))
      continue
    }
    if ((child.type === 'code' || child.type === 'inlineCode') && child.value !== undefined) {
      child.value = child.value
        .replace(PLACEHOLDER, (whole, escape: string | undefined, name: string) => (escape === ESCAPE ? whole.slice(1) : `‹${labelOf(name)}›`))
        .split(ESCAPE).join('')
    }
    visit(child, labelOf)
    next.push(child)
  }
  node.children = next
}

/** remark 插件工厂：`labelOf` 把占位符名称变成显示文字（例如 catalog.icons → 图标）。 */
export function remarkTemplatePlaceholders(labelOf: LabelOf): () => (tree: MdNode) => void {
  return () => (tree: MdNode) => visit(tree, labelOf)
}
