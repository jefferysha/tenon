import { useCallback, useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react'
import gsap from 'gsap'
import { Flip } from 'gsap/Flip'

gsap.registerPlugin(Flip)

const FLIP_SELECTOR = '[data-flip-id]'

function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 列表 / 画布重排的位移动效：在改 state 之前调 `capture()` 记录各 `data-flip-id` 元素的位置，
 * React 提交新布局后（layout effect）用 GSAP Flip 从旧位置补间到新位置；新进元素淡入放大。
 * reduced-motion 或无 matchMedia 时 capture 为空操作，布局直接跳到终态。
 */
export function useFlipLayout(container: RefObject<HTMLElement | null>, deps: DependencyList): () => void {
  const pending = useRef<Flip.FlipState | null>(null)
  const capture = useCallback((): void => {
    const root = container.current
    if (root === null || !motionAllowed()) return
    pending.current = Flip.getState(root.querySelectorAll(FLIP_SELECTOR))
  }, [container])
  useLayoutEffect(() => {
    const state = pending.current
    pending.current = null
    const root = container.current
    if (state === null || root === null) return
    const tween = Flip.from(state, {
      targets: root.querySelectorAll(FLIP_SELECTOR),
      duration: 0.32,
      ease: 'power2.out',
      nested: true,
      onEnter: (elements) => gsap.fromTo(elements, { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.24, ease: 'power2.out' }),
    })
    return () => { tween.kill() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return capture
}

/** 落位反馈：目标元素轻微放大回弹一次。reduced-motion 下不动。 */
export function dropPulse(element: Element | null): void {
  if (element === null || !motionAllowed()) return
  gsap.fromTo(element, { scale: 1.03 }, { scale: 1, duration: 0.28, ease: 'back.out(2)', clearProps: 'transform' })
}
