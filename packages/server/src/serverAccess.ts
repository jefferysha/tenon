/**
 * Request gate in front of every Dashboard route.
 *
 *   public            GET /api/health, GET /assets/*           (no data, no secret)
 *   sign-in           GET /session/start?code=…                (consumes a one-time code, sets the cookie)
 *                     POST /api/session/open                   (server opens the browser; reveals nothing)
 *   everything else   needs a live session cookie, plus Fetch-Metadata / Origin checks
 *
 * Route handlers keep their own Host + bearer + content-type checks; this gate only adds the
 * session, so an unauthenticated caller (another local user, a script run by a same-user agent, a
 * web page) never reaches a handler and never receives the write token embedded in `GET /`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SIGN_IN_CSP, signInPage, type SignInReason } from './serverSignIn.js'
import type { PresenceBinding, SessionAuthority, SessionInfo } from './serverSession.js'

export { signInPage } from './serverSignIn.js'

/** Port the review-confirmation routes use to demand proof that a person is present. */
export interface PresencePort {
  issue(req: IncomingMessage, binding: PresenceBinding): string | null
  verify(req: IncomingMessage, binding: PresenceBinding, nonce: string | undefined): boolean
}

export interface AccessControlDeps {
  readonly authority: SessionAuthority
  readonly boundPort: () => number
  readonly isLocalHost: (host: string | undefined, port: number) => boolean
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  /** `headers` 覆盖默认响应头（登录页用它换成自己的严格 CSP）。 */
  readonly sendHtml: (res: ServerResponse, code: number, html: string, headers?: Readonly<Record<string, string>>) => void
  /** Delivers a one-time login URL to the user's browser; the URL never leaves this process otherwise. */
  readonly openBrowser: (url: string) => Promise<boolean>
  readonly now?: () => number
}

export interface AccessControl {
  /** Resolves true when the request was answered here; false hands it on to the routes. */
  handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean>
  readonly presence: PresencePort
  /** A fresh one-time login URL for the launcher's own terminal (never for an HTTP response). */
  issueLoginUrl(): string
}

const ROUTED_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
const COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60
const OPEN_MIN_INTERVAL_MS = 1_500
const OPEN_WINDOW_MS = 60_000
const OPEN_MAX_PER_WINDOW = 10

export function sessionCookieName(port: number): string {
  return `tenon_session_${port}`
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function hasBrowserMetadata(req: IncomingMessage): boolean {
  return req.headers.origin !== undefined || Object.keys(req.headers).some((name) => name.startsWith('sec-fetch-'))
}

export function createAccessControl(deps: AccessControlDeps): AccessControl {
  const { authority, sendJson, sendHtml } = deps
  /** 登录页 / 链接无效页：语言按请求的 Accept-Language 选，所以响应随它变化（Vary）。 */
  function sendSignIn(req: IncomingMessage, res: ServerResponse, code: number, reason: SignInReason): void {
    sendHtml(res, code, signInPage(reason, headerValue(req, 'accept-language')), { 'Content-Security-Policy': SIGN_IN_CSP, Vary: 'Accept-Language' })
  }
  const now = deps.now ?? Date.now
  const sessions = new WeakMap<IncomingMessage, SessionInfo>()
  const opens: number[] = []

  function openAllowed(at: number): boolean {
    while (opens.length > 0 && at - (opens[0] ?? at) > OPEN_WINDOW_MS) opens.shift()
    const last = opens[opens.length - 1]
    if (last !== undefined && at - last < OPEN_MIN_INTERVAL_MS) return false
    if (opens.length >= OPEN_MAX_PER_WINDOW) return false
    opens.push(at)
    return true
  }

  function loginUrl(): string {
    const port = deps.boundPort()
    if (port === 0) throw new Error('dashboard server is not listening yet')
    return `http://127.0.0.1:${port}/session/start?code=${authority.mintCode()}`
  }

  function startSession(req: IncomingMessage, res: ServerResponse, method: string): boolean {
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return true
    }
    const site = headerValue(req, 'sec-fetch-site')
    if (site !== undefined && site !== 'none' && site !== 'same-origin') {
      sendSignIn(req, res, 403, 'invalid')
      return true
    }
    const code = new URL(req.url ?? '/', 'http://localhost').searchParams.get('code') ?? ''
    const secret = authority.exchange(code)
    if (secret === null) {
      sendSignIn(req, res, 403, 'invalid')
      return true
    }
    res.writeHead(303, {
      Location: '/',
      'Set-Cookie': `${sessionCookieName(deps.boundPort())}=${secret}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Strict`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Length': 0,
    })
    res.end()
    return true
  }

  async function openSession(req: IncomingMessage, res: ServerResponse, method: string): Promise<boolean> {
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return true
    }
    req.resume()
    // A browser always labels its requests; only a local program (the CLI) sends neither header family.
    if (hasBrowserMetadata(req)) {
      sendJson(res, 403, { ok: false, code: 'browser-request-refused', error: '该端点只接受本机命令行调用' })
      return true
    }
    const ctype = (String(req.headers['content-type'] ?? '').split(';', 1)[0] ?? '').trim().toLowerCase()
    if (ctype !== 'application/json') {
      sendJson(res, 400, { ok: false, error: '要求 Content-Type: application/json' })
      return true
    }
    if (!openAllowed(now())) {
      sendJson(res, 429, { ok: false, code: 'rate-limited', error: '打开浏览器的请求过于频繁（两次间隔不足 1.5 秒，或一分钟内超过 10 次）' })
      return true
    }
    const url = loginUrl()
    const code = new URL(url).searchParams.get('code') ?? ''
    let opened = false
    try {
      opened = await deps.openBrowser(url)
    } catch {
      opened = false
    }
    if (!opened) authority.discardCode(code)
    // The response deliberately carries no URL, code or cookie.
    sendJson(res, 200, { ok: true, opened })
    return true
  }

  /** 'cross-site' / 'origin' when a browser marked this request as coming from somewhere else. */
  function crossSiteRefusal(req: IncomingMessage, path: string, method: string): 'cross-site' | 'origin' | null {
    const site = headerValue(req, 'sec-fetch-site')
    const navigation = method === 'GET' && headerValue(req, 'sec-fetch-mode') === 'navigate'
      && (path === '/' || path === '/index.html')
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && !navigation) return 'cross-site'
    if (method !== 'GET') {
      const origin = headerValue(req, 'origin')
      const host = (req.headers.host ?? '').toLowerCase()
      if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) return 'origin'
    }
    return null
  }

  return {
    presence: {
      issue(req, binding) {
        const session = sessions.get(req)
        return session === undefined ? null : authority.issuePresence(session, binding)
      },
      verify(req, binding, nonce) {
        const session = sessions.get(req)
        return session !== undefined && authority.consumePresence(session, binding, nonce)
      },
    },

    issueLoginUrl: loginUrl,

    async handle(req, res, path, method) {
      if (method === 'GET' && (path === '/api/health' || path.startsWith('/assets/'))) return false
      const port = deps.boundPort()
      if (!deps.isLocalHost(req.headers.host, port)) {
        sendJson(res, 403, { ok: false, code: 'host-invalid', error: 'Host header 不合法（疑似 DNS 重绑定攻击）' })
        return true
      }
      if (path === '/session/start') return startSession(req, res, method)
      if (path === '/api/session/open') return openSession(req, res, method)
      // Nothing routes a method outside this set; the dispatcher answers 405 without touching data.
      if (!ROUTED_METHODS.has(method)) return false
      const session = authority.resolve(cookieValue(req.headers.cookie, sessionCookieName(port)))
      if (session === null) {
        if (method === 'GET' && (path === '/' || path === '/index.html')) sendSignIn(req, res, 401, 'required')
        else sendJson(res, 401, { ok: false, code: 'session-required', error: '需要登录：请在终端运行 tenon dashboard --open' })
        return true
      }
      const refusal = crossSiteRefusal(req, path, method)
      if (refusal !== null) {
        sendJson(res, 403, { ok: false, code: refusal === 'origin' ? 'origin-refused' : 'cross-site-refused', error: '跨站请求被拒绝' })
        return true
      }
      sessions.set(req, session)
      return false
    },
  }
}
