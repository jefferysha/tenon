/**
 * 模板文件（固定行 frontmatter + Markdown 正文）的纯文本改写：表单只改 id / title / category / frameworks 四行与正文，
 * 其余 frontmatter 行（directory、catalog、variables…）原样保留。语法与 kernel `instructions/block.ts` 一致。
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

/** 顶层 `[a, b]` 列表键的值；没有该键或不是列表返回空数组。 */
export function frontList(front: readonly string[], key: string): string[] {
  const raw = frontField(front, key)
  if (raw === null || !raw.startsWith('[') || !raw.endsWith(']')) return []
  return raw.slice(1, -1).split(',').map((item) => item.trim()).filter((item) => item !== '')
}

/** 改写 `[a, b]` 列表键；空列表删掉整行（kernel 对不适用 frameworks 的分类连空列表也拒绝）。 */
export function withFrontList(front: readonly string[], key: string, values: readonly string[]): string[] {
  if (values.length > 0) return withFrontField(front, key, `[${values.join(', ')}]`)
  const prefix = `${key}:`
  return front.filter((item) => !item.startsWith(prefix))
}

/** 只有前端、状态管理、样式块有「适用框架」；状态管理与样式块必须声明。 */
export const FRAMEWORK_CATEGORIES: readonly TemplateCategory[] = ['frontend', 'state', 'styling']
export const hasFrameworks = (category: TemplateCategory): boolean => FRAMEWORK_CATEGORIES.includes(category)
export const requiresFrameworks = (category: TemplateCategory): boolean => category === 'state' || category === 'styling'

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
 * 按表单字段重写整份模板：id / title / category / frameworks 四行，正文标题随名称与分类对齐。
 * frontmatter 不可解析时原样返回，让服务端给出具体错误。
 */
export function rewriteTemplate(
  text: string,
  next: {
    readonly id?: string; readonly title?: string; readonly category?: TemplateCategory
    readonly frameworks?: readonly string[]; readonly body?: string
  },
): string {
  const parts = splitTemplate(text)
  if (parts === null) return text
  const oldTitle = frontField(parts.front, 'title') ?? ''
  let front = [...parts.front]
  if (next.id !== undefined) front = withFrontField(front, 'id', next.id)
  if (next.title !== undefined) front = withFrontField(front, 'title', next.title)
  if (next.category !== undefined) front = withFrontField(front, 'category', next.category)
  if (next.frameworks !== undefined) front = withFrontList(front, 'frameworks', next.frameworks)
  const body = next.body ?? parts.body
  const stored = frontField(front, 'category')
  const category = next.category ?? TEMPLATE_CATEGORIES.find((value) => value === stored) ?? 'common'
  const aligned = next.category === undefined && next.title === undefined
    ? body
    : alignHeading(body, headingLevel(category), oldTitle, next.title ?? oldTitle)
  return joinTemplate({ front, body: aligned })
}

/** 新建模板的整份文本：id / category / title / frameworks + 正文（标题级别对齐分类）。 */
export function newTemplateText(fields: {
  readonly id: string; readonly title: string; readonly category: TemplateCategory
  readonly frameworks: readonly string[]; readonly body: string
}): string {
  const front = withFrontList([`id: ${fields.id}`, `category: ${fields.category}`, `title: ${writeScalar(fields.title)}`], 'frameworks', fields.frameworks)
  const body = alignHeading(fields.body, headingLevel(fields.category), '', '')
  return joinTemplate({ front, body: body.endsWith('\n') ? body : `${body}\n` })
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
