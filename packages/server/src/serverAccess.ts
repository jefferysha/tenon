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
import type { PresenceBinding, SessionAuthority, SessionInfo } from './serverSession.js'

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
  readonly sendHtml: (res: ServerResponse, code: number, html: string) => void
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

const PAGE_STYLE = 'body{font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;'
  + 'color:#1f2328;background:#fff}code{background:#0000000f;padding:.15em .4em;border-radius:4px}'
  + 'a{color:#0a58ca}@media(prefers-color-scheme:dark){body{color:#e6e8eb;background:#12151a}'
  + 'code{background:#ffffff1f}a{color:#79b8ff}}'

/** Static sign-in prompt: no script, no token, safe to hand to any caller. */
export function signInPage(reason: 'required' | 'invalid'): string {
  const zh = reason === 'required'
    ? '<h1>需要登录</h1><p>Dashboard 不向未登录的请求提供任何数据。请在终端运行：</p>'
    : '<h1>登录链接无效或已过期</h1><p>一次性登录链接只能用一次，且 2 分钟内有效。请在终端重新运行：</p>'
  const en = reason === 'required'
    ? 'The Dashboard serves nothing to unauthenticated requests. Run <code>tenon dashboard --open</code> in a terminal;'
    : 'A one-time sign-in link works once and expires after 2 minutes. Run <code>tenon dashboard --open</code> again;'
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Tenon Dashboard</title>`
    + `<style>${PAGE_STYLE}</style></head><body data-testid="sign-in-required">${zh}`
    + `<p><code>tenon dashboard --open</code></p>`
    + `<p>浏览器会自动打开并登录。已经登录过？<a href="/">点此进入 Dashboard</a>。</p>`
    + `<p lang="en">${en} your browser opens signed in. Already signed in? <a href="/">Continue</a>.</p>`
    + `</body></html>`
}

export function createAccessControl(deps: AccessControlDeps): AccessControl {
  const { authority, sendJson, sendHtml } = deps
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
      sendHtml(res, 403, signInPage('invalid'))
      return true
    }
    const code = new URL(req.url ?? '/', 'http://localhost').searchParams.get('code') ?? ''
    const secret = authority.exchange(code)
    if (secret === null) {
      sendHtml(res, 403, signInPage('invalid'))
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
        if (method === 'GET' && (path === '/' || path === '/index.html')) sendHtml(res, 401, signInPage('required'))
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
