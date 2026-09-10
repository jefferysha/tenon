import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** 标题右侧的动作（上一份 / 下一份等）。 */
  actions?: ReactNode
  children: ReactNode
  testId?: string
  /** 无障碍名称（title 为复杂节点时必填）。 */
  ariaLabel: string
  /** md = 560px（文档 / 槽位）；lg = 960px（技能详情：文件树 + 正文）。 */
  width?: 'md' | 'lg'
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * 右侧抽屉：覆盖在右列上，任务上下文仍可见。Esc / 遮罩关闭；焦点进入面板，关闭后还原。
 */
export function Drawer({ open, onClose, title, actions, children, testId = 'drawer', ariaLabel, width = 'md' }: DrawerProps): JSX.Element | null {
  const { t } = useT()
  const panelRef = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel)?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusable.length === 0) { event.preventDefault(); panel.focus(); return }
      const head = focusable[0]
      const tail = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail?.focus() } else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head?.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previousFocus.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" data-testid={`${testId}-root`}>
      <button type="button" className="flex-1 cursor-default bg-scrim/40" aria-label={t('common.dialog_close')} tabIndex={-1} onClick={onClose} />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn('flex h-full max-w-full flex-col border-l border-border bg-card shadow-lg outline-none', width === 'lg' ? 'w-[min(960px,92vw)]' : 'w-[560px]', 'max-[900px]:w-full')}
        data-testid={testId}
      >
        <header className="flex flex-none items-center gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0 flex-1">{title}</div>
          {actions}
          <button type="button" className="grid size-8 flex-none place-items-center rounded-sm text-text-3 hover:bg-fill hover:text-text" aria-label={t('common.dialog_close')} data-testid={`${testId}-close`} onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </section>
    </div>,
    document.body,
  )
}
