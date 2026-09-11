import { Trash2 } from 'lucide-react'
import type { WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'

export interface TransitionTarget {
  id: string
  label: string
}

/**
 * 等分两列表加行尾删除：事件 · 去向。与 IoTable 同一套表头 / 行节奏，读起来是右栏的同一种东西。
 *
 * 去向选靠前阶段就是回流——「该阶段验收不通过，退回上一轮修问题」。这里不给回流加标签也不分区：
 * 左栏那条虚线弧已经把它画出来了，同一件事不说两遍。
 */
export function TransitionTable({ step, targets, editable, onEvent, onTo, onRemove }: {
  step: WbStepDef
  targets: readonly TransitionTarget[]
  editable: boolean
  onEvent: (index: number, event: string) => void
  onTo: (index: number, to: string) => void
  onRemove: (index: number) => void
}): JSX.Element {
  const { t } = useT()
  const cols = 'grid-cols-[1fr_1fr_2rem]'
  return (
    <div className="grid" data-testid="transitions-table">
      <div className={cn('grid gap-4 border-b border-border pb-2 text-caption text-text-3', cols)} role="row">
        <span>{t('workflow.col_event')}</span>
        <span>{t('workflow.col_to')}</span>
        <span />
      </div>
      {step.transitions.length === 0 ? (
        <div className="py-3 text-body text-text-3" role="status" data-testid="transitions-empty">{t('workflow.no_transitions')}</div>
      ) : step.transitions.map((transition, index) => (
        <div key={index} className={cn('grid items-center gap-4 border-b border-border py-2.5 text-body', cols)} data-testid={`transition-${index}`}>
          <input
            className="min-w-0 rounded-xs border-b border-transparent bg-transparent pb-0.5 font-mono font-semibold text-text outline-none transition-colors hover:border-border focus:border-accent-b disabled:cursor-default disabled:hover:border-transparent"
            value={transition.event}
            disabled={!editable}
            aria-label={t('workflow.col_event')}
            data-testid={`transition-event-${index}`}
            onChange={(event) => onEvent(index, event.target.value)}
          />
          <select
            className="min-w-0 max-w-full justify-self-start truncate rounded-xs border-b border-transparent bg-transparent pb-0.5 pr-1 text-text outline-none transition-colors hover:border-border focus:border-accent-b disabled:cursor-default disabled:hover:border-transparent"
            value={transition.to}
            disabled={!editable}
            aria-label={t('workflow.col_to')}
            data-testid={`transition-to-${index}`}
            onChange={(event) => onTo(index, event.target.value)}
          >
            {targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
          </select>
          <button
            type="button"
            className="grid size-8 place-items-center rounded-sm text-text-3 outline-none hover:bg-red-t hover:text-red-d focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!editable}
            aria-label={t('workflow.delete_transition', { event: transition.event })}
            title={t('workflow.delete_transition', { event: transition.event })}
            data-testid={`transition-remove-${index}`}
            onClick={() => onRemove(index)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
