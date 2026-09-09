import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../i18n'
import type { ChangeSnapshot } from '../types'

export interface TaskDocumentsSectionProps {
  documents: NonNullable<ChangeSnapshot['documents']>
  extra?: ReactNode
}

export function TaskDocumentsSection({
  documents,
  extra,
}: TaskDocumentsSectionProps): JSX.Element {
  const { t, lang } = useT()
  return (
    <div className="border-b border-border py-3 last:border-b-0" data-testid="dt-documents">
      <div className="mb-2.5 flex items-baseline gap-2 text-caption font-bold text-text">
        {t('detail.docs_heading')}
        <span className="text-caption font-normal text-text-3">
          {documents.pass === true ? t('detail.docs_complete') : t('detail.docs_incomplete')}
        </span>
      </div>
      {documents.items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="dt-documents-items">
          {documents.items.map((item) => (
            <li
              className={`rounded-sm border px-2 py-1.5 text-caption [overflow-wrap:anywhere] ${
                item.status === 'recorded' ? 'border-green-b bg-green-t text-green-d' : 'border-red-b bg-red-t text-red-d'
              }`}
              data-status={item.status}
              data-testid={`dt-document-${item.kind}`}
              key={item.kind}
            >
              <b>{item.kind}</b> · {item.status === 'recorded'
                ? t('detail.docs_recorded')
                : item.status === 'missing'
                  ? t('detail.docs_missing')
                  : item.status === 'stale'
                    ? t('detail.docs_stale')
                    : t('detail.docs_unread')}
              {item.requiredRead && <span className="text-text-3"> · {t('detail.docs_read_required')}</span>}
              {item.paths.length > 0 && <span className="font-mono text-micro text-text-2"> · {item.paths.join(', ')}</span>}
              {item.timeline === undefined && (
                <span className="text-text-3"> · {t('detail.docs_timeline_unavailable')}</span>
              )}
              {item.timeline !== undefined && item.timeline.length > 0 && (
                <details className="mt-1.5 text-text-2"><summary className="cursor-pointer">{t('detail.docs_timeline')}</summary>{item.timeline.map((entry) => <div key={`${entry.producer}-${entry.recordedAt}`}>{entry.producer} · {entry.recordedAt}{entry.readAt === undefined ? ` · ${t('detail.docs_unread')}` : ` → ${entry.readAt}`}</div>)}</details>
              )}
            </li>
          ))}
        </ul>
      )}
      {documents.blockers.length > 0 && (
        <ul className="mt-2 mb-0 flex list-none flex-col gap-1 pl-0 text-caption text-red-d" data-testid="dt-document-blockers">
          {documents.blockers.map((blocker) => <li className="flex items-start gap-1.5" key={blocker}><X className="mt-0.5 size-3 flex-none" strokeWidth={1.75} aria-hidden="true" />{lang === 'zh' ? blocker : t('detail.docs_blocker')}</li>)}
        </ul>
      )}
      {documents.items.length === 0 && documents.blockers.length === 0 && (
        <p className="m-0 text-caption text-text-3" role="status" aria-live="polite">{t('detail.docs_empty')}</p>
      )}
      {extra !== undefined && (
        <div className="mt-3 border-t border-border pt-3">
          {extra}
        </div>
      )}
    </div>
  )
}
