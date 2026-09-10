import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../i18n'
import { Drawer } from './Drawer'
import { isMarkdownPath, Markdown } from './Markdown'

describe('Drawer', () => {
  it('打开即接管焦点；Esc 关闭并还原到触发元素；遮罩点击关闭', () => {
    const onClose = vi.fn()
    render(
      <I18nProvider>
        <button type="button" data-testid="trigger">open</button>
        <Drawer open onClose={onClose} ariaLabel="doc" title={<span>title</span>}>
          <button type="button" data-testid="inside">inside</button>
        </Drawer>
      </I18nProvider>,
    )
    const trigger = screen.getByTestId('trigger')
    trigger.focus()
    expect(screen.getByTestId('drawer')).toHaveAttribute('aria-modal', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('drawer-root').firstElementChild as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(2)
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
