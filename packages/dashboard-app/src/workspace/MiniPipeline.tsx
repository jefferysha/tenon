import { useT } from '../i18n'
import type { StageState } from './taskModel'
import { cn } from '@/lib/utils'

const SEG_CLS: Record<StageState['status'], string> = {
  done: 'bg-seg-done',
  current: 'bg-seg-now-t',
  todo: 'bg-seg-next',
}

/**
 * 任务卡上的迷你流水线：每段一个阶段，已完成 / 当前 / 待进行三色。当前段是浅底 + 40% 内填，
 * 读作「正在做」而不是「做完」；只有一个阶段的工作流不画分段条（一段满条读起来像 100%）。
 */
export function MiniPipeline({ stages, testId }: { stages: readonly StageState[]; testId?: string }): JSX.Element | null {
  const { t } = useT()
  if (stages.length <= 1) return null
  const current = stages.find((stage) => stage.status === 'current')
  return (
    <span
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
      role="img"
      aria-label={current ? t('workspace.rail_label', { stage: current.label }) : t('workspace.rail_label_none')}
      data-testid={testId}
    >
      {stages.map((stage) => (
        <i key={stage.id} className={cn('block h-1.5 overflow-hidden rounded-full', SEG_CLS[stage.status])} data-status={stage.status} title={stage.label}>
          {stage.status === 'current' && <i className="block h-full w-2/5 rounded-full bg-seg-now" data-testid={testId === undefined ? undefined : `${testId}-now`} />}
        </i>
      ))}
    </span>
  )
}
