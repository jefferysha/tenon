import type { WbAutomationSettings } from '../api/client'
import { useT } from '../i18n'

/** 并发上限下拉：写回完整 automation 配置（宿主负责乐观值与回滚）；settings 未加载时显示加载态。 */
export function ConcurrencyField({
  settings,
  busy,
  onChange,
}: {
  settings: WbAutomationSettings | null
  busy: boolean
  onChange: (next: number) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <section data-testid="afk-concurrency">
      <h2 className="mb-3.5 text-section font-bold text-text">{t('automation.concurrency_title')}</h2>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
        <span className="min-w-0">
          <span className="block text-body font-semibold text-text">{t('afk.concurrency_label')}</span>
          <span className="block text-caption text-text-2">{t('automation.concurrency_desc')}</span>
        </span>
        {settings === null ? (
          <span className="text-caption text-text-3" role="status">{t('common.loading')}</span>
        ) : (
          <select
            className="h-9 rounded-sm border border-border bg-card px-2 font-mono text-caption font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:opacity-50"
            aria-label={t('automation.concurrency_title')}
            data-testid="afk-limit-input"
            value={settings.max_parallel}
            disabled={busy}
            onChange={(event) => onChange(Number(event.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        )}
      </div>
    </section>
  )
}
