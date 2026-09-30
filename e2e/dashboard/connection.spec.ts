import { expect, openView, test } from './support/fixtures'

// 页面订阅的是列表流（/api/stream?view=list），带查询串。
const STREAM = /\/api\/stream(\?|$)/

test.describe('断线', () => {
  test('实时流断开：只出现一个「重连」按钮，恢复后横幅消失', async ({ page, server }) => {
    // 浏览器到 server 的实时流（SSE）打桩成连不上；其余请求照常走真实 server。
    let blocked = true
    await page.route(STREAM, async (route) => {
      if (blocked) await route.abort('connectionrefused')
      else await route.continue()
    })
    await openView(page, 'workspace', { root: server.project })

    const banner = page.getByTestId('offline-banner')
    await expect(banner).toBeVisible()
    await expect(page.getByTestId('conn-indicator')).toBeVisible()
    await expect(banner.getByRole('button', { name: /重连/ })).toHaveCount(1)
    await expect(page.getByRole('button', { name: /重连/ }), '整页只有一个重连按钮').toHaveCount(1)
    await expect(page.getByTestId('offline-reconnect')).toHaveText('重连')
    // 服务进程真退出时重连无效：旁边给出可复制的重启命令。
    await expect(page.getByTestId('offline-restart')).toContainText('tenon dashboard --background')

    blocked = false
    await page.getByTestId('offline-reconnect').click()
    await expect(banner).toBeHidden()
    await expect(page.getByTestId('conn-indicator')).toHaveCount(0)
    await expect(page.getByTestId('primary-nav')).toBeVisible()
  })

  test('重连时仍连不上：横幅还在，按钮还是只有一个', async ({ page, server }) => {
    await page.route(STREAM, (route) => route.abort('connectionrefused'))
    await openView(page, 'workspace', { root: server.project })
    const reconnect = page.getByTestId('offline-reconnect')
    await expect(reconnect).toBeVisible()
    await reconnect.click()
    await expect(page.getByTestId('offline-banner')).toBeVisible()
    await expect(page.getByRole('button', { name: /重连/ })).toHaveCount(1)
  })
})
