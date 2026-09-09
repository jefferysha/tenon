import { ChevronRight, FileText, GitBranch } from 'lucide-react'
import { useT } from '../i18n'
import { StatusPill } from '../shell/ThreeColumns'
import { rootBasename, rowBadgeOf, stepLabel, type FlatRow } from './taskRows'
import { nextStepLabel, producedCount } from './workspaceModel'
import { cn } from '@/lib/utils'

export interface TaskCardProps {
  row: FlatRow
  selected: boolean
  /** 聚合语境（未选项目）时卡片副行带项目名，否则只显示 workflow · track。 */
  showProject: boolean
  onSelect: () => void
}

/** 中列任务卡：标题 + 状态 pill / slug / 阶段 · 文件数 · 下一步 · chevron。选中=浅蓝灰底 + 左侧粗边。 */
export function TaskCard({ row, selected, showProject, onSelect }: TaskCardProps): JSX.Element {
  const { t } = useT()
  const change = row.row.change
  const badge = rowBadgeOf(row, t)
  const files = producedCount(change, row.rules)
  const slug = [showProject ? rootBasename(row.row.root) : null, row.workflow, change.track]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' · ')
  return (
    <button
      type="button"
      className={cn(
        'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-md border border-transparent px-3.5 py-4 text-left outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
        selected && 'border-sel-border border-l-[3px] border-l-sel-edge bg-sel-bg pl-3 hover:bg-sel-bg',
      )}
      aria-current={selected ? 'true' : undefined}
      data-state={row.row.state}
      data-testid={`task-card-${change.name}`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-title font-semibold text-text">{change.name}</span>
        <span className="min-w-0 max-w-[55%] truncate"><StatusPill tone={badge.tone} testId={`task-badge-${change.name}`}>{badge.text}</StatusPill></span>
      </span>
      <span className="truncate font-mono text-body text-text-2">{slug}</span>
      <span className="flex min-w-0 items-center gap-3.5 text-body text-text-2">
        <span className="flex flex-none items-center gap-1.5"><GitBranch className="size-3.5 text-text-3" aria-hidden="true" />{stepLabel(change.phase, row.rules, t)}</span>
        <span className="flex flex-none items-center gap-1.5"><FileText className="size-3.5 text-text-3" aria-hidden="true" />{t('workspace.files', { n: files })}</span>
        <span className="min-w-0 flex-1 truncate">{row.archived ? t('workspace.state_archived_lead') : nextStepLabel(change, row.rules, t)}</span>
        <ChevronRight className="size-3.5 flex-none text-text-3" aria-hidden="true" />
      </span>
    </button>
  )
}
