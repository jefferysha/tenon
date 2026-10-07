import { test as base, expect, type Page } from 'playwright/test'
import { settlePage } from './settle.mjs'
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

/**
 * 等页面落定：没有还在跑的 CSS 动画 / 过渡 / Web Animations，没有脚本在改元素的不透明度、可见性、transform、宽或高
 * （GSAP 的淡入与位置补间不经过 `document.getAnimations()`，要看计算样式），而且这样连续几帧。
 * 判据与墙钟兜底（帧不走的后台 / 隐藏页面也以它自己的报错收场）都在 support/settle.mjs，文档截图脚本共用同一份。
 */
export async function settled(page: Page): Promise<void> {
  await settlePage(page)
}

/** 在页面全程没有新动画的条件下做一件事（axe 扫描）：落定之后才开始的动画会让这一轮作废重来，见 support/settle.mjs。 */
export { whileStill } from './settle.mjs'

/** 直达某个视图（可带项目、任务等查询参数）；等顶部导航出现即页面已挂载。 */
export async function openView(page: Page, view: string, params: Record<string, string> = {}): Promise<void> {
  const query = new URLSearchParams({ view, ...params })
  await page.goto(`/?${query.toString()}`)
  await expect(page.getByTestId('primary-nav')).toBeVisible()
}
