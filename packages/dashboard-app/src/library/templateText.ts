/**
 * 模板文件（固定行 frontmatter + Markdown 正文）的纯文本改写：表单只改 id / title / category 三行与正文，
 * 其余 frontmatter 行（frameworks、variables…）原样保留。语法与 kernel `instructions/block.ts` 一致。
 */
import { TEMPLATE_CATEGORIES, type TemplateCategory } from '../api/instructionsDecoders'

export interface TemplateParts {
  /** `---` 与 `---` 之间的行，不含分隔行。 */
  readonly front: readonly string[]
  readonly body: string
}

/** 拆成 frontmatter 行与正文；没有闭合的 frontmatter 返回 null（交给服务端报错）。 */
export function splitTemplate(text: string): TemplateParts | null {
  const lines = text.split('\n')
  if (lines[0] !== '---') return null
  const close = lines.indexOf('---', 1)
  if (close < 0) return null
  return { front: lines.slice(1, close), body: lines.slice(close + 1).join('\n') }
}

export function joinTemplate(parts: TemplateParts): string {
  return ['---', ...parts.front, '---', parts.body].join('\n')
}

/** kernel 的标量语法：以 `"` 开头才是带引号的字符串（`\"` 与 `\\` 转义）。 */
function readScalar(raw: string): string {
  const value = raw.trim()
  if (!value.startsWith('"') || value.length < 2 || !value.endsWith('"')) return value
  return value.slice(1, -1).replace(/\\(["\\])/gu, '$1')
}

function writeScalar(value: string): string {
  const flat = value.replace(/[\r\n]+/gu, ' ')
  return flat.startsWith('"') || flat !== flat.trim() ? `"${flat.replace(/["\\]/gu, '\\$&')}"` : flat
}

/** 顶层键（不缩进）的值；没有该键返回 null。 */
export function frontField(front: readonly string[], key: string): string | null {
  const prefix = `${key}: `
  const line = front.find((item) => item.startsWith(prefix))
  return line === undefined ? null : readScalar(line.slice(prefix.length))
}

/** 改写顶层键；原来没有就追加在末尾。 */
export function withFrontField(front: readonly string[], key: string, value: string): string[] {
  const prefix = `${key}: `
  const next = `${prefix}${writeScalar(value)}`
  const index = front.findIndex((item) => item.startsWith(prefix))
  return index < 0 ? [...front, next] : front.map((item, at) => (at === index ? next : item))
}

/** state / styling 的块标题是三级，其余二级（kernel `categoryHeadingLevel`）。 */
export function headingLevel(category: TemplateCategory): 2 | 3 {
  return category === 'state' || category === 'styling' ? 3 : 2
}

const HEADING = /^(#{2,3}) (.*)$/u

/** 正文第一个非空行若是块标题：把级别对齐到分类，并把其中的旧名称换成新名称（正文标题与名称一致）。 */
export function alignHeading(body: string, level: 2 | 3, oldTitle: string, newTitle: string): string {
  const lines = body.split('\n')
  const first = lines.findIndex((line) => line.trim() !== '')
  const match = first < 0 ? null : HEADING.exec(lines[first] ?? '')
  if (match === null) return body
  const text = match[2] ?? ''
  const renamed = oldTitle !== '' && oldTitle !== newTitle && text.includes(oldTitle) ? text.split(oldTitle).join(newTitle) : text
  lines[first] = `${'#'.repeat(level)} ${renamed}`
  return lines.join('\n')
}

/**
 * 按表单字段重写整份模板：id / title / category 三行，正文标题随名称与分类对齐。
 * frontmatter 不可解析时原样返回，让服务端给出具体错误。
 */
export function rewriteTemplate(
  text: string,
  next: { readonly id?: string; readonly title?: string; readonly category?: TemplateCategory; readonly body?: string },
): string {
  const parts = splitTemplate(text)
  if (parts === null) return text
  const oldTitle = frontField(parts.front, 'title') ?? ''
  let front = [...parts.front]
  if (next.id !== undefined) front = withFrontField(front, 'id', next.id)
  if (next.title !== undefined) front = withFrontField(front, 'title', next.title)
  if (next.category !== undefined) front = withFrontField(front, 'category', next.category)
  const body = next.body ?? parts.body
  const stored = frontField(front, 'category')
  const category = next.category ?? TEMPLATE_CATEGORIES.find((value) => value === stored) ?? 'common'
  const aligned = next.category === undefined && next.title === undefined
    ? body
    : alignHeading(body, headingLevel(category), oldTitle, next.title ?? oldTitle)
  return joinTemplate({ front, body: aligned })
}

/** 副本标识：`<id>-copy`，已占用则 `<id>-copy-2`、`-3`…；不超过模板标识的 64 字符上限。 */
export function uniqueCopyId(id: string, taken: ReadonlySet<string>, max = 64): string {
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '-copy' : `-copy-${n}`
    const candidate = `${id.slice(0, max - suffix.length).replace(/-+$/u, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** 副本名称：`<名称> 副本`，已占用则 `<名称> 副本 2`、`3`…（后缀随界面语言）。 */
export function uniqueCopyTitle(title: string, suffix: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${title} ${suffix}` : `${title} ${suffix} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}
