import { FileText, Hash } from 'lucide-react'
import { useT } from '../i18n'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import type { IoRow, IoRowStatus } from './stageIo'
import { slotLabel } from './taskModel'
import { cn } from '@/lib/utils'
import { LIST_SELECTED } from '../shared/uiRecipes'

const STATUS_TONE: Record<IoRowStatus, PillTone> = {
  recorded: 'done',
  unread: 'done',
  set: 'done',
  stale: 'pending',
  missing: 'blocked',
  unset: 'neutral',
}

const COLS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6.5rem] items-center gap-4 whitespace-nowrap'

export interface StageIoPanelProps {
  /** 当前 sheet 显示哪一侧。 */
  direction: 'inputs' | 'outputs'
  items: readonly IoRow[]
  activePath: string | null
  onOpen: (path: string) => void
  definitionState: 'loading' | 'ready' | 'error'
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 来源技能：已登记取最近一次的登记者，缺失取应产出它的技能，值槽位取声明的 producer。 */
function sourceSkills(item: IoRow): string {
  if (item.slot.kind === 'field') return item.slot.producer ?? ''
  if (item.producer !== null && item.status !== 'missing') return item.producer
  return item.producers.join(', ')
}

/** 行 title：路径或值，加最近一次登记的人与时间。 */
function rowTitle(item: IoRow): string {
  return [item.path ?? (item.value === '' ? null : item.value), item.actor ?? null, item.at === null ? null : formatTime(item.at)]
    .filter((part): part is string => part !== null && part !== '').join(' · ')
}

/**
 * 所选阶段的一张 IO sheet（输入或输出）：带表头的表 文件 · 来源技能 · 状态，行间一条细分隔线。
 * 可阅读的行整行可点开抽屉（文件格里的按钮承担键盘路径）。标题由 sheet 页签承担。
 */
export function StageIoPanel({ direction, items, activePath, onOpen, definitionState }: StageIoPanelProps): JSX.Element {
  const { t } = useT()
  const single = direction === 'outputs' ? 'output' : 'input'

  function row(item: IoRow): JSX.Element {
    const label = slotLabel(item.slot, t)
    const skills = sourceSkills(item)
    const Icon = item.slot.kind === 'field' && item.slot.type !== 'file_path' ? Hash : FileText
    const path = item.path
    const title = rowTitle(item)
    return (
      <div
        key={`${item.slot.kind}:${item.slot.id}`}
        className={cn(COLS, 'min-h-11 border-b border-border px-1 py-1.5 text-body', path !== null && 'cursor-pointer hover:bg-fill', path !== null && activePath === path && LIST_SELECTED)}
        role="row"
        title={title === '' ? undefined : title}
        data-testid={`stage-${single}-${item.slot.kind}-${item.slot.id}`}
        data-status={item.status}
        onClick={path === null ? undefined : () => onOpen(path)}
      >
        <span className="flex min-w-0 items-center gap-2" role="cell">
          <Icon className="size-4 flex-none text-text-3" aria-hidden="true" />
          {path === null ? (
            <span className="truncate font-semibold text-text">{label}</span>
          ) : (
            <button
              type="button"
              className="min-w-0 truncate rounded-xs text-left font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
              aria-pressed={activePath === path}
              data-testid={`stage-${single}-open-${item.slot.id}`}
              onClick={(event) => { event.stopPropagation(); onOpen(path) }}
            >
              {label}
            </button>
          )}
        </span>
        <span className={cn('truncate font-mono text-caption', skills === '' ? 'text-text-3' : 'text-text-2')} role="cell" title={skills === '' ? undefined : skills}>
          {skills === '' ? '—' : skills}
        </span>
        <span
          className="min-w-0"
          role="cell"
          {...(item.reason === null ? {} : { title: t(`workspace.stale_${item.reason.replace('-', '_')}`), 'data-reason': item.reason })}
        >
          <StatusPill tone={STATUS_TONE[item.status]}>{t(`workspace.status_${item.status}`)}</StatusPill>
        </span>
      </div>
    )
  }

  return (
    <section data-testid={`stage-${direction}`}>
      {definitionState === 'loading' ? (
        <p className="text-body text-text-3" role="status">{t('common.loading')}</p>
      ) : definitionState === 'error' ? (
        <p className="text-body text-red-d" role="alert">{t('workspace.definition_error')}</p>
      ) : (
        <div className="grid min-w-0" role="table" aria-label={t(`workspace.${direction}`)}>
          <div className={cn(COLS, 'border-b border-border px-1 pb-2 text-caption text-text-3')} role="row" data-testid={`stage-${direction}-head`}>
            <span role="columnheader">{t('workspace.io_col_file')}</span>
            <span role="columnheader">{t('workspace.io_col_skill')}</span>
            <span role="columnheader">{t('workspace.io_col_status')}</span>
          </div>
          {items.length === 0
            ? <p className="py-3 text-body text-text-3" role="status">{t('workspace.none')}</p>
            : items.map(row)}
        </div>
      )}
    </section>
  )
}
