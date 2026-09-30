/**
 * The review gate exists to constrain the agent, so confirming a review over HTTP must need a person:
 * a browser session (from a one-time link delivered to the user's browser) plus a per-review presence
 * nonce.  The first test plays a same-user agent — it can read every Tenon state file and reach the
 * loopback port — and proves it cannot complete the confirmation; the rest pin the nonce rules.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStateStore } from '@tenon/kernel'
import { freshHarness, type Harness } from '../../cli/src/integration-harness.js'
import { resolveServerPaths } from './paths.js'
import { createDashboardServer } from './server.js'
import { sessionCookieName } from './serverAccess.js'
import { reqGet, reqPost, testFlow, type HttpResult } from './test-support.js'
import type { DashboardServer, ServerPaths } from './types.js'

const TOKEN = 'review-presence-write-token'
const USER = { id: 'tester@tenon.test', name: 'Tester', slug: 'tester-at-tenon.test', source: 'env', trust: 'declared' } as const

let harness: Harness
let home: string
let paths: ServerPaths
let server: DashboardServer
let port: number
/** What the server handed to "the user's browser". */
let delivered: string[]

async function pendingChange(): Promise<Harness> {
  const h = await freshHarness()
  expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
  await h.seedGovernedDocumentEvidence('demo')
  expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
  await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
  await h.satisfyStepAgents('demo')
  expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
  return h
}

beforeEach(async () => {
  harness = await pendingChange()
  home = await mkdtemp(join(tmpdir(), 'tenon-presence-home-'))
  paths = resolveServerPaths({ home, env: {} })
  delivered = []
  server = createDashboardServer({
    version: '9.9.9',
    hostHome: home,
    paths,
    token: TOKEN,
    registry: () => [harness.cwd],
    store: createStateStore(),
    flow: testFlow(),
    resolveUser: () => USER,
    cadence: false,
    pollIntervalMs: 1000,
    openBrowser: async (url) => { delivered.push(url); return true },
  })
  ;({ port } = await server.listen(0, '127.0.0.1'))
  // What a real install leaves behind: the pidfile, plus the worst case of a write token sitting in state.
  await mkdir(paths.stateRoot, { recursive: true })
  await writeFile(paths.pidfilePath, JSON.stringify({ pid: process.pid, port, version: '9.9.9', started: Date.now() }))
  await writeFile(paths.tokenPath, JSON.stringify({ token: TOKEN, pid: process.pid, port }), { mode: 0o600 })
})

afterEach(async () => {
  await server.close()
  await rm(harness.cwd, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

function changeDir(): string {
  return join(harness.cwd, 'openspec', 'changes', 'demo')
}

async function reviewStatus(): Promise<string> {
  const state = await createStateStore().read(changeDir())
  return String(state.fields.review_gate_status ?? '')
}

async function readAllText(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      await readAllText(full, out)
    } else if (entry.isFile() && (await stat(full)).size <= 256 * 1024) {
      out.push(await readFile(full, 'utf8').catch(() => ''))
    }
  }
  return out
}

/** Everything in these files that could conceivably be a secret: each whole file and each long token-like run. */
async function harvestSecrets(): Promise<string[]> {
  const found = new Set<string>()
  for (const text of [...await readAllText(home), ...await readAllText(harness.cwd)]) {
    if (text.trim() !== '' && text.length < 512) found.add(text.trim())
    for (const match of text.matchAll(/[A-Za-z0-9_-]{24,}/g)) found.add(match[0])
  }
  found.add(TOKEN)
  return [...found].filter((candidate) => /^[\x20-\x7e]{1,300}$/.test(candidate)) // usable as a header value
}

function decisionBody(ref: string, revision: number, key = 'k1'): Record<string, unknown> {
  return { root: harness.cwd, ref, expected_revision: revision, idempotency_key: key }
}

/** The user runs `tenon dashboard --open`: the server hands the link to their browser, which follows it. */
async function browserSession(): Promise<string> {
  const open = await reqPost(port, '/api/session/open', {})
  expect(open.status).toBe(200)
  const link = delivered.at(-1)
  expect(link).toBeDefined()
  return followLoginLink(link ?? '')
}

async function followLoginLink(link: string): Promise<string> {
  const target = new URL(link)
  const visit = await reqGet(port, `${target.pathname}${target.search}`, '127.0.0.1', { 'Sec-Fetch-Site': 'none' })
  expect(visit.status).toBe(303)
  return String(visit.headers['set-cookie']?.[0]).split(';', 1)[0] ?? ''
}

async function pendingRef(cookie: string): Promise<{ ref: string; revision: number }> {
  const view = await reqGet(port, `/api/change/demo/pending-decisions?root=${encodeURIComponent(harness.cwd)}`, '127.0.0.1', { Cookie: cookie })
  expect(view.status).toBe(200)
  const item = view.json<{ items: { type: string; ref: { id: string }; revision: number }[] }>().items.find((i) => i.type === 'review')
  expect(item).toBeDefined()
  return { ref: item?.ref.id ?? '', revision: item?.revision ?? -1 }
}

function writeHeaders(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: cookie, Authorization: `Bearer ${TOKEN}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', ...extra }
}

async function presenceNonce(cookie: string, target: { ref: string; revision: number }): Promise<string> {
  const issued = await reqPost(port, '/api/change/demo/decisions/presence', {
    root: harness.cwd, ref: target.ref, expected_revision: target.revision,
  }, { headers: writeHeaders(cookie) })
  expect(issued.status).toBe(200)
  return issued.json<{ nonce: string }>().nonce
}

describe('a same-user agent that can read every Tenon state file', () => {
  it('cannot confirm a review over HTTP: no session, no nonce, no way to get either', async () => {
    const secrets = await harvestSecrets()
    expect(secrets.length).toBeGreaterThan(3)
    expect(secrets).toContain(TOKEN) // the worst case really is in reach

    // `curl /` and `curl /api/snapshot` hand out no token and no data.
    const page = await reqGet(port, '/')
    expect(page.status).toBe(401)
    expect(page.body).not.toContain(TOKEN)
    const snapshot = await reqGet(port, '/api/snapshot')
    expect(snapshot.status).toBe(401)
    expect(snapshot.body).not.toContain(harness.cwd)

    const cookieName = sessionCookieName(port)
    const attempts: HttpResult[] = []
    for (const secret of secrets) {
      const asBearer = { Authorization: `Bearer ${secret}` }
      const asCookie = { Cookie: `${cookieName}=${secret}`, Authorization: `Bearer ${TOKEN}` }
      for (const headers of [asBearer, asCookie, { ...asCookie, 'X-Tenon-Presence': secret }]) {
        attempts.push(await reqGet(port, '/api/snapshot', '127.0.0.1', headers))
        attempts.push(await reqPost(port, '/api/change/demo/decisions/presence', { root: harness.cwd, ref: 'x', expected_revision: 0 }, { headers }))
        attempts.push(await reqPost(port, '/api/change/demo/decisions', decisionBody('x', 0), { headers }))
        attempts.push(await reqPost(port, '/api/change/demo/transition', { root: harness.cwd, event: 'explore-complete' }, { headers }))
      }
      attempts.push(await reqGet(port, `/session/start?code=${encodeURIComponent(secret)}`, '127.0.0.1', { 'Sec-Fetch-Site': 'none' }))
    }
    expect(attempts.length).toBeGreaterThan(secrets.length * 4)
    expect(attempts.filter((a) => a.status !== 401 && a.status !== 403)).toEqual([])
    expect(attempts.filter((a) => a.headers['set-cookie'] !== undefined)).toEqual([])

    // The one thing it can ask for is "open the dashboard for my user", which reveals nothing.
    const open = await reqPost(port, '/api/session/open', {})
    expect(open.status).toBe(200)
    const link = delivered[0] ?? ''
    const code = new URL(link).searchParams.get('code') ?? ''
    expect(code).not.toBe('')
    for (const seen of [open.body, JSON.stringify(open.headers)]) {
      expect(seen).not.toContain(code)
      expect(seen).not.toContain('session/start')
    }

    expect(await reviewStatus()).toBe('pending')
  })

  it('even holding a valid session it cannot approve without a presence nonce, nor with a borrowed one', async () => {
    const cookie = await browserSession() // the user's browser signs in; assume the cookie leaks
    const target = await pendingRef(cookie)

    const bare = await reqPost(port, '/api/change/demo/decisions', decisionBody(target.ref, target.revision), { headers: writeHeaders(cookie) })
    expect(bare.status).toBe(403)
    expect(bare.json<{ code: string }>().code).toBe('presence-required')

    for (const bogus of ['', 'made-up-nonce', 'x'.repeat(400)]) {
      const forged = await reqPost(port, '/api/change/demo/decisions', decisionBody(target.ref, target.revision), {
        headers: writeHeaders(cookie, { 'X-Tenon-Presence': bogus }),
      })
      expect(forged.status).toBe(403)
    }

    // A nonce issued for another ref or revision cannot be spent here.
    const otherRef = await presenceNonce(cookie, { ref: 'decision:0000000000000000', revision: target.revision })
    const otherRevision = await presenceNonce(cookie, { ref: target.ref, revision: target.revision + 1 })
    for (const nonce of [otherRef, otherRevision]) {
      const borrowed = await reqPost(port, '/api/change/demo/decisions', decisionBody(target.ref, target.revision), {
        headers: writeHeaders(cookie, { 'X-Tenon-Presence': nonce }),
      })
      expect(borrowed.status).toBe(403)
    }

    // A second browser session cannot spend the first one's nonce.
    const mine = await presenceNonce(cookie, target)
    const second = await followLoginLink(server.issueLoginUrl()) // another browser profile
    const stolen = await reqPost(port, '/api/change/demo/decisions', decisionBody(target.ref, target.revision), {
      headers: writeHeaders(second, { 'X-Tenon-Presence': mine }),
    })
    expect(stolen.status).toBe(403)
    expect(await reviewStatus()).toBe('pending')
  })
})

describe('the person in the browser', () => {
  it('confirms with session + write token + a fresh nonce; the nonce cannot be replayed', async () => {
    const cookie = await browserSession()
    const target = await pendingRef(cookie)
    const nonce = await presenceNonce(cookie, target)

    const approved = await reqPost(port, '/api/change/demo/decisions', decisionBody(target.ref, target.revision), {
      headers: writeHeaders(cookie, { 'X-Tenon-Presence': nonce }),
    })
    expect(approved.status, approved.body).toBe(200)
    expect(approved.json()).toMatchObject({ ok: true, code: 'approved', channel: 'dashboard' })
    expect(await reviewStatus()).toBe('approved')

    const replay = await reqPost(port, '/api/change/demo/decisions', decisionBody(target.ref, target.revision), {
      headers: writeHeaders(cookie, { 'X-Tenon-Presence': nonce }),
    })
    expect(replay.status).toBe(403)
  })

  it('needs the write token as well as the cookie to ask for a nonce', async () => {
    const cookie = await browserSession()
    const target = await pendingRef(cookie)
    const body = { root: harness.cwd, ref: target.ref, expected_revision: target.revision }
    expect((await reqPost(port, '/api/change/demo/decisions/presence', body, { headers: { Cookie: cookie } })).status).toBe(401)
    expect((await reqPost(port, '/api/change/demo/decisions/presence', body, { headers: writeHeaders(cookie, { Origin: 'http://evil.example' }) })).status).toBe(403)
    expect((await reqPost(port, '/api/change/demo/decisions/presence', { ...body, root: '/not/registered' }, { headers: writeHeaders(cookie) })).status).toBe(404)
    expect((await reqPost(port, '/api/change/demo/decisions/presence', { root: harness.cwd }, { headers: writeHeaders(cookie) })).status).toBe(400)
  })
})
