import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n'
import { Drawer } from './Drawer'
import { isMarkdownPath, Markdown } from './Markdown'

describe('Drawer', () => {
  const renderDrawer = (open: boolean, onClose: () => void): JSX.Element => (
    <I18nProvider>
      <button type="button" data-testid="trigger">open</button>
      <Drawer open={open} onClose={onClose} ariaLabel="doc" title={<span>title</span>}>
        <button type="button" data-testid="inside">inside</button>
      </Drawer>
    </I18nProvider>
  )

  it('打开即接管焦点；Esc 关闭；关闭后焦点还给触发元素；遮罩点击关闭', async () => {
    const onClose = vi.fn()
    const { rerender } = render(renderDrawer(false, onClose))
    const trigger = screen.getByTestId('trigger')
    trigger.focus()
    rerender(renderDrawer(true, onClose))
    const panel = screen.getByRole('dialog', { name: 'doc' })
    expect(panel).toBe(screen.getByTestId('drawer'))
    expect(panel).toHaveAttribute('aria-modal', 'true')
    expect(panel.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('drawer-scrim'))
    expect(onClose).toHaveBeenCalledTimes(2)

    rerender(renderDrawer(false, onClose))
    expect(screen.queryByTestId('drawer')).toBeNull()
    // Radix 在卸载后的下一个任务里派发 closeAutoFocus。
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('Tab 困在面板内', async () => {
    const user = userEvent.setup()
    render(renderDrawer(true, vi.fn()))
    const panel = screen.getByTestId('drawer')
    for (let step = 0; step < 4; step += 1) {
      await user.tab()
      expect(panel.contains(document.activeElement)).toBe(true)
    }
  })

  it('右侧面板：raised 底 + 三级阴影，无描边；进场 24px 滑入 + 淡入 240ms，退场 160ms', () => {
    render(renderDrawer(true, vi.fn()))
    const panel = screen.getByTestId('drawer')
    for (const name of ['bg-surface-raised', 'shadow-(--shadow-3)', 'rounded-l-lg', 'data-[state=open]:animate-in', 'data-[state=open]:fade-in-0', 'data-[state=open]:slide-in-from-right-6', 'data-[state=open]:duration-(--dur-panel)', 'data-[state=open]:ease-(--ease-out)', 'data-[state=closed]:slide-out-to-right-6', 'data-[state=closed]:duration-[160ms]', 'data-[state=closed]:ease-(--ease-exit)']) {
      expect(panel).toHaveClass(name)
    }
    expect(panel.className).not.toMatch(/(^|\s)border-l(\s|$)/u)
    const scrim = screen.getByTestId('drawer-scrim')
    for (const name of ['data-[state=open]:fade-in-0', 'data-[state=open]:duration-(--dur-base)', 'data-[state=closed]:fade-out-0']) expect(scrim).toHaveClass(name)
    expect(screen.getByTestId('drawer-close')).toHaveClass('size-10')
  })

  it('关闭后不渲染', () => {
    render(<I18nProvider><Drawer open={false} onClose={() => undefined} ariaLabel="doc" title="t">x</Drawer></I18nProvider>)
    expect(screen.queryByTestId('drawer')).toBeNull()
  })
})

describe('Markdown', () => {
  it('GFM：标题 / 列表 / 表格 / 代码块渲染为对应元素，原始 HTML 不被注入', () => {
    render(<Markdown testId="md" text={'# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n<script>alert(1)</script>'} />)
    const root = screen.getByTestId('md')
    expect(root.querySelector('h1')?.textContent).toBe('Title')
    expect(root.querySelectorAll('li')).toHaveLength(2)
    expect(root.querySelector('table td')?.textContent).toBe('1')
    expect(root.querySelector('pre code')?.textContent).toContain('const x = 1')
    expect(root.querySelector('script')).toBeNull()
  })
  it('isMarkdownPath 只认 md / markdown / mdx', () => {
    expect(isMarkdownPath('docs/a.md')).toBe(true)
    expect(isMarkdownPath('docs/a.MDX')).toBe(true)
    expect(isMarkdownPath('src/a.ts')).toBe(false)
  })
})
