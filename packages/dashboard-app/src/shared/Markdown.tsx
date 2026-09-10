import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const MD_CLS = [
  'text-base leading-7 text-text [overflow-wrap:anywhere]',
  '[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-page [&_h1]:font-bold [&_h1]:tracking-[-.01em]',
  '[&_h2]:mt-6 [&_h2]:mb-2.5 [&_h2]:text-section [&_h2]:font-bold',
  '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-title [&_h3]:font-semibold',
  '[&_h4]:mt-4 [&_h4]:mb-1.5 [&_h4]:text-base [&_h4]:font-semibold',
  '[&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1',
  '[&_a]:text-(--accent) [&_a]:underline [&_strong]:font-semibold',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-text-2',
  '[&_code]:rounded-xs [&_code]:bg-code-bg [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-body',
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-code-bg [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_table]:my-4 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-fill [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5',
  '[&_hr]:my-6 [&_hr]:border-border [&_input[type=checkbox]]:mr-2',
].join(' ')

/** 标准 GFM 渲染；不输出原始 HTML（react-markdown 缺省即如此），故无需额外净化。 */
export function Markdown({ text, testId }: { text: string; testId?: string }): JSX.Element {
  return (
    <div className={MD_CLS} data-testid={testId}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}
