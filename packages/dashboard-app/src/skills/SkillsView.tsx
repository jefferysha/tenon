import { Fragment, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { fetchSkillSources, type SkillSourceRow, type SkillSourcesDto } from '../api/skillSourcesClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { FilterChip, FilterChipGroup } from '../shared/FilterChip'
import { matchesQuery } from '../shell/GlobalSearch'
import { SkillDetailDrawer } from '../workflow/SkillDetail'
import { SkillFailureRow } from './SkillFailureRow'
import { referenceText, useSkillReferences, type SkillReference } from './useSkillReferences'

type Filter = 'all' | 'changed' | 'failed'
type LoadState = { readonly kind: 'loading' } | { readonly kind: 'ok'; readonly view: SkillSourcesDto } | { readonly kind: 'error'; readonly detail: string }

const CELL = 'truncate whitespace-nowrap px-3 py-2'
const HEAD = `${CELL} sticky top-0 z-10 border-b border-border bg-bg text-left font-semibold text-text-2`
/** 链接平时是正文色，强调色只在悬停时出现。 */
const LINK = 'rounded-xs outline-none underline-offset-4 hover:text-(--accent) hover:underline focus-visible:ring-2 focus-visible:ring-(--accent)'
const FILTERS = ['all', 'changed', 'failed'] as const
const COLUMNS = ['skill', 'source', 'used', 'commit', 'license', 'updated'] as const
const COLUMN_WIDTHS: Record<(typeof COLUMNS)[number] | 'status', string> = {
  skill: 'w-[20%]', source: 'w-[20%]', used: 'w-[20%]', commit: 'w-[12%]', license: 'w-[9%]', updated: 'w-[13%]', status: 'w-24',
}
const STATUS_TONE: Record<SkillSourceRow['status'], string> = {
  changed: 'text-amber-d', unchanged: 'text-text-2', failed: 'text-red-d', bundled: 'text-text-3',
}
/** 状态列只在「有事」时出字：变化 / 失败。无变化与随包技能留空，不在每一行重复同一个词。 */
const SHOWN_STATUS: ReadonlySet<SkillSourceRow['status']> = new Set(['changed', 'failed'])

function stamp(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : value.slice(0, 16).replace('T', ' ')
}

function short(commit: string): string {
  return commit.slice(0, 7)
}

function CommitCell({ row }: { readonly row: SkillSourceRow }): JSX.Element {
  if (row.commit === undefined) return <td className={`${CELL} text-text-3`}>—</td>
  const cell = `${CELL} font-mono text-text-3`
  const previous = row.status === 'changed' && typeof row.previousCommit === 'string' ? row.previousCommit : null
  if (previous !== null && row.compareUrl !== undefined) {
    const label = `${short(previous)}→${short(row.commit)}`
    return (
      <td className={cell} title={`${previous}→${row.commit}`}>
        <a className={LINK} href={row.compareUrl} target="_blank" rel="noreferrer" data-testid={`skills-compare-${row.id}`}>{label}</a>
      </td>
    )
  }
  return (
    <td className={cell} title={row.commit}>
      {row.commitUrl === undefined ? short(row.commit) : <a className={LINK} href={row.commitUrl} target="_blank" rel="noreferrer">{short(row.commit)}</a>}
    </td>
  )
}

/** 引用列：第一处引用 + 「+N」，全部引用在悬停提示里（一行一处）。 */
function UsedCell({ id, references }: { readonly id: string; readonly references: readonly SkillReference[] }): JSX.Element {
  const first = references[0]
  if (first === undefined) return <td className={`${CELL} text-text-3`} data-testid={`skills-used-${id}`}>—</td>
  return (
    <td className={`${CELL} text-text-2`} title={references.map(referenceText).join('\n')} data-testid={`skills-used-${id}`}>
      {referenceText(first)}
      {references.length > 1 && <span className="ml-1.5 tabular-nums text-text-3">+{references.length - 1}</span>}
    </td>
  )
}

/**
 * 技能: every Tenon and upstream skill with source, commit, license, update time and status. Read-only.
 * Search filters by skill / repo; clicking a row opens the skill in the shared SkillDetail drawer.
 * 「引用」列列出把它放进阶段技能的工作流 · 轨道 · 阶段；失败行的状态可展开，给出原因与可复制的修复命令。
 */
export function SkillsView(): JSX.Element {
  const { t } = useT()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const references = useSkillReferences(state.kind === 'ok')
  const toggle = (id: string): void => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

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
  const visible = rows.filter((row) => (filter === 'all' || row.status === filter) && matchesQuery(query, row.id, row.repo ?? ''))
  // 状态列只在可见行里有「变化 / 失败」时出现；全都无事就整列不渲染。
  const showStatus = visible.some((row) => SHOWN_STATUS.has(row.status))
  const columns: readonly (keyof typeof COLUMN_WIDTHS)[] = showStatus ? [...COLUMNS, 'status'] : COLUMNS
  // 行内的链接（仓库 / 提交）照常跳转，不同时打开抽屉。
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, id: string): void => {
    if (event.target instanceof Element && event.target.closest('a, button') !== null) return
    setOpen(id)
  }

  const statusTitle = (row: SkillSourceRow): string => {
    if (row.status === 'bundled') return '—'
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
          <div className="flex items-center justify-between gap-6 whitespace-nowrap">
            <FilterChipGroup label={t('nav.skills')} testId="skills-filter">
              {FILTERS.map((id) => (
                <FilterChip
                  key={id}
                  label={t(`skills.filter_${id}`)}
                  count={counts[id]}
                  selected={filter === id}
                  testId={`skills-filter-${id}`}
                  onClick={() => setFilter(id)}
                />
              ))}
            </FilterChipGroup>
            <div className="flex items-center gap-4">
              <label className="flex h-9 w-64 items-center gap-2 rounded-md border border-border bg-card px-3 text-text-3 focus-within:border-accent-b" data-testid="skills-search-box">
                <Search className="size-4 flex-none" aria-hidden="true" />
                <span className="sr-only">{t('skills.search')}</span>
                <input
                  type="search"
                  autoComplete="off"
                  value={query}
                  placeholder={t('skills.search')}
                  className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-3"
                  data-testid="skills-search"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <span className="text-caption tabular-nums text-text-3" data-testid="skills-updated">{t('skills.updated')} {stamp(state.view.updatedAt)}</span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto" data-testid="skills-table">
            <table className="w-full table-fixed border-collapse text-caption">
              <colgroup>{columns.map((column) => <col key={column} className={COLUMN_WIDTHS[column]} />)}</colgroup>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column} className={HEAD} scope="col">{t(`skills.col_${column}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <Fragment key={row.id}>
                  <tr
                    className="cursor-pointer transition-colors hover:bg-fill motion-reduce:transition-none"
                    data-testid={`skills-row-${row.id}`}
                    onClick={(event) => onRowClick(event, row.id)}
                  >
                    <td className={CELL} title={row.id}>
                      <button
                        type="button"
                        className={`max-w-full truncate font-mono text-text ${LINK}`}
                        data-testid={`skills-open-${row.id}`}
                        onClick={() => setOpen(row.id)}
                      >
                        {row.id}
                      </button>
                    </td>
                    {row.origin === 'tenon' ? (
                      <td className={`${CELL} text-text-2`} title={t('skills.source_tenon')}>{t('skills.source_tenon')}</td>
                    ) : (
                      <td className={CELL} title={`${row.repo ?? ''}:${row.path ?? ''}`}>
                        {row.sourceUrl === undefined
                          ? <span className="text-text-2">{row.repo}</span>
                          : <a className={`text-text-2 ${LINK}`} href={row.sourceUrl} target="_blank" rel="noreferrer">{row.repo}</a>}
                      </td>
                    )}
                    <UsedCell id={row.id} references={references.get(row.id) ?? []} />
                    <CommitCell row={row} />
                    <td className={`${CELL} text-text-2`} title={row.license ?? '—'}>{row.license ?? '—'}</td>
                    <td className={`${CELL} tabular-nums text-text-2`} title={row.fetchedAt ?? '—'}>{stamp(row.fetchedAt)}</td>
                    {showStatus && (
                      <td className={`${CELL} ${STATUS_TONE[row.status]}`} title={statusTitle(row)} data-testid={`skills-status-${row.id}`}>
                        {row.status === 'failed' ? (
                          <button
                            type="button"
                            className={`inline-flex max-w-full items-center gap-1 ${LINK}`}
                            aria-expanded={expanded.has(row.id)}
                            data-testid={`skills-expand-${row.id}`}
                            onClick={() => toggle(row.id)}
                          >
                            {expanded.has(row.id) ? <ChevronDown className="size-3.5 flex-none" aria-hidden="true" /> : <ChevronRight className="size-3.5 flex-none" aria-hidden="true" />}
                            <span className="truncate">{t('skills.status_failed')}</span>
                          </button>
                        ) : SHOWN_STATUS.has(row.status) ? t(`skills.status_${row.status}`) : ''}
                      </td>
                    )}
                  </tr>
                  {row.status === 'failed' && expanded.has(row.id) && (
                    <SkillFailureRow id={row.id} reason={statusTitle(row)} columns={columns.length} />
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <SkillDetailDrawer name={open} onClose={() => setOpen(null)} />
    </section>
  )
}
