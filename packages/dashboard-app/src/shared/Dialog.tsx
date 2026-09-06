import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useT } from '../i18n'
import { BUTTON_ICON } from './uiRecipes'

/**
 * 中立共享 Dialog 组件（评审 P0-5/P1-9 的地基，Task 3）。
 *
 * 真机评审证实现有 7 处手写 backdrop 对话框键盘礼仪全缺：Esc 不关、焦点不进入、
 * 无困笼、卸载不归位，注册对话框更是「无路可退陷阱」。本组件收拢这四件事，
 * Task 4 起逐个迁移调用方。样式已迁 tailwind 原子类（v10b 全量迁移）；组件通过
 * document.body portal 脱离父级 transform/overflow 的 containing block。外部 GSAP
 * （WorkbenchView 的 revealDialog）必须显式传入 portal 节点，不能依赖视图 root scope
 * 内的字符串选择器。ARIA 契约仍是内容锚点，原 `.dialog` 骨架类已无消费方。
 *
 * 多层 Dialog 叠加时 Esc/Tab 的归属（评审修复轮）：初版用
 * `containerRef.current.contains(document.activeElement)` 判断"是不是我"，看似够用，
 * 实则两处会破：① 焦点落到 body 时（子节点被卸载、或显式 `.blur()`）guard 恒为
 * false，Esc 对"退路"组件静默失效；② 对话框真嵌套渲染（内层是外层 children 的一部分，
 * 现实中"确认框叠在表单对话框上"就是这种结构）时，内层容器是外层容器的 DOM 后代，
 * 外层的 contains 检查对内层的 activeElement 也会为 true，一次 Esc 两层一起关。
 * 改用模块级 LIFO 栈 `dialogStack`：每个实例 mount 时 push 自己的 symbol、unmount 时
 * 精确移除；keydown handler 只在自己是栈顶（`dialogStack[dialogStack.length - 1] ===
 * 自己`）时响应 Esc 与 Tab 困笼，与焦点具体落在哪个元素（乃至是否落在 DOM 里）无关，
 * 多层叠加时通常也只有最后 mount 的实例（=视觉最上层）响应。
 *
 * 已知边界（Task 3 重审发现，非无条件成立）：上一句的"最后 mount = 栈顶 = 视觉最上层"
 * 依赖"挂载顺序"这个前提，而挂载顺序在一种结构下会反过来——同一 React commit 内父子
 * Dialog 同时首次挂载时，子组件的 effect 先于父组件跑（React 18 提交阶段的既定顺序是
 * 子先父后），子 Dialog 反而比父 Dialog 更早 push 进 dialogStack，栈序与视觉层序（父在
 * 下、子在上）就对不上了。当前共享 Dialog 调用方不会在同一 commit 首次挂载父子两层，
 * 这个前提天然不触发；因此迁移/
 * 新增调用方时禁止出现"同一 commit 内父子 Dialog 同时首次挂载"的结构（即：不要让一个
 * Dialog 的 children 在它自己首次挂载的那一刻就已经渲染出另一个 Dialog——先挂载外层、
 * 等外层已挂载后再由用户交互触发内层挂载，这种分两个 commit 的时序不受影响）。
 */
export interface DialogProps {
  title: string
  onClose: () => void            // Esc / backdrop 都走它（✕ 由调用方按需放入 actions）
  children: React.ReactNode
  actions?: React.ReactNode      // 底部动作条（调用方放确认/取消按钮）
  testid?: string
  /** Localized accessible label for the workspace close icon. */
  closeLabel?: string
  /** Stable test hook for the workspace close icon when a caller already exposes one. */
  closeTestid?: string
  /** Keep the workspace close surface visibly and semantically unavailable during atomic work. */
  closeDisabled?: boolean
  /** 少数编排型对话框需要更宽的工作面；缺省仍保持既有 420px。 */
  panelClassName?: string
  /** 大型编辑器使用沉浸式工作区骨架；普通确认框保持 default。 */
  variant?: 'default' | 'workspace'
  /** 首个聚焦目标：缺省聚焦对话框容器内第一个可聚焦元素 */
  initialFocusRef?: React.RefObject<HTMLElement>
}

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

// 当前挂载的 Dialog 实例栈，栈顶（数组末尾）= 最后 mount = 视觉最上层。
// 模块级、跨组件实例共享，故意不用 React state/context——Esc/Tab 响应资格判断
// 不需要触发渲染，一个纯数组够用也更省心。
const dialogStack: symbol[] = []
const dialogFocusers = new Map<symbol, () => void>()

// 困笼边界只应计入"真正能被 Tab 到达"的元素。disabled 表单控件与 input[type=hidden]
// 虽然匹配朴素的标签选择器，但原生 Tab 顺序根本不会经过它们——若仍把它们计入
// first/last 边界，会出现"边界元素永远不可能等于 document.activeElement"的死锁：
// 真正的末个可聚焦元素 Tab 出去时，困笼逻辑判定"这不是 last"，于是放行，焦点直接
// 逃出对话框（评审 Task 3 修复的具体触发场景：确认按钮 disabled 的表单对话框）。
// 故意不用 offsetParent 做可见性过滤——jsdom 没有布局引擎，offsetParent 恒为 null，
// 会把所有元素误判不可见，测试全灭；CSS 隐藏（display:none/visibility:hidden）但未加
// disabled/hidden 的元素仍会被计入边界，是已知未处理边界，登记于此。
// 另一处已知未处理边界：FOCUSABLE_SELECTOR 是多条选择器的并集（逗号分隔，or 语义，
// 不是 and）——`button:not(:disabled)` 这一支排除了 disabled 按钮，但同一个元素若还
// 显式带了非负 tabindex（如 `<button disabled tabIndex={0}>`，本身就是自相矛盾的标记：
// disabled 元素不应该再声明非负 tabindex），会被并集里的 `[tabindex]:not([tabindex="-1"])`
// 这一支重新捞回边界内——两支选择器各自独立判断，互不知晓对方已经排除过什么。同上，
// 登记于此、不处理。
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

export function Dialog({ title, onClose, children, actions, testid, closeLabel, closeTestid, closeDisabled = false, panelClassName, variant = 'default', initialFocusRef }: DialogProps): JSX.Element {
  const { t } = useT()
  const interactionDisabled = useContext(DialogInteractionDisabledContext)
  const interactionDisabledRef = useRef(interactionDisabled)
  interactionDisabledRef.current = interactionDisabled
  const resolvedCloseLabel = closeLabel ?? t('common.dialog_close')
  const overlayRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  // 本实例在 dialogStack 里的身份令牌。用 useRef 惰性初始化一次即可——初始化表达式
  // 每次 render 都会被求值，但 useRef 只在首次挂载采用它，后续 render 里新建的
  // Symbol 会被直接丢弃，instanceIdRef.current 全生命周期指向同一个 symbol。
  const instanceIdRef = useRef<symbol>(Symbol('dialog'))
  const focusInsideRef = useRef<() => void>(() => undefined)
  focusInsideRef.current = () => {
    if (interactionDisabledRef.current) return
    const container = containerRef.current
    const target = initialFocusRef?.current ?? (container ? getFocusableElements(container)[0] : undefined) ?? container
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
      if (
        dialogStack[dialogStack.length - 1] === instanceIdRef.current
        && !overlay.contains(document.activeElement)
      ) {
        focusInsideRef.current()
      }
    }
  }, [interactionDisabled])

  // 挂载：记录打开前的焦点 → 聚焦 initialFocusRef 或容器内首个可聚焦元素。
  // 卸载：焦点归位到打开前记录的元素。故意用 [] 依赖只跑一次——
  // 若跟着 initialFocusRef identity 重跑，会用「此刻已被困笼锁在对话框内」的
  // activeElement 覆盖掉 previousFocusRef，卸载归位就指哪儿也回不到打开前了。
  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (interactionDisabledRef.current) return
    focusInsideRef.current()
    return () => {
      previousFocusRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 蓄意 mount-once，见上注释
  }, [])

  // dialogStack 登记：mount 时 push、unmount 时按值精确移除（indexOf + splice，
  // 不用 pop——万一未来出现非严格 LIFO 的卸载顺序，pop 会错删栈顶的别的实例）。
  // 依赖 [] 只跑一次，与下面 keydown 监听（依赖 [onClose]）解耦成两个独立 effect：
  // onClose identity 变化只重挂监听器，不会误触发重复 push/pop。
  useEffect(() => {
    const id = instanceIdRef.current
    dialogFocusers.set(id, () => focusInsideRef.current())
    dialogStack.push(id)
    return () => {
      const wasTop = dialogStack[dialogStack.length - 1] === id
      const idx = dialogStack.indexOf(id)
      if (idx !== -1) dialogStack.splice(idx, 1)
      dialogFocusers.delete(id)
      if (wasTop) {
        const next = dialogStack[dialogStack.length - 1]
        if (next !== undefined) dialogFocusers.get(next)?.()
      }
    }
  }, [])

  // Esc 关闭 + Tab 困笼共用一个 document 级 keydown 监听（原因见组件头注释）。
  // 响应资格只看"我是不是栈顶"，与 document.activeElement 具体落在哪无关。
  useEffect(() => {
    const id = instanceIdRef.current
    function handleKeyDown(e: KeyboardEvent): void {
      if (dialogStack[dialogStack.length - 1] !== id) return
      if (interactionDisabledRef.current) return

      if (e.key === 'Escape') {
        // onClose synchronously unmounts this Dialog. Without consuming the same native event,
        // a later document listener can observe the now-exposed outer surface and close it too.
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose()
        return
      }

      if (e.key === 'Tab') {
        const container = containerRef.current
        if (!container) return
        const focusable = getFocusableElements(container)
        if (focusable.length === 0) {
          e.preventDefault()
          container.focus()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!container.contains(document.activeElement)) {
          e.preventDefault()
          ;(e.shiftKey ? last : first).focus()
          return
        }
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-scrim ${variant === 'workspace' ? 'p-4 backdrop-blur-[3px]' : ''}`}
      data-testid={testid}
      ref={overlayRef}
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
      onClick={(e) => {
        if (!interactionDisabled && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={variant === 'workspace'
          ? `${panelClassName ?? 'w-[min(1480px,96vw)]'} flex max-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-[24px] border border-border bg-bg shadow-xl`
          : `${panelClassName ?? 'w-[min(420px,92%)]'} max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card px-[22px] py-5 shadow-lg`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={containerRef}
        tabIndex={-1}
      >
        {variant === 'workspace' ? (
          <>
            <header className="flex min-h-16 flex-none items-center gap-4 border-b border-border bg-card px-6 py-3.5">
              <div className="min-w-0 flex-1">
                <h2 className="break-words whitespace-normal text-[18px] font-bold leading-tight tracking-[-0.015em] text-text">{title}</h2>
              </div>
              <button type="button" className={BUTTON_ICON} data-testid={closeTestid} aria-label={resolvedCloseLabel} disabled={closeDisabled} onClick={onClose}><X className="size-4" strokeWidth={1.75} aria-hidden="true" /></button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto bg-bg p-5 sm:p-6">{children}</div>
            {actions && <footer className="flex flex-none justify-end gap-2 border-t border-border bg-card px-6 py-4">{actions}</footer>}
          </>
        ) : (
          <>
            <h2 className="mb-2 text-[16px] font-bold text-text">{title}</h2>
            {children}
            {actions && <div className="mt-5 flex justify-end gap-2">{actions}</div>}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
