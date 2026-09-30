import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FILL_HEIGHT_PX, StepFrame } from './StepFrame'

class FakeObserver {
  static instances: FakeObserver[] = []
  disconnected = false
  constructor(readonly callback: () => void) { FakeObserver.instances.push(this) }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void { this.disconnected = true }
}

/** 让被量的容器（StepFrame 的内层）报告一个自然高度；getBoundingClientRect 故意报一个被缩放过的小值（对话框进场缩放 0.97）。 */
function reportHeight(value: { current: number }): void {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => value.current)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height: value.current * 0.97, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  FakeObserver.instances = []
})

describe('StepFrame', () => {
  it('没有 ResizeObserver（jsdom、旧浏览器）：贴内容步骤保持自动高度，不写死', () => {
    render(<StepFrame fill={false}><p>内容</p></StepFrame>)
    expect(screen.getByTestId('np-frame').style.height).toBe('')
    expect(screen.getByTestId('np-frame')).toHaveAttribute('data-fit', 'hug')
  })

  it('铺满型步骤固定 384px（等于 h-96），内层 h-full 供子树撑满', () => {
    render(<StepFrame fill><p>内容</p></StepFrame>)
    expect(FILL_HEIGHT_PX).toBe(384)
    expect(screen.getByTestId('np-frame')).toHaveStyle({ height: '384px' })
    expect(screen.getByTestId('np-frame').firstElementChild).toHaveClass('h-full')
  })

  it('贴内容步骤：外框高度取内层自然高度，内容长高 / 变矮时跟着变（由 CSS 做 200ms 过渡）', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    const height = { current: 132 }
    reportHeight(height)
    render(<StepFrame fill={false}><p>内容</p></StepFrame>)
    const frame = screen.getByTestId('np-frame')
    expect(frame).toHaveStyle({ height: '132px' })
    height.current = 210
    act(() => { FakeObserver.instances[0]?.callback() })
    expect(frame).toHaveStyle({ height: '210px' })
    height.current = 96
    act(() => { FakeObserver.instances[0]?.callback() })
    expect(frame).toHaveStyle({ height: '96px' })
    expect(frame.className).toContain('transition-[height]')
    expect(frame.className).toContain('duration-200')
  })

  it('铺满 ↔ 贴内容切换：高度先保持旧值再过渡到新值，不跳', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    const height = { current: 120 }
    reportHeight(height)
    const { rerender } = render(<StepFrame fill={false}><p>内容</p></StepFrame>)
    expect(screen.getByTestId('np-frame')).toHaveStyle({ height: '120px' })
    rerender(<StepFrame fill><p>内容</p></StepFrame>)
    expect(screen.getByTestId('np-frame')).toHaveStyle({ height: '384px' })
    height.current = 260
    rerender(<StepFrame fill={false}><p>内容</p></StepFrame>)
    act(() => { FakeObserver.instances[0]?.callback() })
    expect(screen.getByTestId('np-frame')).toHaveStyle({ height: '260px' })
  })

  it('卸载时断开观察', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    reportHeight({ current: 50 })
    const { unmount } = render(<StepFrame fill={false}><p>内容</p></StepFrame>)
    unmount()
    expect(FakeObserver.instances[0]?.disconnected).toBe(true)
  })
})
