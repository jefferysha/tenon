import type { ReactNode } from 'react'
import { Archive } from 'lucide-react'
import { useT } from '../i18n'
import { FilterChip, ListColumn } from '../shell/ThreeColumns'
import { TaskCard } from './TaskCard'
import { stageChips, type TaskFilterState, type TaskRow } from './taskModel'
import { cn } from '@/lib/utils'

export interface TaskListPaneProps {
  eyebrow: string
  rows: readonly TaskRow[]
  visibleRows: readonly TaskRow[]
  filter: TaskFilterState
  onFilter: (next: TaskFilterState) => void
  search: string
  onSearch: (next: string) => void
  selectedKey: string | null
  onSelect: (row: TaskRow) => void
  showProject: boolean
  emptyKind: 'no-project' | 'no-task' | 'filtered' | 'compat'
  onClearFilters: () => void
  notice?: ReactNode
}

/** 中列：阶段芯片（与流水线一一对应）+ 含已归档开关 + 任务卡。 */
export function TaskListPane({
  eyebrow, rows, visibleRows, filter, onFilter, search, onSearch, selectedKey, onSelect, showProject, emptyKind, onClearFilters, notice,
}: TaskListPaneProps): JSX.Element {
  const { t } = useT()
  const chips = stageChips(rows, filter.includeArchived)
  const total = rows.filter((row) => filter.includeArchived || !row.archived).length
  return (
    <ListColumn
      eyebrow={eyebrow}
      title={t('workspace.title')}
      search={{ value: search, onChange: onSearch, placeholder: t('workspace.search_tasks'), label: t('workspace.search_tasks') }}
      chips={(
        <div className="flex w-full flex-wrap items-center gap-1" role="tablist" aria-label={t('workspace.filter_label')}>
          <FilterChip label={t('workspace.filter_all')} count={total} selected={filter.stage === 'all'} testId="task-filter-all" onClick={() => onFilter({ ...filter, stage: 'all' })} />
          {chips.map((chip) => (
            <FilterChip key={chip.id} label={chip.label} count={chip.count} selected={filter.stage === chip.id} testId={`task-filter-${chip.id}`} onClick={() => onFilter({ ...filter, stage: chip.id })} />
          ))}
          <button
            type="button"
            className={cn(
              'ml-auto inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-body text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)',
              filter.includeArchived && 'bg-accent-t font-semibold text-(--accent)',
            )}
            aria-pressed={filter.includeArchived}
            data-testid="task-filter-archived"
            onClick={() => onFilter({ ...filter, includeArchived: !filter.includeArchived })}
          >
            <Archive className="size-3.5" aria-hidden="true" />
            {t('workspace.include_archived')}
          </button>
        </div>
      )}
      testId="task-list"
    >
      {notice}
      {visibleRows.length === 0 && emptyKind === 'compat' ? null : visibleRows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-5 py-10 text-center" role="status" aria-live="polite" data-testid={`task-list-empty-${emptyKind}`}>
          <p className="text-base font-semibold text-text">{t(`workspace.empty_${emptyKind}`)}</p>
          {emptyKind === 'no-task' && (
            <code className="mt-3 inline-block rounded-xs bg-accent-t px-2 py-1 font-mono text-body text-(--accent)">tenon init my-change --track chat</code>
          )}
          {emptyKind === 'filtered' && (
            <button type="button" className="mt-3 min-h-9 rounded-sm border border-border bg-card px-3 text-caption font-semibold text-text-2 hover:bg-fill" onClick={onClearFilters}>
              {t('projects.clear_filters')}
            </button>
          )}
        </div>
      ) : (
        <ul className="grid" data-testid="task-list-items">
          {visibleRows.map((row, index) => {
            const selected = row.key === selectedKey
            const previousSelected = index > 0 && visibleRows[index - 1]?.key === selectedKey
            return (
              <li key={row.key} className={index > 0 && !selected && !previousSelected ? 'border-t border-border' : undefined}>
                <TaskCard row={row} selected={selected} showProject={showProject} onSelect={() => onSelect(row)} />
              </li>
            )
          })}
        </ul>
      )}
    </ListColumn>
  )
}
