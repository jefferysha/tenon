import type { ReactNode } from 'react'
import { FileText } from 'lucide-react'
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
 * 等分三列表（输入 / 输出同构，纵向对齐）：文件 · 来源阶段 · 来源技能。表头常显，行只放数据；
 * 来源技能为空显示「—」。
 */
export function IoTable({ direction, rows, empty }: { direction: 'inputs' | 'outputs'; rows: readonly IoRow[]; empty: ReactNode }): JSX.Element {
  const { t } = useT()
  const cols = 'grid-cols-3'
  return (
    <div className="grid" data-testid={`io-${direction}`}>
      <div className={cn('grid gap-4 border-b border-border pb-2 text-caption text-text-3', cols)} role="row">
        <span>{t('workflow.col_file')}</span>
        <span>{t('workflow.col_stage')}</span>
        <span>{t('workflow.col_skill')}</span>
      </div>
      {rows.length === 0 ? (
        <div className="py-3 text-body text-text-3" role="status">{empty}</div>
      ) : rows.map(({ slot, stage, skills, path }) => (
        <div key={`${slot.kind}:${slot.id}`} className={cn('grid items-center gap-4 border-b border-border py-2.5 text-body', cols)} title={path} data-testid={`slot-${slot.kind}-${slot.id}`}>
          <span className="flex min-w-0 items-center gap-2 font-mono font-semibold text-text">
            <FileText className="size-4 flex-none text-text-3" aria-hidden="true" />
            <span className="truncate">{slot.id}</span>
          </span>
          <span className="truncate text-text" data-testid={`slot-stage-${slot.id}`}>{stage ?? '—'}</span>
          <span className={cn('truncate font-mono', skills.length === 0 ? 'text-text-3' : 'text-text-2')} data-testid={`slot-skills-${slot.id}`}>{skills.length === 0 ? '—' : skills.join(', ')}</span>
        </div>
      ))}
    </div>
  )
}
