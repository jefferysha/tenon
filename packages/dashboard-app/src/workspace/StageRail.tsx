import { useT } from '../i18n'
import type { StageState } from './taskModel'
import { cn } from '@/lib/utils'

const BAR_CLS: Record<StageState['status'], string> = {
  done: 'bg-seg-done',
  current: 'bg-seg-now-t',
  todo: 'bg-seg-next',
}
const LABEL_CLS: Record<StageState['status'], string> = {
  done: 'text-text-2',
  current: 'font-semibold text-seg-now',
  todo: 'text-text-2',
}

/** 右列阶段轨：每段一个阶段，点段 = 查看该阶段的输入 / 输出。 */
export function StageRail({ stages, selected, onSelect }: { stages: readonly StageState[]; selected: string | null; onSelect: (step: string) => void }): JSX.Element {
  const { t } = useT()
  const current = stages.find((stage) => stage.status === 'current')
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${Math.max(stages.length, 1)}, minmax(0, 1fr))` }}
      role="group"
      aria-label={current ? t('workspace.rail_label', { stage: current.label }) : t('workspace.rail_label_none')}
      data-testid="stage-rail"
    >
      {stages.map((stage) => (
        <button
          key={stage.id}
          type="button"
          className="group grid gap-2.5 rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2"
          aria-pressed={selected === stage.id}
          aria-label={`${stage.label} · ${t(`workspace.stage_${stage.status}`)}`}
          data-status={stage.status}
          data-testid={`stage-rail-${stage.id}`}
          onClick={() => onSelect(stage.id)}
        >
          <span className={cn('block h-1 rounded-full transition-opacity group-hover:opacity-80', BAR_CLS[stage.status], selected === stage.id && 'ring-2 ring-(--accent) ring-offset-2 ring-offset-surface-detail')} aria-hidden="true">
            {/* 当前段 = 浅底 + 40% 内填，与任务卡迷你流水线同一读法。 */}
            {stage.status === 'current' && <span className="block h-full w-2/5 rounded-full bg-seg-now" />}
          </span>
          <span className={cn('truncate text-body', LABEL_CLS[stage.status])}>{stage.label}</span>
        </button>
      ))}
    </div>
  )
}
