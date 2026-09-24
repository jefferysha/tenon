import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { handleRadioKey } from './radioKeyboard'
import { SLIDING_INDICATOR_CLS, useSlidingIndicator } from './useSlidingIndicator'

/**
 * 单选筛选芯片的样式；FacetBar 的测量层用同一串类读出芯片自然宽度。
 * 选中底色不画在芯片上，由所在 FilterChipGroup 的共享指示块滑过去；悬停底只给未选中项。
 */
export const FILTER_CHIP_CLS = 'inline-flex min-h-10 flex-none items-center gap-1 whitespace-nowrap rounded-sm px-2 text-body font-medium text-text-2 outline-none enabled:aria-[checked=false]:hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:font-semibold aria-checked:text-(--accent)'

/** 方向键 / Home / End 在同组芯片间移动并选中（单选语义）。组 = 最近的 radiogroup。 */
function onChipKey(event: KeyboardEvent<HTMLButtonElement>): void {
  const group = event.currentTarget.closest('[role="radiogroup"]')
  if (group === null) return
  const chips = Array.from(group.querySelectorAll<HTMLButtonElement>('[data-filter-chip]')).filter((chip) => !chip.disabled)
  const index = chips.indexOf(event.currentTarget)
  if (index < 0) return
  handleRadioKey(event, index, chips.length, (next) => {
    const target = chips[next]
    if (target !== undefined && target.getAttribute('aria-checked') !== 'true') target.click()
  })
}

/** 单选芯片组：role=radiogroup + 可访问名；单行，不换行。选中底色是组内一块共享指示块，切换时滑动。 */
export function FilterChipGroup({
  label,
  children,
  className,
  testId,
}: {
  label: string
  children: ReactNode
  className?: string
  testId?: string
}): JSX.Element {
  const { containerRef, indicatorRef } = useSlidingIndicator<HTMLDivElement>()
  return (
    <div ref={containerRef} className={cn('relative isolate flex flex-none flex-nowrap items-center gap-1', className)} role="radiogroup" aria-label={label} data-testid={testId}>
      {children}
      <span ref={indicatorRef} className={cn(SLIDING_INDICATOR_CLS, 'rounded-sm bg-accent-t')} aria-hidden="true" data-testid={testId === undefined ? undefined : `${testId}-indicator`} />
    </div>
  )
}

/** 筛选芯片（全部 5 / 需要你 2 …）：role=radio；选中=绿字，底色由组内指示块提供；只有选中项在 Tab 序列里。 */
export function FilterChip({
  label,
  count,
  selected,
  focusable,
  onClick,
  testId,
}: {
  label: string
  count?: number
  selected: boolean
  /** 缺省 = selected。组内选中项不可见（收进「更多」）时由调用方让首项可聚焦。 */
  focusable?: boolean
  onClick: () => void
  testId: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={(focusable ?? selected) ? 0 : -1}
      className={FILTER_CHIP_CLS}
      data-filter-chip=""
      data-testid={testId}
      onClick={onClick}
      onKeyDown={onChipKey}
    >
      {label}
      {count !== undefined && <span className={cn('text-caption tabular-nums', selected ? 'text-(--accent)' : 'text-text-3')}>{count}</span>}
    </button>
  )
}
