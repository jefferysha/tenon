import type { KeyboardEvent } from 'react'
import type { SheetDef } from '../shared/DetailSheets'
import { cn } from '@/lib/utils'

/**
 * 分段控件形态的页签（fill 轨道 + 白色滑块，与设置弹层的分段控件同一语汇）。语义仍是 tablist：
 * 左右 / Home / End 移动并即时切换（roving tabindex）。各段等宽，滑块按选中序号 translateX，
 * 用 CSS 过渡（reduced-motion 下不位移动画）。
 */
export function SegmentTabs<Id extends string>({
  sheets, active, onChange, ariaLabel, idPrefix,
}: {
  sheets: readonly SheetDef<Id>[]
  active: Id
  onChange: (next: Id) => void
  ariaLabel: string
  idPrefix: string
}): JSX.Element {
  const index = Math.max(0, sheets.findIndex((sheet) => sheet.id === active))
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, at: number): void {
    const last = sheets.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight') next = at === last ? 0 : at + 1
    if (event.key === 'ArrowLeft') next = at === 0 ? last : at - 1
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    const target = sheets[next]
    if (target === undefined) return
    onChange(target.id)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }
  return (
    <div
      className="relative inline-grid auto-cols-fr grid-flow-col rounded-sm bg-fill p-0.5"
      role="tablist"
      aria-label={ariaLabel}
      data-testid={`${idPrefix}-sheets`}
    >
      <span
        className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-sm bg-card shadow-sm transition-transform duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none"
        style={{ width: `calc((100% - 4px) / ${sheets.length})`, transform: `translateX(${index * 100}%)` }}
        aria-hidden="true"
        data-testid={`${idPrefix}-thumb`}
      />
      {sheets.map((sheet, at) => {
        const selected = sheet.id === active
        return (
          <button
            key={sheet.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${sheet.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            data-testid={`${idPrefix}-tab-${sheet.id}`}
            className={cn(
              'relative inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-sm px-4 text-caption font-semibold text-text-2 outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)',
              selected && 'text-text',
            )}
            onClick={() => onChange(sheet.id)}
            onKeyDown={(event) => onKeyDown(event, at)}
          >
            {sheet.label}
          </button>
        )
      })}
    </div>
  )
}
