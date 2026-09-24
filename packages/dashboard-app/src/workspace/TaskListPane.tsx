import type { ReactNode } from 'react'
import { ArchiveRestore, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { ListColumn } from '../shell/ThreeColumns'
import { FacetBar, type FacetGroup, type FacetOption } from '../shared/FacetBar'
import { CommandLine } from './CommandLine'
import { TaskCard } from './TaskCard'
import type { TaskMenuEntry } from './TaskMenu'
import { localTime } from '../model/time'
import { facetTotal, isTaskStatus, stageLabel, statusCounts, taskFacets, TASK_STATUSES, type FacetChip, type TaskFilterState, type TaskRow } from './taskModel'
import type { UserRefView } from '../types'
import { cn } from '@/lib/utils'

export interface TaskListPaneProps {
  rows: readonly TaskRow[]
  visibleRows: readonly TaskRow[]
  filter: TaskFilterState
  onFilter: (next: TaskFilterState) => void
  search: string
  onSearch: (next: string) => void
  selectedKey: string | null
  onSelect: (row: TaskRow) => void
  showProject: boolean
  emptyKind: 'no-project' | 'no-task' | 'no-archived' | 'filtered' | 'compat'
  onClearFilters: () => void
  notice?: ReactNode
  /** Current declared user; enables the 我的 option. */
  me: UserRefView | null
  /** 'active' = 活跃列表；'archived' = 已归档视图（只留搜索，无筛选）。 */
  listMode: 'active' | 'archived'
  onListMode: (next: 'active' | 'archived') => void
  archivedCount: number
  uncommittedDeletions: number
  /** 每张卡的 ⋯ 菜单项；空数组 = 不渲染菜单。 */
  menuOf: (row: TaskRow) => readonly TaskMenuEntry[]
  onUnarchive?: (row: TaskRow) => void
  /** 测试注入筛选栏宽度测量。 */
  measureWidth?: (element: HTMLElement) => number
}

const INIT_COMMAND = 'tenon init my-change --track chat'
const TOGGLE_CLS = 'inline-flex min-h-10 flex-none items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-body text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)'

function menuOptions(chips: readonly FacetChip[], allCount: number, allLabel: string, testPrefix: string, lead: readonly FacetOption[] = []): FacetOption[] {
  return [
    { id: 'all', label: allLabel, count: allCount, testId: `${testPrefix}-all` },
    ...lead,
    ...chips.map((chip) => ({ id: chip.id, label: chip.label, count: chip.count, testId: `${testPrefix}-${chip.id}` })),
  ]
}

/** 中列：单行筛选栏（状态芯片 + 负责人 / 工作流 / 轨道 / 阶段下拉）+ 任务卡。 */
export function TaskListPane({
  rows, visibleRows, filter, onFilter, search, onSearch, selectedKey, onSelect, showProject, emptyKind, onClearFilters, notice, me,
  listMode, onListMode, archivedCount, uncommittedDeletions, menuOf, onUnarchive, measureWidth,
}: TaskListPaneProps): JSX.Element {
  const { t, lang } = useT()
  const archivedView = listMode === 'archived'
  const facets = taskFacets(rows, filter)
  const counts = statusCounts(rows, filter)
  const all = t('workspace.filter_all')
  const mine: FacetOption[] = me === null ? [] : [{
    id: me.slug,
    label: t('workspace.filter_mine'),
    count: facets.owners.find((chip) => chip.id === me.slug)?.count ?? 0,
    testId: 'task-facet-owner-me',
  }]
  const groups: FacetGroup[] = [
    {
      id: 'status',
      kind: 'chips',
      label: t('workspace.facet_status'),
      testId: 'task-status',
      value: filter.status,
      onChange: (id) => { if (isTaskStatus(id)) onFilter({ ...filter, status: id }) },
      options: TASK_STATUSES.map((id) => ({ id, label: id === 'all' ? all : t(`workspace.status_${id.replace('-', '_')}`), count: counts[id] })),
    },
    {
      id: 'owner',
      kind: 'menu',
      label: t('workspace.facet_owner'),
      testId: 'task-facet-owner',
      value: filter.owner,
      onChange: (id) => onFilter({ ...filter, owner: id }),
      options: menuOptions(facets.owners.filter((chip) => chip.id !== me?.slug), facetTotal(rows, filter, 'owner'), all, 'task-facet-owner', mine),
    },
    {
      id: 'workflow',
      kind: 'menu',
      label: t('workspace.facet_workflow'),
      testId: 'task-facet-workflow',
      mono: true,
      value: filter.workflow,
      onChange: (id) => onFilter({ ...filter, workflow: id, stage: 'all' }),
      options: menuOptions(facets.workflows, facetTotal(rows, filter, 'workflow'), all, 'task-facet-workflow'),
    },
    {
      id: 'track',
      kind: 'menu',
      label: t('workspace.facet_track'),
      testId: 'task-facet-track',
      mono: true,
      value: filter.track,
      onChange: (id) => onFilter({ ...filter, track: id }),
      options: menuOptions(facets.tracks, facetTotal(rows, filter, 'track'), all, 'task-facet-track'),
    },
    ...(facets.stages === null ? [] : [{
      id: 'stage',
      kind: 'menu' as const,
      label: t('workspace.facet_stage'),
      testId: 'task-facet-stage',
      value: filter.stage,
      onChange: (id: string) => onFilter({ ...filter, stage: id }),
      options: menuOptions(facets.stages, facetTotal(rows, filter, 'stage'), all, 'task-facet-stage'),
    }]),
  ]
  const trailing = (
    <>
      <button
        type="button"
        className={TOGGLE_CLS}
        aria-pressed="false"
        aria-label={`${t('workspace.archived_view')} ${archivedCount}`}
        title={t('workspace.archived_view')}
        data-testid="task-view-archived"
        onClick={() => onListMode('archived')}
      >
        <ArchiveRestore className="size-4" aria-hidden="true" />
        <span className="text-caption tabular-nums text-text-3">{archivedCount}</span>
      </button>
      {uncommittedDeletions > 0 && (
        // 只有计数、没有目录清单：做成纯文本，不假装可点。
        <span
          className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap px-1 text-body text-text-3"
          title={`${t('workspace.uncommitted_deletions')} ${uncommittedDeletions}`}
          aria-label={`${t('workspace.uncommitted_deletions')} ${uncommittedDeletions}`}
          role="status"
          data-testid="task-uncommitted-deletions"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          <span className="text-caption tabular-nums text-text-3">{uncommittedDeletions}</span>
        </span>
      )}
    </>
  )
  return (
    <ListColumn
      title={t('workspace.title')}
      search={{ value: search, onChange: onSearch, placeholder: t('workspace.search_tasks'), label: t('workspace.search_tasks') }}
      chips={archivedView ? (
        <div className="flex w-full flex-nowrap items-center gap-2">
          <button
            type="button"
            className={cn(TOGGLE_CLS, 'bg-accent-t font-semibold text-(--accent)')}
            aria-pressed="true"
            data-testid="task-view-archived"
            onClick={() => onListMode('active')}
          >
            <ArchiveRestore className="size-4" aria-hidden="true" />
            {t('workspace.archived_view')}
            <span className="tabular-nums">{archivedCount}</span>
          </button>
        </div>
      ) : (
        <FacetBar
          groups={groups}
          label={t('workspace.filters')}
          testId="task-filters"
          trailing={trailing}
          {...(measureWidth === undefined ? {} : { measureWidth })}
        />
      )}
      testId="task-list"
    >
      {notice}
      {visibleRows.length === 0 && emptyKind === 'compat' ? null : visibleRows.length === 0 ? (
        <div className="grid justify-items-start gap-3 px-1 py-10" role="status" aria-live="polite" data-testid={`task-list-empty-${emptyKind}`}>
          <p className="text-base font-semibold text-text">{t(`workspace.empty_${emptyKind}`)}</p>
          {emptyKind === 'no-task' && <div className="grid w-full min-w-0"><CommandLine command={INIT_COMMAND} testId="task-list-empty-command" /></div>}
          {emptyKind === 'filtered' && (
            <button type="button" className="min-h-10 rounded-sm border border-border bg-card px-3 text-caption font-semibold text-text-2 hover:bg-fill" onClick={onClearFilters}>
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
                  menu={menuOf(row)}
                />
                {archivedView && row.archive !== undefined && (
                  <p className="truncate whitespace-nowrap px-3.5 pb-3 font-mono text-caption text-text-3" data-testid={`task-archived-meta-${row.change.name}`}>
                    <span title={row.archive.archivedAt}>
                      {t('workspace.archived_meta', { stage: stageLabel(row.archive.phase, row.rules), time: localTime(row.archive.archivedAt, lang), actor: row.archive.actor.name })}
                    </span>
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
