import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { AlertDialog as AlertDialogPrimitive, Dialog as DialogPrimitive } from 'radix-ui'
import { X } from 'lucide-react'
import { useT } from '../i18n'
import { BUTTON_ICON } from './uiRecipes'

/**
 * 唯一的模态对话框：Radix Dialog（`role="dialog"`）或 Radix AlertDialog（`role="alertdialog"`，
 * 破坏性确认用）。Radix 负责 portal、焦点困笼、分层 Esc（只有最上层响应）、`aria-labelledby`
 * 指向标题、背景 `aria-hidden` 与滚动锁；本组件只补 Radix 没有的三件事：
 *
 * ① 焦点进出：打开时聚焦 `initialFocusRef` 或容器内首个可聚焦元素；卸载时同步把焦点还给
 *    打开前的元素——调用方总是条件渲染本组件（没有 Radix Trigger），Radix 自己不会归还焦点。
 *    打开前元素已不可用时，交给仍然打开的最上层对话框。
 * ② 背景点击：Content 嵌在 Overlay 里，只有点到 Overlay 本身（非冒泡）才关闭；
 *    alertdialog 不因背景点击关闭，只能显式选择。
 * ③ `DialogInteractionBoundary`：外层守卫接管时整层 `inert` + `aria-hidden`，点击、按键、
 *    提交在捕获阶段被吞掉，Esc 不关闭；权限回来时若焦点无处可去，重新落回本层。
 */
export interface DialogProps {
  title: string
  onClose: () => void            // Esc / backdrop 都走它（✕ 由调用方按需放入 actions）
  children: React.ReactNode
  actions?: React.ReactNode      // 底部动作条（调用方放确认/取消按钮）
  testid?: string
  /** `alertdialog` 用于破坏性确认：背景点击不关闭。 */
  role?: 'dialog' | 'alertdialog'
  /** Localized accessible label for the workspace close icon. */
  closeLabel?: string
  /** Stable test hook for the workspace close icon when a caller already exposes one. */
  closeTestid?: string
  /** Keep the workspace close surface visibly and semantically unavailable during atomic work. */
  closeDisabled?: boolean
  /** 少数编排型对话框需要更宽的工作面；缺省 480px。 */
  panelClassName?: string
  /** 大型编辑器使用沉浸式工作区骨架；普通确认框保持 default。 */
  variant?: 'default' | 'workspace'
  /** 首个聚焦目标：缺省聚焦对话框容器内第一个可聚焦元素 */
  initialFocusRef?: React.RefObject<HTMLElement>
  /**
   * 缺省 true：调用方条件渲染时只有进场动画。保持挂载并传 false 时，Radix Presence 等退场动画
   * （120ms）播完再卸载。
   */
  open?: boolean
}

/* 遮罩 180ms 淡入；内容淡入 + 0.97 缩放 + 8px 上移 240ms，退场 120ms。reduced-motion 由 index.css 只留淡入淡出。 */
const OVERLAY_MOTION =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-(--dur-base) data-[state=open]:ease-(--ease-out) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--dur-exit) data-[state=closed]:ease-(--ease-exit)'
const CONTENT_MOTION =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[.97] data-[state=open]:slide-in-from-bottom-2 data-[state=open]:duration-(--dur-panel) data-[state=open]:ease-(--ease-out) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[.97] data-[state=closed]:duration-(--dur-exit) data-[state=closed]:ease-(--ease-exit)'

const DialogInteractionDisabledContext = createContext(false)

/** Portals preserve React context, so this boundary also disables dialogs rendered under body. */
export function DialogInteractionBoundary({
  disabled,
  children,
}: {
  disabled: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <DialogInteractionDisabledContext.Provider value={disabled}>
      {children}
    </DialogInteractionDisabledContext.Provider>
  )
}

// 挂载中的对话框，末尾 = 最后挂载 = 视觉最上层；只用于卸载时把焦点交给下一层。
const dialogStack: symbol[] = []
const dialogFocusers = new Map<symbol, () => void>()

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function firstFocusable(container: HTMLElement): HTMLElement | undefined {
  return container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? undefined
}

function focusIsInsideDialog(): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && active.closest('[role="dialog"],[role="alertdialog"]') !== null
}

/**
 * 挂在 Content 内部的焦点归还点：卸载时它的 effect 清理排在 Radix 焦点作用域之后，
 * 此时困笼监听已撤，归还的焦点不会再被拉回正在卸载的对话框。蓄意 mount-once。
 */
function FocusReturn({ focusInside }: { focusInside: React.MutableRefObject<() => void> }): null {
  const previousRef = useRef<HTMLElement | null>(null)
  // 布局阶段记录：Radix 的 onOpenAutoFocus 可能先于本组件的被动 effect 把焦点移进来。
  useLayoutEffect(() => {
    previousRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [])
  useEffect(() => {
    const id = Symbol('dialog')
    dialogFocusers.set(id, () => focusInside.current())
    dialogStack.push(id)
    return () => {
      const index = dialogStack.indexOf(id)
      if (index !== -1) dialogStack.splice(index, 1)
      dialogFocusers.delete(id)
      const previous = previousRef.current
      if (previous && previous !== document.body && previous.isConnected && previous.closest('[inert]') === null) {
        previous.focus()
        return
      }
      const next = dialogStack[dialogStack.length - 1]
      if (next !== undefined) dialogFocusers.get(next)?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 蓄意 mount-once，见上注释
  }, [])
  return null
}

export function Dialog({ title, onClose, children, actions, testid, role = 'dialog', closeLabel, closeTestid, closeDisabled = false, panelClassName, variant = 'default', initialFocusRef, open = true }: DialogProps): JSX.Element {
  const { t } = useT()
  const Primitive = role === 'alertdialog' ? AlertDialogPrimitive : DialogPrimitive
  const interactionDisabled = useContext(DialogInteractionDisabledContext)
  const interactionDisabledRef = useRef(interactionDisabled)
  interactionDisabledRef.current = interactionDisabled
  const resolvedCloseLabel = closeLabel ?? t('common.dialog_close')
  const wasDisabledRef = useRef(interactionDisabled)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const setOverlay = useCallback((node: HTMLDivElement | null) => {
    overlayRef.current = node
    if (node && interactionDisabledRef.current) node.setAttribute('inert', '')
  }, [])
  const focusInsideRef = useRef<() => void>(() => undefined)
  focusInsideRef.current = () => {
    if (interactionDisabledRef.current) return
    const container = containerRef.current
    const target = initialFocusRef?.current ?? (container ? firstFocusable(container) : undefined) ?? container
    target?.focus()
  }

  useLayoutEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    if (interactionDisabled) {
      overlay.setAttribute('inert', '')
      if (overlay.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    } else {
      overlay.removeAttribute('inert')
      // 只在权限回来时补焦点；首次挂载交给 onOpenAutoFocus，让 Radix 困笼记住初始焦点。
      if (wasDisabledRef.current && !overlay.contains(document.activeElement) && !focusIsInsideDialog()) focusInsideRef.current()
    }
    wasDisabledRef.current = interactionDisabled
  }, [interactionDisabled])


  const heading = variant === 'workspace'
    ? <Primitive.Title className="break-words whitespace-normal text-title font-semibold leading-tight text-text">{title}</Primitive.Title>
    : <Primitive.Title className="mb-2 text-title font-semibold text-text">{title}</Primitive.Title>

  const body = variant === 'workspace' ? (
    <>
      <FocusReturn focusInside={focusInsideRef} />
      <header className="flex min-h-16 flex-none items-center gap-4 border-b border-border bg-card/95 px-6 py-3.5">
        <div className="min-w-0 flex-1">{heading}</div>
        <button type="button" className={BUTTON_ICON} data-testid={closeTestid} aria-label={resolvedCloseLabel} disabled={closeDisabled} onClick={onClose}><X className="size-4" strokeWidth={1.75} aria-hidden="true" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-bg p-5 sm:p-6">{children}</div>
      {actions && <footer className="flex flex-none justify-end gap-2 border-t border-border bg-card px-6 py-4">{actions}</footer>}
    </>
  ) : (
    <>
      <FocusReturn focusInside={focusInsideRef} />
      {heading}
      {children}
      {actions && <div className="mt-5 flex justify-end gap-2">{actions}</div>}
    </>
  )
  const contentProps = {
    className: variant === 'workspace'
      ? `${panelClassName ?? 'w-[min(1480px,96vw)]'} flex max-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-lg bg-bg shadow-(--shadow-3) outline-none ${CONTENT_MOTION}`
      : `${panelClassName ?? 'w-[min(480px,92vw)]'} max-h-[90vh] overflow-y-auto rounded-lg bg-surface-raised px-6 py-5 text-text shadow-(--shadow-3) outline-none ${CONTENT_MOTION}`,
    'aria-modal': true,
    'aria-describedby': undefined,
    ref: containerRef,
    onOpenAutoFocus: (event: Event) => {
      event.preventDefault()
      focusInsideRef.current()
    },
    onCloseAutoFocus: (event: Event) => event.preventDefault(),
    onEscapeKeyDown: (event: KeyboardEvent) => {
      event.preventDefault()
      if (interactionDisabledRef.current) return
      // onClose 同步卸载本层；吞掉同一个原生事件，免得后注册的 document 监听把下层也关掉。
      event.stopImmediatePropagation()
      onClose()
    },
  }

  return (
    <Primitive.Root open={open} onOpenChange={(open) => { if (!open && !interactionDisabledRef.current) onClose() }}>
      {/* 显式 container：内容与调用方同一次提交挂载；缺省时 Radix 晚一拍挂出，子树 effect 会排到调用方 effect 之后。 */}
      <Primitive.Portal container={document.body}>
        <Primitive.Overlay
          className={`fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-[2px] ${OVERLAY_MOTION} ${variant === 'workspace' ? 'p-4 mobile:p-3' : ''}`}
          data-testid={testid}
          ref={setOverlay}
          aria-hidden={interactionDisabled || undefined}
          onClickCapture={(event) => {
            if (!interactionDisabled) return
            event.preventDefault()
            event.stopPropagation()
          }}
          onKeyDownCapture={(event) => {
            if (!interactionDisabled) return
            event.preventDefault()
            event.stopPropagation()
          }}
          onSubmitCapture={(event) => {
            if (!interactionDisabled) return
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            if (!interactionDisabled && role === 'dialog' && event.target === event.currentTarget) onClose()
          }}
        >
          {role === 'alertdialog'
            ? <AlertDialogPrimitive.Content {...contentProps}>{body}</AlertDialogPrimitive.Content>
            : <DialogPrimitive.Content {...contentProps} onPointerDownOutside={(event) => event.preventDefault()}>{body}</DialogPrimitive.Content>}
        </Primitive.Overlay>
      </Primitive.Portal>
    </Primitive.Root>
  )
}
