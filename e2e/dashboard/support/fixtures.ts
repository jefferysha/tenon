import { test as base, expect, type Page } from 'playwright/test'
import { readServerState, type ServerState } from './server-state'

interface DashboardFixtures {
  /** 被测服务与种子项目的路径。 */
  readonly server: ServerState
}

export const test = base.extend<DashboardFixtures>({
  server: async ({}, use) => { await use(readServerState()) },
  baseURL: async ({ server }, use) => { await use(server.url) },
  // Dashboard 不向未登录的请求提供任何东西：每个上下文带着 serve.mjs 登录得到的会话 cookie（HttpOnly、SameSite=Strict）。
  context: async ({ context, server }, use) => {
    await context.addCookies([{
      name: server.session.name, value: server.session.value, url: server.url, httpOnly: true, sameSite: 'Strict',
    }])
    await use(context)
  },
})

export { expect }

/** 连续这么多帧页面都没有变化，才算落定。 */
const QUIET_FRAMES = 3
const SETTLE_TIMEOUT_MS = 15_000

/**
 * 等页面落定：没有还在跑的 CSS 动画 / 过渡 / Web Animations，没有脚本在改元素的不透明度（GSAP 的 autoAlpha
 * 淡入不经过 `document.getAnimations()`，要看计算样式），而且这样连续 QUIET_FRAMES 帧。
 * 对话框与抽屉的进场（淡入 + 位移）、页面切换淡入、向导步骤框 200ms 的高度过渡都是 CSS 动画或过渡；
 * 慢的浏览器（CI 里的 WebKit）上它们要拖得久得多，所以不能按固定时长等。
 * 连续多帧都安静才返回：动画常在提交之后的下一两帧才开始（ResizeObserver 量完高度才触发过渡），一帧安静不算数。
 * 无限循环的动画（旋转图标、Signal 彗星）永远不会结束，它们本身不计入，暂停的也不计。
 * 超时抛出仍在变化的东西，便于看是谁没停。
 */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(({ quietFrames, timeoutMs }) => new Promise<void>((resolve, reject) => {
    const finiteRunning = (): Animation[] => document.getAnimations().filter((animation) => {
      if (animation.playState !== 'running') return false
      const end = animation.effect?.getComputedTiming().endTime
      return typeof end === 'number' && Number.isFinite(end)
    })
    const describe = (animation: Animation): string => {
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
      const name = 'animationName' in animation ? String(animation.animationName) : 'transitionProperty' in animation ? String(animation.transitionProperty) : animation.id
      const testId = target?.getAttribute('data-testid')
      return `${target?.tagName.toLowerCase() ?? 'unknown'}${testId ? `[${testId}]` : ''} ${name}`
    }
    // 每个元素的不透明度与可见性；无限循环动画的目标不算（它们每帧都变）。
    const opacitySignature = (): string => {
      const looping = new Set<Element>()
      for (const animation of document.getAnimations()) {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
        if (target !== null && animation.effect?.getComputedTiming().endTime === Infinity) looping.add(target)
      }
      let signature = ''
      for (const element of document.body.querySelectorAll('*')) {
        if (looping.has(element)) continue
        const style = getComputedStyle(element)
        signature += `${style.opacity}${style.visibility === 'hidden' ? 'h' : ''},`
      }
      return signature
    }
    const started = performance.now()
    let quiet = 0
    let previous = ''
    const tick = (): void => {
      const animating = finiteRunning()
      const signature = opacitySignature()
      quiet = animating.length === 0 && signature === previous ? quiet + 1 : 0
      previous = signature
      if (quiet >= quietFrames) resolve()
      else if (performance.now() - started > timeoutMs) {
        reject(new Error(`page did not settle within ${timeoutMs}ms; still animating: ${animating.map(describe).join(', ') || '(script-driven opacity change)'}`))
      } else requestAnimationFrame(tick)
    }
    void document.fonts.ready.then(() => requestAnimationFrame(tick))
  }), { quietFrames: QUIET_FRAMES, timeoutMs: SETTLE_TIMEOUT_MS })
}

/** 直达某个视图（可带项目、任务等查询参数）；等顶部导航出现即页面已挂载。 */
export async function openView(page: Page, view: string, params: Record<string, string> = {}): Promise<void> {
  const query = new URLSearchParams({ view, ...params })
  await page.goto(`/?${query.toString()}`)
  await expect(page.getByTestId('primary-nav')).toBeVisible()
}
