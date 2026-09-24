import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 方向键在同组芯片间移动并选中（单选语义）。组 = 最近的 radiogroup；尚未迁移的调用方仍用
 * tablist 或 ListColumn 芯片行包裹，同样认。
 */
function onChipKey(event: KeyboardEvent<HTMLButtonElement>): void {
  const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const self = event.currentTarget
  const group = self.closest('[role="radiogroup"]') ?? self.closest('[role="tablist"]') ?? self.closest('[data-chip-group]')
  if (group === null) return
  const chips = Array.from(group.querySelectorAll<HTMLButtonElement>('[data-filter-chip]'))
    .filter((chip) => !chip.disabled)
  const index = chips.indexOf(self)
  if (index < 0 || chips.length === 0) return
  const count = chips.length
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? count - 1
      : event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (index + 1) % count
        : (index - 1 + count) % count
  event.preventDefault()
  const target = chips[next]
  if (target === undefined) return
  target.focus()
  if (target.getAttribute('aria-checked') !== 'true') target.click()
}

/** 单选芯片组：role=radiogroup + 可访问名；芯片之间用方向键切换。 */
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
  return (
    <div className={cn('flex items-center gap-1', className)} role="radiogroup" aria-label={label} data-testid={testId}>
      {children}
    </div>
  )
}

/** 筛选芯片（全部 5 / 需要你 2 …）：role=radio；选中=浅绿底绿字；只有选中项在 Tab 序列里。 */
export function FilterChip({
  label,
  count,
  selected,
  onClick,
  testId,
}: {
  label: string
  count?: number
  selected: boolean
  onClick: () => void
  testId: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      className="inline-flex min-h-10 items-center rounded-sm px-3 py-1.5 text-base font-medium whitespace-nowrap text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:bg-accent-t aria-checked:font-semibold aria-checked:text-(--accent)"
      data-filter-chip=""
      data-testid={testId}
      onClick={onClick}
      onKeyDown={onChipKey}
    >
      {label}
      {count !== undefined && <span className={cn('ml-1 text-body', selected ? 'text-(--accent)' : 'text-text-3')}>{count}</span>}
    </button>
  )
}
