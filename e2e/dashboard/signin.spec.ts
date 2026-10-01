import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { expect, openView, test } from './support/fixtures'

test.describe('登录', () => {
  test('没有会话的浏览器只看到登录提示：没有数据、没有写 token、API 读是 401', async ({ browser, server }) => {
    const context = await browser.newContext({ baseURL: server.url })
    try {
      const page = await context.newPage()
      const response = await page.goto('/')
      expect(response?.status()).toBe(401)
      await expect(page.getByTestId('sign-in-required')).toContainText('tenon dashboard --open')
      await expect(page.getByTestId('primary-nav')).toHaveCount(0)
      expect(await page.evaluate(() => (window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__)).toBeUndefined()
      expect(await page.content()).not.toContain('__TENON_DASHBOARD_TOKEN__')

      expect((await page.request.get('/api/snapshot')).status()).toBe(401)
      expect((await page.request.get('/api/snapshot?view=list')).status()).toBe(401)
      expect((await page.request.get('/api/stream?view=list')).status()).toBe(401)
      expect((await page.request.get('/api/change/demo/snapshot?root=%2Ftmp')).status()).toBe(401)
      expect((await page.request.get('/api/health')).status()).toBe(200)
    } finally {
      await context.close()
    }
  })

  test('tenon dashboard --open 的真实路径：server 把一次性链接只交给浏览器，浏览器换到会话并落在 Dashboard；链接只能用一次', async ({ browser, server }) => {
    const context = await browser.newContext({ baseURL: server.url })
    try {
      await rm(server.openedUrlFile, { force: true })
      // 发起者（CLI）只知道「打开了没有」：响应里没有链接，也没有 cookie。
      const asked = await context.request.post('/api/session/open', { data: {} })
      expect(asked.status()).toBe(200)
      const answer = await asked.text()
      expect(JSON.parse(answer)).toEqual({ ok: true, opened: true })
      expect(answer).not.toContain('session/start')
      expect(asked.headers()['set-cookie']).toBeUndefined()

      // 假桌面 opener 收到的链接，由浏览器自己打开。
      const link = readFileSync(server.openedUrlFile, 'utf8').trim().split('\n').at(-1) ?? ''
      expect(link).toMatch(new RegExp(`^${server.url}/session/start\\?code=[A-Za-z0-9_-]{43}$`))
      const page = await context.newPage()
      await page.goto(link)
      await expect(page.getByTestId('primary-nav')).toBeVisible()
      expect(new URL(page.url()).pathname).toBe('/')
      expect(new URL(page.url()).search).not.toContain('code=')
      const cookie = (await context.cookies(server.url)).find((entry) => entry.name.startsWith('tenon_session_'))
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' })

      // 同一条链接不能再换第二个会话。
      const other = await browser.newContext({ baseURL: server.url })
      try {
        const replay = await (await other.newPage()).goto(link)
        expect(replay?.status()).toBe(403)
        expect(await other.cookies(server.url)).toEqual([])
      } finally {
        await other.close()
      }
    } finally {
      await context.close()
    }
  })

  test('登录后刷新仍是登录状态；会话 cookie 是 HttpOnly + SameSite=Strict，页面脚本读不到', async ({ page, context, server }) => {
    await openView(page, 'workspace', { root: server.project })
    await page.reload()
    await expect(page.getByTestId('primary-nav')).toBeVisible()

    const cookie = (await context.cookies(server.url)).find((entry) => entry.name === server.session.name)
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' })
    expect(await page.evaluate(() => document.cookie)).toBe('')
    // 写 token 只在登录后的页面里，且只在内存里的全局变量，不在 storage。
    expect(await page.evaluate(() => Boolean((window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__))).toBe(true)
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/[0-9a-f]{64}/)
  })

  test('会话失效后已打开的页面给出重新登录的命令，而不是泛泛的断线', async ({ page, context, server }) => {
    // 实时流起不来（服务重启 / 升级会掐断已有连接）：页面先带着会话把首个快照加载出来。
    // 页面订阅的是列表流（/api/stream?view=list），带查询串。
    await page.route(/\/api\/stream(\?|$)/, (route) => route.abort('connectionrefused'))
    await openView(page, 'workspace', { root: server.project })
    await expect(page.getByTestId('offline-banner')).toContainText('连接断开')
    // 重启 / 升级后会话没了（或 cookie 过期）：下一次请求没有会话。
    await context.clearCookies()
    await page.getByTestId('offline-reconnect').click()

    await expect(page.getByTestId('offline-banner')).toContainText('登录已失效')
    await expect(page.getByTestId('offline-restart-text')).toHaveText('tenon dashboard --open')
  })
})
