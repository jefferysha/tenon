import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { requestDashboardBrowserOpen } from './dashboard-open.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function serve(answer: (req: IncomingMessage) => { status: number; body: string }): Promise<{ url: string; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = []
  const server = createServer((req, res) => {
    seen.push(req)
    req.resume()
    const { status, body } = answer(req)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen }
}

describe('requestDashboardBrowserOpen', () => {
  test('posts an empty JSON body to the session-open endpoint and reports what the server says', async () => {
    const opened = await serve(() => ({ status: 200, body: '{"ok":true,"opened":true}' }))
    expect(await requestDashboardBrowserOpen(opened.url)).toBe(true)
    const request = opened.seen[0]
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/api/session/open')
    expect(request?.headers['content-type']).toBe('application/json')
    // A local program, not a browser: it labels itself with neither family of browser headers.
    expect(request?.headers.origin).toBeUndefined()
    expect(Object.keys(request?.headers ?? {}).filter((name) => name.startsWith('sec-fetch-'))).toEqual([])

    const declined = await serve(() => ({ status: 200, body: '{"ok":true,"opened":false}' }))
    expect(await requestDashboardBrowserOpen(declined.url)).toBe(false)
  })

  test.each([
    ['an older server without the endpoint', 404, '{"ok":false}'],
    ['rate limiting', 429, '{"ok":false,"code":"rate-limited"}'],
    ['a refusal', 403, '{"ok":false}'],
    ['garbage', 200, 'not json'],
    ['an unrelated 200', 200, '{"ok":true}'],
  ])('is false for %s', async (_label, status, body) => {
    const target = await serve(() => ({ status, body }))
    expect(await requestDashboardBrowserOpen(target.url)).toBe(false)
  })

  test('is false when nothing listens or the URL has no port', async () => {
    const closed = await serve(() => ({ status: 200, body: '{}' }))
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
    expect(await requestDashboardBrowserOpen(closed.url)).toBe(false)
    expect(await requestDashboardBrowserOpen('http://127.0.0.1/')).toBe(false)
    expect(await requestDashboardBrowserOpen('not a url')).toBe(false)
  })
})
