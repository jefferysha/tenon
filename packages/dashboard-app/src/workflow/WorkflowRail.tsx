import { Download, GitBranch, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import type { WbWorkflowSource } from '../api/governanceTypes'
import { useT } from '../i18n'
import { MenuButton } from '../shared/MenuButton'
import { RailColumn } from '../shell/ThreeColumns'
import { BASE_BRANCH } from '../workbench/workbenchDefinition'
import { cn } from '@/lib/utils'

export interface WorkflowRailProps {
  names: readonly string[]
  current: string | null
  defaultSource: WbWorkflowSource
  stagesCountOf: (name: string) => number | null
  /** 当前工作流的分支（'' = 单条 pipeline）；未加载完时为空数组。 */
  branches: ReadonlyArray<{ id: string; label: string | null }>
  branch: string
  collapsed: boolean
  canWrite: boolean
  busy: boolean
  onToggle: () => void
  onSwitch: (name: string) => void
  onSwitchBranch: (branch: string) => void
  /** 标题旁的「+」：新建工作流对话框（复制 / 空白 / 导入 YAML 三种模式）。 */
  onCreate: () => void
  onExport: () => void
  onDelete: () => void
  onNewTrack: () => void
  onDeleteTrack: (trackId: string) => void
}

const HIDE_NARROW = 'max-[1279px]:hidden max-[900px]:flex'

/**
 * 工作流页左列。标题旁「+」新建工作流；当前工作流行内：「+」新建轨道、「⋯」导出 / 删除（default 为恢复内建）；
 * 其下每条轨道一行（`label ?? id`），行内「×」删除该轨道。没有底部动作清单。
 */
export function WorkflowRail({
  names, current, defaultSource, stagesCountOf, branches, branch, collapsed, canWrite, busy,
  onToggle, onSwitch, onSwitchBranch, onCreate, onExport, onDelete, onNewTrack, onDeleteTrack,
}: WorkflowRailProps): JSX.Element {
  const { t } = useT()
  const noToken = canWrite ? undefined : t('workflow.no_token')
  const tracks = branches.filter((candidate) => candidate.id !== BASE_BRANCH)
  return (
    <RailColumn
      title={t('workflow.rail_title')}
      collapsed={collapsed}
      onToggle={onToggle}
      testId="workflow-rail"
      headerAction={(
        <button
          type="button"
          className="grid size-8 place-items-center rounded-sm border border-border bg-card text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('workflow.new_workflow')}
          title={noToken ?? t('workflow.new_workflow')}
          disabled={!canWrite || busy}
          data-testid="wb-workflow-new"
          onClick={onCreate}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      )}
    >
      <ul className="grid gap-1" data-testid="workflow-rail-list">
        {names.map((name) => {
          const count = stagesCountOf(name)
          const source = name === 'default' ? defaultSource : 'project'
          const selected = name === current
          const isDefault = name === 'default'
          const deleteEnabled = canWrite && !busy && (!isDefault || defaultSource === 'project')
          return (
            <li key={name} className="grid gap-1">
              <div
                className={cn(
                  'group grid items-center rounded-md border transition-colors',
                  selected ? 'border-accent-b bg-accent-t' : 'border-transparent hover:bg-fill',
                  collapsed ? 'grid-cols-1 justify-items-center' : 'grid-cols-[minmax(0,1fr)_auto] pr-1.5 max-[1279px]:grid-cols-1 max-[1279px]:justify-items-center max-[1279px]:pr-0 max-[900px]:grid-cols-[minmax(0,1fr)_auto] max-[900px]:pr-1.5',
                )}
                data-testid={`wb-wf-row-${name}`}
              >
                <button
                  type="button"
                  className={cn(
                    'grid min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)',
                    collapsed ? 'grid-cols-1 p-2' : 'grid-cols-[auto_minmax(0,1fr)_auto] px-3 py-3 max-[1279px]:grid-cols-1 max-[1279px]:p-2 max-[900px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[900px]:px-3 max-[900px]:py-3',
                  )}
                  aria-current={selected ? 'true' : undefined}
                  title={collapsed ? name : undefined}
                  data-testid={`wb-wf-item-${name}`}
                  onClick={() => { if (!busy) onSwitch(name) }}
                >
                  <span className={cn('grid size-8 place-items-center rounded-sm border bg-card text-body font-semibold', selected ? 'border-accent-b text-(--accent)' : 'border-border text-text-2')} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
                  {!collapsed && (
                    <>
                      <span className="min-w-0 max-[1279px]:hidden max-[900px]:block">
                        <span className={cn('flex items-center gap-1.5 text-base font-semibold', selected ? 'text-(--accent)' : 'text-text')}>
                          <span className="truncate">{name}</span>
                          <span className="rounded-full bg-fill px-1.5 text-micro font-medium text-text-2" data-testid={`wb-wf-source-${name}`}>{t(`workflow.source_${source}`)}</span>
                        </span>
                        {selected && tracks.length > 0 && <span className="block text-caption text-text-2 max-[900px]:hidden">{t('workflow.branches_meta', { n: tracks.length })}</span>}
                      </span>
                      {count !== null && <span className={cn('font-mono text-body max-[1279px]:hidden max-[900px]:inline', selected ? 'text-(--accent)' : 'text-text-3')}>{count}</span>}
                    </>
                  )}
                </button>
                {selected && !collapsed && (
                  <span className={cn('flex items-center gap-0.5', HIDE_NARROW)} data-testid={`wb-wf-actions-${name}`}>
                    <button
                      type="button"
                      className="grid size-7 place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={t('workflow.new_track')}
                      title={noToken ?? t('workflow.new_track')}
                      disabled={!canWrite || busy}
                      data-testid={`wb-track-new-${name}`}
                      onClick={onNewTrack}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </button>
                    <MenuButton
                      testId={`wb-wf-menu-${name}`}
                      label={t('workflow.workflow_menu')}
                      disabled={busy}
                      items={[
                        { id: 'export', label: t('workflow.export_yaml'), icon: <Download />, onSelect: onExport },
                        isDefault
                          ? { id: 'restore', label: t('workflow.restore_default'), icon: <RotateCcw />, onSelect: onDelete, disabled: !deleteEnabled, title: noToken }
                          : { id: 'delete', label: t('workflow.delete_workflow'), icon: <Trash2 />, onSelect: onDelete, disabled: !deleteEnabled, title: noToken, danger: true },
                      ]}
                    />
                  </span>
                )}
              </div>
              {selected && !collapsed && tracks.length > 0 && (
                <ul className={cn('ml-6 grid gap-0.5 border-l border-border pl-2.5', HIDE_NARROW, 'max-[900px]:flex-col')} data-testid={`wb-wf-branches-${name}`} aria-label={t('workflow.tracks_title')}>
                  {tracks.map((candidate) => {
                    const active = candidate.id === branch
                    const label = candidate.label ?? candidate.id
                    return (
                      <li key={candidate.id} className="group/track grid grid-cols-[minmax(0,1fr)_auto] items-center gap-0.5">
                        <button
                          type="button"
                          className={cn('flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)', active ? 'bg-accent-t font-semibold text-(--accent)' : 'text-text-2')}
                          aria-current={active ? 'true' : undefined}
                          data-testid={`wb-branch-${candidate.id}`}
                          onClick={() => { if (!busy) onSwitchBranch(candidate.id) }}
                        >
                          <GitBranch className="size-3.5 flex-none" aria-hidden="true" />
                          <span className="truncate">{label}</span>
                        </button>
                        <button
                          type="button"
                          className={cn('grid size-6 place-items-center rounded-xs text-text-3 outline-none transition-opacity hover:bg-fill hover:text-red-d focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-30', active ? 'opacity-100' : 'opacity-0 group-hover/track:opacity-100')}
                          aria-label={`${t('workflow.delete_track')} ${label}`}
                          title={noToken ?? t('workflow.delete_track')}
                          disabled={!canWrite || busy}
                          data-testid={`wb-track-delete-${candidate.id}`}
                          onClick={() => onDeleteTrack(candidate.id)}
                        >
                          <X className="size-3.5" aria-hidden="true" />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </RailColumn>
  )
}
