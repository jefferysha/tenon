import type { ChangeHistoryEntry } from '../api/client'
import { useT } from '../i18n'
import { shortTime } from '../model/time'
import { historyText } from './taskDetailParts'

export interface TaskHistorySectionProps {
  entries: ChangeHistoryEntry[] | null
}

export function TaskHistorySection({ entries }: TaskHistorySectionProps): JSX.Element {
  const { lang, t } = useT()
  const flowEntries = entries?.filter(
    (entry) => entry.kind === 'transition' || entry.kind === 'init' || entry.kind === 'import',
  ) ?? null
  return (
    <div className="border-b border-border py-3 last:border-b-0" data-testid="dt-hist-sec" data-settled={entries !== null ? 'true' : 'false'}>
      <div className="mb-2.5 flex items-baseline gap-2 text-caption font-bold text-text">
        {t('detail.history_heading')} <span className="text-caption font-normal text-text-3">{t('detail.hist_flow_hint')}</span>
      </div>
      {flowEntries !== null && (flowEntries.length === 0 ? (
        <p className="m-0 text-caption text-text-3" role="status" aria-live="polite">{t('detail.history_empty')}</p>
      ) : (
        <ol className="m-0 flex max-h-[180px] list-none flex-col gap-1 overflow-y-auto p-0" data-testid="dt-hist">
          {flowEntries.map((entry, index) => (
            <li className="flex items-baseline gap-2 text-caption" data-testid={`dt-hist-${index}`} key={`${entry.ts}-${index}`}>
              <span className="font-mono whitespace-nowrap text-text-3">{shortTime(entry.ts, lang)}</span>
              <span className="text-text-2 [overflow-wrap:anywhere]">{historyText(entry, t)}</span>
            </li>
          ))}
        </ol>
      ))}
    </div>
  )
}
