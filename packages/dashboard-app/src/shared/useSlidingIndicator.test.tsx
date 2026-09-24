/** 共享底色指示块：首次直接到位；切换时 Flip 220ms power3.out；reduced-motion 下只跳不滑；无当前项时隐藏。 */
import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Flip } from 'gsap/Flip'
import { SLIDING_INDICATOR_CLS, useSlidingIndicator } from './useSlidingIndicator'

const LEFT: Record<string, number> = { a: 0, b: 60, c: 140 }
const WIDTH: Record<string, number> = { a: 60, b: 80, c: 50 }

function rect(left: number, width: number): DOMRect {
  return { left, top: 0, right: left + width, bottom: 40, width, height: 40, x: left, y: 0, toJSON: () => ({}) }
}

function Group({ initial = 'a', duration }: { initial?: string | null; duration?: number }): JSX.Element {
  const [value, setValue] = useState<string | null>(initial)
  const { containerRef, indicatorRef } = useSlidingIndicator<HTMLDivElement>(duration === undefined ? {} : { duration })
  return (
    <div ref={containerRef} className="relative isolate" role="radiogroup" aria-label="g">
      {['a', 'b', 'c'].map((id) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} data-id={id} onClick={() => setValue(id)}>{id}</button>
      ))}
      <button type="button" data-testid="clear" onClick={() => setValue(null)}>clear</button>
      <span ref={indicatorRef} className={SLIDING_INDICATOR_CLS} data-testid="indicator" aria-hidden="true" />
    </div>
  )
}

function stubMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  }))
}

// MutationObserver 回调是微任务：等它跑完再断言。
const flush = (): Promise<void> => act(async () => { await Promise.resolve() })

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const id = this.dataset.id
    return id === undefined ? rect(0, 300) : rect(LEFT[id] ?? 0, WIDTH[id] ?? 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useSlidingIndicator', () => {
  it('首次渲染直接落在当前项上，不做动画', () => {
    stubMotion(false)
    const from = vi.spyOn(Flip, 'from')
    render(<Group initial="b" />)
    const indicator = screen.getByTestId('indicator')
    expect(indicator).toHaveAttribute('data-placed', 'true')
    expect(indicator.style.left).toBe('60px')
    expect(indicator.style.width).toBe('80px')
    expect(indicator.style.height).toBe('40px')
    expect(from).not.toHaveBeenCalled()
  })

  it('切换当前项：Flip 从旧位置滑到新位置，220ms power3.out，不缩放', async () => {
    stubMotion(false)
    const from = vi.spyOn(Flip, 'from')
    render(<Group />)
    fireEvent.click(screen.getByRole('radio', { name: 'c' }))
    await flush()
    const indicator = screen.getByTestId('indicator')
    expect(indicator.style.left).toBe('140px')
    expect(from).toHaveBeenCalledTimes(1)
    expect(from.mock.calls[0]?.[1]).toMatchObject({ duration: 0.22, ease: 'power3.out', scale: false })
    // 补间跑完后停在新项的尺寸上。
    from.mock.results[0]?.value.progress(1)
    expect(indicator.style.width).toBe('50px')
  })

  it('时长可配（分段控件 0.18）', async () => {
    stubMotion(false)
    const from = vi.spyOn(Flip, 'from')
    render(<Group duration={0.18} />)
    fireEvent.click(screen.getByRole('radio', { name: 'b' }))
    await flush()
    expect(from.mock.calls[0]?.[1]).toMatchObject({ duration: 0.18 })
  })

  it('reduced-motion：指示块立即到位，不调用 Flip', async () => {
    stubMotion(true)
    const from = vi.spyOn(Flip, 'from')
    render(<Group />)
    fireEvent.click(screen.getByRole('radio', { name: 'b' }))
    await flush()
    expect(screen.getByTestId('indicator').style.left).toBe('60px')
    expect(from).not.toHaveBeenCalled()
  })

  it('组内没有当前项时隐藏；再选中时直接到位（不从隐藏处滑入）', async () => {
    stubMotion(false)
    const from = vi.spyOn(Flip, 'from')
    render(<Group />)
    fireEvent.click(screen.getByTestId('clear'))
    await flush()
    const indicator = screen.getByTestId('indicator')
    expect(indicator).toHaveAttribute('data-placed', 'false')
    fireEvent.click(screen.getByRole('radio', { name: 'c' }))
    await flush()
    expect(indicator).toHaveAttribute('data-placed', 'true')
    expect(indicator.style.left).toBe('140px')
    expect(from).not.toHaveBeenCalled()
  })

  it('指示块类：在内容之下、不接收指针、未定位时不可见', () => {
    expect(SLIDING_INDICATOR_CLS.split(' ')).toEqual(expect.arrayContaining(['absolute', '-z-10', 'pointer-events-none', 'opacity-0', 'data-[placed=true]:opacity-100']))
  })
})
