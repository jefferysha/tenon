import { createRequire } from 'node:module'
import type { Page } from 'playwright/test'
import { expect, settled, test } from './support/fixtures'
import { settlePage } from './support/settle.mjs'

/**
 * settled() 对脚本驱动的动画：GSAP 的补间不经过 document.getAnimations()，只能看计算样式。
 * 这里用真实的 GSAP（Dashboard 自己用的那份）在空白页上补间一个元素的位移、宽、高和不透明度，
 * 断言 settled() 返回时补间已经走完——只看不透明度与可见性的旧判据会在补间中途就返回。
 */
const GSAP = createRequire(import.meta.url).resolve('gsap/dist/gsap.min.js')
const DURATION_S = 0.8

async function mountBox(page: Page): Promise<void> {
  await page.setContent('<div data-testid="tween-box" style="position:absolute;left:10px;top:10px;width:40px;height:40px;background:#888"></div>')
  await page.addScriptTag({ path: GSAP })
}

/** 开始一个补间；onComplete 时打上 __tweenDone，让断言能在 settled() 返回后立刻看到补间是否走完。 */
async function tween(page: Page, vars: Record<string, number>): Promise<void> {
  await page.evaluate(({ props, duration }) => {
    Object.assign(window, { __tweenDone: false })
    const gsap = Reflect.get(window, 'gsap')
    gsap.to('[data-testid="tween-box"]', { ...props, duration, ease: 'none', onComplete: () => { Object.assign(window, { __tweenDone: true }) } })
  }, { props: vars, duration: DURATION_S })
}

const done = (page: Page): Promise<boolean> => page.evaluate((): boolean => Reflect.get(window, '__tweenDone') === true)

test.describe('settled() 与脚本驱动的补间', () => {
  for (const [name, vars] of [
    ['位置（x / y，GSAP 写 transform）', { x: 240, y: 120 }],
    ['宽度', { width: 320 }],
    ['高度', { height: 260 }],
    ['不透明度（autoAlpha）', { autoAlpha: 0.2 }],
  ] as const) {
    test(`${name}补间走完才算落定`, async ({ page }) => {
      await mountBox(page)
      await tween(page, vars)
      expect(await done(page), '补间开始时还没走完').toBe(false)
      await settled(page)
      expect(await done(page), 'settled() 在补间中途就返回了').toBe(true)
    })
  }

  test('静止的页面立刻落定，不为判据本身多等', async ({ page }) => {
    await mountBox(page)
    const started = Date.now()
    await settled(page)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('一直在动的补间到超时抛出，并点名是哪个元素在变', async ({ page }) => {
    await mountBox(page)
    await page.evaluate(() => {
      const gsap = Reflect.get(window, 'gsap')
      gsap.to('[data-testid="tween-box"]', { x: 200, duration: 0.5, ease: 'none', repeat: -1, yoyo: true })
    })
    const error = await settlePage(page, { timeoutMs: 600 }).then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toMatch(/page did not settle within 600ms; still animating: \(script-driven style change: div\[tween-box\]/)
  })
})
