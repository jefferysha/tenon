import { Check, ChevronRight, X } from 'lucide-react'
import { useT } from '../i18n'
import type { ChangeSnapshot } from '../types'
import { formatReadinessBlocker } from '../model/progressModel'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { chipProduced, type StageExec } from './workspaceModel'
import { cn } from '@/lib/utils'

const TONE: Record<StageExec['status'], PillTone> = { done: 'done', current: 'pending', failed: 'blocked', pending: 'neutral' }
const DOT: Record<StageExec['status'], string> = {
  done: 'bg-seg-done ring-seg-done',
  current: 'bg-seg-now ring-seg-now',
  failed: 'bg-red ring-red',
  pending: 'bg-seg-next ring-seg-next',
}

export interface StageExecutionListProps {
  change: ChangeSnapshot
  stages: readonly StageExec[]
  expanded: string | null
  onToggle: (step: string) => void
  onCopy: (value: string) => void
}

/**
 * 阶段执行列表：每个 stage 一行——状态点 / 阶段名 + key / 摘要（产出与门禁）/ 状态 pill。
 * 展开一行 = 该阶段的产出字段（已产出可复制、未产出虚线占位）、tasks.md 条目、当前阶段的推进阻塞原因。
 */
export function StageExecutionList({ change, stages, expanded, onToggle, onCopy }: StageExecutionListProps): JSX.Element {
  const { t } = useT()
  const readiness = change.workflowExecution.readinessByTransition
  return (
    <ul className="grid gap-1.5" data-testid="stage-exec-list">
      {stages.map((stage) => {
        const produced = stage.outputs.filter(chipProduced)
        const open = expanded === stage.step
        const summary = [
          produced.length > 0
            ? t('workspace.stage_outputs', { fields: produced.map((chip) => chip.key).join('、') })
            : stage.outputs.length > 0
              ? t('workspace.stage_outputs_pending', { fields: stage.outputs.map((chip) => chip.key).join('、') })
              : t('workspace.stage_no_outputs'),
          stage.gate === 'review' ? t('workspace.stage_gate_review') : stage.gate === 'confirm' ? t('workspace.stage_gate_confirm') : null,
          stage.tasks.length > 0 ? t('workspace.stage_tasks', { done: stage.tasks.filter((task) => task.completed).length, total: stage.tasks.length }) : null,
        ].filter((part): part is string => part !== null).join(' · ')
        const blockers = stage.status === 'current' || stage.status === 'failed'
          ? Object.entries(readiness[stage.step] ?? {}).flatMap(([event, state]) => state.ready ? [] : state.blockers.map((blocker) => ({ event, text: formatReadinessBlocker(blocker) })))
          : []
        const active = stage.status === 'current' || stage.status === 'failed'
        return (
          <li
            key={stage.step}
            className={cn('rounded-md border', active ? 'border-sel-border bg-sel-bg' : 'border-border bg-card')}
            data-status={stage.status}
            data-testid={`stage-exec-${stage.step}`}
          >
            <button
              type="button"
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
              aria-expanded={open}
              aria-controls={`stage-exec-panel-${stage.step}`}
              onClick={() => onToggle(stage.step)}
            >
              <span className={cn('size-2.5 rounded-full ring-1 ring-offset-2 ring-offset-card', DOT[stage.status])} aria-hidden="true" />
              <span className="min-w-0">
                <span className="flex items-baseline gap-2 text-base font-semibold text-text">
                  {stage.label}
                  <span className="font-mono text-caption font-normal text-text-2">{stage.step}</span>
                </span>
                <span className="block truncate text-caption text-text-2">{summary}</span>
              </span>
              <StatusPill tone={TONE[stage.status]}>{t(`workspace.stage_${stage.status}`)}</StatusPill>
              <ChevronRight className={cn('size-4 text-text-3 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden="true" />
            </button>
            {open && (
              <div id={`stage-exec-panel-${stage.step}`} className="grid gap-3 border-t border-border px-3.5 py-3" data-testid={`stage-exec-panel-${stage.step}`}>
                {stage.outputs.length > 0 ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-1.5">
                    {stage.outputs.map((chip) => (
                      <div
                        key={chip.key}
                        className={cn('min-w-0 rounded-sm border px-2.5 py-1.5', chipProduced(chip) ? 'border-border bg-bg' : 'border-dashed border-border')}
                        data-state={chipProduced(chip) ? 'set' : 'miss'}
                        data-testid={`stage-output-${stage.step}-${chip.key}`}
                      >
                        <div className="font-mono text-micro text-text-3">{chip.key}</div>
                        {!chipProduced(chip) ? (
                          <div className="text-caption text-text-3">{t('evidence.unset')}</div>
                        ) : (
                          <button
                            type="button"
                            className="block w-full truncate text-left font-mono text-caption text-text hover:text-(--accent)"
                            title={chip.value}
                            onClick={() => onCopy(chip.value)}
                          >
                            {chip.value}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-caption text-text-3">{t('workspace.stage_no_outputs')}</p>
                )}
                {stage.tasks.length > 0 && (
                  <ul className="grid gap-1 text-body">
                    {stage.tasks.map((task, index) => (
                      <li key={`${stage.step}-${index}`} className="flex items-start gap-2 text-text-2">
                        {task.completed
                          ? <Check className="mt-1 size-3.5 flex-none text-green-d" aria-hidden="true" />
                          : <span className="mt-1.5 size-2.5 flex-none rounded-full border border-border-2" aria-hidden="true" />}
                        <span className={cn(task.completed && 'text-text-3 line-through')}>{task.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {blockers.length > 0 && (
                  <ul className="grid gap-1 rounded-sm border border-amber-b bg-amber-t px-3 py-2 text-caption text-amber-d" data-testid={`stage-blockers-${stage.step}`}>
                    {blockers.map((blocker) => (
                      <li key={`${blocker.event}-${blocker.text}`} className="flex items-start gap-1.5">
                        <X className="mt-0.5 size-3 flex-none" aria-hidden="true" />
                        <span><span className="font-mono">{blocker.event}</span> · {blocker.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
