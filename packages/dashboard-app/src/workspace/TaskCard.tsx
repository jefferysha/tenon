import { useT } from '../i18n'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { MiniPipeline } from './MiniPipeline'
import { TaskMenu, type TaskMenuEntry } from './TaskMenu'
import { rootBasename, statusOf, summaryText, type TaskRow, type TaskStatus } from './taskModel'
import { cn } from '@/lib/utils'
import { LIST_SELECTED } from '../shared/uiRecipes'


/**
 * 语义色跟随状态筛选的分组：需要你 = 琥珀，进行中 = 信息蓝，已完成 = 中性。出口阻断属于 agent 侧
 * 的工作量而非故障，用警示琥珀；红色只留给真正的错误 / 失败。
 */
const STATUS_TONE: Record<Exclude<TaskStatus, 'all'>, PillTone> = {
  'needs-you': 'pending',
  running: 'running',
  done: 'neutral',
}

export function summaryTone(row: TaskRow): PillTone {
  if (row.summary.kind === 'blocked') return 'pending'
  return STATUS_TONE[statusOf(row.summary)]
}

/** 负责人头像：首字母圆标，名字放 title。 */
export function OwnerAvatar({ name, testId }: { name: string; testId?: string }): JSX.Element {
  return (
    <span
      className="grid size-6 flex-none place-items-center rounded-full bg-fill text-micro font-semibold text-text-2"
      title={name}
      role="img"
      aria-label={name}
      data-testid={testId}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

export interface TaskCardProps {
  row: TaskRow
  selected: boolean
  /** 聚合语境（未选项目）时副行带项目名。 */
  showProject: boolean
  onSelect: () => void
  /** ⋯ 菜单项；空 = 不渲染菜单。 */
  menu: readonly TaskMenuEntry[]
}

/** 中列任务卡：名称 + 状态 / 项目 · 工作流/轨道 + 负责人头像 / 迷你流水线 + ⋯。 */
export function TaskCard({ row, selected, showProject, onSelect, menu }: TaskCardProps): JSX.Element {
  const { t } = useT()
  const change = row.change
  const flow = change.track === '' ? row.workflow : `${row.workflow}/${change.track}`
  const meta = [showProject ? rootBasename(row.root) : null, flow].filter((part): part is string => part !== null && part !== '').join(' · ')
  const summary = summaryText(row, t)
  return (
    <div className="relative">
    <button
      type="button"
      className={cn(
        'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-md px-3.5 py-4 text-left outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
        selected && `${LIST_SELECTED} hover:bg-sel-bg`,
      )}
      aria-current={selected ? 'true' : undefined}
      data-summary={row.summary.kind}
      data-status={statusOf(row.summary)}
      data-owner={row.owner?.slug ?? ''}
      data-testid={`task-card-${change.name}`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-title font-semibold text-text" title={change.name}>{change.name}</span>
        <StatusPill tone={summaryTone(row)} testId={`task-summary-${change.name}`} className="flex-none max-w-[60%]" title={summary}>{summary}</StatusPill>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-body text-text-2" data-testid={`task-meta-${change.name}`}>{meta}</span>
        {row.owner !== null && <OwnerAvatar name={row.owner.name} testId={`task-owner-${change.name}`} />}
      </span>
      <span className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1"><MiniPipeline stages={row.stages} testId={`task-pipeline-${change.name}`} /></span>
        <span className="size-7 flex-none" aria-hidden="true" />
      </span>
    </button>
    <TaskMenu items={menu} testId={`task-card-menu-${change.name}`} className="absolute right-1.5 bottom-2" />
    </div>
  )
}
