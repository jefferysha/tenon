import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTenonUser, type TenonUserResolution } from '@tenon/kernel'
import { resolveServerPaths } from './paths.js'
import { createDashboardServer } from './server.js'
import { makeProject, makeTempHome, reqGet, reqPost, testFlow } from './test-support.js'
import type { DashboardServer, ServerPaths } from './types.js'

const servers: DashboardServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Started { port: number; root: string; paths: ServerPaths; roots: string[] }

async function start(resolve?: (home: string) => (root: string) => TenonUserResolution): Promise<Started> {
  const home = await makeTempHome()
  const root = await makeProject()
  dirs.push(home, root)
  const paths = resolveServerPaths({ home, env: {} })
  const roots: string[] = []
  const machine = (root: string): TenonUserResolution => resolveTenonUser(undefined, {
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  })
  const resolver = resolve?.(home) ?? machine
  const srv = createDashboardServer({
    paths, hostHome: home, token: 'tok', registry: () => [root], flow: testFlow(),
    resolveUser: (candidate) => {
      roots.push(candidate)
      return resolver(candidate)
    },
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, paths, roots }
}

const AUTH = { Authorization: 'Bearer tok' }

describe('GET /api/user', () => {
  it('returns the machine user for the aggregate view and for a registered root', async () => {
    const tester: TenonUserResolution = { id: 't@x.io', name: 'T', slug: 't-at-x.io', source: 'git', trust: 'declared' }
    const h = await start(() => () => tester)
    const aggregate = await reqGet(h.port, '/api/user')
    expect(aggregate.status).toBe(200)
    expect(aggregate.json()).toEqual({ ok: true, user: tester })
    const scoped = await reqGet(h.port, `/api/user?root=${encodeURIComponent(h.root)}`)
    expect(scoped.status).toBe(200)
    expect(h.roots).toEqual(['', h.root])
  })

  it('missing identity is user:null; unregistered root 404; bad Host 403', async () => {
    const h = await start()
    expect((await reqGet(h.port, '/api/user')).json()).toEqual({ ok: true, user: null })
    expect((await reqGet(h.port, '/api/user?root=%2Fnot-registered')).status).toBe(404)
    expect((await reqGet(h.port, '/api/user', '127.0.0.1', { Host: 'evil.com' })).status).toBe(403)
  })
})

describe('POST /api/user', () => {
  it('requires the token and exact {id,name}', async () => {
    const h = await start()
    expect((await reqPost(h.port, '/api/user', { id: 'jeff@x.io', name: 'Jeff' })).status).toBe(401)
    const extra = await reqPost(h.port, '/api/user', { id: 'jeff@x.io', name: 'Jeff', role: 'x' }, { headers: AUTH })
    expect(extra.status).toBe(400)
    expect(extra.json()).toMatchObject({ ok: false, code: 'invalid-user' })
    const bad = await reqPost(h.port, '/api/user', { id: 'bad', name: 'Jeff' }, { headers: AUTH })
    expect(bad.status).toBe(400)
    expect(bad.json()).toEqual({ ok: false, code: 'invalid-user', error: '用户邮箱非法: bad' })
  })

  it('writes userConfigPath and returns the resolved user', async () => {
    const h = await start()
    const saved = await reqPost(h.port, '/api/user', { id: 'jeff@x.io', name: 'Jeff Sha' }, { headers: AUTH })
    expect(saved.status).toBe(200)
    expect(saved.json()).toEqual({
      ok: true,
      user: { id: 'jeff@x.io', name: 'Jeff Sha', slug: 'jeff-at-x.io', source: 'config', trust: 'declared' },
    })
    expect(await readFile(h.paths.userConfigPath, 'utf8')).toBe('{"id":"jeff@x.io","name":"Jeff Sha"}\n')
  })
})
