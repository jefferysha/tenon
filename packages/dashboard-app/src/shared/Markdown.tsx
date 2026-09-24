import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 两种密度：正文限 72ch 行长；行内代码为所在文字的 0.9em（不低于 13px）、左右 5px；代码块里的 code 沿用 pre 字号。
 * 两种密度共用：表格里的行内代码不断行（表格本身 block + overflow-x-auto，宽了就横向滚动）；
 * 带复选框的任务项去掉列表圆点，只留复选框一个标记。
 */
const TABLE_AND_TASKS = [
  '[&_td_code]:whitespace-nowrap [&_th_code]:whitespace-nowrap',
  '[&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:pl-1 [&_li.task-list-item]:list-none',
].join(' ')

const MD_CLS = [
  'max-w-[72ch] text-base leading-7 text-text [overflow-wrap:anywhere]',
  '[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-page [&_h1]:font-bold',
  '[&_h2]:mt-6 [&_h2]:mb-2.5 [&_h2]:text-section [&_h2]:font-semibold',
  '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-title [&_h3]:font-semibold',
  '[&_h4]:mt-4 [&_h4]:mb-1.5 [&_h4]:text-base [&_h4]:font-semibold',
  '[&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1',
  '[&_a]:text-(--accent) [&_a]:underline [&_strong]:font-semibold',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-text-2',
  '[&_code]:rounded-xs [&_code]:bg-code-bg [&_code]:px-[5px] [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[length:max(.9em,13px)]',
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-code-bg [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:[font-size:inherit]',
  '[&_table]:my-4 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-fill [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5',
  '[&_hr]:my-6 [&_hr]:border-border [&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:accent-(--accent)',
  TABLE_AND_TASKS,
].join(' ')

/** 窄栏（技能详情）密度：标题降两档、正文 13px、段距收紧，读起来像文档而不是页面。 */
const COMPACT_CLS = [
  'max-w-[72ch] text-body leading-6 text-text [overflow-wrap:anywhere]',
  '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-section [&_h1]:font-semibold [&_h1]:[text-wrap:balance]',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1.5 [&_h2]:text-title [&_h2]:font-semibold',
  '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-body [&_h4]:font-semibold [&_h4]:text-text-2',
  '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_li>p]:my-1',
  '[&_a]:text-(--accent) [&_a]:underline [&_strong]:font-semibold',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-accent-b [&_blockquote]:bg-accent-t/40 [&_blockquote]:px-3 [&_blockquote]:py-1.5 [&_blockquote]:text-text-2',
  '[&_code]:rounded-xs [&_code]:bg-code-bg [&_code]:px-[5px] [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[length:max(.9em,13px)]',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:border [&_pre]:border-code-border [&_pre]:bg-code-bg [&_pre]:p-3 [&_pre]:text-caption [&_pre]:leading-5 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:[font-size:inherit]',
  '[&_table]:my-3 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-caption [&_th]:border [&_th]:border-border [&_th]:bg-fill [&_th]:px-2.5 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1',
  '[&_hr]:my-4 [&_hr]:border-border [&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:accent-(--accent)',
  TABLE_AND_TASKS,
].join(' ')

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u

/**
 * 去掉开头的 YAML frontmatter（`---` … `---`）。它是元数据不是正文：交给 Markdown 渲染会变成一段文字，
 * 或被 setext 规则读成一大段粗体标题。没有闭合行的 `---` 不是 frontmatter，原样保留。
 */
export function stripFrontmatter(text: string): string {
  const match = FRONTMATTER.exec(text)
  return match === null ? text : text.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/u, '')
}

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

const HTML_COMMENT = /^\s*<!--[\s\S]*?-->\s*$/u

/**
 * 剥掉 HTML 注释节点（`<!-- create-rule:start -->` 这类生成区标记）。react-markdown 不渲染原始 HTML，
 * 注释会以字面文本露出。按语法树删而不是按正则改原文：代码块里的 `<!-- -->` 是 code 节点，不受影响。
 */
function removeHtmlComments(node: MdNode): void {
  if (node.children === undefined) return
  node.children = node.children.filter((child) => !(child.type === 'html' && HTML_COMMENT.test(child.value ?? '')))
  for (const child of node.children) removeHtmlComments(child)
}

export function remarkStripHtmlComments(): (tree: MdNode) => void {
  return removeHtmlComments
}

/** 标准 GFM 渲染；不输出原始 HTML（react-markdown 缺省即如此），HTML 注释整段不渲染。开头的 frontmatter 不渲染。 */
export function Markdown({ text, testId, density = 'default' }: { text: string; testId?: string; density?: 'default' | 'compact' }): JSX.Element {
  return (
    <div className={density === 'compact' ? COMPACT_CLS : MD_CLS} data-testid={testId} data-density={density}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripHtmlComments]}>{stripFrontmatter(text)}</ReactMarkdown>
    </div>
  )
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}
