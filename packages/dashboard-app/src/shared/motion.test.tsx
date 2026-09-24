/**
 * 共享 GSAP 动效：motion / reduce / 无 matchMedia 三条分支，以及 toast 退场「播完才卸载」。
 * reduced-motion 只留 0.1s 淡入淡出，不位移。
 * 文件后缀 .tsx 是本包 vitest include（只收 src 下 .test.tsx）的准入要求，与是否含 JSX 无关。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import gsap from 'gsap'
import * as motion from './motion'
import { revealList, toastIn, toastOut } from './motion'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 可控 matchMedia 桩：reduce/motion 两条媒体查询独立驱动。 */
function stubMatchMedia(opts: { reduce: boolean; motion: boolean }): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce')
        ? opts.reduce
        : query.includes('no-preference')
          ? opts.motion
          : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  )
}

function makeTargets(n: number): HTMLElement[] {
  return Array.from({ length: n }, () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    return el
  })
}

type FromTo = [unknown, gsap.TweenVars, gsap.TweenVars]

describe('revealList', () => {
  it('motion 分支：上浮 4px + 淡入 180ms，错开 30ms', () => {
    stubMatchMedia({ reduce: false, motion: true })
    const fromTo = vi.spyOn(gsap, 'fromTo')
    revealList(makeTargets(3))
    expect(fromTo).toHaveBeenCalledTimes(1)
    const [, fromVars, toVars] = fromTo.mock.calls[0] as unknown as FromTo
    expect(fromVars).toMatchObject({ autoAlpha: 0, y: 4 })
    expect(toVars).toMatchObject({ autoAlpha: 1, y: 0, duration: 0.18, ease: 'power3.out', stagger: 0.03 })
  })

  it('reduce 分支：只做 0.1s autoAlpha，不位移', () => {
    stubMatchMedia({ reduce: true, motion: false })
    const fromTo = vi.spyOn(gsap, 'fromTo')
    revealList(makeTargets(2))
    const [, fromVars, toVars] = fromTo.mock.calls[0] as unknown as FromTo
    expect(fromVars).toEqual({ autoAlpha: 0 })
    expect(toVars).toMatchObject({ autoAlpha: 1, duration: 0.1 })
    expect(toVars).not.toHaveProperty('y')
    expect(toVars).not.toHaveProperty('stagger')
  })

  it.each([
    ['无 matchMedia', () => vi.stubGlobal('matchMedia', undefined)],
    ['两条件都不匹配', () => stubMatchMedia({ reduce: false, motion: false })],
  ])('%s → gsap.set 直达可见终态', (_label, arrange) => {
    arrange()
    const fromTo = vi.spyOn(gsap, 'fromTo')
    const set = vi.spyOn(gsap, 'set')
    const targets = makeTargets(2)
    revealList(targets)
    expect(fromTo).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith(targets, expect.objectContaining({ autoAlpha: 1, y: 0 }))
  })

  it('没有调用方的 revealDialog / revealStages 已删除，revealList 签名保持 (targets, stagger?)', () => {
    expect(Object.keys(motion).sort()).toEqual(['revealList', 'toastIn', 'toastOut'])
    expect(revealList.length).toBe(1)
  })
})

describe('toast 入场与退场', () => {
  it('入场 motion 分支：y 12 → 0 + 淡入 200ms', () => {
    stubMatchMedia({ reduce: false, motion: true })
    const fromTo = vi.spyOn(gsap, 'fromTo')
    const handle = toastIn(document.createElement('div'))
    const [, fromVars, toVars] = fromTo.mock.calls[0] as unknown as FromTo
    expect(fromVars).toMatchObject({ autoAlpha: 0, y: 12 })
    expect(toVars).toMatchObject({ autoAlpha: 1, y: 0, duration: 0.2 })
    handle.kill()
  })

  it('入场 reduce 分支：只淡入 0.1s', () => {
    stubMatchMedia({ reduce: true, motion: false })
    const fromTo = vi.spyOn(gsap, 'fromTo')
    const handle = toastIn(document.createElement('div'))
    const [, , toVars] = fromTo.mock.calls[0] as unknown as FromTo
    expect(toVars).toMatchObject({ autoAlpha: 1, duration: 0.1 })
    expect(toVars).not.toHaveProperty('y')
    handle.kill()
  })

  it('退场：下沉 8px + 淡出 120ms power2.in，播完才回调', () => {
    stubMatchMedia({ reduce: false, motion: true })
    const tween = { kill: vi.fn() }
    const to = vi.spyOn(gsap, 'to').mockReturnValue(tween as unknown as gsap.core.Tween)
    const onDone = vi.fn()
    const target = document.createElement('div')
    const handle = toastOut(target, onDone)
    expect(to).toHaveBeenCalledWith(target, expect.objectContaining({ autoAlpha: 0, y: 8, duration: 0.12, ease: 'power2.in' }))
    expect(onDone).not.toHaveBeenCalled()
    const vars = to.mock.calls[0]?.[1] as gsap.TweenVars
    vars.onComplete?.()
    expect(onDone).toHaveBeenCalledTimes(1)
    handle.kill()
    expect(tween.kill).toHaveBeenCalledTimes(1)
  })

  it('退场 reduce 分支只淡出 0.1s；无 matchMedia 直接回调', () => {
    stubMatchMedia({ reduce: true, motion: false })
    const to = vi.spyOn(gsap, 'to')
    toastOut(document.createElement('div'), vi.fn())
    const vars = to.mock.calls[0]?.[1] as gsap.TweenVars
    expect(vars).toMatchObject({ autoAlpha: 0, duration: 0.1 })
    expect(vars).not.toHaveProperty('y')

    vi.stubGlobal('matchMedia', undefined)
    const onDone = vi.fn()
    toastOut(document.createElement('div'), onDone)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('toast 无 matchMedia 时直达终态并返回可清理 handle', () => {
    vi.stubGlobal('matchMedia', undefined)
    const tween = { kill: vi.fn() }
    const set = vi.spyOn(gsap, 'set').mockReturnValue(tween as unknown as gsap.core.Tween)
    const target = document.createElement('div')

    const handle = toastIn(target)
    expect(set).toHaveBeenCalledWith(target, { autoAlpha: 1, y: 0 })
    handle.kill()
    expect(tween.kill).toHaveBeenCalledTimes(1)
  })

  it('toast 的媒体上下文在调用方 cleanup 时 revert 并清理活动 tween', () => {
    stubMatchMedia({ reduce: false, motion: true })
    const tween = { kill: vi.fn() }
    vi.spyOn(gsap, 'fromTo').mockReturnValue(tween as unknown as gsap.core.Tween)
    let cleanup: (() => void) | undefined
    const mediaContext = {
      add: vi.fn((_conditions: unknown, callback: (ctx: { conditions?: { reduce?: boolean } }) => (() => void)) => {
        cleanup = callback({ conditions: { reduce: false } })
        return mediaContext
      }),
      revert: vi.fn(() => cleanup?.()),
    }
    vi.spyOn(gsap, 'matchMedia').mockReturnValue(mediaContext as unknown as gsap.MatchMedia)

    const handle = toastIn(document.createElement('div'))
    handle.kill()

    expect(mediaContext.revert).toHaveBeenCalledTimes(1)
    expect(tween.kill).toHaveBeenCalledTimes(1)
  })
})
