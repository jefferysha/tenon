/**
 * Dialog.test —— 共享 Dialog 组件的 6 条键盘礼仪契约（评审 P0-5/P1-9 地基，Task 3）。
 * 用带按钮的宿主组件真实开合（非直接 render Dialog 常驻），让「挂载即聚焦」「卸载归位」
 * 都对应真实的 DOM 生命周期，而不是靠 rerender props 模拟。
 */
import { useRef, useState, type ReactElement, type RefObject } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n'
import { Dialog } from './Dialog'

const renderWithI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

/** 默认宿主：打开按钮 + Dialog（children 一个输入框，actions 两个按钮）。 */
function Host({ testid, initialFocusRef }: { testid?: string; initialFocusRef?: RefObject<HTMLElement> } = {}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(true)}>打开</button>
      {open && (
        <Dialog
          title="标题"
          onClose={() => setOpen(false)}
          testid={testid}
          initialFocusRef={initialFocusRef}
          actions={
            <>
              <button>取消</button>
              <button>确认</button>
            </>
          }
        >
          <input data-testid="dlg-input" placeholder="姓名" />
        </Dialog>
      )}
    </div>
  )
}

/** 困笼边界测试专用宿主：「确认」按钮 disabled，验证困笼边界不把它算作末个可聚焦元素。 */
function HostWithDisabledConfirm() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(true)}>打开</button>
      {open && (
        <Dialog
          title="标题"
          onClose={() => setOpen(false)}
          actions={
            <>
              <button>取消</button>
              <button disabled>确认</button>
            </>
          }
        >
          <input data-testid="dlg-input" placeholder="姓名" />
        </Dialog>
      )}
    </div>
  )
}

/** 两层叠加测试专用宿主：外层 Dialog 内嵌一个「打开内层」按钮，点击后在 children 里再挂一层 Dialog。 */
function HostTwoLayers() {
  const [outerOpen, setOuterOpen] = useState(false)
  const [innerOpen, setInnerOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOuterOpen(true)}>打开外层</button>
      {outerOpen && (
        <Dialog title="外层" onClose={() => setOuterOpen(false)} testid="outer">
          <button onClick={() => setInnerOpen(true)}>打开内层</button>
          {innerOpen && (
            <Dialog title="内层" onClose={() => setInnerOpen(false)} testid="inner">
              内层内容
            </Dialog>
          )}
        </Dialog>
      )}
    </div>
  )
}

/** initialFocusRef 场景专用宿主：ref 指向「确认」按钮，验证优先级高于默认首个可聚焦元素。 */
function HostWithInitialFocus() {
  const [open, setOpen] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button onClick={() => setOpen(true)}>打开</button>
      {open && (
        <Dialog
          title="标题"
          onClose={() => setOpen(false)}
          initialFocusRef={confirmRef}
          actions={
            <>
              <button>取消</button>
              <button ref={confirmRef}>确认</button>
            </>
          }
        >
          <input data-testid="dlg-input" placeholder="姓名" />
        </Dialog>
      )}
    </div>
  )
}

/** workspace 冲突回归：关闭控件同时保留本地化标签与共享 Lucide 图标语义。 */
function HostWorkspace() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open workspace</button>
      {open && (
        <Dialog
          closeLabel="Close evidence composer"
          onClose={() => setOpen(false)}
          title="Evidence composer"
          variant="workspace"
        >
          Workspace content
        </Dialog>
      )}
    </div>
  )
}

/** 破坏性确认：alertdialog 只能显式选择，背景点击不关闭。 */
function HostAlert() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(true)}>删除</button>
      {open && (
        <Dialog
          title="删除任务"
          role="alertdialog"
          testid="alert"
          onClose={() => setOpen(false)}
          actions={(
            <>
              <button onClick={() => setOpen(false)}>取消</button>
              <button>确认删除</button>
            </>
          )}
        >
          不可撤销
        </Dialog>
      )}
    </div>
  )
}

describe('Dialog（共享组件，Task 3）', () => {
  it('挂载时焦点进入对话框：默认落在容器内首个可聚焦元素；提供 initialFocusRef 时优先聚焦它', async () => {
    const user = userEvent.setup()
    const { unmount } = renderWithI18n(<Host />)
    await user.click(screen.getByText('打开'))
    expect(document.activeElement).toBe(screen.getByTestId('dlg-input'))
    unmount()

    renderWithI18n(<HostWithInitialFocus />)
    await user.click(screen.getByText('打开'))
    expect(document.activeElement).toBe(screen.getByText('确认'))
  })

  it('Esc 触发 onClose', async () => {
    const user = userEvent.setup()
    renderWithI18n(<Host />)
    await user.click(screen.getByText('打开'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('点 backdrop 自身（非冒泡）触发 onClose；点击对话框卡片内部不触发', async () => {
    const user = userEvent.setup()
    renderWithI18n(<Host testid="t-dialog" />)
    await user.click(screen.getByText('打开'))

    const card = screen.getByRole('dialog')
    fireEvent.click(card)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    const backdrop = screen.getByTestId('t-dialog')
    fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Tab 在对话框内循环困笼：末元素 Tab → 回到首元素', async () => {
    const user = userEvent.setup()
    renderWithI18n(<Host />)
    await user.click(screen.getByText('打开'))

    const input = screen.getByTestId('dlg-input')
    const cancelBtn = screen.getByText('取消')
    const confirmBtn = screen.getByText('确认')
    expect(document.activeElement).toBe(input)

    await user.tab()
    expect(document.activeElement).toBe(cancelBtn)
    await user.tab()
    expect(document.activeElement).toBe(confirmBtn)
    await user.tab()
    expect(document.activeElement).toBe(input)
  })

  it('卸载时焦点回到打开前的元素', async () => {
    const user = userEvent.setup()
    renderWithI18n(<Host />)
    const openBtn = screen.getByText('打开')
    await user.click(openBtn)
    expect(document.activeElement).not.toBe(openBtn)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(openBtn)
  })

  it('role="dialog" aria-modal="true"，可访问名称经 aria-labelledby 指向标题', async () => {
    const user = userEvent.setup()
    renderWithI18n(<Host />)
    await user.click(screen.getByText('打开'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).not.toHaveAttribute('aria-label')
    const heading = screen.getByRole('heading', { name: '标题' })
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id)
    expect(dialog).toHaveAccessibleName('标题')
  })

  it('Tab 在对话框内循环困笼（反向）：首元素 Shift+Tab → 跳到末元素', async () => {
    const user = userEvent.setup()
    renderWithI18n(<Host />)
    await user.click(screen.getByText('打开'))

    const input = screen.getByTestId('dlg-input')
    const confirmBtn = screen.getByText('确认')
    expect(document.activeElement).toBe(input)

    await user.tab({ shift: true })
    expect(document.activeElement).toBe(confirmBtn)
  })

  it('困笼边界排除 disabled 元素：确认按钮 disabled 时，从取消 Tab 应困笼回到首个可聚焦元素而非逃逸', async () => {
    const user = userEvent.setup()
    renderWithI18n(<HostWithDisabledConfirm />)
    await user.click(screen.getByText('打开'))

    const input = screen.getByTestId('dlg-input')
    const cancelBtn = screen.getByText('取消')
    expect(document.activeElement).toBe(input)

    await user.tab()
    expect(document.activeElement).toBe(cancelBtn)
    // 「确认」disabled，边界计算应把它排除在外——真正的末个可聚焦元素是「取消」，
    // 从这里 Tab 应该困笼回到首个可聚焦元素，而不是逃逸出对话框。
    await user.tab()
    expect(document.activeElement).toBe(input)
  })

  it('焦点落到 body（如子节点被卸载 / 调用 blur）时，Esc 仍能触发 onClose', async () => {
    const user = userEvent.setup()
    renderWithI18n(<Host />)
    await user.click(screen.getByText('打开'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('焦点因子节点卸载落到 body 时，Tab 会被顶层 Dialog 拉回困笼', async () => {
    const user = userEvent.setup()
    renderWithI18n(<Host />)
    await user.click(screen.getByText('打开'))

    const dialog = screen.getByRole('dialog')
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    await user.tab()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)

    ;(document.activeElement as HTMLElement).blur()
    await user.tab({ shift: true })
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
  })

  it('两层 Dialog 叠加：按一次 Esc 只关最上层，外层 onClose 不被调用', async () => {
    const user = userEvent.setup()
    renderWithI18n(<HostTwoLayers />)
    await user.click(screen.getByText('打开外层'))
    expect(screen.getByTestId('outer')).toBeInTheDocument()

    await user.click(screen.getByText('打开内层'))
    expect(screen.getByTestId('inner')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByTestId('inner')).toBeNull()
    expect(screen.getByTestId('outer')).toBeInTheDocument()
  })

  it('workspace 关闭控件使用本地化 accessible label 与共享 Lucide X', async () => {
    const user = userEvent.setup()
    renderWithI18n(<HostWorkspace />)
    await user.click(screen.getByText('Open workspace'))

    const closeButton = screen.getByRole('button', { name: 'Close evidence composer' })
    expect(closeButton.querySelector('svg.lucide-x')).not.toBeNull()
  })

  it('workspace 长标题在窄屏允许完整换行，不以省略号截断', async () => {
    const user = userEvent.setup()
    renderWithI18n(<HostWorkspace />)
    await user.click(screen.getByText('Open workspace'))

    const heading = screen.getByRole('heading', { name: 'Evidence composer' })
    expect(heading).not.toHaveClass('truncate')
    expect(heading).toHaveClass('break-words', 'whitespace-normal')
  })

  it('alertdialog：role 与标题关联，初始焦点落在取消，背景点击不关闭，Esc 关闭并归还焦点', async () => {
    const user = userEvent.setup()
    renderWithI18n(<HostAlert />)
    const trigger = screen.getByText('删除')
    await user.click(trigger)

    const dialog = screen.getByRole('alertdialog', { name: '删除任务' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('取消')).toHaveFocus()

    fireEvent.click(screen.getByTestId('alert'))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })
})
