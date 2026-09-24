import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import { fetchSkillFile, fetchSkillFiles } from '../api/client'
import type { WbSkillFiles } from '../api/governanceTypes'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import { isMarkdownPath, Markdown } from '../shared/Markdown'
import { SkillSourceIcon } from './SkillSourceIcon'
import { cn } from '@/lib/utils'

/** SKILL.md 的 YAML 头（name / description / metadata）不是正文：正文渲染前剥掉，头部单列。 */
export function splitFrontmatter(markdown: string): { meta: Array<[string, string]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (match === null) return { meta: [], body: stripHtmlComments(markdown) }
  const meta = (match[1] ?? '').split('\n')
    .map((line) => /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line))
    .filter((hit): hit is RegExpExecArray => hit !== null && hit[2] !== undefined && hit[2].trim() !== '')
    .map((hit) => [hit[1] ?? '', (hit[2] ?? '').trim().replace(/^['"]|['"]$/g, '')] as [string, string])
  return { meta, body: stripHtmlComments(markdown.slice(match[0].length)).replace(/^\s+/, '') }
}

/** react-markdown 不渲染原始 HTML，注释会以字面文本露出：生成区标记这类注释直接剥掉。 */
function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->\n?/g, '')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

type FilesState = { kind: 'loading' } | { kind: 'ready'; files: WbSkillFiles } | { kind: 'error'; detail: string }
type FileState = { kind: 'loading' } | { kind: 'ready'; path: string; text: string } | { kind: 'error'; detail: string }

export interface SkillDetailProps {
  name: string
  /** split = 左树右文（宽抽屉）；stacked = 文件横排芯片在上、正文在下（浮层右栏这类窄容器）。 */
  layout?: 'split' | 'stacked'
}

/**
 * 技能详情：来源 + 目录内全部文件（左树）+ 选中文件（右文，.md 用 Markdown 渲染，其它纯文本）。
 * 默认选中 SKILL.md。
 */
export function SkillDetail({ name, layout = 'split' }: SkillDetailProps): JSX.Element {
  const { t } = useT()
  const [files, setFiles] = useState<FilesState>({ kind: 'loading' })
  const [selected, setSelected] = useState<string>('SKILL.md')
  const [file, setFile] = useState<FileState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setFiles({ kind: 'loading' })
    setSelected('SKILL.md')
    fetchSkillFiles(name)
      .then((body) => { if (!cancelled) setFiles({ kind: 'ready', files: body }) })
      .catch((error: unknown) => { if (!cancelled) setFiles({ kind: 'error', detail: formatApiError(error, t) }) })
    return () => { cancelled = true }
  }, [name, t])

  useEffect(() => {
    if (files.kind !== 'ready') return
    let cancelled = false
    setFile({ kind: 'loading' })
    fetchSkillFile(name, selected)
      .then((body) => { if (!cancelled) setFile({ kind: 'ready', path: body.path, text: body.text }) })
      .catch((error: unknown) => { if (!cancelled) setFile({ kind: 'error', detail: formatApiError(error, t) }) })
    return () => { cancelled = true }
  }, [name, selected, files.kind, t])

  if (files.kind === 'loading') return <p className="text-body text-text-3" role="status">{t('workflow.preview_loading')}</p>
  if (files.kind === 'error') return <p className="text-body text-red-d" role="alert">{t('workflow.preview_failed')} · {files.detail}</p>

  const parsed = file.kind === 'ready' && isMarkdownPath(file.path) ? splitFrontmatter(file.text) : null
  const stacked = layout === 'stacked'
  return (
    <div className={cn('h-full min-h-0 gap-5', stacked ? 'flex flex-col' : 'grid grid-cols-[minmax(11rem,14rem)_minmax(0,1fr)] max-[900px]:grid-cols-1')} data-testid="skill-detail" data-layout={layout}>
      <aside className={cn('min-h-0', stacked ? 'flex-none' : 'overflow-y-auto')}>
        <p className="mb-3 flex items-center gap-2 text-caption text-text-2" data-testid="skill-detail-origin">
          <SkillSourceIcon source={files.files.source} />
          <span className="truncate font-mono">{files.files.origin}</span>
        </p>
        <ul className={cn(stacked ? 'flex flex-wrap gap-1' : 'grid gap-0.5')} aria-label={t('workflow.skill_files')} data-testid="skill-detail-files">
          {files.files.files.map((entry) => {
            const active = entry.path === selected
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  className={cn('grid items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)', stacked ? 'grid-cols-[auto_minmax(0,1fr)] border border-border bg-card' : 'w-full grid-cols-[auto_minmax(0,1fr)_auto]', active && 'border-accent-b bg-accent-t text-(--accent)')}
                  aria-current={active ? 'true' : undefined}
                  data-testid={`skill-file-${entry.path}`}
                  onClick={() => setSelected(entry.path)}
                >
                  <FileText className="size-3.5 flex-none text-text-3" aria-hidden="true" />
                  <span className="truncate font-mono text-caption">{entry.path}</span>
                  {!stacked && <span className="font-mono text-micro text-text-3">{formatBytes(entry.bytes)}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </aside>
      <section className={cn('min-h-0 min-w-0 overflow-y-auto', stacked && 'flex-1')} aria-label={selected} data-testid="skill-detail-content">
        {file.kind === 'loading' ? (
          <p className="text-body text-text-3" role="status">{t('workflow.preview_loading')}</p>
        ) : file.kind === 'error' ? (
          <p className="text-body text-red-d" role="alert">{t('workflow.preview_failed')} · {file.detail}</p>
        ) : parsed !== null ? (
          <>
            {parsed.meta.length > 0 && (
              <dl className="mb-5 grid gap-1.5 rounded-md border border-border bg-bg px-4 py-3 text-caption" data-testid="skill-detail-meta">
                {parsed.meta.map(([key, value]) => (
                  <div key={key} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 max-[1400px]:grid-cols-1 max-[1400px]:gap-0.5">
                    <dt className="font-mono text-text-3">{key}</dt>
                    <dd className="text-text-2 [overflow-wrap:anywhere]">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <Markdown text={parsed.body} testId="skill-detail-markdown" density="compact" />
          </>
        ) : (
          <pre className="overflow-x-auto rounded-sm border border-code-border bg-code-bg p-3 font-mono text-caption leading-5 text-text" data-testid="skill-detail-text">{file.text}</pre>
        )}
      </section>
    </div>
  )
}

/** 右侧宽抽屉里的技能详情；`name === null` 时不渲染。 */
export function SkillDetailDrawer({ name, onClose }: { name: string | null; onClose: () => void }): JSX.Element {
  const { t } = useT()
  return (
    <Drawer open={name !== null} onClose={onClose} width="lg" title={<span className="font-mono">{name ?? ''}</span>} ariaLabel={t('workflow.preview_skill', { id: name ?? '' })} testId="skill-preview">
      {name !== null && <SkillDetail name={name} />}
    </Drawer>
  )
}
