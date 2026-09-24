import { useT } from '../i18n'
import type { StageState } from './taskModel'
import { cn } from '@/lib/utils'

/** 与 StageRail 同一套段：已完成 = 成功绿，当前 = 强调色，未到 = 边框灰。 */
const SEG_CLS: Record<StageState['status'], string> = {
  done: 'bg-green',
  current: 'bg-(--accent)',
  todo: 'bg-border',
}

/**
 * 任务卡上的迷你流水线：每段一个阶段，段 4px 高、段间 2px，静态（列表卡不播动画）。
 * 只有一个阶段的工作流不画分段条（一段满条读起来像 100%）。
 */
export function MiniPipeline({ stages, testId }: { stages: readonly StageState[]; testId?: string }): JSX.Element | null {
  const { t } = useT()
  const current = stages.find((stage) => stage.status === 'current')
  if (stages.length <= 1) return null
  return (
    <span
      className="grid gap-x-0.5"
      style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
      role="img"
      aria-label={current ? t('workspace.rail_label', { stage: current.label }) : t('workspace.rail_label_none')}
      data-testid={testId}
    >
      {stages.map((stage) => (
        <i key={stage.id} className={cn('block h-1', SEG_CLS[stage.status])} data-status={stage.status} title={stage.label} />
      ))}
    </span>
  )
}
