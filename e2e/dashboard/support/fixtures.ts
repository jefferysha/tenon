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

/** 直达某个视图（可带项目、任务等查询参数）；等顶部导航出现即页面已挂载。 */
export async function openView(page: Page, view: string, params: Record<string, string> = {}): Promise<void> {
  const query = new URLSearchParams({ view, ...params })
  await page.goto(`/?${query.toString()}`)
  await expect(page.getByTestId('primary-nav')).toBeVisible()
}
