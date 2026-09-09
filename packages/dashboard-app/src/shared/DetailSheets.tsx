import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'

export interface SheetDef<Id extends string = string> {
  readonly id: Id
  readonly label: string
  readonly count?: number
}

/**
 * 右列 sheet 页签：一次只显示一个 sheet。语汇沿模板的下划线 subtab（选中=品牌绿字 + 2px 下划线）。
 * 键盘：左右 / Home / End 在页签间移动并即时切换（roving tabindex）。
 */
export function SheetTabs<Id extends string>({
  sheets,
  active,
  onChange,
  ariaLabel,
  idPrefix,
}: {
  sheets: readonly SheetDef<Id>[]
  active: Id
  onChange: (next: Id) => void
  ariaLabel: string
  idPrefix: string
}): JSX.Element {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = sheets.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
    if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    const target = sheets[next]
    if (!target) return
    onChange(target.id)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[next]?.focus()
  }
  return (
    <div
      className="flex gap-6 overflow-x-auto border-b border-border [scrollbar-width:none]"
      role="tablist"
      aria-label={ariaLabel}
      data-testid={`${idPrefix}-sheets`}
    >
      {sheets.map((sheet, index) => {
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
            className="-mb-px flex-none whitespace-nowrap border-b-2 border-transparent pb-3 text-base font-medium text-text-2 outline-none transition-colors hover:text-text focus-visible:rounded-xs focus-visible:ring-2 focus-visible:ring-(--accent) aria-selected:border-(--accent) aria-selected:font-semibold aria-selected:text-(--accent) motion-reduce:transition-none"
            onClick={() => onChange(sheet.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {sheet.label}
            {sheet.count !== undefined && (
              <span className="ml-1.5 text-body text-text-3 aria-selected:text-(--accent)" aria-hidden="true">{sheet.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * sheet 选择记忆：按 storageKey 存 localStorage；存的值不在当前 sheets 里时回落 fallback
 * （sheet 集合会随对象类型变化——例如工作流页的阶段 / 轨道各有一组）。
 */
export function useSheetState<Id extends string>(
  storageKey: string,
  sheets: readonly SheetDef<Id>[],
  fallback: Id,
): [Id, (next: Id) => void] {
  const valid = useCallback(
    (value: string | null): value is Id => value !== null && sheets.some((sheet) => sheet.id === value),
    [sheets],
  )
  const [active, setActiveState] = useState<Id>(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (valid(stored)) return stored
    } catch {
      /* ignore */
    }
    return fallback
  })
  useEffect(() => {
    if (!valid(active)) setActiveState(fallback)
  }, [active, fallback, valid])
  const setActive = useCallback((next: Id) => {
    setActiveState(next)
    try {
      localStorage.setItem(storageKey, next)
    } catch {
      /* ignore */
    }
  }, [storageKey])
  return [valid(active) ? active : fallback, setActive]
}
