/**
 * Test-side sign-in helpers.  The Dashboard serves nothing without a session, so tests play the user's
 * browser: they take a one-time login link from the server (`issueLoginUrl`, the in-process embedder
 * API), follow it over real HTTP and keep the session cookie per port.
 *
 * Deliberately free of server imports: the web package's integration tests import this file, and
 * pulling the server sources into that TypeScript program breaks its stricter build.
 */
import { get as httpGet } from 'node:http'

/** The only thing these helpers need from a server. */
export interface LoginUrlSource {
  issueLoginUrl(): string
}

/**
 * 会话 cookie 按端口登记：`createTestDashboardServer` 走真实的“一次性链接 → 会话”流程建立会话，
 * 之后 reqGet / reqPost / reqPatch / reqDelete / openSSE 自动带上。要模拟未登录，显式传 `Cookie: ''`。
 */
const testSessionCookies = new Map<number, string>()
export const ANONYMOUS: Readonly<Record<string, string>> = { Cookie: '' }

export function withSession(port: number, headers: Record<string, string> | undefined): Record<string, string> | undefined {
  const cookie = testSessionCookies.get(port)
  if (cookie === undefined) return headers
  if (headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() === 'cookie')) return headers
  return { ...(headers ?? {}), Cookie: cookie }
}

/** 扮演“用户的浏览器”：换出登录链接，返回会话 cookie 的 `name=value`。 */
export function exchangeLoginUrl(url: string): Promise<string> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const r = httpGet({ host: target.hostname, port: Number(target.port), path: `${target.pathname}${target.search}` }, (res) => {
      res.resume()
      const raw = res.headers['set-cookie']?.[0]
      if (res.statusCode !== 303 || raw === undefined) return reject(new Error(`login exchange failed: ${res.statusCode}`))
      resolve(raw.split(';', 1)[0] ?? '')
    })
    r.on('error', reject)
  })
}

/** 在已 listen 的 server 上建立一个测试会话并登记到端口。 */
export async function establishTestSession(server: LoginUrlSource, port: number): Promise<string> {
  const cookie = await exchangeLoginUrl(server.issueLoginUrl())
  testSessionCookies.set(port, cookie)
  return cookie
}

/** 忘掉这个端口的测试会话（server 关闭时）。 */
export function forgetTestSession(port: number): void {
  testSessionCookies.delete(port)
}

/** 给端口取当前测试会话的 cookie（没有则 undefined）。 */
export function testSessionCookie(port: number): string | undefined {
  return testSessionCookies.get(port)
}

/**
 * 给直接调全局 `fetch` 的跨包集成测试用：对这个 server 建立会话，并让发往 `http://127.0.0.1:<port>` 的 fetch 自动带上
 * 会话 cookie（调用方显式写了 Cookie 头则不动）。返回的函数还原全局 fetch。
 */
export async function installSessionFetch(server: LoginUrlSource, port: number): Promise<() => void> {
  const cookie = await exchangeLoginUrl(server.issueLoginUrl())
  const origin = `http://127.0.0.1:${port}`
  const original = globalThis.fetch
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!target.startsWith(origin)) return original(input, init)
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined))
    if (!headers.has('cookie')) headers.set('cookie', cookie)
    return original(input, { ...init, headers })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}
