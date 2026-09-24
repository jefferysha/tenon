import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { X } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'
import { BUTTON_ICON } from './uiRecipes'

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

/* 遮罩 180ms 淡入 / 160ms 淡出；面板从右侧 24px 滑入 + 淡入 240ms，退场 160ms。reduced-motion 由 index.css 只留淡入淡出。 */
const SCRIM_MOTION =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-(--dur-base) data-[state=open]:ease-(--ease-out) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-[160ms] data-[state=closed]:ease-(--ease-exit)'
const PANEL_MOTION =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-6 data-[state=open]:duration-(--dur-panel) data-[state=open]:ease-(--ease-out) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-6 data-[state=closed]:duration-[160ms] data-[state=closed]:ease-(--ease-exit)'

/**
 * 右侧抽屉（Radix Dialog）：覆盖在右列上，任务上下文仍可见。Radix 负责焦点困笼、分层 Esc 与退场动画；
 * 本组件只补两件事：遮罩点击才关闭（面板外的其他浮层不算），关闭后把焦点还给打开前的元素
 * （调用方没有 Radix Trigger，Radix 自己不会归还）。
 */
export function Drawer({ open, onClose, title, actions, children, testId = 'drawer', ariaLabel, width = 'md' }: DrawerProps): JSX.Element {
  const { t } = useT()
  const previousFocus = useRef<HTMLElement | null>(null)

  // 布局阶段记录：Radix 在子树 effect 里才把焦点移进面板。
  useLayoutEffect(() => {
    if (open) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      {/* 显式 container：内容与调用方同一次提交挂载。 */}
      <DialogPrimitive.Portal container={document.body}>
        <DialogPrimitive.Overlay
          className={cn('fixed inset-0 z-50 bg-scrim/40', SCRIM_MOTION)}
          data-testid={`${testId}-scrim`}
          onClick={onClose}
        />
        <DialogPrimitive.Content
          aria-modal="true"
          aria-describedby={undefined}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex h-full max-w-full flex-col rounded-l-lg bg-surface-raised shadow-(--shadow-3) outline-none',
            PANEL_MOTION,
            width === 'lg' ? 'w-[min(960px,92vw)]' : 'w-[560px]',
            'max-[900px]:w-full',
          )}
          data-testid={testId}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const previous = previousFocus.current
            if (previous?.isConnected) previous.focus()
          }}
        >
          <DialogPrimitive.Title className="sr-only">{ariaLabel}</DialogPrimitive.Title>
          <header className="flex flex-none items-center gap-3 border-b border-border px-5 py-2">
            <div className="min-w-0 flex-1">{title}</div>
            {actions}
            <button type="button" className={cn(BUTTON_ICON, 'flex-none')} aria-label={t('common.dialog_close')} data-testid={`${testId}-close`} onClick={onClose}>
              <X className="size-4" aria-hidden="true" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
