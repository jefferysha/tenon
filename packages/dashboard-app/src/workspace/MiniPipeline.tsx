import { useT } from '../i18n'
import type { StageState } from './taskModel'
import { cn } from '@/lib/utils'

const SEG_CLS: Record<StageState['status'], string> = {
  done: 'bg-seg-done',
  current: 'bg-seg-now',
  todo: 'bg-seg-next',
}

/** 任务卡上的迷你流水线：每段一个阶段，已完成 / 当前 / 待进行三色。 */
export function MiniPipeline({ stages, testId }: { stages: readonly StageState[]; testId?: string }): JSX.Element {
  const { t } = useT()
  const current = stages.find((stage) => stage.status === 'current')
  return (
    <span
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${Math.max(stages.length, 1)}, minmax(0, 1fr))` }}
      role="img"
      aria-label={current ? t('workspace.rail_label', { stage: current.label }) : t('workspace.rail_label_none')}
      data-testid={testId}
    >
      {stages.map((stage) => (
        <i key={stage.id} className={cn('block h-1.5 rounded-full', SEG_CLS[stage.status])} data-status={stage.status} title={stage.label} />
      ))}
    </span>
  )
}
