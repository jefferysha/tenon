import { useT } from '../i18n'
import type { StageExec } from './workspaceModel'
import { cn } from '@/lib/utils'

const BAR_CLS: Record<StageExec['status'], string> = {
  done: 'bg-seg-done',
  current: 'bg-seg-now',
  failed: 'bg-red',
  pending: 'bg-seg-next',
}
const LABEL_CLS: Record<StageExec['status'], string> = {
  done: 'text-text-2',
  current: 'font-semibold text-seg-now',
  failed: 'font-semibold text-red-d',
  pending: 'text-text-2',
}

/** 六段阶段轨：已完成深绿 / 当前橙 / 受阻红 / 未开始浅灰；点段 = 选中该阶段。 */
export function PhaseRail({ stages, selected, onSelect }: { stages: readonly StageExec[]; selected: string | null; onSelect: (step: string) => void }): JSX.Element {
  const { t } = useT()
  const current = stages.find((stage) => stage.status === 'current' || stage.status === 'failed')
  return (
    <div
      className="grid gap-2.5"
      role="group"
      aria-label={current ? t('workspace.rail_label', { stage: current.label }) : t('workspace.rail_label_none')}
      data-testid="phase-rail"
    >
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
        {stages.map((stage) => (
          <button
            key={stage.step}
            type="button"
            className="group grid gap-2.5 rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2"
            aria-pressed={selected === stage.step}
            aria-label={`${stage.label} · ${t(`workspace.stage_${stage.status}`)}`}
            data-status={stage.status}
            data-testid={`phase-rail-${stage.step}`}
            onClick={() => onSelect(stage.step)}
          >
            <span className={cn('block h-1 rounded-full transition-opacity group-hover:opacity-80', BAR_CLS[stage.status], selected === stage.step && 'ring-2 ring-(--accent) ring-offset-2 ring-offset-surface-detail')} aria-hidden="true" />
            <span className={cn('truncate text-body', LABEL_CLS[stage.status])}>{stage.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
