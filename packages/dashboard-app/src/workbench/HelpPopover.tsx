import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOBILE_HIT } from './workbenchStyles'

export function HelpPopover({
  label,
  children,
  compact = false,
}: {
  label: string
  children: ReactNode
  compact?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])
  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={contentId}
        className={cn(
          'grid place-items-center rounded-full text-text-3 outline-none transition-colors hover:bg-fill hover:text-text-2 focus-visible:ring-3 focus-visible:ring-accent-t',
          MOBILE_HIT,
          compact ? 'size-7' : 'size-9',
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <CircleHelp className={compact ? 'size-3.5' : 'size-4'} aria-hidden="true" />
      </button>
      {open && (
        <span
          id={contentId}
          data-testid="help-popover-content"
          className="absolute top-full left-1/2 z-50 mt-2 w-72 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2.5 text-left text-caption font-normal leading-relaxed whitespace-normal text-text-2 shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  )
}
