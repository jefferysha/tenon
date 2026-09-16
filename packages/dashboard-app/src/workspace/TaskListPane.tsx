import type { ReactNode } from 'react'
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { FilterChip, ListColumn } from '../shell/ThreeColumns'
import { TaskCard } from './TaskCard'
import { facetTotal, taskFacets, type FacetChip, type TaskFilterState, type TaskRow } from './taskModel'
import type { UserRefView } from '../types'
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
  /** Current declared user; enables the 我的 chip. */
  me: UserRefView | null
  /** 'active' = 活跃列表；'archived' = 已归档视图（只留搜索，无 facet）。 */
  listMode: 'active' | 'archived'
  onListMode: (next: 'active' | 'archived') => void
  archivedCount: number
  uncommittedDeletions: number
  /** 缺省 = 只读（聚合语境）：卡上不出现 归档 / 删除 菜单。 */
  onAction?: (row: TaskRow, action: 'archive' | 'delete') => void
  onUnarchive?: (row: TaskRow) => void
}

function FacetRow({ label, facet, chips, current, total, mono, lead, onPick }: {
  label: string
  facet: 'owner' | 'workflow' | 'track' | 'stage'
  /** Extra chip rendered right after 全部 (the owner row's 我的). */
  lead?: ReactNode
  chips: readonly FacetChip[]
  current: string
  total: number
  mono?: boolean
  onPick: (id: string) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <div className="flex w-full items-center gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label={label} data-testid={`task-facet-${facet}`}>
      <span className="mr-1 min-w-12 flex-none whitespace-nowrap text-caption text-text-3">{label}</span>
      <FilterChip label={t('workspace.filter_all')} count={total} selected={current === 'all'} testId={`task-facet-${facet}-all`} onClick={() => onPick('all')} />
      {lead}
      {chips.map((chip) => (
        <span key={chip.id} className={cn('flex-none', mono && '[&>button]:font-mono')}>
          <FilterChip label={chip.label} count={chip.count} selected={current === chip.id} testId={facet === 'stage' ? `task-filter-${chip.id}` : `task-facet-${facet}-${chip.id}`} onClick={() => onPick(chip.id)} />
        </span>
      ))}
    </div>
  )
}

/** 中列：工作流 → 轨道 → 阶段三层芯片（阶段只在选定单一工作流时出现）+ 含已归档开关 + 任务卡。 */
export function TaskListPane({
  eyebrow, rows, visibleRows, filter, onFilter, search, onSearch, selectedKey, onSelect, showProject, emptyKind, onClearFilters, notice, me,
  listMode, onListMode, archivedCount, uncommittedDeletions, onAction, onUnarchive,
}: TaskListPaneProps): JSX.Element {
  const { t } = useT()
  const archivedView = listMode === 'archived'
  const facets = taskFacets(rows, filter)
  const mine = me === null ? undefined : (
    <span className="flex-none">
      <FilterChip
        label={t('workspace.filter_mine')}
        count={facets.owners.find((chip) => chip.id === me.slug)?.count ?? 0}
        selected={filter.owner === me.slug}
        testId="task-facet-owner-me"
        onClick={() => onFilter({ ...filter, owner: me.slug })}
      />
    </span>
  )
  return (
    <ListColumn
      eyebrow={eyebrow}
      title={t('workspace.title')}
      search={{ value: search, onChange: onSearch, placeholder: t('workspace.search_tasks'), label: t('workspace.search_tasks') }}
      chips={archivedView ? (
        <div className="flex w-full items-center gap-2">
          <button
            type="button"
            className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-sm bg-accent-t px-2.5 py-1.5 text-body font-semibold text-(--accent) outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
            aria-pressed="true"
            data-testid="task-view-archived"
            onClick={() => onListMode('active')}
          >
            <ArchiveRestore className="size-3.5" aria-hidden="true" />
            {t('workspace.archived_view')}
            <span className="font-mono">{archivedCount}</span>
          </button>
        </div>
      ) : (
        <div className="grid w-full gap-1.5">
          {(facets.owners.length > 0 || me !== null) && (
            <FacetRow
              label={t('workspace.facet_owner')}
              facet="owner"
              chips={facets.owners.filter((chip) => chip.id !== me?.slug)}
              current={filter.owner}
              total={facetTotal(rows, filter, 'owner')}
              lead={mine}
              onPick={(id) => onFilter({ ...filter, owner: id })}
            />
          )}
          <div className="flex w-full items-start gap-2">
            <div className="min-w-0 flex-1">
              <FacetRow label={t('workspace.facet_workflow')} facet="workflow" chips={facets.workflows} current={filter.workflow} total={facetTotal(rows, filter, 'workflow')} mono onPick={(id) => onFilter({ ...filter, workflow: id, stage: 'all' })} />
            </div>
            <button
              type="button"
              className={cn(
                'inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 py-1.5 text-body text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)',
                filter.includeCompleted && 'bg-accent-t font-semibold text-(--accent)',
              )}
              aria-pressed={filter.includeCompleted}
              data-testid="task-filter-completed"
              onClick={() => onFilter({ ...filter, includeCompleted: !filter.includeCompleted })}
            >
              <Archive className="size-3.5" aria-hidden="true" />
              {t('workspace.include_completed')}
            </button>
            <button
              type="button"
              className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 py-1.5 text-body text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)"
              aria-pressed="false"
              data-testid="task-view-archived"
              onClick={() => onListMode('archived')}
            >
              <ArchiveRestore className="size-3.5" aria-hidden="true" />
              {t('workspace.archived_view')}
              <span className="font-mono">{archivedCount}</span>
            </button>
            {uncommittedDeletions > 0 && (
              <span
                className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-sm bg-fill px-2.5 py-1.5 text-body text-text-2"
                data-testid="task-uncommitted-deletions"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t('workspace.uncommitted_deletions')}
                <span className="font-mono">{uncommittedDeletions}</span>
              </span>
            )}
          </div>
          {facets.tracks.length > 0 && (
            <FacetRow label={t('workspace.facet_track')} facet="track" chips={facets.tracks} current={filter.track} total={facetTotal(rows, filter, 'track')} mono onPick={(id) => onFilter({ ...filter, track: id })} />
          )}
          {facets.stages !== null && (
            <FacetRow label={t('workspace.facet_stage')} facet="stage" chips={facets.stages} current={filter.stage} total={facetTotal(rows, filter, 'stage')} onPick={(id) => onFilter({ ...filter, stage: id })} />
          )}
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
                <TaskCard
                  row={row}
                  selected={selected}
                  showProject={showProject}
                  onSelect={() => onSelect(row)}
                  {...(archivedView || onAction === undefined ? {} : { onAction: (action: 'archive' | 'delete') => onAction(row, action) })}
                />
                {archivedView && row.archive !== undefined && (
                  <p className="truncate whitespace-nowrap px-3.5 pb-3 font-mono text-caption text-text-3" data-testid={`task-archived-meta-${row.change.name}`}>
                    {t('workspace.archived_meta', { stage: row.archive.phase, time: row.archive.archivedAt, actor: row.archive.actor.name })}
                    {onUnarchive !== undefined && (
                      <button type="button" className="ml-2 rounded-sm text-(--accent) underline outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid={`task-archived-unarchive-${row.change.name}`} onClick={() => onUnarchive(row)}>
                        {t('workspace.unarchive')}
                      </button>
                    )}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </ListColumn>
  )
}
