import { useT } from '../i18n'
import { localTime } from '../model/time'
import { LIST_SELECTED } from '../shared/uiRecipes'
import { StatusPill } from '../shell/ThreeColumns'
import { cn } from '@/lib/utils'
import { resultOf, type EndedRow } from './endedModel'
import { OwnerAvatar, resultTone } from './TaskCard'
import { rootBasename } from './taskModel'

export interface EndedCardProps {
  row: EndedRow
  selected: boolean
  /** 聚合语境（未选项目）时副行带项目名。 */
  showProject: boolean
  onSelect: () => void
}

/** 中列已结束任务卡：名称 + 任务结果 / 项目 · 工作流/轨道 · 结束时间 + 负责人头像。只读，没有 ⋯ 菜单与流水线。 */
export function EndedCard({ row, selected, showProject, onSelect }: EndedCardProps): JSX.Element {
  const { t, lang } = useT()
  const { task, dir } = row
  const result = resultOf(task)
  const flow = task.track === '' ? task.workflow : `${task.workflow}/${task.track}`
  const meta = [showProject ? rootBasename(row.root) : null, flow].filter((part): part is string => part !== null && part !== '').join(' · ')
  const label = t(`workspace.result_${result}`)
  return (
    <button
      type="button"
      className={cn(
        'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-md px-3.5 py-4 text-left outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
        selected && `${LIST_SELECTED} hover:bg-sel-bg`,
      )}
      aria-current={selected ? 'true' : undefined}
      data-summary="ended"
      data-status="ended"
      data-result={result}
      data-testid={`task-card-${dir}`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-title font-semibold text-text" title={task.name}>{task.name}</span>
        <StatusPill tone={resultTone(result)} testId={`task-summary-${dir}`} className="flex-none max-w-[60%]" title={label}>{label}</StatusPill>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-body text-text-2" data-testid={`task-meta-${dir}`}>{meta}</span>
        <span className="flex-none whitespace-nowrap text-caption tabular-nums text-text-3" title={task.endedAt}>{localTime(task.endedAt, lang)}</span>
        {task.owner !== undefined && <OwnerAvatar name={task.owner} testId={`task-owner-${dir}`} />}
      </span>
    </button>
  )
}
