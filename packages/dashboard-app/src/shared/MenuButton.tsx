import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
  /** 禁用原因 / 悬停说明。 */
  title?: string
  danger?: boolean
  /** 给了就是开关项（role=menuitemcheckbox），勾选态显示对勾。 */
  checked?: boolean
}

/**
 * 「⋯」按钮 + `role=menu` 弹层。点按钮开合，Esc / 点到外面关闭，选中一项后关闭。
 * 只做行内动作菜单，不做键盘 roving（项目里菜单都在 2–3 项）。
 */
export function MenuButton({ items, label, testId, align = 'right', className, disabled }: {
  items: readonly MenuItem[]
  label: string
  testId: string
  align?: 'left' | 'right'
  className?: string
  disabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        className="grid size-7 place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:bg-fill aria-expanded:text-text"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        disabled={disabled}
        data-testid={testId}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value) }}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <div className={cn('absolute top-[calc(100%+4px)] z-40 min-w-[180px] rounded-md border border-border bg-card p-1 shadow-lg', align === 'right' ? 'right-0' : 'left-0')} role="menu" aria-label={label} data-testid={`${testId}-menu`}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              className={cn('flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-body outline-none hover:bg-fill focus-visible:bg-fill disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent', item.danger ? 'text-red-d' : 'text-text')}
              disabled={item.disabled}
              title={item.title}
              data-testid={`${testId}-${item.id}`}
              onClick={() => { setOpen(false); item.onSelect() }}
            >
              {item.icon !== undefined && <span className="flex-none text-text-3 [&_svg]:size-4" aria-hidden="true">{item.icon}</span>}
              {item.label}
              {item.checked === true && <Check className="ml-auto size-4 flex-none text-(--accent)" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
