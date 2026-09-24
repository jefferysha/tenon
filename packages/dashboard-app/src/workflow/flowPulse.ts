import { useEffect, type RefObject } from 'react'
import gsap from 'gsap'

/** 脉冲沿边前进的速度（px/s）：每条边的时长 = 边长 / 速度，长边走得久、短边走得快，整条传递匀速。 */
export const PULSE_SPEED = 420
/** 循环播放时两轮之间的停顿（s）。 */
export const PULSE_REPEAT_DELAY = 0.8
/** 到达节点时节点边框闪一下的总时长（s）。 */
export const PULSE_FLASH = 0.16
/** 到达终点时圆点放大与光环淡出的总时长（s）。 */
export const PULSE_RING = 0.32
/** 边的布局与测量要一两帧才落定；晚一点再量路径长度。 */
const BUILD_DELAY_MS = 120

/** off = 不播；loop = 运行中循环；once = 刚编辑后从起点到终点走一遍。 */
export type PulseMode = 'off' | 'loop' | 'once'

/** 高亮段长度：边长的 35%，夹在 36–64px 之间。 */
export function pulseSegment(length: number): number {
  return Math.min(64, Math.max(36, length * 0.35))
}

export interface PulseLeg { order: number; length: number }
export interface PulseStep { order: number; start: number; duration: number }

/**
 * 按段序排出每条边的起止：同一段序的边同时出发（扇出 / 汇合），下一段序等本段最长的那条走完再出发。
 * 返回与输入同序的起点与时长（s）。
 */
export function pulsePlan(legs: readonly PulseLeg[], speed = PULSE_SPEED): PulseStep[] {
  const orders = [...new Set(legs.map((leg) => leg.order))].sort((a, b) => a - b)
  const startOf = new Map<number, number>()
  let cursor = 0
  for (const order of orders) {
    startOf.set(order, cursor)
    cursor += Math.max(...legs.filter((leg) => leg.order === order).map((leg) => leg.length / speed))
  }
  return legs.map((leg) => ({ order: leg.order, start: startOf.get(leg.order) ?? 0, duration: leg.length / speed }))
}

/** 用户是否要求减少动态效果；没有 matchMedia（非浏览器环境）按「否」处理。 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 在画布容器里找到各条边的高亮组（`[data-pulse-order]`，内含 `path[data-pulse-stroke]`），把整条传递编进一条 timeline：
 * 高亮段沿线匀速前进，两端 5% 淡入淡出；每条边走完时它指向的技能节点闪一下（`[data-pulse-flash]`），
 * 终点圆点放大并放出一圈淡出的光环。loop 无限重复、每轮间隔 0.8s。容器里没有可量的边时返回 null。
 */
export function buildPulseTimeline(root: Element, mode: Exclude<PulseMode, 'off'>): gsap.core.Timeline | null {
  const groups = [...root.querySelectorAll<SVGGElement>('[data-pulse-order]')]
  const legs = groups.flatMap((group) => {
    const strokes = [...group.querySelectorAll<SVGPathElement>('path[data-pulse-stroke]')]
    const first = strokes[0]
    const length = first !== undefined && typeof first.getTotalLength === 'function' ? first.getTotalLength() : 0
    if (!Number.isFinite(length) || length <= 0) return []
    return [{ group, strokes, length, order: Number(group.dataset.pulseOrder ?? 0), target: group.dataset.pulseTarget ?? '' }]
  })
  if (legs.length === 0) return null
  const plan = pulsePlan(legs)
  const timeline = gsap.timeline({ repeat: mode === 'loop' ? -1 : 0, repeatDelay: PULSE_REPEAT_DELAY })
  const arrivals = new Map<string, number>()
  legs.forEach((leg, index) => {
    const step = plan[index]
    if (step === undefined) return
    const segment = pulseSegment(leg.length)
    const fade = step.duration * 0.05
    gsap.set(leg.strokes, { attr: { 'stroke-dasharray': `${segment} ${leg.length + segment}` } })
    timeline.fromTo(leg.strokes, { strokeDashoffset: segment }, { strokeDashoffset: -leg.length, duration: step.duration, ease: 'none' }, step.start)
    timeline.fromTo(leg.group, { opacity: 0 }, { opacity: 1, duration: fade, ease: 'none' }, step.start)
    timeline.to(leg.group, { opacity: 0, duration: fade, ease: 'none' }, step.start + step.duration - fade)
    const end = step.start + step.duration
    arrivals.set(leg.target, Math.max(arrivals.get(leg.target) ?? 0, end))
  })
  for (const [target, at] of arrivals) {
    const node = root.querySelector(`[data-flow-node="${target.replace(/["\\]/gu, '\\$&')}"]`)
    const flash = node?.querySelector('[data-pulse-flash]')
    if (flash !== null && flash !== undefined) timeline.fromTo(flash, { opacity: 0 }, { opacity: 1, duration: PULSE_FLASH / 2, ease: 'power1.out', yoyo: true, repeat: 1 }, at)
    const dot = node?.querySelector('[data-pulse-dot]')
    const ring = node?.querySelector('[data-pulse-ring]')
    if (dot !== null && dot !== undefined) timeline.fromTo(dot, { scale: 1 }, { scale: 1.35, duration: PULSE_RING / 2, ease: 'power2.out', yoyo: true, repeat: 1 }, at)
    if (ring !== null && ring !== undefined) timeline.fromTo(ring, { scale: 1, opacity: 0.5 }, { scale: 2.4, opacity: 0, duration: PULSE_RING, ease: 'power2.out' }, at)
  }
  return timeline
}

/**
 * SkillFlow 的脉冲：mode / run / layout 任一变化就丢掉旧 timeline、晚一拍重建。off、减少动态效果、卸载时都不留 timeline；
 * 播放中切到减少动态效果立即停。
 */
export function usePulseTimeline(container: RefObject<HTMLElement | null>, mode: PulseMode, run: number, layout: string): void {
  useEffect(() => {
    const root = container.current
    if (root === null || mode === 'off') return
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    let timeline: gsap.core.Timeline | null = null
    const stop = (): void => {
      timeline?.kill()
      timeline = null
      const groups = root.querySelectorAll('[data-pulse-order]')
      if (groups.length > 0) gsap.set(groups, { opacity: 0 })
    }
    const start = (): void => {
      stop()
      if (!prefersReducedMotion()) timeline = buildPulseTimeline(root, mode)
    }
    const timer = setTimeout(start, BUILD_DELAY_MS)
    query?.addEventListener?.('change', start)
    return () => { clearTimeout(timer); query?.removeEventListener?.('change', start); stop() }
  }, [container, mode, run, layout])
}
