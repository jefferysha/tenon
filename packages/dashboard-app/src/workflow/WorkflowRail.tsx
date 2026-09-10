import { ChevronDown, ChevronRight, Download, FileUp, GitBranch, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { WbWorkflowSource } from '../api/governanceTypes'
import { useT } from '../i18n'
import { RailCard, RailColumn, RailFootLink } from '../shell/ThreeColumns'
import { BASE_BRANCH } from '../workbench/workbenchDefinition'
import { cn } from '@/lib/utils'

export interface WorkflowRailProps {
  names: readonly string[]
  current: string | null
  defaultSource: WbWorkflowSource
  stagesCountOf: (name: string) => number | null
  /** 当前工作流的分支（'' = 通用）；未加载完时为空数组。 */
  branches: ReadonlyArray<{ id: string; label: string | null }>
  branch: string
  collapsed: boolean
  canWrite: boolean
  busy: boolean
  onToggle: () => void
  onSwitch: (name: string) => void
  onSwitchBranch: (branch: string) => void
  onCreate: () => void
  onImport: () => void
  onExport: () => void
  onDelete: () => void
  onNewTrack: () => void
  onDeleteTrack: () => void
}

/**
 * 工作流页左列：工作流卡（default 恒在，标来源）；当前工作流展开为分支树——「通用」+ 每条 track，
 * 点分支切换中列流水线。底部：新建 / 导入 / 导出 / 删除工作流，新建 / 删除轨道。
 */
export function WorkflowRail({
  names, current, defaultSource, stagesCountOf, branches, branch, collapsed, canWrite, busy,
  onToggle, onSwitch, onSwitchBranch, onCreate, onImport, onExport, onDelete, onNewTrack, onDeleteTrack,
}: WorkflowRailProps): JSX.Element {
  const { t } = useT()
  const isDefault = current === 'default'
  const deleteLabel = isDefault ? t('workflow.restore_default') : t('workflow.delete_workflow')
  const deleteEnabled = canWrite && !busy && current !== null && (!isDefault || defaultSource === 'project')
  const noToken = canWrite ? undefined : t('workflow.no_token')
  const trackCount = Math.max(branches.length - 1, 0)
  return (
    <RailColumn
      title={t('workflow.rail_title')}
      collapsed={collapsed}
      onToggle={onToggle}
      testId="workflow-rail"
      footer={(
        <>
          <RailFootLink icon={<Plus />} label={t('workflow.new_workflow')} collapsed={collapsed} testId="wb-workflow-new" disabled={!canWrite || busy} title={noToken} onClick={onCreate} />
          <RailFootLink icon={<GitBranch />} label={t('workflow.new_track')} collapsed={collapsed} testId="wb-track-new" disabled={!canWrite || busy || current === null} title={noToken} onClick={onNewTrack} />
          <RailFootLink icon={<FileUp />} label={t('workflow.import_yaml')} collapsed={collapsed} testId="wb-workflow-import" disabled={!canWrite || busy} title={noToken} onClick={onImport} />
          <RailFootLink icon={<Download />} label={t('workflow.export_yaml')} collapsed={collapsed} testId="wb-workflow-export" disabled={current === null} onClick={onExport} />
          {branch !== BASE_BRANCH && (
            <RailFootLink icon={<Trash2 />} label={t('workflow.delete_track')} collapsed={collapsed} testId="wb-track-delete" disabled={!canWrite || busy} title={noToken} onClick={onDeleteTrack} />
          )}
          <RailFootLink icon={isDefault ? <RotateCcw /> : <Trash2 />} label={deleteLabel} collapsed={collapsed} testId={isDefault ? 'wb-workflow-restore-default' : 'wb-workflow-delete'} disabled={!deleteEnabled} title={noToken} onClick={onDelete} />
        </>
      )}
    >
      <ul className="grid gap-1" data-testid="workflow-rail-list">
        {names.map((name) => {
          const count = stagesCountOf(name)
          const source = name === 'default' ? defaultSource : 'project'
          const expanded = name === current
          return (
            <li key={name}>
              <RailCard
                mark={name.slice(0, 1).toUpperCase()}
                name={name}
                meta={expanded && trackCount > 0 ? t('workflow.branches_meta', { n: trackCount }) : undefined}
                count={count ?? undefined}
                selected={expanded}
                collapsed={collapsed}
                tag={(
                  <>
                    <span className="rounded-full bg-fill px-1.5 text-micro font-medium text-text-2" data-testid={`wb-wf-source-${name}`}>{t(`workflow.source_${source}`)}</span>
                    {!collapsed && (expanded ? <ChevronDown className="size-3.5 text-text-3" aria-hidden="true" /> : <ChevronRight className="size-3.5 text-text-3" aria-hidden="true" />)}
                  </>
                )}
                testId={`wb-wf-item-${name}`}
                onClick={() => { if (!busy) onSwitch(name) }}
              />
              {expanded && !collapsed && branches.length > 0 && (
                <ul className="ml-11 mt-1 grid gap-0.5 border-l border-border pl-3 max-[1279px]:hidden max-[900px]:grid" data-testid={`wb-wf-branches-${name}`} aria-label={t('workflow.tracks_title')}>
                  {branches.map((candidate) => {
                    const active = candidate.id === branch
                    return (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)', active ? 'bg-accent-t font-semibold text-(--accent)' : 'text-text-2')}
                          aria-current={active ? 'true' : undefined}
                          data-testid={`wb-branch-${candidate.id === BASE_BRANCH ? 'base' : candidate.id}`}
                          onClick={() => { if (!busy) onSwitchBranch(candidate.id) }}
                        >
                          <GitBranch className="size-3.5 flex-none" aria-hidden="true" />
                          <span className="truncate">{candidate.label ?? t('workflow.branch_base')}</span>
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
