import { Fragment, type ReactNode } from 'react'
import { SlidersHorizontal, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { ListColumn } from '../shell/ThreeColumns'
import { CountRoll } from '../shared/CountRoll'
import { FilterChip, FilterChipGroup } from '../shared/FilterChip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Hint } from '../workflow/Hint'
import { CommandLine } from './CommandLine'
import { EndedCard } from './EndedCard'
import type { EndedRow } from './endedModel'
import { TaskCard } from './TaskCard'
import type { TaskMenuEntry } from './TaskMenu'
import { facetTotal, statusCounts, taskFacets, TASK_STATUSES, type FacetChip, type TaskFilterState } from './taskFilter'
import type { TaskRow } from './taskModel'
import type { UserRefView } from '../types'
import { cn } from '@/lib/utils'

export interface TaskListPaneProps {
  /** 范围内全部的活跃行与已结束行：计数与候选按它们算；列出的是下面两个 visible。 */
  rows: readonly TaskRow[]
  ended: readonly EndedRow[]
  visibleRows: readonly TaskRow[]
  visibleEnded: readonly EndedRow[]
  /** 列出 shown 个、共 total 个；total 大于 shown 说明快照把已结束列表截断了。 */
  endedCount: { shown: number; total: number }
  filter: TaskFilterState
  onFilter: (next: TaskFilterState) => void
  search: string
  onSearch: (next: string) => void
  selectedKey: string | null
  onSelect: (row: TaskRow | EndedRow) => void
  showProject: boolean
  emptyKind: 'no-project' | 'no-task' | 'filtered' | 'compat'
  onClearFilters: () => void
  notice?: ReactNode
  /** Current declared user; enables the 我的 option. */
  me: UserRefView | null
  uncommittedDeletions: number
  /** 每张卡的 ⋯ 菜单项；空数组 = 不渲染菜单。 */
  menuOf: (row: TaskRow) => readonly TaskMenuEntry[]
}

const MENU_TRIGGER_CLS = 'relative grid size-10 flex-none place-items-center rounded-sm text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) data-[active=true]:text-(--accent) aria-expanded:bg-fill'
const MENU_BADGE_CLS = 'absolute -top-0.5 -right-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-btn-bg px-1 text-micro font-semibold tabular-nums text-btn-fg'

interface FilterMenuGroup {
  id: keyof Omit<TaskFilterState, 'status'>
  label: string
  mono: boolean
  options: Array<{ id: string; label: string; count: number }>
}

function menuOptions(chips: readonly FacetChip[], allCount: number, allLabel: string, lead: FilterMenuGroup['options'] = []): FilterMenuGroup['options'] {
  return [{ id: 'all', label: allLabel, count: allCount }, ...lead, ...chips.map((chip) => ({ id: chip.id, label: chip.label, count: chip.count }))]
}

/**
 * 「筛选」：负责人 / 工作流 / 轨道 / 阶段收进一个菜单。图标按钮（文字进 Tooltip），有生效条件时
 * 右上角显示计数徽标；只有一个取值的维度不列。
 */
function FilterMenu({ groups, filter, onFilter }: { groups: readonly FilterMenuGroup[]; filter: TaskFilterState; onFilter: (next: TaskFilterState) => void }): JSX.Element | null {
  const { t } = useT()
  const shown = groups.filter((group) => group.options.length > 2 || filter[group.id] !== 'all')
  const active = groups.filter((group) => filter[group.id] !== 'all').length
  if (shown.length === 0) return null
  return (
    <DropdownMenu>
      <Hint label={t('workspace.filters')}>
        <DropdownMenuTrigger className={MENU_TRIGGER_CLS} data-active={active > 0} aria-label={active > 0 ? `${t('workspace.filters')} ${active}` : t('workspace.filters')} data-testid="task-filter-menu">
          <SlidersHorizontal className="size-4 flex-none" aria-hidden="true" />
          {active > 0 && <span className={MENU_BADGE_CLS} aria-hidden="true" data-testid="task-filter-active">{active}</span>}
        </DropdownMenuTrigger>
      </Hint>
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
                  <CountRoll value={option.count} className="text-caption tabular-nums text-text-3" />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 空态只留 `/tenon` 提示词：对话里发它，路由会先评估再建任务。 */
function EmptyGuide(): JSX.Element {
  const { t } = useT()
  return (
    <div className="grid w-full min-w-0" data-testid="task-list-empty-guide">
      <CommandLine command={t('workspace.guide_prompt')} testId="task-list-empty-prompt" />
    </div>
  )
}

/** 中列：单行筛选（状态分段 + 「筛选」菜单）+ 任务卡，已结束的任务排在进行中之后。 */
export function TaskListPane({
  rows, ended, visibleRows, visibleEnded, endedCount, filter, onFilter, search, onSearch, selectedKey, onSelect, showProject, emptyKind,
  onClearFilters, notice, me, uncommittedDeletions, menuOf,
}: TaskListPaneProps): JSX.Element {
  const { t } = useT()
  const facets = taskFacets(rows, filter, ended)
  const counts = statusCounts(rows, filter, ended)
  const all = t('workspace.filter_all')
  const mine = me === null ? [] : [{ id: me.slug, label: t('workspace.filter_mine'), count: facets.owners.find((chip) => chip.id === me.slug)?.count ?? 0 }]
  const menuGroups: FilterMenuGroup[] = [
    { id: 'owner', label: t('workspace.facet_owner'), mono: false, options: menuOptions(facets.owners.filter((chip) => chip.id !== me?.slug), facetTotal(rows, filter, 'owner', ended), all, mine) },
    { id: 'workflow', label: t('workspace.facet_workflow'), mono: true, options: menuOptions(facets.workflows, facetTotal(rows, filter, 'workflow', ended), all) },
    { id: 'track', label: t('workspace.facet_track'), mono: true, options: menuOptions(facets.tracks, facetTotal(rows, filter, 'track', ended), all) },
    ...(facets.stages === null ? [] : [{ id: 'stage' as const, label: t('workspace.facet_stage'), mono: false, options: menuOptions(facets.stages, facetTotal(rows, filter, 'stage', ended), all) }]),
  ]
  const headAction = uncommittedDeletions > 0 ? (
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
  ) : undefined
  const listed = visibleRows.length + visibleEnded.length
  const items = [
    ...visibleRows.map((row) => ({ key: row.key, row })),
    ...visibleEnded.map((row) => ({ key: row.key, row })),
  ]
  return (
    <ListColumn
      title={t('workspace.title')}
      {...(headAction === undefined ? {} : { action: headAction })}
      search={{ value: search, onChange: onSearch, placeholder: t('workspace.search_tasks'), label: t('workspace.search_tasks') }}
      chips={(
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
      )}
      testId="task-list"
    >
      {notice}
      {listed === 0 && emptyKind === 'compat' ? null : listed === 0 ? (
        <div className="grid justify-items-start gap-3 px-1 py-10" role="status" aria-live="polite" data-testid={`task-list-empty-${emptyKind}`}>
          {emptyKind !== 'no-task' && <p className="text-base font-semibold text-text">{t(`workspace.empty_${emptyKind}`)}</p>}
          {emptyKind === 'no-task' && <EmptyGuide />}
          {emptyKind === 'filtered' && (
            <button type="button" className="min-h-10 rounded-sm border border-border bg-card px-3 text-caption font-semibold text-text-2 hover:bg-fill" onClick={onClearFilters}>
              {t('projects.clear_filters')}
            </button>
          )}
        </div>
      ) : (
        <>
          <ul className="grid" data-testid="task-list-items">
            {items.map((item, index) => {
              const selected = item.key === selectedKey
              const previousSelected = index > 0 && items[index - 1]?.key === selectedKey
              const row = item.row
              return (
                <li key={item.key} className={index > 0 && !selected && !previousSelected ? 'border-t border-border' : undefined}>
                  {'task' in row
                    ? <EndedCard row={row} selected={selected} showProject={showProject} onSelect={() => onSelect(row)} />
                    : <TaskCard row={row} selected={selected} showProject={showProject} onSelect={() => onSelect(row)} menu={menuOf(row)} />}
                </li>
              )
            })}
          </ul>
          {visibleEnded.length > 0 && endedCount.total > endedCount.shown && (
            <p className="whitespace-nowrap px-3.5 py-3 text-caption tabular-nums text-text-3" data-testid="task-ended-count">
              {t('workspace.ended_count', { shown: endedCount.shown, total: endedCount.total })}
            </p>
          )}
        </>
      )}
    </ListColumn>
  )
}
