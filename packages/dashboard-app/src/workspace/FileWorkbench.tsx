import { useEffect, useMemo, useState } from 'react'
import { FileText } from 'lucide-react'
import { fetchDocument, type DocumentRead } from '../api/documentsClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import type { ChangeSnapshot } from '../types'
import type { WbStepDef } from '../workbench/workbenchDefinition'
import { SheetTabs, type SheetDef } from '../shared/DetailSheets'
import { changeDocuments, fileName, stageIo, type StageFile } from './stageFiles'
import type { WorkflowDefinitionState } from './useWorkflowDefinition'
import { cn } from '@/lib/utils'

type Direction = 'inputs' | 'outputs'
type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'ready'; doc: DocumentRead }
  | { status: 'error'; path: string; detail: string }

export interface FileWorkbenchProps {
  root: string
  change: ChangeSnapshot
  stageLabel: string
  step: WbStepDef | undefined
  definition: WorkflowDefinitionState
}

/**
 * 文件工作台（模板右列下半）：所选阶段的「输入 / 输出」文件列表 + 变更文档 + 点击即读的预览卡。
 * 只读：唯一请求是 GET /api/documents/read。
 */
export function FileWorkbench({ root, change, stageLabel, step, definition }: FileWorkbenchProps): JSX.Element {
  const { t } = useT()
  const [direction, setDirection] = useState<Direction>('outputs')
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' })
  const io = useMemo(() => stageIo(step, change), [step, change])
  // 变更文档里与本阶段输入 / 输出同路径的文件不重复列（同一份 plan.md 既是阶段输出也是治理文档）。
  const documents = useMemo(() => {
    const stagePaths = new Set([...io.inputs, ...io.outputs].map((file) => file.path).filter((path): path is string => path !== null))
    return changeDocuments(change).filter((doc) => doc.path === null || !stagePaths.has(doc.path))
  }, [change, io])
  const identity = `${root} ${change.name} ${step?.id ?? ''}`
  useEffect(() => { setPreview({ status: 'idle' }) }, [identity])

  const tabs: readonly SheetDef<Direction>[] = [
    { id: 'inputs', label: t('workspace.dir_inputs'), count: io.inputs.length },
    { id: 'outputs', label: t('workspace.dir_outputs'), count: io.outputs.length },
  ]
  const rows = direction === 'inputs' ? io.inputs : io.outputs
  const readable = rows.filter((row) => row.kind === 'file' && row.present).length
  const missing = rows.filter((row) => row.kind === 'file' && !row.present).length

  function open(path: string): void {
    const controller = new AbortController()
    setPreview({ status: 'loading', path })
    fetchDocument(root, path, controller.signal)
      .then((doc) => setPreview((current) => current.status === 'loading' && current.path === path ? { status: 'ready', doc } : current))
      .catch((error: unknown) => setPreview((current) => current.status === 'loading' && current.path === path
        ? { status: 'error', path, detail: formatApiError(error, t, { exposeServerDetail: true }) }
        : current))
  }
  const activePath = preview.status === 'idle' ? null : preview.status === 'ready' ? preview.doc.path : preview.path

  function fileRow(file: StageFile): JSX.Element {
    if (file.kind === 'value') {
      return (
        <li key={file.field} className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-4 py-3" data-testid={`stage-file-${file.field}`} data-kind="value">
          <span className="min-w-0">
            <span className="block font-mono text-body font-semibold text-text">{file.field}</span>
            <span className="block truncate font-mono text-caption text-text-2">{file.present ? file.value : t('evidence.unset')}</span>
          </span>
          <span className="text-body text-text-3">{t('workspace.file_value')}</span>
        </li>
      )
    }
    if (!file.present || file.path === null) {
      return (
        <li key={file.field} className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-4 py-3" data-testid={`stage-file-${file.field}`} data-state="missing">
          <span className="min-w-0">
            <span className="block font-mono text-body font-semibold text-text-2">{file.field}</span>
            <span className="block text-caption text-text-3">{t('workspace.file_missing_desc')}</span>
          </span>
          <span className="text-body text-red-d">{t('workspace.file_missing')}</span>
        </li>
      )
    }
    return fileButton(file.field, file.path, file.field, `stage-file-${file.field}`)
  }

  function fileButton(key: string, path: string, desc: string, testId: string): JSX.Element {
    const active = activePath === path
    return (
      <li key={key}>
        <button
          type="button"
          className={cn(
            'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border bg-card px-4 py-3 text-left outline-none hover:border-accent-b focus-visible:ring-2 focus-visible:ring-(--accent)',
            active ? 'border-accent-b bg-accent-t' : 'border-border',
          )}
          aria-pressed={active}
          data-testid={testId}
          data-state="readable"
          onClick={() => open(path)}
        >
          <FileText className="size-4 text-text-3" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate font-mono text-body font-semibold text-text">{fileName(path)}</span>
            <span className="block truncate text-caption text-text-2">{desc} · {path}</span>
          </span>
          <span className="text-body text-(--accent)">{t('workspace.file_readable')}</span>
        </button>
      </li>
    )
  }

  return (
    <section data-testid="file-workbench">
      <div className="mb-3.5 flex items-baseline justify-between gap-4">
        <h2 className="text-section font-bold text-text">{t('workspace.files_title', { stage: stageLabel })}</h2>
        <span className="text-body text-text-3">{t('workspace.files_meta', { readable, missing })}</span>
      </div>
      <SheetTabs sheets={tabs} active={direction} onChange={setDirection} ariaLabel={t('workspace.files_title', { stage: stageLabel })} idPrefix="file-direction" />
      <div className="pt-4" role="tabpanel" id="file-direction-panel" aria-labelledby={`file-direction-tab-${direction}`}>
        {definition.status === 'loading' ? (
          <p className="text-body text-text-3" role="status">{t('common.loading')}</p>
        ) : definition.status === 'error' ? (
          <p className="text-body text-red-d" role="alert">{t('workspace.definition_error')}</p>
        ) : rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-body text-text-3" role="status">
            {t(direction === 'inputs' ? 'workspace.no_inputs' : 'workspace.no_outputs')}
          </p>
        ) : (
          <ul className="grid gap-2" data-testid={`stage-files-${direction}`}>{rows.map(fileRow)}</ul>
        )}
      </div>

      {documents.length > 0 && (
        <div className="mt-6" data-testid="change-documents">
          <div className="mb-2.5 flex items-baseline justify-between gap-4">
            <span className="text-body text-text-2">{t('workspace.docs_title')}</span>
            <span className="text-caption text-text-3">{t('workspace.docs_meta', { recorded: documents.filter((doc) => doc.status === 'recorded').length, total: documents.length })}</span>
          </div>
          <ul className="grid gap-2">
            {documents.map((doc) => doc.path !== null
              ? fileButton(`doc-${doc.kind}`, doc.path, t(`workspace.doc_status_${doc.status}`), `change-doc-${doc.kind}`)
              : (
                <li key={`doc-${doc.kind}`} className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-4 py-3" data-testid={`change-doc-${doc.kind}`} data-state="missing">
                  <span className="font-mono text-body font-semibold text-text-2">{doc.kind}</span>
                  <span className="text-body text-red-d">{t('workspace.file_missing')}</span>
                </li>
              ))}
          </ul>
        </div>
      )}

      <article className="mt-5 overflow-hidden rounded-lg border border-border bg-card" data-testid="file-preview" data-status={preview.status}>
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span className="truncate font-mono text-body font-semibold text-text">
            {activePath === null ? t('workspace.preview_title') : fileName(activePath)}
          </span>
          <span className={cn('text-body', preview.status === 'error' ? 'text-red-d' : 'text-text-3')}>
            {preview.status === 'ready' ? t('workspace.preview_bytes', { n: preview.doc.bytes }) : preview.status === 'loading' ? t('common.loading') : preview.status === 'error' ? t('workspace.preview_failed') : ''}
          </span>
        </header>
        <div className="px-5 py-5">
          {preview.status === 'idle' && <p className="text-body text-text-3">{t('workspace.preview_pick')}</p>}
          {preview.status === 'loading' && <p className="text-body text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>}
          {preview.status === 'error' && <p className="text-body text-red-d" role="alert">{preview.detail}</p>}
          {preview.status === 'ready' && (
            <pre className="m-0 max-h-[60vh] overflow-auto whitespace-pre-wrap font-mono text-body leading-6 text-text [overflow-wrap:anywhere]" data-testid="file-preview-text">{preview.doc.text}</pre>
          )}
        </div>
      </article>
    </section>
  )
}
