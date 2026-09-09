import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { FilterChip, ListColumn } from '../shell/ThreeColumns'
import { TaskCard } from './TaskCard'
import type { FlatRow } from './taskRows'
import { TASK_FILTERS, taskFilterMatch, type TaskFilter } from './workspaceModel'

export interface TaskListPaneProps {
  eyebrow: string
  rows: readonly FlatRow[]
  visibleRows: readonly FlatRow[]
  filter: TaskFilter
  onFilter: (next: TaskFilter) => void
  search: string
  onSearch: (next: string) => void
  selectedKey: string | null
  onSelect: (row: FlatRow) => void
  showProject: boolean
  /** 空列表时的教学：当前项目零任务 → 给终端命令；有任务但被筛掉 → 清筛选。 */
  emptyKind: 'no-project' | 'no-task' | 'filtered' | 'compat'
  onClearFilters: () => void
  /** 列表上方的提示条（快照失败 / 未来版本升级提示）。 */
  notice?: ReactNode
}

export function TaskListPane({
  eyebrow,
  rows,
  visibleRows,
  filter,
  onFilter,
  search,
  onSearch,
  selectedKey,
  onSelect,
  showProject,
  emptyKind,
  onClearFilters,
  notice,
}: TaskListPaneProps): JSX.Element {
  const { t } = useT()
  const counts = Object.fromEntries(TASK_FILTERS.map((candidate) => [candidate, rows.filter((row) => taskFilterMatch(row, candidate)).length])) as Record<TaskFilter, number>
  return (
    <ListColumn
      eyebrow={eyebrow}
      title={t('workspace.title')}
      note={<><b className="font-semibold text-text">{t('workspace.filter_note_lead')}</b> {t('workspace.filter_note')}</>}
      search={{ value: search, onChange: onSearch, placeholder: t('workspace.search_tasks'), label: t('workspace.search_tasks') }}
      chips={(
        <div role="tablist" aria-label={t('progress.tabs_label')} className="flex flex-wrap gap-1">
          {TASK_FILTERS.map((candidate) => (
            <FilterChip
              key={candidate}
              label={t(`workspace.filter_${candidate}`)}
              count={counts[candidate]}
              selected={filter === candidate}
              testId={`task-filter-${candidate}`}
              onClick={() => onFilter(candidate)}
            />
          ))}
        </div>
      )}
      testId="task-list"
    >
      {notice}
      {visibleRows.length === 0 && emptyKind === 'compat' ? null : visibleRows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-5 py-10 text-center" role="status" aria-live="polite" data-testid={`task-list-empty-${emptyKind}`}>
          <p className="text-base font-semibold text-text">{t(`workspace.empty_${emptyKind}_title`)}</p>
          <p className="mt-1 text-body text-text-2">{t(`workspace.empty_${emptyKind}_desc`)}</p>
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
