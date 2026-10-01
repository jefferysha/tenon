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

/** 匿名页的语言按 Accept-Language 选（浏览器的界面语言决定它）；配色跟随系统。 */
const ANONYMOUS_PAGES = [
  { name: '中文', locale: 'zh-CN', lang: 'zh', heading: '需要登录', invalid: '登录链接无效或已过期', copy: '复制命令', copied: '已复制', continue: '继续' },
  { name: 'English', locale: 'en-US', lang: 'en', heading: 'Sign in required', invalid: 'Sign-in link invalid or expired', copy: 'Copy command', copied: 'Copied', continue: 'Continue' },
] as const

for (const scheme of ['light', 'dark'] as const) {
  for (const spec of ANONYMOUS_PAGES) {
    test.describe(`登录页 · ${spec.name} · ${scheme}`, () => {
      test('一种语言、Dashboard 的 token、严格 CSP；标题 + 一条命令 + 复制钮 + 继续链接', async ({ browser, browserName, server }) => {
        const context = await browser.newContext({ baseURL: server.url, colorScheme: scheme, locale: spec.locale, viewport: { width: 1000, height: 640 } })
        try {
          const violations: string[] = []
          const page = await context.newPage()
          page.on('console', (message) => { if (/content security policy|refused to/iu.test(message.text())) violations.push(message.text()) })
          const requests: string[] = []
          page.on('request', (request) => requests.push(request.url()))
          const response = await page.goto('/')
          expect(response?.status()).toBe(401)
          const csp = response?.headers()['content-security-policy'] ?? ''
          expect(csp).toContain("default-src 'none'")
          expect(csp).not.toContain('unsafe-inline')

          await expect(page.locator('html')).toHaveAttribute('lang', spec.lang)
          await expect(page.getByTestId('sign-in-heading')).toHaveText(spec.heading)
          await expect(page.getByTestId('sign-in-command')).toHaveText('tenon dashboard --open')
          await expect(page.getByTestId('sign-in-copy')).toHaveAttribute('aria-label', spec.copy)
          await expect(page.getByTestId('sign-in-continue')).toHaveText(spec.continue)
          await expect(page.getByTestId('sign-in-continue')).toHaveAttribute('href', '/')
          // 一种语言：另一种语言的标题不在页面上；可见文字只有标志（t）、标题、命令、继续。
          const other = ANONYMOUS_PAGES.find((candidate) => candidate.lang !== spec.lang)
          expect(await page.content()).not.toContain(other?.heading ?? '\u0000')
          expect((await page.locator('main').innerText()).replace(/\s+/gu, ' ').trim()).toBe(`t ${spec.heading} tenon dashboard --open ${spec.continue}`)
          // 解释放在 title，不写在页面上。
          expect(await page.getByTestId('sign-in-command-block').getAttribute('title')).not.toBe('')

          // Dashboard 的 token：暖灰底 / 深绿 accent / 应用字体栈 / 刻度内字号。
          const look = await page.evaluate(() => {
            const style = (selector: string) => getComputedStyle(document.querySelector(selector) as Element)
            return {
              background: style('body').backgroundColor, card: style('main').backgroundColor, link: style('a').color,
              heading: style('h1').fontSize, command: style('code').fontSize, linkSize: style('a').fontSize, family: style('body').fontFamily,
              mono: style('code').fontFamily, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
              button: { w: (document.getElementById('copy') as HTMLElement).offsetWidth, h: (document.getElementById('copy') as HTMLElement).offsetHeight },
            }
          })
          expect(look.background).toBe(scheme === 'light' ? 'rgb(246, 246, 243)' : 'rgb(19, 21, 19)')
          expect(look.card).toBe(scheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(26, 28, 26)')
          expect(look.link).toBe(scheme === 'light' ? 'rgb(35, 106, 80)' : 'rgb(116, 194, 158)')
          expect([look.heading, look.command, look.linkSize]).toEqual(['24px', '16px', '14px'])
          expect(look.family).toContain('Inter')
          expect(look.mono).toContain('monospace')
          expect(look.scrollW).toBeLessThanOrEqual(look.clientW)
          expect(look.button).toEqual({ w: 32, h: 32 })

          // 复制：Chromium 读得出剪贴板；其它引擎至少给出已复制状态或选中命令。
          if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url })
          await page.getByTestId('sign-in-copy').click()
          if (browserName === 'chromium') {
            await expect(page.getByTestId('sign-in-copy')).toHaveAttribute('aria-label', spec.copied)
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('tenon dashboard --open')
            await expect(page.getByTestId('sign-in-copy')).toHaveAttribute('aria-label', spec.copy, { timeout: 3_000 })
          } else {
            expect(await page.evaluate(() => document.getElementById('copy')?.getAttribute('data-copied') === 'true' || String(getSelection()) === 'tenon dashboard --open')).toBe(true)
          }

          // 只请求了页面自己；没有任何 CSP 违规。
          expect(requests.every((url) => new URL(url).origin === new URL(server.url).origin)).toBe(true)
          expect(requests.every((url) => !new URL(url).pathname.startsWith('/api/'))).toBe(true)
          expect(violations).toEqual([])
        } finally {
          await context.close()
        }
      })

      test('登录链接无效或已过期的页面用同样的样式与语言', async ({ browser, server }) => {
        const context = await browser.newContext({ baseURL: server.url, colorScheme: scheme, locale: spec.locale })
        try {
          const page = await context.newPage()
          const response = await page.goto('/session/start?code=not-a-real-code')
          expect(response?.status()).toBe(403)
          await expect(page.locator('html')).toHaveAttribute('lang', spec.lang)
          await expect(page.getByTestId('sign-in-heading')).toHaveText(spec.invalid)
          await expect(page.getByTestId('sign-in-command')).toHaveText('tenon dashboard --open')
          expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(scheme === 'light' ? 'rgb(246, 246, 243)' : 'rgb(19, 21, 19)')
          expect(await context.cookies(server.url)).toEqual([])
        } finally {
          await context.close()
        }
      })
    })
  }
}

test('已经登录过的人点「继续」就回到 Dashboard', async ({ browser, server }) => {
  const context = await browser.newContext({ baseURL: server.url, locale: 'en-US' })
  try {
    const page = await context.newPage()
    expect((await page.goto('/'))?.status()).toBe(401)
    await context.addCookies([{ name: server.session.name, value: server.session.value, url: server.url, httpOnly: true, sameSite: 'Strict' }])
    await page.getByTestId('sign-in-continue').click()
    await expect(page.getByTestId('primary-nav')).toBeVisible()
  } finally {
    await context.close()
  }
})
