import { AlertTriangle } from 'lucide-react'
import { useT } from '../i18n'
import type { CanonicalStateCompatibilityIssue, LegacyScopeCompatibilityIssue } from '../types'

const PRIMARY_ISSUE_LIMIT = 5

export interface CanonicalStateVersionNoticeProps {
  issues: readonly (CanonicalStateCompatibilityIssue | LegacyScopeCompatibilityIssue)[]
  truncated?: boolean
  loading: boolean
  onRefresh?: () => void | Promise<void>
}

export function CanonicalStateVersionNotice({
  issues,
  truncated = false,
  loading,
  onRefresh,
}: CanonicalStateVersionNoticeProps): JSX.Element | null {
  const { t } = useT()
  if (issues.length === 0) return null
  const primaryIssues = issues.slice(0, PRIMARY_ISSUE_LIMIT)
  const remainingIssues = issues.slice(PRIMARY_ISSUE_LIMIT)

  const issueRow = (issue: CanonicalStateCompatibilityIssue | LegacyScopeCompatibilityIssue): JSX.Element => (
    <li
      key={issue.change}
      className="grid gap-1 rounded-md border border-amber-b bg-card/75 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <code className="min-w-0 break-all text-caption font-semibold text-text">{issue.change}</code>
      <span className="text-caption font-medium">
        {issue.kind === 'legacy-scope-unmerged'
          ? t('progress.legacy_scope_values', { path: issue.legacyScopePath })
          : t('progress.canonical_version_values', { found: issue.foundVersion, supported: issue.supportedVersion })}
      </span>
    </li>
  )

  return (
    <section
      className="mt-5 rounded-md border border-amber-b bg-amber-t px-5 py-4 text-amber-d"
      data-testid="canonical-state-version-notice"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-none" strokeWidth={1.75} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div role="alert" aria-live="assertive">
              <h2 className="text-base font-bold text-text">{t('progress.canonical_version_title')}</h2>
              <p className="mt-1 text-body leading-6">
                {t('progress.canonical_version_summary', { count: issues.length })}
              </p>
            </div>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-amber-b bg-card px-3.5 py-2 text-body font-bold text-amber-d transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-wait disabled:opacity-60"
              disabled={loading || onRefresh === undefined}
              onClick={() => { void onRefresh?.() }}
            >
              {loading ? t('progress.canonical_version_refreshing') : t('progress.canonical_version_refresh')}
            </button>
          </div>
          <p className="mt-2 text-body leading-6">{t('progress.canonical_version_desc')}</p>
          <ol className="mt-3 space-y-2" aria-label={t('progress.canonical_version_list')} data-testid="canonical-state-version-primary-list">
            {primaryIssues.map(issueRow)}
          </ol>
          {remainingIssues.length > 0 && (
            <details className="mt-3 rounded-md border border-amber-b bg-card/50">
              <summary className="cursor-pointer px-3 py-2.5 text-caption font-bold outline-none focus-visible:ring-2 focus-visible:ring-(--accent)">
                {t('progress.canonical_version_more', { count: remainingIssues.length })}
              </summary>
              <ol className="space-y-2 px-3 pb-3" aria-label={t('progress.canonical_version_list')}>
                {remainingIssues.map(issueRow)}
              </ol>
            </details>
          )}
          {truncated && (
            <p className="mt-3 text-caption leading-5" data-testid="canonical-state-version-truncated">
              {t('progress.canonical_version_truncated')}
            </p>
          )}
          <p className="mt-3 text-caption leading-5">
            {t('progress.canonical_version_command')}{' '}
            <code className="rounded-xs bg-fill px-1.5 py-1 font-mono text-caption text-text">
              tenon update --codex
            </code>
          </p>
        </div>
      </div>
    </section>
  )
}
