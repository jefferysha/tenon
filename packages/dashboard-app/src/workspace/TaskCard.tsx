import { ChevronRight } from 'lucide-react'
import { useT } from '../i18n'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { MiniPipeline } from './MiniPipeline'
import { rootBasename, summaryText, type TaskRow } from './taskModel'
import { cn } from '@/lib/utils'

const TONE: Record<TaskRow['summary']['kind'], PillTone> = {
  missing: 'pending',
  review: 'blocked',
  ready: 'done',
  running: 'running',
  archived: 'neutral',
}

export interface TaskCardProps {
  row: TaskRow
  selected: boolean
  /** 聚合语境（未选项目）时副行带项目名。 */
  showProject: boolean
  onSelect: () => void
}

/** 中列任务卡：名称 / 工作流 · 轨道 / 迷你流水线 / 一行数据状态。 */
export function TaskCard({ row, selected, showProject, onSelect }: TaskCardProps): JSX.Element {
  const { t } = useT()
  const change = row.change
  const slug = [showProject ? rootBasename(row.root) : null, row.workflow, change.track]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' · ')
  return (
    <button
      type="button"
      className={cn(
        'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-md border border-transparent px-3.5 py-4 text-left outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
        selected && 'border-sel-border border-l-[3px] border-l-sel-edge bg-sel-bg pl-3 hover:bg-sel-bg',
      )}
      aria-current={selected ? 'true' : undefined}
      data-summary={row.summary.kind}
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
        <ChevronRight className="size-3.5 flex-none text-text-3" aria-hidden="true" />
      </span>
    </button>
  )
}
