import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CountRoll } from './CountRoll'

describe('CountRoll', () => {
  it('首次渲染不动；值变化时新值带 count-roll 滑入，同一值重渲染不再触发', () => {
    const { rerender } = render(<CountRoll value={3} testId="n" />)
    expect(screen.getByTestId('n')).toHaveTextContent('3')
    expect(screen.getByTestId('n').className).not.toContain('count-roll')
    rerender(<CountRoll value={4} testId="n" />)
    expect(screen.getByTestId('n')).toHaveTextContent('4')
    expect(screen.getByTestId('n').className).toContain('count-roll')
    expect(screen.getByTestId('n')).toHaveAttribute('data-rolling', 'true')
    rerender(<CountRoll value={4} testId="n" />)
    expect(screen.getByTestId('n').className).not.toContain('count-roll')
    expect(screen.getByTestId('n')).not.toHaveAttribute('data-rolling')
  })

  it('进度串（3/5）与数字同一处理；className 透传', () => {
    const { rerender } = render(<CountRoll value="1/2" className="tabular-nums" testId="n" />)
    expect(screen.getByTestId('n').className).toContain('tabular-nums')
    rerender(<CountRoll value="2/2" className="tabular-nums" testId="n" />)
    expect(screen.getByTestId('n')).toHaveTextContent('2/2')
    expect(screen.getByTestId('n').className.split(/\s+/u)).toEqual(expect.arrayContaining(['count-roll', 'tabular-nums']))
  })

  it('换值时是新节点（key 变化），旧值不会残留', () => {
    const { rerender } = render(<CountRoll value={1} testId="n" />)
    const before = screen.getByTestId('n')
    rerender(<CountRoll value={2} testId="n" />)
    expect(screen.getByTestId('n')).not.toBe(before)
    expect(screen.getAllByTestId('n')).toHaveLength(1)
  })
})

describe('count-roll 样式', () => {
  const css = readFileSync(['src/index.css', 'packages/dashboard-app/src/index.css'].find((path) => {
    try { readFileSync(path); return true } catch { return false }
  }) ?? 'src/index.css', 'utf8')

  it('纵向滑入 160ms ease-out；reduced-motion 由全局规则把动画时长归零', () => {
    expect(css).toMatch(/\.count-roll\s*\{[^}]*animation:\s*count-roll 160ms var\(--ease-out\)/u)
    expect(css).toMatch(/@keyframes count-roll\s*\{[^}]*translateY\(/u)
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation-duration: 0s !important/u)
  })
})
