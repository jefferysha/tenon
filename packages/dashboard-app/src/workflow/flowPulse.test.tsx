import { useRef } from 'react'
import { act, render } from '@testing-library/react'
import gsap from 'gsap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPulseTimeline, PULSE_REPEAT_DELAY, PULSE_SPEED, pulsePlan, pulseSegment, usePulseTimeline, type PulseMode } from './flowPulse'

function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? reduce : !reduce,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }))
}

function stubLengths(): void {
  Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value(this: SVGElement) { return Number(this.getAttribute('data-length') ?? 0) } })
}

/** 画布替身：每条边一组高亮描边（长度由 data-length 给出），外加一个技能节点与终点。 */
function Canvas({ mode, legs }: { mode: PulseMode; legs: ReadonlyArray<{ order: number; length: number; target: string }> }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  usePulseTimeline(ref, mode, 0, 'layout')
  return (
    <div ref={ref}>
      <svg>
        {legs.map((leg, index) => (
          <g key={index} data-pulse-order={leg.order} data-pulse-target={leg.target} style={{ opacity: 0 }}>
            <path data-pulse-stroke="glow" data-length={leg.length} />
            <path data-pulse-stroke="core" data-length={leg.length} />
          </g>
        ))}
      </svg>
      <div data-flow-node="a"><span data-pulse-flash="" /></div>
      <div data-flow-node="end"><span data-pulse-ring="" /><span data-pulse-dot="" /></div>
    </div>
  )
}

const LEGS = [
  { order: 0, length: 84, target: 'a' },
  { order: 1, length: 210, target: 'end' },
  { order: 1, length: 420, target: 'end' },
]

function targetsOf(tween: gsap.core.Tween): Element[] {
  return tween.targets() as Element[]
}

describe('flowPulse', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('pulsePlan：时长 = 边长 / 420；同段序同时出发，下一段序等本段最长那条走完', () => {
    const plan = pulsePlan(LEGS)
    expect(plan.map((step) => step.duration)).toEqual([84 / PULSE_SPEED, 210 / PULSE_SPEED, 420 / PULSE_SPEED])
    expect(plan[1]!.duration / plan[0]!.duration).toBeCloseTo(210 / 84)
    expect(plan.map((step) => step.start)).toEqual([0, 0.2, 0.2])
  })

  it('pulseSegment：边长的 35%，夹在 36–64', () => {
    expect(pulseSegment(40)).toBe(36)
    expect(pulseSegment(140)).toBeCloseTo(49)
    expect(pulseSegment(1000)).toBe(64)
  })

  it('buildPulseTimeline：一条 timeline；描边时长与边长成正比；到达节点闪 160ms、终点光环 320ms；loop 间隔 0.8s', () => {
    stubLengths()
    const timeline = vi.spyOn(gsap, 'timeline')
    const { container } = render(<Canvas mode="off" legs={LEGS} />)
    const built = buildPulseTimeline(container, 'loop')
    expect(built).not.toBeNull()
    expect(timeline).toHaveBeenCalledTimes(1)
    expect(timeline.mock.calls[0]![0]).toMatchObject({ repeat: -1, repeatDelay: PULSE_REPEAT_DELAY })
    const tweens = built!.getChildren(false, true, false) as gsap.core.Tween[]
    const strokes = tweens.filter((tween) => targetsOf(tween).every((target) => target.hasAttribute('data-pulse-stroke')))
    expect(strokes.map((tween) => tween.duration())).toEqual([84 / PULSE_SPEED, 210 / PULSE_SPEED, 420 / PULSE_SPEED])
    const flash = tweens.find((tween) => targetsOf(tween)[0]?.hasAttribute('data-pulse-flash'))
    expect(flash!.totalDuration()).toBeCloseTo(0.16)
    expect(flash!.startTime()).toBeCloseTo(0.2)
    const ring = tweens.find((tween) => targetsOf(tween)[0]?.hasAttribute('data-pulse-ring'))
    expect(ring!.duration()).toBeCloseTo(0.32)
    expect(ring!.startTime()).toBeCloseTo(1.2)
    expect(container.querySelector('path[data-pulse-stroke="core"]')).toHaveAttribute('stroke-dasharray', `36 ${84 + 36}`)
    built!.kill()
    expect(buildPulseTimeline(document.createElement('div'), 'once')).toBeNull()
  })

  it('once 只走一遍', () => {
    stubLengths()
    const { container } = render(<Canvas mode="off" legs={LEGS} />)
    const built = buildPulseTimeline(container, 'once')
    expect(built!.repeat()).toBe(0)
    built!.kill()
  })

  it('usePulseTimeline：减少动态效果与 off 都不建 timeline；播放中卸载时 kill', () => {
    vi.useFakeTimers()
    stubLengths()
    const timeline = vi.spyOn(gsap, 'timeline')
    stubMatchMedia(true)
    const reduced = render(<Canvas mode="loop" legs={LEGS} />)
    act(() => { vi.advanceTimersByTime(500) })
    expect(timeline).not.toHaveBeenCalled()
    reduced.unmount()
    stubMatchMedia(false)
    const off = render(<Canvas mode="off" legs={LEGS} />)
    act(() => { vi.advanceTimersByTime(500) })
    expect(timeline).not.toHaveBeenCalled()
    off.unmount()
    const playing = render(<Canvas mode="loop" legs={LEGS} />)
    act(() => { vi.advanceTimersByTime(500) })
    expect(timeline).toHaveBeenCalledTimes(1)
    const kill = vi.spyOn(timeline.mock.results[0]!.value as gsap.core.Timeline, 'kill')
    playing.unmount()
    expect(kill).toHaveBeenCalled()
  })
})
