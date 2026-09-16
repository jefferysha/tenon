import { Archive, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { MenuButton } from '../shared/MenuButton'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { MiniPipeline } from './MiniPipeline'
import { rootBasename, summaryText, type TaskRow } from './taskModel'
import { cn } from '@/lib/utils'

const TONE: Record<TaskRow['summary']['kind'], PillTone> = {
  missing: 'pending',
  review: 'blocked',
  ready: 'done',
  running: 'running',
  completed: 'neutral',
}

export interface TaskCardProps {
  row: TaskRow
  selected: boolean
  /** 聚合语境（未选项目）时副行带项目名。 */
  showProject: boolean
  onSelect: () => void
  /** 缺省 = 只读卡（聚合语境）：不渲染 归档 / 删除 菜单。 */
  onAction?: (action: 'archive' | 'delete') => void
}

/** 中列任务卡：名称 / 工作流 · 轨道 / 迷你流水线 / 一行数据状态 + 归档 / 删除 菜单。 */
export function TaskCard({ row, selected, showProject, onSelect, onAction }: TaskCardProps): JSX.Element {
  const { t } = useT()
  const change = row.change
  const slug = [showProject ? rootBasename(row.root) : null, row.workflow, change.track, row.owner?.name ?? null]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' · ')
  return (
    <div className="relative">
    <button
      type="button"
      className={cn(
        'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-md border border-transparent px-3.5 py-4 text-left outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
        selected && 'border-sel-border border-l-[3px] border-l-sel-edge bg-sel-bg pl-3 hover:bg-sel-bg',
      )}
      aria-current={selected ? 'true' : undefined}
      data-summary={row.summary.kind}
      data-owner={row.owner?.slug ?? ''}
      data-testid={`task-card-${change.name}`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-title font-semibold text-text" title={change.name}>{change.name}</span>
        <StatusPill tone={TONE[row.summary.kind]} testId={`task-summary-${change.name}`} className="flex-none max-w-[60%]" title={summaryText(row, t)}>{summaryText(row, t)}</StatusPill>
      </span>
      <span className="truncate font-mono text-body text-text-2">{slug}</span>
      <span className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1"><MiniPipeline stages={row.stages} testId={`task-pipeline-${change.name}`} /></span>
        <span className="size-7 flex-none" aria-hidden="true" />
      </span>
    </button>
    {onAction !== undefined && (
      <MenuButton
        className="absolute bottom-3.5 right-2.5"
        label={t('workspace.task_actions')}
        testId={`task-card-menu-${change.name}`}
        items={[
          { id: 'archive', label: t('workspace.archive'), icon: <Archive />, onSelect: () => onAction('archive') },
          { id: 'delete', label: t('workspace.delete'), icon: <Trash2 />, danger: true, onSelect: () => onAction('delete') },
        ]}
      />
    )}
    </div>
  )
}
