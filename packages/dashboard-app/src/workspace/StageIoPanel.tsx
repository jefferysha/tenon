import { FileText, Hash } from 'lucide-react'
import { useT } from '../i18n'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { fileName, type IoRow, type IoRowStatus } from './stageIo'
import { slotLabel } from './taskModel'
import { cn } from '@/lib/utils'

const STATUS_TONE: Record<IoRowStatus, PillTone> = {
  recorded: 'done',
  unread: 'done',
  set: 'done',
  stale: 'pending',
  missing: 'blocked',
  unset: 'neutral',
}

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

/** 所选阶段的一张 IO sheet（输入或输出）：每行一个槽位，文件行可点开抽屉。标题由 sheet 页签承担。 */
export function StageIoPanel({ direction, items, activePath, onOpen, definitionState }: StageIoPanelProps): JSX.Element {
  const { t } = useT()
  const single = direction === 'outputs' ? 'output' : 'input'

  function row(item: IoRow, direction: 'output' | 'input'): JSX.Element {
    const label = slotLabel(item.slot, t)
    const meta = item.slot.kind === 'document'
      ? [item.path === null ? null : fileName(item.path), item.producer, item.actor ?? null, item.at === null ? null : formatTime(item.at)].filter((part): part is string => part !== null && part !== '').join(' · ')
      : item.value === '' ? '' : item.slot.type === 'file_path' ? fileName(item.value) : item.value
    const Icon = item.slot.kind === 'field' && item.slot.type !== 'file_path' ? Hash : FileText
    const clickable = item.path !== null
    const testId = `stage-${direction}-${item.slot.kind}-${item.slot.id}`
    const body = (
      <>
        <Icon className="size-4 flex-none text-text-3" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block truncate text-base font-semibold text-text">{label}</span>
          {meta !== '' && <span className="block truncate font-mono text-caption text-text-2">{meta}</span>}
        </span>
        <StatusPill tone={STATUS_TONE[item.status]} className="flex-none">{t(`workspace.status_${item.status}`)}</StatusPill>
      </>
    )
    const cls = 'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-4 py-3 text-left'
    return (
      <li key={`${item.slot.kind}:${item.slot.id}`}>
        {clickable ? (
          <button
            type="button"
            className={cn(cls, 'bg-card outline-none hover:border-accent-b focus-visible:ring-2 focus-visible:ring-(--accent)', activePath === item.path ? 'border-accent-b bg-accent-t' : 'border-border')}
            aria-pressed={activePath === item.path}
            data-testid={testId}
            data-status={item.status}
            onClick={() => onOpen(item.path as string)}
          >
            {body}
          </button>
        ) : (
          <div className={cn(cls, item.status === 'missing' || item.status === 'unset' ? 'border-dashed border-border' : 'border-border bg-card')} data-testid={testId} data-status={item.status}>
            {body}
          </div>
        )}
      </li>
    )
  }

  return (
    <section data-testid={`stage-${direction}`}>
      {definitionState === 'loading' ? (
        <p className="text-body text-text-3" role="status">{t('common.loading')}</p>
      ) : definitionState === 'error' ? (
        <p className="text-body text-red-d" role="alert">{t('workspace.definition_error')}</p>
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-5 text-center text-body text-text-3" role="status">{t('workspace.none')}</p>
      ) : (
        <ul className="grid gap-2">{items.map((item) => row(item, single))}</ul>
      )}
    </section>
  )
}
