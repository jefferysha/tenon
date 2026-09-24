import { Fragment, type KeyboardEvent, type ReactElement } from 'react'
import type { SheetDef } from '../shared/DetailSheets'
import { SEGMENT_SLIDE_S, SEGMENT_THUMB_CLS, useSlidingIndicator } from '../shared/useSlidingIndicator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface SegmentDef<Id extends string> extends SheetDef<Id> {
  /** 不可选：仍可聚焦（好读到提示），但点击与方向键都跳过。 */
  readonly disabled?: boolean
  /** 悬停 / 聚焦时的说明（Tooltip）。 */
  readonly hint?: string
}

function withHint(hint: string | undefined, button: ReactElement): ReactElement {
  if (hint === undefined) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className="whitespace-nowrap">{hint}</TooltipContent>
    </Tooltip>
  )
}

/**
 * 分段控件形态的页签（fill 轨道 + 白色滑块，与设置弹层的分段控件同一语汇）。语义仍是 tablist：
 * 左右 / Home / End 在可选段之间移动并即时切换（roving tabindex）。各段等宽，白色滑块用共享的
 * useSlidingIndicator（GSAP Flip 0.18s；reduced-motion 下直接到位）。
 */
export function SegmentTabs<Id extends string>({
  sheets, active, onChange, ariaLabel, idPrefix, controls,
}: {
  sheets: readonly SegmentDef<Id>[]
  active: Id
  onChange: (next: Id) => void
  ariaLabel: string
  idPrefix: string
  /** 受控面板的 id；缺省 `${idPrefix}-panel`。 */
  controls?: string
}): JSX.Element {
  const { containerRef, indicatorRef } = useSlidingIndicator<HTMLDivElement>({ duration: SEGMENT_SLIDE_S })
  const enabled = sheets.map((sheet, at) => (sheet.disabled === true ? -1 : at)).filter((at) => at >= 0)
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, at: number): void {
    const position = enabled.indexOf(at)
    const last = enabled.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight') next = position === last || position < 0 ? 0 : position + 1
    if (event.key === 'ArrowLeft') next = position <= 0 ? last : position - 1
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    const index = enabled[next]
    const target = index === undefined ? undefined : sheets[index]
    if (index === undefined || target === undefined) return
    onChange(target.id)
    event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
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
        const disabled = sheet.disabled === true
        return <Fragment key={sheet.id}>{withHint(sheet.hint, (
          <button
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${sheet.id}`}
            aria-selected={selected}
            aria-disabled={disabled || undefined}
            aria-controls={controls ?? `${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            data-testid={`${idPrefix}-tab-${sheet.id}`}
            className={cn(
              'relative inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-sm px-4 text-caption font-semibold text-text-2 outline-none transition-colors duration-(--dur-fast) ease-(--ease-out) hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)',
              selected && 'text-text',
              disabled && 'cursor-not-allowed text-text-4 hover:text-text-4',
            )}
            onClick={() => { if (!disabled) onChange(sheet.id) }}
            onKeyDown={(event) => onKeyDown(event, at)}
          >
            {sheet.label}
          </button>
        ))}</Fragment>
      })}
      <span ref={indicatorRef} className={SEGMENT_THUMB_CLS} aria-hidden="true" data-testid={`${idPrefix}-thumb`} />
    </div>
  )
}
