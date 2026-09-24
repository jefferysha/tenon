import type { ReactNode } from 'react'
import { FileText, X } from 'lucide-react'
import type { WbIoSlot } from '../api/governanceTypes'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'

/** 一行槽位：来源阶段（输入 = 产出它的上游阶段，输出 = 本阶段）与来源技能（可能为空）。 */
export interface IoRow {
  slot: WbIoSlot
  stage: string | undefined
  skills: readonly string[]
  /** YAML 位置，放在行 title 上。 */
  path: string
}

/**
 * 等分三列表（输入 / 输出同构，纵向对齐）：文件 · 来源阶段 · 来源技能。不列读取阶段。表头常显，
 * 空格子显示「—」；等宽字只用于文件名。
 * 给了 onRemove 时每行末尾多一条 40px 的列放「×」，悬停或聚焦该行时才显出（字段槽位由 YAML 决定，不给 ×）。
 */
export function IoTable({ direction, rows, empty, onRemove }: {
  direction: 'inputs' | 'outputs'
  rows: readonly IoRow[]
  empty: ReactNode
  onRemove?: (slot: WbIoSlot) => void
}): JSX.Element {
  const { t } = useT()
  const cols = onRemove === undefined ? 'grid-cols-3' : 'grid-cols-[repeat(3,minmax(0,1fr))_2.5rem]'
  return (
    <div className="grid" role="table" aria-label={t(direction === 'inputs' ? 'workflow.inputs_title' : 'workflow.outputs_title')} data-testid={`io-${direction}`}>
      <div className={cn('grid gap-4 whitespace-nowrap border-b border-border pb-2 text-caption text-text-3', cols)} role="row">
        <span role="columnheader">{t('workflow.col_file')}</span>
        <span role="columnheader">{t('workflow.col_stage')}</span>
        <span role="columnheader">{t('workflow.col_skill')}</span>
        {onRemove !== undefined && <span aria-hidden="true" />}
      </div>
      {rows.length === 0 ? (
        <div className="py-3 text-body text-text-3" role="status">{empty}</div>
      ) : rows.map(({ slot, stage, skills, path }) => (
        <div key={`${slot.kind}:${slot.id}`} className={cn('group grid min-h-10 items-center gap-4 whitespace-nowrap border-b border-border py-1 text-body', cols)} role="row" title={path} data-testid={`slot-${slot.kind}-${slot.id}`}>
          <span className="flex min-w-0 items-center gap-2 font-mono font-semibold text-text" role="cell">
            <FileText className="size-4 flex-none text-text-3" aria-hidden="true" />
            <span className="truncate">{slot.id}</span>
          </span>
          <span className={cn('truncate', stage === undefined ? 'text-text-3' : 'text-text')} role="cell" data-testid={`slot-stage-${slot.id}`}>{stage ?? '—'}</span>
          <span className={cn('truncate', skills.length === 0 ? 'text-text-3' : 'text-text-2')} role="cell" data-testid={`slot-skills-${slot.id}`}>{skills.length === 0 ? '—' : skills.join(', ')}</span>
          {onRemove !== undefined && (
            <span className="grid justify-end" role="cell">
              {slot.kind === 'document' && (
                <button
                  type="button"
                  className="grid size-8 place-items-center rounded-sm text-text-3 opacity-0 outline-none transition-opacity hover:bg-red-t hover:text-red-d focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-(--accent) group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={t('workflow.remove_slot', { id: slot.id })}
                  data-testid={`slot-remove-${slot.id}`}
                  onClick={() => onRemove(slot)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
