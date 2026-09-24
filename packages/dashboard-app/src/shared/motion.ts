import gsap from 'gsap'

/**
 * 跨视图共享的 GSAP 入场 / 退场动效：同一套 reduced-motion 判断与时长缓动惯例（index.css 的 --dur-* /
 * --ease-* 对位：power3.out ≈ --ease-out，power2.in ≈ --ease-exit）。
 * reduced-motion 分支只做 0.1s 的 autoAlpha 淡入淡出，不位移。
 * revealList 必须在组件的 `useGSAP(() => { ... }, { scope })` 回调内同步调用——GSAP 的 context 追踪按调用栈生效。
 * toastIn 也支持普通 React effect，调用方必须在 effect cleanup 中调用它返回 handle 的 kill()。
 */
const REDUCE = '(prefers-reduced-motion: reduce)'
const REDUCE_FADE = 0.1

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

function withMotionPreference(
  reduce: () => gsap.core.Tween[],
  motion: () => gsap.core.Tween[],
  fallback: () => gsap.core.Tween[],
): void {
  if (!hasMatchMedia()) {
    fallback()
    return
  }

  let handled = false
  gsap.matchMedia().add(
    { reduce: REDUCE, motion: '(prefers-reduced-motion: no-preference)' },
    (ctx) => {
      handled = true
      const shouldReduce = Boolean((ctx.conditions as { reduce?: boolean } | undefined)?.reduce)
      const tweens = shouldReduce ? reduce() : motion()
      return () => {
        for (const tween of tweens) tween.kill()
      }
    },
  )
  // matchMedia 存在但两个条件都不匹配（非常规 UA 桩）：直达终态，保证可见。
  if (!handled) fallback()
}

/** 列表 / 右栏内容入场：上浮 4px + 淡入 180ms，按顺序错开 30ms。 */
export function revealList(targets: gsap.TweenTarget, stagger = 0.03): void {
  withMotionPreference(
    () => [gsap.fromTo(targets, { autoAlpha: 0 }, { autoAlpha: 1, duration: REDUCE_FADE, ease: 'none' })],
    () => [gsap.fromTo(targets, { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: 0.18, ease: 'power3.out', stagger })],
    () => [gsap.set(targets, { autoAlpha: 1, y: 0 })],
  )
}

export interface MotionHandle {
  kill: () => void
}

/** toast 底部滑入：y 12→0 + 淡入 200ms；偏好变化时立即切换到对应终态。 */
export function toastIn(el: gsap.TweenTarget): MotionHandle {
  if (!hasMatchMedia()) {
    const fallbackTween = gsap.set(el, { autoAlpha: 1, y: 0 })
    return { kill: () => fallbackTween.kill() }
  }

  const mediaContext = gsap.matchMedia()
  let handled = false
  let fallbackTween: gsap.core.Tween | undefined
  mediaContext.add(
    { reduce: REDUCE, motion: '(prefers-reduced-motion: no-preference)' },
    (ctx) => {
      handled = true
      const reduce = Boolean((ctx.conditions as { reduce?: boolean } | undefined)?.reduce)
      const tween = reduce
        ? gsap.fromTo(el, { autoAlpha: 0, y: 0 }, { autoAlpha: 1, duration: REDUCE_FADE, ease: 'none' })
        : gsap.fromTo(el, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.2, ease: 'power3.out' })
      return () => tween.kill()
    },
  )

  if (!handled) fallbackTween = gsap.set(el, { autoAlpha: 1, y: 0 })
  return {
    kill: () => {
      fallbackTween?.kill()
      mediaContext.revert()
    },
  }
}

/**
 * toast 退场：下沉 8px + 淡出 120ms（power2.in），播完才调用 onDone 让调用方卸载。
 * 没有 matchMedia 时直接 onDone；reduced-motion 只淡出 0.1s。kill() 中止退场且不再调用 onDone。
 */
export function toastOut(el: gsap.TweenTarget, onDone: () => void): MotionHandle {
  if (!hasMatchMedia()) {
    onDone()
    return { kill: () => undefined }
  }
  const reduce = window.matchMedia(REDUCE).matches
  const tween = gsap.to(el, reduce
    ? { autoAlpha: 0, duration: REDUCE_FADE, ease: 'none', onComplete: onDone }
    : { autoAlpha: 0, y: 8, duration: 0.12, ease: 'power2.in', onComplete: onDone })
  return { kill: () => tween.kill() }
}
