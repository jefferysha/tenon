import { test as base, expect, type Page } from 'playwright/test'
import { readServerState, type ServerState } from './server-state'

interface DashboardFixtures {
  /** 被测服务与种子项目的路径。 */
  readonly server: ServerState
}

export const test = base.extend<DashboardFixtures>({
  server: async ({}, use) => { await use(readServerState()) },
  baseURL: async ({ server }, use) => { await use(server.url) },
})

export { expect }

/** 直达某个视图（可带项目、任务等查询参数）；等顶部导航出现即页面已挂载。 */
export async function openView(page: Page, view: string, params: Record<string, string> = {}): Promise<void> {
  const query = new URLSearchParams({ view, ...params })
  await page.goto(`/?${query.toString()}`)
  await expect(page.getByTestId('primary-nav')).toBeVisible()
}
