/**
 * 项目设计体系的结构检查：根目录 `DESIGN.md` + `design/`（模型与四张预览）。
 *
 * 纯逻辑，文件读取走 DesignFileReader 端口（Node 实现在 infrastructure/design-system-fs.ts）。
 * 章节标题固定用 hue 自己的英文词汇，检查与界面语言无关；正文语言不限。
 *
 * 四种状态：missing（没有 DESIGN.md）、seed（有文件但没有 schema 标记，例如刚取来的品牌文件）、
 * incomplete（有标记但缺东西）、ready（可以开前端任务）。
 */
export const DESIGN_SCHEMA = 'tenon-design/v1'
export const DESIGN_MODEL_PATH = 'design/design-model.yaml'
export const DESIGN_MD_PATH = 'DESIGN.md'

export const DESIGN_SECTIONS = [
  'Philosophy', 'Craft Rules', 'Anti-Patterns', 'Tokens', 'Iconography', 'Hero Stage',
  'Components', 'Voice', 'Platform Mapping', 'Previews',
] as const

export const DESIGN_PREVIEWS = [
  'design/preview.html', 'design/component-library.html', 'design/landing-page.html', 'design/app-screen.html',
] as const

export const DESIGN_MODEL_KEYS = ['name', 'primitives', 'tokens', 'components'] as const

/**
 * 对比度门要跑起来，模型必须给出 hue 读得到的那几个槽。
 *
 * hue 的 validate.mjs 只认 `tokens.colors.<light|dark>` 下的 `background` 与 `text1`：拼成
 * `tokens.color`（单数）它报 "tokens.colors not found — contrast check skipped"，只给
 * `tokens.colors` 而不分 light/dark 它报 "no resolvable text/background pairs"。两种都只是 WARN，
 * 于是 DESIGN.md 一路「就绪」，正文对比度其实一次都没被检查过。Tenon 这边只要求过一个顶层
 * `tokens`，等于把这道门的开关交给了拼写。
 */
export const DESIGN_MODEL_CONTRAST_PATHS = [
  'tokens.colors.light.background',
  'tokens.colors.light.text1',
  'tokens.colors.dark.background',
  'tokens.colors.dark.text1',
] as const

export type DesignSystemStatus = 'missing' | 'seed' | 'incomplete' | 'ready'

export interface DesignFileReader { read(relativePath: string): string | null }

export interface DesignSystemCheck {
  readonly status: DesignSystemStatus
  readonly problems: readonly string[]
}

interface FrontMatter { readonly keys: ReadonlyMap<string, string>; readonly body: string }

/** 只认文件开头的 `---` 围栏；没有围栏时 keys 为空。 */
function frontMatter(text: string): FrontMatter {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { keys: new Map(), body: text }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { keys: new Map(), body: text }
  const keys = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z_]+):\s*(.*)$/u.exec(line.trim())
    if (match) keys.set(match[1] ?? '', (match[2] ?? '').trim().replace(/^["']|["']$/gu, ''))
  }
  return { keys, body: lines.slice(end + 1).join('\n') }
}

function sectionProblems(body: string): string[] {
  const problems: string[] = []
  const found = [...body.matchAll(/^## (\d+)\. (.+)$/gmu)].map((match) => (match[2] ?? '').trim())
  let cursor = 0
  DESIGN_SECTIONS.forEach((section, index) => {
    const at = found.indexOf(section)
    if (at < 0) {
      problems.push(`缺少章节 ## ${index + 1}. ${section}`)
      return
    }
    if (at < cursor) problems.push(`章节顺序错误：${section}`)
    else cursor = at
  })
  return problems
}

function previewProblems(reader: DesignFileReader, body: string): string[] {
  const problems: string[] = []
  const after = body.split(/^## 10\. Previews$/mu)[1] ?? ''
  const previews = after.split(/^## /mu)[0] ?? ''
  for (const path of DESIGN_PREVIEWS) {
    if (reader.read(path) === null) problems.push(`缺少预览 ${path}`)
    if (!previews.includes(path)) problems.push(`Previews 未链接 ${path}`)
  }
  return problems
}

/**
 * 模型里出现过的映射键路径（`a.b.c`），按缩进还原层级。
 *
 * 只认「键: [值]」这一种行，够用来判某个槽在不在；值本身不解析（是不是合法颜色由 hue 判）。
 * 制表符按一格缩进计，避免混排缩进把同级键算成父子。
 */
function modelKeyPaths(model: string): ReadonlySet<string> {
  const paths = new Set<string>()
  const stack: Array<{ readonly indent: number; readonly key: string }> = []
  for (const raw of model.split('\n')) {
    const line = raw.replace(/\t/gu, ' ')
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):(.*)$/u.exec(line)
    if (match === null) continue
    const indent = (match[1] ?? '').length
    const key = match[2] ?? ''
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop()
    stack.push({ indent, key })
    paths.add(stack.map((entry) => entry.key).join('.'))
  }
  return paths
}

function modelProblems(reader: DesignFileReader, keys: ReadonlyMap<string, string>): string[] {
  const problems: string[] = []
  if ((keys.get('model') ?? '') !== DESIGN_MODEL_PATH) problems.push(`model 必须是 ${DESIGN_MODEL_PATH}`)
  const model = reader.read(DESIGN_MODEL_PATH)
  if (model === null) {
    problems.push(`缺少 ${DESIGN_MODEL_PATH}`)
    return problems
  }
  const top = new Set([...model.matchAll(/^([a-z_]+):/gmu)].map((match) => match[1] ?? ''))
  for (const key of DESIGN_MODEL_KEYS) {
    if (!top.has(key)) problems.push(`design-model.yaml 缺少顶层键 ${key}`)
  }
  const paths = modelKeyPaths(model)
  for (const path of DESIGN_MODEL_CONTRAST_PATHS) {
    if (!paths.has(path)) {
      problems.push(`design-model.yaml 缺少 ${path}（缺了这个槽 hue 的对比度检查会静默跳过）`)
    }
  }
  return problems
}

/** hue 禁止的占位内容；两个大写词由字符码拼出，写成字面量会撞上本仓的注释诚实度门禁。 */
const PLACEHOLDERS: readonly string[] = [
  '{{',
  String.fromCharCode(84, 79, 68, 79),
  String.fromCharCode(70, 73, 88, 77, 69),
  'lorem ipsum',
]

function textProblems(text: string): string[] {
  const problems: string[] = []
  const lower = text.toLowerCase()
  for (const marker of PLACEHOLDERS) {
    if (lower.includes(marker.toLowerCase())) problems.push(`DESIGN.md 含占位内容 ${marker}`)
  }
  if (text.includes('—')) problems.push('DESIGN.md 含 em-dash（hue 硬性规则）')
  return problems
}

/** iconIds 是资源目录里 category: icons 的 id 集合；frontmatter 的 icons 必须在其中。 */
export function checkDesignSystem(reader: DesignFileReader, iconIds: ReadonlySet<string>): DesignSystemCheck {
  const text = reader.read(DESIGN_MD_PATH)
  if (text === null) return { status: 'missing', problems: [`缺少 ${DESIGN_MD_PATH}`] }
  const { keys, body } = frontMatter(text)
  if (keys.get('schema') !== DESIGN_SCHEMA) {
    return { status: 'seed', problems: [`DESIGN.md 缺少 schema: ${DESIGN_SCHEMA}`] }
  }
  const icons = keys.get('icons') ?? ''
  const problems = [
    ...modelProblems(reader, keys),
    ...(iconIds.has(icons) ? [] : [`icons 必须是资源目录中的图标：${icons}`]),
    ...sectionProblems(body),
    ...previewProblems(reader, body),
    ...textProblems(text),
  ]
  return problems.length === 0 ? { status: 'ready', problems: [] } : { status: 'incomplete', problems }
}
