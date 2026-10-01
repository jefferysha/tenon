/**
 * Local Dashboard authentication (v0.3): an unauthenticated caller — another local user, a script a
 * same-user agent runs, a web page — gets no data and no write token; the only way in is a one-time
 * login link that goes to the user's browser.
 */
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createDashboardServer } from './server.js'
import { resolveServerPaths } from './paths.js'
import { sessionCookieName } from './serverAccess.js'
import { reqGet, reqPost, type HttpResult } from './test-support.js'
import type { DashboardServer } from './types.js'

const TOKEN = 'write-token-for-access-tests'
const servers: DashboardServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface Started {
  readonly server: DashboardServer
  readonly port: number
  /** URLs the server handed to "the user's browser" (the injected opener). */
  readonly delivered: string[]
}

async function start(options: { opener?: (url: string) => Promise<boolean> } = {}): Promise<Started> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-access-'))
  dirs.push(home)
  const delivered: string[] = []
  const server = createDashboardServer({
    version: '9.9.9',
    hostHome: home,
    paths: resolveServerPaths({ home, env: {} }),
    token: TOKEN,
    registry: () => [],
    pollIntervalMs: 1000,
    cadence: false,
    manifestPath: fileURLToPath(new URL('../../../templates/manifest.yaml', import.meta.url)),
    openBrowser: options.opener ?? (async (url) => { delivered.push(url); return true }),
  })
  servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, port, delivered }
}

/** The user's browser landing on a login link: no cookie yet, a navigation from outside (`none`). */
function visit(url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  const target = new URL(url)
  return reqGet(Number(target.port), `${target.pathname}${target.search}`, '127.0.0.1', { 'Sec-Fetch-Site': 'none', ...headers })
}

async function signIn(started: Started): Promise<string> {
  const response = await visit(started.server.issueLoginUrl())
  expect(response.status).toBe(303)
  return String(response.headers['set-cookie']?.[0]).split(';', 1)[0] ?? ''
}

function postJson(port: number, path: string, headers: Record<string, string>): Promise<HttpResult> {
  return reqPost(port, path, {}, { headers })
}

function rawRequest(port: number, options: { method: string; path: string; headers?: Record<string, string> }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: options.path, method: options.method, headers: options.headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: <T,>() => JSON.parse(body) as T }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('anonymous callers get nothing', () => {
  it('GET / is a 401 sign-in prompt with no token in it', async () => {
    const { port } = await start()
    const response = await reqGet(port, '/')
    expect(response.status).toBe(401)
    expect(String(response.headers['content-type'])).toContain('text/html')
    expect(response.body).toContain('tenon dashboard --open')
    expect(response.body).not.toContain(TOKEN)
    expect(response.body).not.toContain('__TENON_DASHBOARD_TOKEN__')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect((await reqGet(port, '/index.html')).status).toBe(401)
  })

  it.each([
    '/api/snapshot',
    '/api/snapshot?view=list',
    '/api/stream',
    '/api/stream?view=list',
    '/api/change/demo/snapshot?root=/tmp',
    '/api/afk/snapshot',
    '/api/secrets',
    '/api/config?root=/tmp',
    '/api/workflows?root=/tmp',
    '/api/change/demo/history?root=/tmp',
    '/api/nothing-routes-here',
  ])('GET %s is a 401 JSON error that carries no data', async (path) => {
    const { port } = await start()
    const response = await reqGet(port, path)
    expect(response.status).toBe(401)
    expect(response.json<{ ok: boolean; code: string }>()).toMatchObject({ ok: false, code: 'session-required' })
    expect(response.body).not.toContain(TOKEN)
  })

  it('the write token alone does not open a read or a write: a session is required first', async () => {
    const { port } = await start()
    const bearer = { Authorization: `Bearer ${TOKEN}` }
    expect((await reqGet(port, '/api/snapshot', '127.0.0.1', bearer)).status).toBe(401)
    expect((await reqPost(port, '/api/changes', { root: '/tmp', name: 'x' }, { headers: bearer })).status).toBe(401)
  })

  it('keeps the health probe and static assets public, and answers 405 for unrouted methods', async () => {
    const { port } = await start()
    const health = await reqGet(port, '/api/health')
    expect(health.status).toBe(200)
    expect(health.body).not.toContain(TOKEN)
    expect((await reqGet(port, '/assets/nothing.js')).status).toBe(404)
    expect((await rawRequest(port, { method: 'TRACE', path: '/api/snapshot' })).status).toBe(405)
  })

  it('refuses a forged Host before anything else, including the sign-in endpoints', async () => {
    const { server, port } = await start()
    const evil = { Host: 'evil.example:1234' }
    expect((await reqGet(port, '/api/snapshot', '127.0.0.1', evil)).status).toBe(403)
    expect((await reqGet(port, new URL(server.issueLoginUrl()).pathname + new URL(server.issueLoginUrl()).search, '127.0.0.1', evil)).status).toBe(403)
    expect((await postJson(port, '/api/session/open', evil)).status).toBe(403)
  })
})

describe('one-time login link', () => {
  it('exchanges once for an HttpOnly SameSite=Strict cookie and lands on /', async () => {
    const started = await start()
    const url = started.server.issueLoginUrl()
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${started.port}/session/start\\?code=[A-Za-z0-9_-]{43}$`))

    const first = await visit(url)
    expect(first.status).toBe(303)
    expect(first.headers.location).toBe('/')
    expect(first.headers['referrer-policy']).toBe('no-referrer')
    expect(first.headers['cache-control']).toBe('no-store')
    const cookie = String(first.headers['set-cookie']?.[0])
    expect(cookie).toMatch(new RegExp(`^${sessionCookieName(started.port)}=[A-Za-z0-9_-]{43};`))
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Secure')

    const replay = await visit(url)
    expect(replay.status).toBe(403)
    expect(replay.headers['set-cookie']).toBeUndefined()
    expect(replay.body).toContain('tenon dashboard --open')
  })

  it('rejects guessed, empty and cross-site attempts without setting a cookie', async () => {
    const { server, port } = await start()
    for (const path of ['/session/start', '/session/start?code=', '/session/start?code=guess']) {
      const response = await reqGet(port, path, '127.0.0.1', { 'Sec-Fetch-Site': 'none' })
      expect(response.status).toBe(403)
      expect(response.headers['set-cookie']).toBeUndefined()
    }
    // A web page navigating the user to a login link it obtained somewhere is not the browser-open path.
    const crossSite = await visit(server.issueLoginUrl(), { 'Sec-Fetch-Site': 'cross-site' })
    expect(crossSite.status).toBe(403)
    expect(crossSite.headers['set-cookie']).toBeUndefined()
    expect((await postJson(port, '/session/start', {})).status).toBe(405)
  })

  it('lets the cookie in: / now carries the write token, API reads work, and the cookie is per port', async () => {
    const started = await start()
    const cookie = await signIn(started)
    const page = await reqGet(started.port, '/', '127.0.0.1', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' })
    expect(page.status).toBe(200)
    expect(page.body).toContain(TOKEN)
    expect((await reqGet(started.port, '/api/snapshot', '127.0.0.1', { Cookie: cookie })).status).toBe(200)
    // The same value under another port's cookie name is not a session here.
    const value = cookie.split('=')[1] ?? ''
    const foreign = await reqGet(started.port, '/api/snapshot', '127.0.0.1', { Cookie: `${sessionCookieName(started.port + 1)}=${value}` })
    expect(foreign.status).toBe(401)
  })
})

describe('POST /api/session/open (the server opens the browser; the caller learns nothing)', () => {
  it('hands the login URL to the opener only, never to the response', async () => {
    const started = await start()
    const response = await postJson(started.port, '/api/session/open', {})
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ ok: true, opened: true })
    expect(started.delivered).toHaveLength(1)
    const code = new URL(started.delivered[0] ?? '').searchParams.get('code') ?? ''
    expect(code).not.toBe('')
    expect(response.body).not.toContain(code)
    expect(JSON.stringify(response.headers)).not.toContain(code)
    // The link the "browser" received works exactly once and yields a real session.
    const cookie = await visit(started.delivered[0] ?? '')
    expect(cookie.status).toBe(303)
    expect((await visit(started.delivered[0] ?? '')).status).toBe(403)
  })

  it('discards the link when nothing could be opened', async () => {
    const seen: string[] = []
    const started = await start({ opener: async (url) => { seen.push(url); return false } })
    const response = await postJson(started.port, '/api/session/open', {})
    expect(response.json()).toEqual({ ok: true, opened: false })
    expect((await visit(seen[0] ?? '')).status).toBe(403)
  })

  it('treats an opener that throws as "not opened"', async () => {
    const started = await start({ opener: async () => { throw new Error('no display') } })
    expect((await postJson(started.port, '/api/session/open', {})).json()).toEqual({ ok: true, opened: false })
  })

  it('answers only local programs: any browser-labelled request, a non-JSON body or another method is refused', async () => {
    const started = await start()
    expect((await postJson(started.port, '/api/session/open', { Origin: 'http://evil.example' })).status).toBe(403)
    expect((await postJson(started.port, '/api/session/open', { Origin: `http://127.0.0.1:${started.port}` })).status).toBe(403)
    expect((await postJson(started.port, '/api/session/open', { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(403)
    expect((await postJson(started.port, '/api/session/open', { 'Content-Type': 'text/plain' })).status).toBe(400)
    expect((await reqGet(started.port, '/api/session/open')).status).toBe(405)
    expect(started.delivered).toHaveLength(0)
  })

  it('is rate limited', async () => {
    const started = await start()
    expect((await postJson(started.port, '/api/session/open', {})).status).toBe(200)
    const second = await postJson(started.port, '/api/session/open', {})
    expect(second.status).toBe(429)
    expect(second.json<{ code: string }>().code).toBe('rate-limited')
    expect(started.delivered).toHaveLength(1)
  })
})

describe('a signed-in browser is still held to same-origin rules', () => {
  it('refuses cross-site fetches and foreign origins, accepts the page itself', async () => {
    const started = await start()
    const cookie = await signIn(started)
    const self = `http://127.0.0.1:${started.port}`
    expect((await reqGet(started.port, '/api/snapshot', '127.0.0.1', { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await reqGet(started.port, '/api/snapshot', '127.0.0.1', { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' })).status).toBe(403)
    expect((await reqGet(started.port, '/api/snapshot', '127.0.0.1', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)

    const bearer = { Authorization: `Bearer ${TOKEN}`, Cookie: cookie }
    const foreign = await postJson(started.port, '/api/nope', { ...bearer, Origin: 'http://evil.example' })
    expect(foreign.status).toBe(403)
    expect(foreign.json<{ code: string }>().code).toBe('origin-refused')
    expect((await postJson(started.port, '/api/nope', { ...bearer, Origin: 'null' })).status).toBe(403)
    // Same origin passes the gate and is then judged by the route (unknown write endpoint → 404).
    expect((await postJson(started.port, '/api/nope', { ...bearer, Origin: self })).status).toBe(404)
  })

  it('a session with no write token still cannot write', async () => {
    const started = await start()
    const cookie = await signIn(started)
    expect((await postJson(started.port, '/api/nope', { Cookie: cookie })).status).toBe(401)
  })
})
