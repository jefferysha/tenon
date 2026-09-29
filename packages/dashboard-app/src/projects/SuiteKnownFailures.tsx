import { useT } from '../i18n'
import type { KnownFailuresView } from '../api/testSystemTypes'
import { StatusPill } from '../shell/ThreeColumns'
import { TestSection } from '../tests/TestSection'
import { TABLE_HEAD, TABLE_ROW, gridRow } from '../tests/testStyles'

const COLUMNS = 'grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1fr)_7rem]'

/** 只有 http(s) 链接才做成可点的锚点；其它一律当纯文本，不生成 javascript: 之类的目标。 */
export function isSafeLink(link: string): boolean {
  return /^https?:\/\/\S+$/u.test(link)
}

/** 已知失败：本套件的清单条目（用例 · 原因 · 链接 · 到期）；清单解析失败给一行错误，没有条目就整段不出现。 */
export function SuiteKnownFailures({ suite, view }: { suite: string; view: KnownFailuresView }): JSX.Element | null {
  const { t } = useT()
  if (view.state === 'missing') return null
  if (view.state === 'invalid') {
    return (
      <TestSection title={t('tests.word.known')} testId="proj-known">
        <p className="truncate whitespace-nowrap text-body text-red-d" role="alert" title={view.issues.join('\n')} data-testid="proj-known-invalid">
          {t('tests.project.known.invalid')}
        </p>
      </TestSection>
    )
  }
  const entries = view.entries.filter((entry) => entry.suite === suite)
  if (entries.length === 0) return null
  return (
    <TestSection title={t('tests.word.known')} count={entries.length} testId="proj-known">
      <div role="table" aria-label={t('tests.word.known')}>
        <div className={`${gridRow(COLUMNS)} ${TABLE_HEAD}`} role="row">
          <span role="columnheader">{t('tests.project.known.test')}</span>
          <span role="columnheader">{t('tests.project.known.reason')}</span>
          <span role="columnheader">{t('tests.project.known.link')}</span>
          <span role="columnheader">{t('tests.project.known.expires')}</span>
        </div>
        {entries.map((entry) => (
          <div key={entry.test} className={`${gridRow(COLUMNS)} ${TABLE_ROW}`} role="row" data-testid={`proj-known-${entry.test}`} data-expired={entry.expired}>
            <span className="truncate font-mono text-caption text-text" role="cell" title={entry.test}>{entry.test}</span>
            <span className="truncate text-text-2" role="cell" title={entry.reason}>{entry.reason}</span>
            <span className="truncate" role="cell">
              {entry.link === undefined
                ? <span className="text-text-3">—</span>
                : isSafeLink(entry.link)
                  ? <a className="text-(--accent) underline" href={entry.link} target="_blank" rel="noopener noreferrer" title={entry.link}>{entry.link}</a>
                  : <span className="font-mono text-caption text-text-2" title={entry.link}>{entry.link}</span>}
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap" role="cell">
              {entry.expired
                ? <StatusPill tone="blocked" testId={`proj-known-expired-${entry.test}`}>{t('tests.project.known.expired')}</StatusPill>
                : <span className="font-mono text-caption text-text-2">{entry.expires}</span>}
            </span>
          </div>
        ))}
      </div>
    </TestSection>
  )
}
