import { useEffect, useMemo, useState } from 'react'
import { fetchSkillSources, type SkillSourceRow, type SkillSourcesDto } from '../api/skillSourcesClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { SheetTabs } from '../shared/DetailSheets'

type Filter = 'all' | 'changed' | 'failed'
type LoadState = { readonly kind: 'loading' } | { readonly kind: 'ok'; readonly view: SkillSourcesDto } | { readonly kind: 'error'; readonly detail: string }

const CELL = 'truncate whitespace-nowrap px-3 py-2'
const HEAD = `${CELL} sticky top-0 z-10 border-b border-border bg-card text-left font-semibold text-text-2`
const LINK = 'text-accent-d hover:underline'
const COLUMN_WIDTHS = ['w-[22%]', 'w-[26%]', 'w-[14%]', 'w-[10%]', 'w-[16%]', 'w-[12%]'] as const
const STATUS_TONE: Record<SkillSourceRow['status'], string> = {
  changed: 'text-amber-d', unchanged: 'text-text-2', failed: 'text-red-d', bundled: 'text-text-3',
}

function stamp(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : value.slice(0, 16).replace('T', ' ')
}

function short(commit: string): string {
  return commit.slice(0, 7)
}

function CommitCell({ row }: { readonly row: SkillSourceRow }): JSX.Element {
  if (row.commit === undefined) return <td className={`${CELL} text-text-3`}>—</td>
  const previous = row.status === 'changed' && typeof row.previousCommit === 'string' ? row.previousCommit : null
  if (previous !== null && row.compareUrl !== undefined) {
    const label = `${short(previous)}→${short(row.commit)}`
    return (
      <td className={`${CELL} font-mono`} title={`${previous}→${row.commit}`}>
        <a className={LINK} href={row.compareUrl} target="_blank" rel="noreferrer" data-testid={`skills-compare-${row.id}`}>{label}</a>
      </td>
    )
  }
  return (
    <td className={`${CELL} font-mono`} title={row.commit}>
      {row.commitUrl === undefined ? short(row.commit) : <a className={LINK} href={row.commitUrl} target="_blank" rel="noreferrer">{short(row.commit)}</a>}
    </td>
  )
}

/** 技能: every Tenon and upstream skill with source, commit, license, update time and status. Read-only. */
export function SkillsView(): JSX.Element {
  const { t } = useT()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    let active = true
    fetchSkillSources()
      .then((view) => { if (active) setState({ kind: 'ok', view }) })
      .catch((error: unknown) => { if (active) setState({ kind: 'error', detail: formatApiError(error, t, { exposeServerDetail: true }) }) })
    return () => { active = false }
  }, [t])

  const rows = state.kind === 'ok' ? state.view.rows : []
  const counts = useMemo(() => ({
    all: rows.length,
    changed: rows.filter((row) => row.status === 'changed').length,
    failed: rows.filter((row) => row.status === 'failed').length,
  }), [rows])
  const visible = filter === 'all' ? rows : rows.filter((row) => row.status === filter)

  const statusTitle = (row: SkillSourceRow): string => {
    if (row.status !== 'failed') return t(`skills.status_${row.status}`)
    const reason = row.reason === undefined ? t('skills.status_failed') : t(`skills.reason_${row.reason}`)
    return row.detail === undefined ? reason : `${reason} ${row.detail}`
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 px-6 py-4" data-testid="skills-view">
      {state.kind === 'error' ? (
        <p className="whitespace-nowrap text-body text-red-d" role="alert" data-testid="skills-load-error">
          {t('skills.load_error')}：{state.detail}
        </p>
      ) : null}
      {state.kind === 'ok' ? (
        <>
          <div className="flex items-end justify-between gap-6 whitespace-nowrap">
            <SheetTabs
              sheets={(['all', 'changed', 'failed'] as const).map((id) => ({ id, label: `${t(`skills.filter_${id}`)} ${counts[id]}` }))}
              active={filter}
              onChange={setFilter}
              ariaLabel={t('nav.skills')}
              idPrefix="skills-filter"
            />
            <span className="pb-3 text-caption text-text-3" data-testid="skills-updated">{t('skills.updated')} {stamp(state.view.updatedAt)}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-sm border border-border bg-card" id="skills-filter-panel" role="tabpanel">
            <table className="w-full table-fixed border-collapse text-caption">
              <colgroup>{COLUMN_WIDTHS.map((width) => <col key={width} className={width} />)}</colgroup>
              <thead>
                <tr>
                  {(['skill', 'source', 'commit', 'license', 'updated', 'status'] as const).map((column) => (
                    <th key={column} className={HEAD} scope="col">{t(`skills.col_${column}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-b-0" data-testid={`skills-row-${row.id}`}>
                    <td className={`${CELL} font-mono text-text`} title={row.id}>{row.id}</td>
                    {row.origin === 'tenon' ? (
                      <td className={`${CELL} text-text-2`} title="tenon">tenon</td>
                    ) : (
                      <td className={CELL} title={`${row.repo ?? ''}:${row.path ?? ''}`}>
                        {row.sourceUrl === undefined
                          ? <span className="text-text-2">{row.repo}</span>
                          : <a className={LINK} href={row.sourceUrl} target="_blank" rel="noreferrer">{row.repo}</a>}
                      </td>
                    )}
                    <CommitCell row={row} />
                    <td className={`${CELL} text-text-2`} title={row.license ?? '—'}>{row.license ?? '—'}</td>
                    <td className={`${CELL} text-text-2`} title={row.fetchedAt ?? '—'}>{stamp(row.fetchedAt)}</td>
                    <td className={`${CELL} ${STATUS_TONE[row.status]}`} title={statusTitle(row)} data-testid={`skills-status-${row.id}`}>
                      {row.status === 'bundled' ? '—' : t(`skills.status_${row.status}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  )
}
