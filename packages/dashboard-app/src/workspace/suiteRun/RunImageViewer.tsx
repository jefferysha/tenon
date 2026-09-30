import { useEffect } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useT } from '../../i18n'
import { BUTTON_ICON } from '../../shared/uiRecipes'
import { runHref, type RunContext } from './runContext'

function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * 截图放大查看：Radix Dialog（焦点困笼、Esc 只关最上层）。左右方向键在同一套件的截图之间切换，
 * 图片的替代文字就是文件名。查看器不做缩放手势，只把原图撑满可视区。
 */
export function RunImageViewer({ images, current, ctx, onChange, onClose }: {
  images: readonly string[]
  current: string | null
  ctx: RunContext
  onChange: (path: string) => void
  onClose: () => void
}): JSX.Element | null {
  const { t } = useT()
  const index = current === null ? -1 : images.indexOf(current)
  useEffect(() => {
    if (index < 0) return
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const next = images[(index + (event.key === 'ArrowRight' ? 1 : images.length - 1)) % images.length]
      if (next !== undefined) {
        event.preventDefault()
        onChange(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images, onChange])
  if (current === null || index < 0) return null
  const name = nameOf(current)
  const step = (delta: number): void => {
    const next = images[(index + delta + images.length) % images.length]
    if (next !== undefined) onChange(next)
  }
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPrimitive.Portal container={document.body}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-scrim/70" data-testid="run-viewer-scrim" onClick={onClose} />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-6 z-[60] grid grid-rows-[auto_minmax(0,1fr)] gap-3 rounded-lg bg-surface-raised p-4 shadow-(--shadow-3) outline-none"
          data-testid="run-viewer"
        >
          <div className="flex min-w-0 items-center gap-2">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-body text-text" title={current}>{name}</DialogPrimitive.Title>
            <span className="whitespace-nowrap text-caption tabular-nums text-text-3" data-testid="run-viewer-position">{index + 1} / {images.length}</span>
            <button type="button" className={BUTTON_ICON} aria-label={t('tests.run.artifact.prev')} data-testid="run-viewer-prev" disabled={images.length < 2} onClick={() => step(-1)}>
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <button type="button" className={BUTTON_ICON} aria-label={t('tests.run.artifact.next')} data-testid="run-viewer-next" disabled={images.length < 2} onClick={() => step(1)}>
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
            <button type="button" className={BUTTON_ICON} aria-label={t('tests.run.artifact.close')} data-testid="run-viewer-close" onClick={onClose}>
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="grid min-h-0 place-items-center overflow-auto">
            <img src={runHref(ctx, current)} alt={name} className="max-h-full max-w-full object-contain" data-testid="run-viewer-image" />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
