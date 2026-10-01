import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ScrollablePre } from './ScrollablePre'

describe('ScrollablePre', () => {
  it('会滚动的预格式化文本：键盘可聚焦（Tab 到得了）、是有名字的区域、聚焦有环', async () => {
    render(<ScrollablePre label="日志" className="max-h-64 overflow-auto" testId="log">line 1{'\n'}line 2</ScrollablePre>)
    const pre = screen.getByRole('region', { name: '日志' })
    expect(pre).toBe(screen.getByTestId('log'))
    expect(pre.tagName).toBe('PRE')
    expect(pre).toHaveAttribute('tabindex', '0')
    expect(pre.className).toContain('overflow-auto')
    expect(pre.className).toContain('focus-visible:ring-2')
    await userEvent.tab()
    expect(pre).toHaveFocus()
    expect(pre.textContent).toBe('line 1\nline 2')
  })
})
