import { ChevronRight, Clock3, GitBranch } from 'lucide-react'
import { useT } from '../i18n'
import { shortTime } from '../model/time'
import { FilterChip, ListColumn, StatusPill } from '../shell/ThreeColumns'
import { cn } from '@/lib/utils'
import {
  RUN_FILTERS,
  runFilterMatch,
  runNextLabel,
  runPhaseLabel,
  runSlug,
  runStateLabel,
  runTone,
  type AutomationRow,
  type RunFilter,
} from './automationModel'

export interface RunListPaneProps {
  eyebrow: string
  /** 当前范围内的全部运行（页签计数口径）。 */
  rows: readonly AutomationRow[]
  /** 再经页签 + 搜索过滤后的运行。 */
  visibleRows: readonly AutomationRow[]
  filter: RunFilter
  onFilter: (next: RunFilter) => void
  search: string
  onSearch: (next: string) => void
  selectedName: string | null
  onSelect: (row: AutomationRow) => void
  /** 零运行 → 教学空态；有运行但被筛掉 → 清筛选。 */
  emptyKind: 'no-run' | 'filtered'
  onClearFilters: () => void
}

/** 自动化页中列：eyebrow / H1「运行」/ 说明框 / 搜索 / 状态页签 / 运行卡列表。 */
export function RunListPane({
  eyebrow,
  rows,
  visibleRows,
  filter,
  onFilter,
  search,
  onSearch,
  selectedName,
  onSelect,
  emptyKind,
  onClearFilters,
}: RunListPaneProps): JSX.Element {
  const { t } = useT()
  const counts = Object.fromEntries(RUN_FILTERS.map((candidate) => [candidate, rows.filter((row) => runFilterMatch(row, candidate)).length])) as Record<RunFilter, number>
  return (
    <ListColumn
      eyebrow={eyebrow}
      title={t('automation.title')}
      note={<><b className="font-semibold text-text">{t('automation.filter_note_lead')}</b> {t('automation.filter_note')}</>}
      search={{ value: search, onChange: onSearch, placeholder: t('automation.search_runs'), label: t('afk.search_label'), name: 'afk-search' }}
      chips={(
        <div role="tablist" aria-label={t('automation.filters_label')} className="flex flex-wrap gap-1">
          {RUN_FILTERS.map((candidate) => (
            <FilterChip
              key={candidate}
              label={t(`automation.filter_${candidate}`)}
              count={counts[candidate]}
              selected={filter === candidate}
              testId={`afk-filter-${candidate}`}
              onClick={() => onFilter(candidate)}
            />
          ))}
        </div>
      )}
      testId="afk-run-list"
    >
      {visibleRows.length === 0 ? (
        <div
          className="rounded-md border border-dashed border-border px-5 py-10 text-center"
          role="status"
          aria-live="polite"
          data-testid={emptyKind === 'no-run' ? 'afk-empty' : 'afk-filter-empty'}
        >
          <p className="text-base font-semibold text-text">{emptyKind === 'no-run' ? t('afk.empty_runs') : t('automation.filtered_title')}</p>
          <p className="mt-1 text-body text-text-2">{emptyKind === 'no-run' ? t('automation.empty_desc') : t('projects.no_results_desc')}</p>
          {emptyKind === 'no-run' && (
            <code className="mt-3 inline-block rounded-xs bg-accent-t px-2 py-1 font-mono text-body text-(--accent)">tenon afk enqueue &lt;change&gt;</code>
          )}
          {emptyKind === 'filtered' && (
            <button type="button" className="mt-3 min-h-9 rounded-sm border border-border bg-card px-3 text-caption font-semibold text-text-2 hover:bg-fill" onClick={onClearFilters}>
              {t('projects.clear_filters')}
            </button>
          )}
        </div>
      ) : (
        <ul className="grid" data-testid="afk-run-items">
          {visibleRows.map((row, index) => {
            const name = row.row.change.name
            const selected = name === selectedName
            const previousSelected = index > 0 && visibleRows[index - 1]?.row.change.name === selectedName
            return (
              <li key={name} className={index > 0 && !selected && !previousSelected ? 'border-t border-border' : undefined} data-testid={`afk-sec-${row.row.state}`}>
                <RunCard row={row} selected={selected} onSelect={() => onSelect(row)} />
              </li>
            )
          })}
        </ul>
      )}
    </ListColumn>
  )
}

/** 运行卡：标题 + 状态 pill / workflow · track / 阶段 · 更新时间 · 下一步 · chevron。选中 = 浅蓝灰底 + 左侧粗边。 */
function RunCard({ row, selected, onSelect }: { row: AutomationRow; selected: boolean; onSelect: () => void }): JSX.Element {
  const { t, lang } = useT()
  const change = row.row.change
  const state = row.row.state
  return (
    <button
      type="button"
      className={cn(
        'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-md border border-transparent px-3.5 py-4 text-left outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
        selected && 'border-sel-border border-l-[3px] border-l-sel-edge bg-sel-bg pl-3 hover:bg-sel-bg',
      )}
      aria-current={selected ? 'true' : undefined}
      data-state={state}
      data-testid={`afk-row-${change.name}`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-title font-semibold text-text">{change.name}</span>
        <span className="min-w-0 max-w-[55%] truncate"><StatusPill tone={runTone(state)} testId={`afk-badge-${change.name}`}>{runStateLabel(state, t)}</StatusPill></span>
      </span>
      <span className="truncate font-mono text-body text-text-2">{runSlug(row)}</span>
      <span className="flex min-w-0 items-center gap-3.5 text-body text-text-2">
        <span className="flex flex-none items-center gap-1.5"><GitBranch className="size-3.5 text-text-3" aria-hidden="true" />{runPhaseLabel(row, t)}</span>
        {change.updated_at !== '' && (
          <span className="flex flex-none items-center gap-1.5"><Clock3 className="size-3.5 text-text-3" aria-hidden="true" />{shortTime(change.updated_at, lang)}</span>
        )}
        <span className="min-w-0 flex-1 truncate">{runNextLabel(row, t)}</span>
        <ChevronRight className="size-3.5 flex-none text-text-3" aria-hidden="true" />
      </span>
    </button>
  )
}
