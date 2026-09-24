import type { KeyboardEvent } from 'react'
import type { SheetDef } from '../shared/DetailSheets'
import { SEGMENT_SLIDE_S, SEGMENT_THUMB_CLS, useSlidingIndicator } from '../shared/useSlidingIndicator'
import { cn } from '@/lib/utils'

/**
 * 分段控件形态的页签（fill 轨道 + 白色滑块，与设置弹层的分段控件同一语汇）。语义仍是 tablist：
 * 左右 / Home / End 移动并即时切换（roving tabindex）。各段等宽，白色滑块用共享的
 * useSlidingIndicator（GSAP Flip 0.18s；reduced-motion 下直接到位）。
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
  const { containerRef, indicatorRef } = useSlidingIndicator<HTMLDivElement>({ duration: SEGMENT_SLIDE_S })
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
      ref={containerRef}
      className="relative isolate inline-grid auto-cols-fr grid-flow-col rounded-sm bg-fill p-0.5"
      role="tablist"
      aria-label={ariaLabel}
      data-testid={`${idPrefix}-sheets`}
    >
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
      <span ref={indicatorRef} className={SEGMENT_THUMB_CLS} aria-hidden="true" data-testid={`${idPrefix}-thumb`} />
    </div>
  )
}
