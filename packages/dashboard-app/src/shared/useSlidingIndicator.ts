import { useLayoutEffect, useRef, type RefObject } from 'react'
import gsap from 'gsap'
import { Flip } from 'gsap/Flip'

gsap.registerPlugin(Flip)

/** 默认当前项：单选芯片 / 分段（aria-checked）、导航当前页（aria-current=page）与分段页签（aria-selected）。 */
export const SLIDING_ACTIVE_SELECTOR = '[aria-checked="true"],[aria-current="page"],[role="tab"][aria-selected="true"]'

/**
 * 指示块的定位类：容器须带 `relative isolate`，指示块在内容之下（-z-10），不接收指针。
 * 底色与圆角由调用方追加（导航 / 芯片 `rounded-sm bg-accent-t`，分段滑块 `rounded-sm bg-card shadow-sm`）。
 */
export const SLIDING_INDICATOR_CLS = 'pointer-events-none absolute top-0 left-0 -z-10 opacity-0 data-[placed=true]:opacity-100'

/** 分段控件（设置弹层、门禁、编辑 / 渲染页签）滑块的滑动时长（秒）。 */
export const SEGMENT_SLIDE_S = 0.18
/** 分段控件的白色滑块：定位类 + 圆角、卡片底、轻阴影。 */
export const SEGMENT_THUMB_CLS = `${SLIDING_INDICATOR_CLS} rounded-sm bg-card shadow-sm`

export interface SlidingIndicatorOptions {
  /** 在容器内找当前项的选择器；缺省 SLIDING_ACTIVE_SELECTOR。 */
  selector?: string
  /** 滑动时长（秒）；缺省 0.22（导航、芯片），分段控件用 SEGMENT_SLIDE_S。 */
  duration?: number
}

export interface SlidingIndicator<C extends HTMLElement> {
  containerRef: RefObject<C>
  indicatorRef: RefObject<HTMLSpanElement>
}

interface Box { x: number; y: number; width: number; height: number }

function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function boxOf(container: HTMLElement, target: HTMLElement): Box {
  const outer = container.getBoundingClientRect()
  const inner = target.getBoundingClientRect()
  return {
    x: inner.left - outer.left + container.scrollLeft,
    y: inner.top - outer.top + container.scrollTop,
    width: inner.width,
    height: inner.height,
  }
}

function sameBox(a: Box | null, b: Box): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function place(indicator: HTMLElement, box: Box): void {
  indicator.style.left = `${box.x}px`
  indicator.style.top = `${box.y}px`
  indicator.style.width = `${box.width}px`
  indicator.style.height = `${box.height}px`
}

/**
 * 共享底色指示块：一组互斥选项（导航标签、单选芯片、分段控件）只画一个底色块，当前项变化时
 * 用 GSAP Flip 从旧位置滑到新位置（220ms power3.out）。当前项由容器内 aria 状态决定，调用方只需
 * 把 containerRef 挂在组容器上、把 indicatorRef 挂在组内一个 SLIDING_INDICATOR_CLS 的 span 上，
 * 选项自身不再画选中底色。
 * 首次定位、尺寸变化和 reduced-motion 下直接到位，不做动画；组内没有当前项时指示块隐藏。
 */
export function useSlidingIndicator<C extends HTMLElement = HTMLDivElement>(
  options: SlidingIndicatorOptions = {},
): SlidingIndicator<C> {
  const containerRef = useRef<C>(null)
  const indicatorRef = useRef<HTMLSpanElement>(null)
  const selector = options.selector ?? SLIDING_ACTIVE_SELECTOR
  const duration = options.duration ?? 0.22

  useLayoutEffect(() => {
    const container = containerRef.current
    const indicator = indicatorRef.current
    if (container === null || indicator === null) return undefined
    let current: { target: HTMLElement; box: Box } | null = null
    let tween: gsap.core.Timeline | null = null

    const sync = (animate: boolean): void => {
      const target = container.querySelector<HTMLElement>(selector)
      if (target === null) {
        tween?.kill()
        current = null
        indicator.dataset.placed = 'false'
        return
      }
      const box = boxOf(container, target)
      if (current !== null && current.target === target && sameBox(current.box, box)) return
      const slide = animate && current !== null && current.target !== target && motionAllowed()
      // 先记下当前可见位置（可能正滑到一半），再停掉旧补间、清掉它留下的 transform，最后落到新位置。
      const state = slide ? Flip.getState(indicator) : null
      tween?.kill()
      tween = null
      gsap.set(indicator, { clearProps: 'transform' })
      place(indicator, box)
      if (state !== null) tween = Flip.from(state, { duration, ease: 'power3.out', scale: false })
      current = { target, box }
      indicator.dataset.placed = 'true'
    }

    sync(false)
    const mutations = new MutationObserver(() => sync(true))
    mutations.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-checked', 'aria-current', 'aria-selected'],
    })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => sync(false))
    resize?.observe(container)
    return () => {
      mutations.disconnect()
      resize?.disconnect()
      tween?.kill()
    }
  }, [selector, duration])

  return { containerRef, indicatorRef }
}
