import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import gsap from 'gsap'
import { useFlash, type Flash } from './useFlash'

function stubMotion(): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query.includes('no-preference'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })))
}

let show: (kind: Flash['kind'], message: string) => void = () => undefined

function Host({ language = 'zh' }: { language?: string }): JSX.Element {
  const { flash, flashRef, showFlash } = useFlash(language)
  show = showFlash
  return <>{flash && <div ref={flashRef} data-testid="flash">{flash.msg}</div>}</>
}

describe('useFlash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubMotion()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('4s 后先播 GSAP 退场，播完才卸载', () => {
    const exit = { kill: vi.fn() }
    const to = vi.spyOn(gsap, 'to').mockReturnValue(exit as unknown as gsap.core.Tween)
    render(<Host />)
    act(() => show('toast', 'saved'))
    expect(screen.getByTestId('flash')).toHaveTextContent('saved')

    act(() => { vi.advanceTimersByTime(4000) })
    expect(to).toHaveBeenCalledWith(screen.getByTestId('flash'), expect.objectContaining({ autoAlpha: 0, y: 8, duration: 0.12, ease: 'power2.in' }))
    // 退场还在播：元素仍挂着。
    expect(screen.getByTestId('flash')).toBeInTheDocument()

    const vars = to.mock.calls[0]?.[1] as gsap.TweenVars
    act(() => { vars.onComplete?.() })
    expect(screen.queryByTestId('flash')).toBeNull()
  })

  it('退场途中来了新消息：中止退场，新消息留下', () => {
    const exit = { kill: vi.fn() }
    const to = vi.spyOn(gsap, 'to').mockReturnValue(exit as unknown as gsap.core.Tween)
    render(<Host />)
    act(() => show('toast', 'first'))
    act(() => { vi.advanceTimersByTime(4000) })
    expect(to).toHaveBeenCalledTimes(1)

    act(() => show('error', 'second'))
    expect(exit.kill).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('flash')).toHaveTextContent('second')
  })

  it('切换语言立即清掉 toast，不等退场', () => {
    const to = vi.spyOn(gsap, 'to')
    const { rerender } = render(<Host language="zh" />)
    act(() => show('toast', 'saved'))
    rerender(<Host language="en" />)
    expect(screen.queryByTestId('flash')).toBeNull()
    expect(to).not.toHaveBeenCalled()
  })
})
