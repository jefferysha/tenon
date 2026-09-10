import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { fetchDocument, type DocumentRead } from '../api/documentsClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import { isMarkdownPath, Markdown } from '../shared/Markdown'
import { fileName } from './stageIo'

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; doc: DocumentRead }
  | { status: 'error'; detail: string }

export interface DocumentDrawerProps {
  root: string
  files: readonly { path: string; label: string }[]
  /** 当前打开的文件在 files 里的序号；null = 关闭。 */
  index: number | null
  onIndex: (index: number) => void
  onClose: () => void
}

/** 右侧抽屉：读一份阶段文件；Markdown 标准渲染，其余等宽纯文本；可切上一份 / 下一份。 */
export function DocumentDrawer({ root, files, index, onIndex, onClose }: DocumentDrawerProps): JSX.Element | null {
  const { t } = useT()
  const file = index === null ? undefined : files[index]
  const [preview, setPreview] = useState<{ path: string; state: PreviewState }>({ path: '', state: { status: 'loading' } })

  useEffect(() => {
    if (!file) return
    const controller = new AbortController()
    const path = file.path
    setPreview({ path, state: { status: 'loading' } })
    fetchDocument(root, path, controller.signal)
      .then((doc) => setPreview({ path, state: { status: 'ready', doc } }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setPreview({ path, state: { status: 'error', detail: formatApiError(error, t, { exposeServerDetail: true }) } })
      })
    return () => controller.abort()
  }, [file, root, t])

  if (!file || index === null) return null
  const state: PreviewState = preview.path === file.path ? preview.state : { status: 'loading' }
  const NAV = 'grid size-8 place-items-center rounded-sm text-text-2 hover:bg-fill hover:text-text disabled:opacity-40'
  return (
    <Drawer
      open
      onClose={onClose}
      ariaLabel={fileName(file.path)}
      testId="document-drawer"
      title={(
        <>
          <span className="block truncate font-mono text-base font-semibold text-text" data-testid="document-drawer-title">{fileName(file.path)}</span>
          <span className="block truncate font-mono text-caption text-text-3">{file.path}{state.status === 'ready' ? ` · ${t('workspace.bytes', { n: state.doc.bytes })}` : ''}</span>
        </>
      )}
      actions={(
        <span className="flex flex-none items-center gap-1">
          <button type="button" className={NAV} aria-label={t('workspace.drawer_prev')} data-testid="document-drawer-prev" disabled={index <= 0} onClick={() => onIndex(index - 1)}><ChevronLeft className="size-4" aria-hidden="true" /></button>
          <span className="font-mono text-caption text-text-3">{index + 1}/{files.length}</span>
          <button type="button" className={NAV} aria-label={t('workspace.drawer_next')} data-testid="document-drawer-next" disabled={index >= files.length - 1} onClick={() => onIndex(index + 1)}><ChevronRight className="size-4" aria-hidden="true" /></button>
        </span>
      )}
    >
      {state.status === 'loading' && <p className="text-body text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>}
      {state.status === 'error' && <p className="text-body text-red-d" role="alert" data-testid="document-drawer-error">{state.detail}</p>}
      {state.status === 'ready' && (isMarkdownPath(file.path)
        ? <Markdown text={state.doc.text} testId="file-preview-markdown" />
        : <pre className="m-0 whitespace-pre-wrap font-mono text-body leading-6 text-text [overflow-wrap:anywhere]" data-testid="file-preview-text">{state.doc.text}</pre>)}
    </Drawer>
  )
}
