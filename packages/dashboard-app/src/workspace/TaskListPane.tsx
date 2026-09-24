import { Fragment, type ReactNode } from 'react'
import { SlidersHorizontal, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { ListColumn } from '../shell/ThreeColumns'
import { FilterChip, FilterChipGroup } from '../shared/FilterChip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CommandLine } from './CommandLine'
import { TaskCard } from './TaskCard'
import type { TaskMenuEntry } from './TaskMenu'
import { INIT_COMMAND } from './taskCommands'
import { localTime } from '../model/time'
import { facetTotal, stageLabel, statusCounts, taskFacets, TASK_STATUSES, type FacetChip, type TaskFilterState, type TaskRow } from './taskModel'
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
}

const TOGGLE_CLS = 'inline-flex min-h-10 flex-none items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-body text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-pressed:bg-accent-t aria-pressed:font-semibold aria-pressed:text-(--accent)'
const MENU_TRIGGER_CLS = 'inline-flex min-h-10 flex-none items-center gap-1 whitespace-nowrap rounded-sm px-2 text-body text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) data-[active=true]:font-semibold data-[active=true]:text-(--accent) aria-expanded:bg-fill'

interface FilterMenuGroup {
  id: keyof Omit<TaskFilterState, 'status'>
  label: string
  mono: boolean
  options: Array<{ id: string; label: string; count: number }>
}

function menuOptions(chips: readonly FacetChip[], allCount: number, allLabel: string, lead: FilterMenuGroup['options'] = []): FilterMenuGroup['options'] {
  return [{ id: 'all', label: allLabel, count: allCount }, ...lead, ...chips.map((chip) => ({ id: chip.id, label: chip.label, count: chip.count }))]
}

/** 「筛选」：负责人 / 工作流 / 轨道 / 阶段收进一个菜单，按钮上显示生效条件数；只有一个取值的维度不列。 */
function FilterMenu({ groups, filter, onFilter }: { groups: readonly FilterMenuGroup[]; filter: TaskFilterState; onFilter: (next: TaskFilterState) => void }): JSX.Element | null {
  const { t } = useT()
  const shown = groups.filter((group) => group.options.length > 2 || filter[group.id] !== 'all')
  const active = groups.filter((group) => filter[group.id] !== 'all').length
  if (shown.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={MENU_TRIGGER_CLS} data-active={active > 0} aria-label={`${t('workspace.filters')} ${active}`} data-testid="task-filter-menu">
        <SlidersHorizontal className="size-4 flex-none" aria-hidden="true" />
        {t('workspace.filters')}
        {active > 0 && <span className="text-caption tabular-nums" data-testid="task-filter-active">{active}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52" data-testid="task-filter-menu-content">
        {shown.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-caption text-text-3">{group.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filter[group.id]}
              onValueChange={(id) => onFilter(group.id === 'workflow' ? { ...filter, workflow: id, stage: 'all' } : { ...filter, [group.id]: id })}
            >
              {group.options.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id} className="min-h-10 whitespace-nowrap text-body" data-testid={`task-facet-${group.id}-${option.id}`}>
                  <span className={cn('min-w-0 flex-1 truncate', group.mono && option.id !== 'all' && 'font-mono')} title={option.label}>{option.label}</span>
                  <span className="text-caption tabular-nums text-text-3">{option.count}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 空态两步引导：在智能体对话里发提示词，或在终端跑完整命令（含 --preset）。 */
function EmptyGuide(): JSX.Element {
  const { t } = useT()
  return (
    <div className="grid w-full min-w-0 gap-3" data-testid="task-list-empty-guide">
      <div className="grid min-w-0 gap-1.5">
        <span className="whitespace-nowrap text-caption font-semibold text-text-2">1 · {t('workspace.guide_chat')}</span>
        <CommandLine command={t('workspace.guide_prompt')} testId="task-list-empty-prompt" />
      </div>
      <div className="grid min-w-0 gap-1.5">
        <span className="whitespace-nowrap text-caption font-semibold text-text-2">2 · {t('workspace.guide_terminal')}</span>
        <CommandLine command={INIT_COMMAND} testId="task-list-empty-command" />
      </div>
    </div>
  )
}

/** 中列：单行筛选（状态分段 + 「筛选」菜单）+ 任务卡；已归档是标题旁的文字开关。 */
export function TaskListPane({
  rows, visibleRows, filter, onFilter, search, onSearch, selectedKey, onSelect, showProject, emptyKind, onClearFilters, notice, me,
  listMode, onListMode, archivedCount, uncommittedDeletions, menuOf, onUnarchive,
}: TaskListPaneProps): JSX.Element {
  const { t, lang } = useT()
  const archivedView = listMode === 'archived'
  const facets = taskFacets(rows, filter)
  const counts = statusCounts(rows, filter)
  const all = t('workspace.filter_all')
  const mine = me === null ? [] : [{ id: me.slug, label: t('workspace.filter_mine'), count: facets.owners.find((chip) => chip.id === me.slug)?.count ?? 0 }]
  const menuGroups: FilterMenuGroup[] = [
    { id: 'owner', label: t('workspace.facet_owner'), mono: false, options: menuOptions(facets.owners.filter((chip) => chip.id !== me?.slug), facetTotal(rows, filter, 'owner'), all, mine) },
    { id: 'workflow', label: t('workspace.facet_workflow'), mono: true, options: menuOptions(facets.workflows, facetTotal(rows, filter, 'workflow'), all) },
    { id: 'track', label: t('workspace.facet_track'), mono: true, options: menuOptions(facets.tracks, facetTotal(rows, filter, 'track'), all) },
    ...(facets.stages === null ? [] : [{ id: 'stage' as const, label: t('workspace.facet_stage'), mono: false, options: menuOptions(facets.stages, facetTotal(rows, filter, 'stage'), all) }]),
  ]
  const headAction = (
    <>
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
      <button
        type="button"
        className={TOGGLE_CLS}
        aria-pressed={archivedView}
        data-testid="task-view-archived"
        onClick={() => onListMode(archivedView ? 'active' : 'archived')}
      >
        {t('workspace.archived_view')}
        <span className="text-caption tabular-nums">{archivedCount}</span>
      </button>
    </>
  )
  return (
    <ListColumn
      title={t('workspace.title')}
      action={headAction}
      search={{ value: search, onChange: onSearch, placeholder: t('workspace.search_tasks'), label: t('workspace.search_tasks') }}
      {...(archivedView ? {} : {
        chips: (
          <div className="flex w-full min-w-0 flex-nowrap items-center gap-1 overflow-hidden" role="group" aria-label={t('workspace.filters')} data-testid="task-filters">
            <FilterChipGroup label={t('workspace.facet_status')} testId="task-status">
              {TASK_STATUSES.map((id) => (
                <FilterChip
                  key={id}
                  label={id === 'all' ? all : t(`workspace.status_${id.replace('-', '_')}`)}
                  count={counts[id]}
                  selected={filter.status === id}
                  testId={`task-status-${id}`}
                  onClick={() => onFilter({ ...filter, status: id })}
                />
              ))}
            </FilterChipGroup>
            <FilterMenu groups={menuGroups} filter={filter} onFilter={onFilter} />
          </div>
        ),
      })}
      testId="task-list"
    >
      {notice}
      {visibleRows.length === 0 && emptyKind === 'compat' ? null : visibleRows.length === 0 ? (
        <div className="grid justify-items-start gap-3 px-1 py-10" role="status" aria-live="polite" data-testid={`task-list-empty-${emptyKind}`}>
          <p className="text-base font-semibold text-text">{t(`workspace.empty_${emptyKind}`)}</p>
          {emptyKind === 'no-task' && <EmptyGuide />}
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
