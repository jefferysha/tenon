import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { overflowEdges } from './overflowEdges'
import { TrackTabs, type TrackTabsProps } from './TrackTabs'

const TABS: TrackTabsProps['tabs'] = [
  { id: 'chat', label: 'Chat' },
  { id: 'pm', label: 'Product' },
  { id: 'frontend', label: 'Frontend' },
  { id: 'backend', label: 'Backend' },
  { id: 'free', label: null },
]

/** jsdom 不排版：scrollLeft / clientWidth / scrollWidth 由用例设定，读的是同一份。 */
const geometry = { scrollLeft: 0, clientWidth: 220, scrollWidth: 220 }
const GEOMETRY_KEYS = ['scrollLeft', 'clientWidth', 'scrollWidth'] as const
const OVERFLOWING = 420

function stubGeometry(): void {
  for (const key of GEOMETRY_KEYS) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get: () => geometry[key],
      set: (value: number) => { geometry[key] = value },
    })
  }
}

function renderTabs(overrides: Partial<TrackTabsProps> = {}) {
  const onSelect = vi.fn()
  const props: TrackTabsProps = { tabs: TABS, selected: 'backend', busy: false, label: 'Tracks', onSelect, ...overrides }
  const view = render(<TrackTabs {...props} />)
  return { onSelect, rerender: (next: Partial<TrackTabsProps>) => view.rerender(<TrackTabs {...props} {...next} />) }
}

/** 渐隐状态是 data-fade-start / data-fade-end：有隐藏内容的那一侧才设。 */
function fadeOf(): { start: boolean; end: boolean } {
  const strip = screen.getByTestId('wb-tracks')
  return { start: strip.hasAttribute('data-fade-start'), end: strip.hasAttribute('data-fade-end') }
}

function scrollTo(left: number): void {
  geometry.scrollLeft = left
  fireEvent.scroll(screen.getByTestId('wb-tracks'))
}

beforeEach(() => {
  geometry.scrollLeft = 0
  geometry.clientWidth = 220
  geometry.scrollWidth = 220
  stubGeometry()
})

afterEach(() => {
  for (const key of GEOMETRY_KEYS) Reflect.deleteProperty(HTMLElement.prototype, key)
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  vi.unstubAllGlobals()
})

describe('overflowEdges', () => {
  it('start：已经往右滚过；end：右边还有没滚到的；差不到 1px 的取整误差不算隐藏内容', () => {
    expect(overflowEdges({ scrollLeft: 0, clientWidth: 220, scrollWidth: 220 })).toEqual({ start: false, end: false })
    expect(overflowEdges({ scrollLeft: 0, clientWidth: 220, scrollWidth: 420 })).toEqual({ start: false, end: true })
    expect(overflowEdges({ scrollLeft: 80, clientWidth: 220, scrollWidth: 420 })).toEqual({ start: true, end: true })
    expect(overflowEdges({ scrollLeft: 200, clientWidth: 220, scrollWidth: 420 })).toEqual({ start: true, end: false })
    expect(overflowEdges({ scrollLeft: 0.6, clientWidth: 220, scrollWidth: 420 })).toEqual({ start: false, end: true })
    expect(overflowEdges({ scrollLeft: 199.4, clientWidth: 220, scrollWidth: 420 })).toEqual({ start: true, end: false })
  })
})

describe('TrackTabs 渐隐', () => {
  it('放得下：两侧都没有渐隐', () => {
    renderTabs()
    expect(fadeOf()).toEqual({ start: false, end: false })
  })

  it('放不下：在最左端只有右侧渐隐；滚到中间两侧都有；滚到最右端只剩左侧', () => {
    geometry.scrollWidth = OVERFLOWING
    renderTabs()
    expect(fadeOf()).toEqual({ start: false, end: true })
    scrollTo(90)
    expect(fadeOf()).toEqual({ start: true, end: true })
    scrollTo(OVERFLOWING - geometry.clientWidth)
    expect(fadeOf()).toEqual({ start: true, end: false })
    scrollTo(0)
    expect(fadeOf()).toEqual({ start: false, end: true })
  })

  it('页签条变宽（导航栏拉开）后渐隐跟着消失；变窄后又出现', () => {
    let notify: () => void = () => undefined
    const observed: Element[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notify = callback }
      observe(target: Element): void { observed.push(target) }
      disconnect(): void {}
    })
    geometry.scrollWidth = OVERFLOWING
    renderTabs()
    expect(fadeOf()).toEqual({ start: false, end: true })
    // 条本身和每个页签都被观察：字体载入后页签变宽，条的外框不变也要重新量。
    expect(observed).toContain(screen.getByTestId('wb-tracks'))
    for (const tab of TABS) expect(observed).toContain(screen.getByTestId(`wb-track-${tab.id}`))
    geometry.clientWidth = OVERFLOWING
    act(() => notify())
    expect(fadeOf()).toEqual({ start: false, end: false })
    geometry.clientWidth = 220
    act(() => notify())
    expect(fadeOf()).toEqual({ start: false, end: true })
  })

  it('页签增删后重新量', () => {
    const { rerender } = renderTabs({ tabs: TABS.slice(0, 2) })
    expect(fadeOf()).toEqual({ start: false, end: false })
    geometry.scrollWidth = OVERFLOWING
    rerender({ tabs: TABS })
    expect(fadeOf()).toEqual({ start: false, end: true })
  })
})

describe('TrackTabs 滚入可见范围', () => {
  function stubScrollIntoView() {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    return spy
  }

  it('选中的页签（含换选）滚进可见范围，只动横向的最近一档', () => {
    const spy = stubScrollIntoView()
    const { rerender } = renderTabs({ selected: 'backend' })
    expect(spy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(spy.mock.contexts.at(-1)).toBe(screen.getByTestId('wb-track-backend'))
    rerender({ selected: 'free' })
    expect(spy.mock.contexts.at(-1)).toBe(screen.getByTestId('wb-track-free'))
  })

  it('键盘焦点移到哪个页签，哪个页签就滚进可见范围（不只是选中的）', () => {
    const spy = stubScrollIntoView()
    renderTabs({ selected: 'backend' })
    spy.mockClear()
    act(() => screen.getByTestId('wb-track-chat').focus())
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.contexts[0]).toBe(screen.getByTestId('wb-track-chat'))
    act(() => screen.getByTestId('wb-track-pm').focus())
    expect(spy.mock.contexts.at(-1)).toBe(screen.getByTestId('wb-track-pm'))
  })

  it('挂载时选中的页签就滚进可见范围（URL 直达的轨道），不等换选', () => {
    const spy = stubScrollIntoView()
    renderTabs({ selected: 'backend' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.contexts[0]).toBe(screen.getByTestId('wb-track-backend'))
  })

  it('轨道列表在挂载之后才载入：载入时选中的页签滚进可见范围', () => {
    const spy = stubScrollIntoView()
    const { rerender } = renderTabs({ tabs: [], selected: 'backend' })
    expect(spy).not.toHaveBeenCalled()
    rerender({ tabs: TABS })
    expect(spy.mock.contexts.at(-1)).toBe(screen.getByTestId('wb-track-backend'))
  })

  it('页签数量没变、名称变了（切换语言让页签变宽）：选中的页签重新滚进可见范围', () => {
    const spy = stubScrollIntoView()
    const narrow = TABS.map((tab) => tab.label === null ? tab : { ...tab, label: tab.label.slice(0, 2) })
    const { rerender } = renderTabs({ tabs: narrow, selected: 'backend' })
    spy.mockClear()
    rerender({ tabs: TABS, selected: 'backend' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.contexts[0]).toBe(screen.getByTestId('wb-track-backend'))
    spy.mockClear()
    rerender({ tabs: TABS.map((tab) => ({ ...tab })), selected: 'backend' })
    expect(spy, '内容没变就不重复滚').not.toHaveBeenCalled()
  })

  describe('条或页签尺寸变化（条变窄、字体载入后页签变宽）', () => {
    function stubResizeObserver(): { notify: () => void } {
      const holder = { notify: (): void => undefined }
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) { holder.notify = callback }
        observe(): void {}
        disconnect(): void {}
      })
      return holder
    }

    it('用户没有动手滚过：选中的页签重新滚进可见范围', () => {
      const resize = stubResizeObserver()
      const spy = stubScrollIntoView()
      renderTabs({ selected: 'backend' })
      spy.mockClear()
      act(() => resize.notify())
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.contexts[0]).toBe(screen.getByTestId('wb-track-backend'))
    })

    const GESTURES: ReadonlyArray<readonly [string, () => void]> = [
      ['滚轮', () => { fireEvent.wheel(screen.getByTestId('wb-tracks')) }],
      ['指针按下', () => { fireEvent.pointerDown(screen.getByTestId('wb-tracks')) }],
      ['触摸', () => { fireEvent.touchStart(screen.getByTestId('wb-tracks')) }],
      ['焦点移到某个页签', () => { act(() => screen.getByTestId('wb-track-chat').focus()) }],
    ]

    it.each(GESTURES)('用户动手之后（%s）：不再把选中的页签拉回来；换选后重新跟随', (_name, gesture) => {
      const resize = stubResizeObserver()
      const spy = stubScrollIntoView()
      const { rerender } = renderTabs({ selected: 'backend' })
      gesture()
      spy.mockClear()
      act(() => resize.notify())
      expect(spy).not.toHaveBeenCalled()
      rerender({ selected: 'free' })
      spy.mockClear()
      act(() => resize.notify())
      expect(spy.mock.contexts.at(-1)).toBe(screen.getByTestId('wb-track-free'))
    })
  })

  it('没有 scrollIntoView 的环境里不抛错', () => {
    expect(() => renderTabs()).not.toThrow()
    expect(() => act(() => screen.getByTestId('wb-track-chat').focus())).not.toThrow()
  })
})

describe('TrackTabs 页签', () => {
  it('名称 label ?? id，完整显示（title 同名）；选中态 aria-selected；点击选择', () => {
    const { onSelect } = renderTabs()
    expect(screen.getByTestId('wb-track-free')).toHaveTextContent('free')
    expect(screen.getByTestId('wb-track-free')).toHaveAttribute('title', 'free')
    expect(screen.getByTestId('wb-track-frontend')).toHaveTextContent('Frontend')
    expect(screen.getByTestId('wb-track-backend')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('wb-track-pm')).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(screen.getByTestId('wb-track-pm'))
    expect(onSelect).toHaveBeenCalledWith('pm')
  })

  it('忙时点击不切换', () => {
    const { onSelect } = renderTabs({ busy: true })
    fireEvent.click(screen.getByTestId('wb-track-pm'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  // 页签条是 overflow 容器：外圈（outset）的环会被它裁掉、只剩左右两道细边，所以环画在页签框里面。真实几何见 e2e english.spec 的焦点用例。
  it('键盘焦点环：2px、强调色、画在页签框里面（ring-inset）；下划线仍是页签自己的下边框位置', () => {
    renderTabs()
    for (const tab of TABS) {
      const tokens = screen.getByTestId(`wb-track-${tab.id}`).className.split(/\s+/u)
      for (const token of ['focus-visible:ring-2', 'focus-visible:ring-inset', 'focus-visible:ring-(--accent)', 'border-b-2', 'outline-none']) expect(tokens).toContain(token)
    }
    // 选中的页签下划线用强调色，别的透明；下划线按字宽画（两侧的 6px 内边距不算）。
    expect(screen.getByTestId('wb-track-backend').className.split(/\s+/u)).toContain('after:bg-(--accent)')
    expect(screen.getByTestId('wb-track-pm').className.split(/\s+/u)).toContain('after:bg-transparent')
    expect(screen.getByTestId('wb-track-backend').className.split(/\s+/u)).toContain('after:inset-x-1.5')
  })

  it('tablist 里只有 tab', () => {
    renderTabs()
    const strip = screen.getByTestId('wb-tracks')
    expect(strip).toHaveAttribute('role', 'tablist')
    expect(strip).toHaveAccessibleName('Tracks')
    for (const child of Array.from(strip.children)) expect(child).toHaveAttribute('role', 'tab')
  })
})
