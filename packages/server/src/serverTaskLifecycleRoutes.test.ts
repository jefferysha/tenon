/**
 * 删除 / 归档 / 取消归档 over real HTTP: reasons from GET, the token gate, the zero-write 409s, and the
 * snapshot partition the Dashboard reads afterwards. Deletion is destructive, so each refusal is asserted
 * to leave the Change directory and the archive store untouched.
 */
import { execFile } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureUserLocalDir, serializeTaskArchive, userProjectPaths, type TenonUserResolution } from '@tenon/kernel'
import { resolveServerPaths } from './paths.js'
import { createDashboardServer } from './server.js'
import { initChange, makeProject, makeTempHome, newStore, reqDelete, reqGet, reqPost, testFlow } from './test-support.js'
import type { DashboardServer } from './types.js'

const execFileAsync = promisify(execFile)
const AUTH = { Authorization: 'Bearer tok' }
/** `initChange` records this identity as creator and owner, so the viewer owns what it deletes. */
const alice: TenonUserResolution = {
  id: 'tester@tenon.test', name: 'Tester', slug: 'tester-at-tenon.test', source: 'env', trust: 'declared',
}
const bob: TenonUserResolution = { id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }

const servers: DashboardServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Started {
  port: number
  root: string
  store: ReturnType<typeof newStore>
}

async function start(
  changes: readonly string[],
  viewer: TenonUserResolution = alice,
): Promise<Started> {
  const home = await makeTempHome()
  const root = await makeProject()
  dirs.push(home, root)
  const store = newStore()
  for (const name of changes) await initChange(store, root, name)
  const srv = createDashboardServer({
    paths: resolveServerPaths({ home, env: {} }),
    hostHome: home, token: 'tok', registry: () => [root], store, flow: testFlow(),
    version: '9.9.9', clock: () => '2026-09-15T12:00:00.000Z',
    resolveUser: () => viewer,
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, store }
}

async function commitAll(root: string): Promise<void> {
  const git = async (...args: string[]): Promise<void> => {
    await execFileAsync('git', args, { cwd: root, maxBuffer: 65_536 })
  }
  await git('init', '-q')
  await git('config', 'user.email', 'tenon-tests@example.invalid')
  await git('config', 'user.name', 'Tenon tests')
  await git('add', '-A')
  await git('commit', '-qm', 'seed')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function archiveStore(root: string, slug: string): Promise<string | null> {
  try {
    return await readFile(userProjectPaths(root, slug).archived, 'utf8')
  } catch {
    return null
  }
}

describe('GET /api/change/:name/lifecycle', () => {
  it('reports the reasons the dialog displays', async () => {
    const h = await start(['feat'])
    await h.store.setMany(join(h.root, 'openspec', 'changes', 'feat'), { review_gate_status: 'pending' } as never)
    const r = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=delete`)
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({
      ok: true, action: 'delete', phase: 'open', blockers: [], confirmations: [{ code: 'review-pending' }],
    })
  })

  it('confirms another owner for a viewer who does not own the Change', async () => {
    const h = await start(['feat'], bob)
    const r = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=delete`)
    expect(r.json()).toMatchObject({
      confirmations: [{ code: 'owned-by-other', detail: 'Tester <tester@tenon.test>' }],
    })
  })

  it('blocks a running AFK task and refuses a bad action, name or root', async () => {
    const h = await start(['feat'])
    await h.store.setMany(join(h.root, 'openspec', 'changes', 'feat'), { automation: 'running' } as never)
    const blocked = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=archive`)
    expect(blocked.status).toBe(200)
    expect(blocked.json()).toMatchObject({ blockers: [{ code: 'afk-running' }] })

    const action = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=nope`)
    expect(action.status).toBe(400)
    const name = await reqGet(h.port, `/api/change/archive/lifecycle?root=${encodeURIComponent(h.root)}&action=delete`)
    expect([name.status, (name.json<{ code: string }>()).code]).toEqual([400, 'invalid-name'])
    const missing = await reqGet(h.port, `/api/change/nope/lifecycle?root=${encodeURIComponent(h.root)}&action=delete`)
    expect([missing.status, (missing.json<{ code: string }>()).code]).toEqual([404, 'task-not-found'])
    const root = await reqGet(h.port, '/api/change/feat/lifecycle?root=/nope&action=delete')
    expect(root.status).toBe(404)
  })
})

describe('POST /api/change/:name/archive|unarchive', () => {
  it('requires a token', async () => {
    const h = await start(['feat'])
    for (const sub of ['archive', 'unarchive']) {
      const r = await reqPost(h.port, `/api/change/feat/${sub}`, { root: h.root })
      expect(r.status).toBe(401)
    }
    expect(await archiveStore(h.root, alice.slug)).toBeNull()
  })

  it('hides the Change for the viewer only and restores it', async () => {
    const h = await start(['feat', 'other'])
    await h.store.setMany(join(h.root, 'openspec', 'changes', 'feat'), { phase: 'build' } as never)
    const archived = await reqPost(h.port, '/api/change/feat/archive', { root: h.root, acknowledged: [] }, { headers: AUTH })
    expect(archived.status).toBe(200)
    expect(archived.json()).toEqual({
      ok: true, changed: true, archived_at: '2026-09-15T12:00:00.000Z', phase: 'build',
    })

    const snapshot = (await reqGet(h.port, '/api/snapshot')).json<{
      change_count: number
      projects: { changes: { name: string }[]; archived?: { name: string; archive: { phase: string; actor: { name: string } } }[] }[]
    }>()
    expect(snapshot.projects[0]?.changes.map((c) => c.name)).toEqual(['other'])
    expect(snapshot.projects[0]?.archived?.map((c) => c.name)).toEqual(['feat'])
    expect(snapshot.projects[0]?.archived?.[0]?.archive.phase).toBe('build')
    expect(snapshot.change_count).toBe(1)

    const afk = (await reqGet(h.port, '/api/afk/snapshot')).json<{ cards: { name: string }[] }>()
    expect(afk.cards.map((card) => card.name)).not.toContain('feat')

    // The archived Change stays readable for its detail view.
    expect((await reqGet(h.port, `/api/change/feat/history?root=${encodeURIComponent(h.root)}`)).status).toBe(200)

    const repeated = await reqPost(h.port, '/api/change/feat/archive', { root: h.root }, { headers: AUTH })
    expect(repeated.json()).toMatchObject({ ok: true, changed: false })
    const restored = await reqPost(h.port, '/api/change/feat/unarchive', { root: h.root }, { headers: AUTH })
    expect(restored.json()).toEqual({ ok: true, changed: true })
    const after = (await reqGet(h.port, '/api/snapshot')).json<{ projects: { changes: { name: string }[]; archived?: unknown }[] }>()
    expect(after.projects[0]?.changes.map((c) => c.name)).toEqual(['feat', 'other'])
    expect(after.projects[0]?.archived).toBeUndefined()
  })

  it('another viewer still sees a Change archived by someone else', async () => {
    const h = await start(['feat'], alice)
    expect((await reqPost(h.port, '/api/change/feat/archive', { root: h.root }, { headers: AUTH })).status).toBe(200)
    const forBob = await start([], bob)
    // Bob's server reads the same checkout through its own registry entry.
    const srv = createDashboardServer({
      paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
      token: 'tok', registry: () => [h.root], store: h.store, flow: testFlow(), resolveUser: () => bob,
    })
    servers.push(srv)
    const { port } = await srv.listen(0, '127.0.0.1')
    expect(forBob.port).not.toBe(port)
    const snapshot = (await reqGet(port, '/api/snapshot')).json<{ projects: { changes: { name: string }[]; archived?: unknown }[] }>()
    expect(snapshot.projects[0]?.changes.map((c) => c.name)).toEqual(['feat'])
    expect(snapshot.projects[0]?.archived).toBeUndefined()
  })

  it('refuses an unacknowledged confirmation, an unknown code and a blocker without writing', async () => {
    const h = await start(['feat'])
    const dir = join(h.root, 'openspec', 'changes', 'feat')
    await h.store.setMany(dir, { review_gate_status: 'pending' } as never)
    const pending = await reqPost(h.port, '/api/change/feat/archive', { root: h.root, acknowledged: [] }, { headers: AUTH })
    expect(pending.status).toBe(409)
    expect(pending.json()).toMatchObject({ code: 'confirmation-required', reasons: [{ code: 'review-pending' }] })
    expect(await archiveStore(h.root, alice.slug)).toBeNull()

    const bad = await reqPost(h.port, '/api/change/feat/archive', { root: h.root, acknowledged: ['nope'] }, { headers: AUTH })
    expect(bad.status).toBe(400)

    const ok = await reqPost(h.port, '/api/change/feat/archive', { root: h.root, acknowledged: ['review-pending'] }, { headers: AUTH })
    expect(ok.status).toBe(200)

    await reqPost(h.port, '/api/change/feat/unarchive', { root: h.root }, { headers: AUTH })
    await h.store.setMany(dir, { automation: 'queued' } as never)
    const blocked = await reqPost(h.port, '/api/change/feat/archive', { root: h.root, acknowledged: ['afk-queued'] }, { headers: AUTH })
    expect(blocked.status).toBe(409)
    expect(blocked.json()).toMatchObject({ code: 'task-blocked', reasons: [{ code: 'afk-queued' }] })
  })

  it('reports a malformed archive store without overwriting it', async () => {
    const h = await start(['feat'])
    const paths = await ensureUserLocalDir(h.root, alice.slug)
    await writeFile(paths.archived, 'not json', 'utf8')
    const r = await reqPost(h.port, '/api/change/feat/archive', { root: h.root }, { headers: AUTH })
    expect(r.status).toBe(409)
    expect(r.json()).toMatchObject({ code: 'archive-store-corrupt' })
    expect(await readFile(paths.archived, 'utf8')).toBe('not json')
  })
})

describe('DELETE /api/change/:name', () => {
  it('requires a token and leaves the Change in place', async () => {
    const h = await start(['feat'])
    const r = await reqDelete(h.port, `/api/change/feat?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(401)
    expect(await exists(join(h.root, 'openspec', 'changes', 'feat'))).toBe(true)
  })

  it('removes the Change from the working tree and reports 未提交删除', async () => {
    const h = await start(['feat', 'other'])
    await commitAll(h.root)
    const r = await reqDelete(h.port, `/api/change/feat?root=${encodeURIComponent(h.root)}`, { headers: AUTH })
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; removed: string[]; uncommittedDeletions: number }>()
    expect(body.ok).toBe(true)
    expect(body.removed).toContain('openspec/changes/feat')
    expect(body.uncommittedDeletions).toBe(1)
    expect(await exists(join(h.root, 'openspec', 'changes', 'feat'))).toBe(false)

    const snapshot = (await reqGet(h.port, '/api/snapshot')).json<{
      projects: { changes: { name: string }[]; uncommittedDeletions?: number }[]
    }>()
    expect(snapshot.projects[0]?.changes.map((c) => c.name)).toEqual(['other'])
    expect(snapshot.projects[0]?.uncommittedDeletions).toBe(1)
  })

  it('refuses an unacknowledged confirmation and a blocker without touching the directory', async () => {
    const h = await start(['feat'])
    const dir = join(h.root, 'openspec', 'changes', 'feat')
    await h.store.setMany(dir, { review_gate_status: 'pending' } as never)
    const before = await readFile(join(dir, '.pipeline.yaml'), 'utf8')
    const pending = await reqDelete(h.port, `/api/change/feat?root=${encodeURIComponent(h.root)}`, { headers: AUTH })
    expect(pending.status).toBe(409)
    expect(pending.json()).toMatchObject({ code: 'confirmation-required', reasons: [{ code: 'review-pending' }] })
    expect(await readFile(join(dir, '.pipeline.yaml'), 'utf8')).toBe(before)

    await h.store.setMany(dir, { automation: 'running' } as never)
    const blocked = await reqDelete(
      h.port,
      `/api/change/feat?root=${encodeURIComponent(h.root)}&acknowledged=review-pending`,
      { headers: AUTH },
    )
    expect(blocked.status).toBe(409)
    expect(blocked.json()).toMatchObject({ code: 'task-blocked', reasons: [{ code: 'afk-running' }] })
    expect(await exists(dir)).toBe(true)

    const unknown = await reqDelete(
      h.port,
      `/api/change/feat?root=${encodeURIComponent(h.root)}&acknowledged=nope`,
      { headers: AUTH },
    )
    expect(unknown.status).toBe(400)
  })

  it('refuses a bad name, a missing Change and an unregistered root', async () => {
    const h = await start(['feat'])
    const name = await reqDelete(h.port, `/api/change/archive?root=${encodeURIComponent(h.root)}`, { headers: AUTH })
    expect([name.status, name.json<{ code: string }>().code]).toEqual([400, 'invalid-name'])
    const missing = await reqDelete(h.port, `/api/change/nope?root=${encodeURIComponent(h.root)}`, { headers: AUTH })
    expect([missing.status, missing.json<{ code: string }>().code]).toEqual([404, 'task-not-found'])
    const root = await reqDelete(h.port, '/api/change/feat?root=/nope', { headers: AUTH })
    expect(root.status).toBe(404)
  })

  it('drops the archive entry of the deleted Change', async () => {
    const h = await start(['feat', 'other'])
    expect((await reqPost(h.port, '/api/change/feat/archive', { root: h.root }, { headers: AUTH })).status).toBe(200)
    expect((await reqPost(h.port, '/api/change/other/archive', { root: h.root }, { headers: AUTH })).status).toBe(200)
    expect((await reqDelete(h.port, `/api/change/feat?root=${encodeURIComponent(h.root)}`, { headers: AUTH })).status).toBe(200)
    const stored = await archiveStore(h.root, alice.slug)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ version: 1, changes: { other: { phase: 'open' } } })
    expect(stored).not.toContain('"feat"')
  })
})

describe('archived Changes refuse progress over HTTP', () => {
  it('transition and decisions answer 409 task-archived', async () => {
    const h = await start(['feat'])
    const archive = await ensureUserLocalDir(h.root, alice.slug)
    await writeFile(archive.archived, serializeTaskArchive({
      version: 1,
      changes: { feat: { archivedAt: '2026-09-15T12:00:00.000Z', phase: 'open', actor: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } } },
    }), 'utf8')
    const before = await readFile(join(h.root, 'openspec', 'changes', 'feat', '.pipeline.yaml'), 'utf8')

    const transition = await reqPost(h.port, '/api/change/feat/transition', { root: h.root, event: 'open-complete' }, { headers: AUTH })
    expect(transition.status).toBe(409)
    expect(transition.json()).toMatchObject({ ok: false, code: 'task-archived' })

    const decision = await reqPost(h.port, '/api/change/feat/decisions', {
      root: h.root, ref: 'r', expected_revision: 1, idempotency_key: 'k',
    }, { headers: AUTH })
    expect(decision.status).toBe(409)
    expect(decision.json()).toMatchObject({ ok: false, code: 'task-archived' })

    expect(await readFile(join(h.root, 'openspec', 'changes', 'feat', '.pipeline.yaml'), 'utf8')).toBe(before)
  })
})
