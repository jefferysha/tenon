/**
 * 删除 / 终止 over real HTTP: reasons from GET, the token gate, the zero-write 409s, and the snapshot the
 * Dashboard reads afterwards. Deletion and termination move or remove a whole task directory, so each
 * refusal is asserted to leave the Change directory untouched. There is no "hide" any more.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureHostAgentFiles, readTaskResult, type TenonUserResolution } from '@tenon/kernel'
import { resolveServerPaths } from './paths.js'
import { createTestDashboardServer } from './test-server.js'
import { initChange, makeProject, makeTempHome, newStore, reqDelete, reqGet, reqPost, testFlow } from './test-support.js'
import type { DashboardServer } from './types.js'

const execFileAsync = promisify(execFile)
const AUTH = { Authorization: 'Bearer tok' }
/** `initChange` records this identity as creator and owner, so the viewer owns what it deletes. */
const alice: TenonUserResolution = {
  id: 'tester@tenon.test', name: 'Tester', slug: 'tester-at-tenon.test', source: 'env', trust: 'declared',
}
const bob: TenonUserResolution = { id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }
const TODAY = '2026-09-15'
/** 截断的百分号编码：`decodeURIComponent` 会抛 URIError。 */
const MALFORMED_NAME = '%E0%A4%A'

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
  /** Every change handed to the `openspec archive` stand-in. */
  openspecCalls: string[]
}

async function start(
  changes: readonly string[],
  viewer: TenonUserResolution = alice,
  failOpenspec?: string,
): Promise<Started> {
  const home = await makeTempHome()
  const root = await makeProject()
  dirs.push(home, root)
  const store = newStore()
  for (const name of changes) await initChange(store, root, name)
  const openspecCalls: string[] = []
  const srv = createTestDashboardServer({
    paths: resolveServerPaths({ home, env: {} }),
    hostHome: home, token: 'tok', registry: () => [root], store, flow: testFlow(),
    version: '9.9.9', clock: () => `${TODAY}T12:00:00.000Z`,
    resolveUser: () => viewer,
    // 测试里不跑真实 openspec：同样的布局（archive/<日期>-<名>），日期取自测试时钟。
    runOpenspecArchive: async (repoRoot, change) => {
      openspecCalls.push(change)
      if (failOpenspec !== undefined) throw new Error(failOpenspec)
      await mkdir(archiveRoot(repoRoot), { recursive: true })
      await rename(join(repoRoot, 'openspec', 'changes', change), join(archiveRoot(repoRoot), `${TODAY}-${change}`))
    },
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, store, openspecCalls }
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

function archiveRoot(root: string): string {
  return join(root, 'openspec', 'changes', 'archive')
}

describe('GET /api/change/:name/lifecycle', () => {
  it('reports the reasons the dialog displays', async () => {
    const h = await start(['feat'])
    await h.store.setMany(join(h.root, 'openspec', 'changes', 'feat'), { review_gate_status: 'pending' } as never)
    const r = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=delete`)
    expect(r.status).toBe(200)
    // 不在 git 仓库里：删除后找不回。
    expect(r.json()).toEqual({
      ok: true, action: 'delete', phase: 'open', blockers: [], confirmations: [{ code: 'review-pending' }], recoverable: false,
    })
  })

  it('reports a Change with git-tracked files as recoverable; terminate carries no recoverable field', async () => {
    const h = await start(['feat'])
    const run = (args: readonly string[]) => execFileAsync('git', ['-C', h.root, ...args])
    await run(['init', '-q'])
    const before = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=delete`)
    expect(before.json()).toMatchObject({ recoverable: false })
    await run(['add', '--', 'openspec/changes/feat'])
    const after = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=delete`)
    expect(after.json()).toMatchObject({ recoverable: true })
    const terminate = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=terminate`)
    expect(terminate.json()).toMatchObject({ ok: true, action: 'terminate' })
    expect(terminate.json()).not.toHaveProperty('recoverable')
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
    const blocked = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=terminate`)
    expect(blocked.status).toBe(200)
    expect(blocked.json()).toMatchObject({ blockers: [{ code: 'afk-running' }] })

    for (const retired of ['archive', 'unarchive', 'nope']) {
      const action = await reqGet(h.port, `/api/change/feat/lifecycle?root=${encodeURIComponent(h.root)}&action=${retired}`)
      expect(action.status, retired).toBe(400)
    }
    const name = await reqGet(h.port, `/api/change/archive/lifecycle?root=${encodeURIComponent(h.root)}&action=delete`)
    expect([name.status, (name.json<{ code: string }>()).code]).toEqual([400, 'invalid-name'])
    const missing = await reqGet(h.port, `/api/change/nope/lifecycle?root=${encodeURIComponent(h.root)}&action=delete`)
    expect([missing.status, (missing.json<{ code: string }>()).code]).toEqual([404, 'task-not-found'])
    const root = await reqGet(h.port, '/api/change/feat/lifecycle?root=/nope&action=delete')
    expect(root.status).toBe(404)
  })

  it('answers 400 invalid-name for a malformed percent-encoded name instead of throwing', async () => {
    const h = await start(['feat'])
    for (const action of ['delete', 'terminate']) {
      const r = await reqGet(h.port, `/api/change/${MALFORMED_NAME}/lifecycle?root=${encodeURIComponent(h.root)}&action=${action}`)
      expect([r.status, r.json<{ code: string }>().code], action).toEqual([400, 'invalid-name'])
    }
  })
})

describe('POST /api/change/:name/terminate', () => {
  it('requires a token and leaves the Change in place', async () => {
    const h = await start(['feat'])
    const r = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root })
    expect(r.status).toBe(401)
    expect(await exists(join(h.root, 'openspec', 'changes', 'feat'))).toBe(true)
    expect(await exists(archiveRoot(h.root))).toBe(false)
  })

  it('moves the Change under archive/, records 已终止 and answers where it went', async () => {
    const h = await start(['feat', 'other'])
    await h.store.setMany(join(h.root, 'openspec', 'changes', 'feat'), { phase: 'build' } as never)
    const r = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root, acknowledged: [] }, { headers: AUTH })
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({
      ok: true,
      result: 'terminated',
      archived_dir: `openspec/changes/archive/${TODAY}-feat`,
      ended_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      commit: 'skipped',
    })
    expect(await exists(join(h.root, 'openspec', 'changes', 'feat'))).toBe(false)
    expect(await readTaskResult(join(archiveRoot(h.root), `${TODAY}-feat`))).toBe('terminated')
    expect((await h.store.read(join(archiveRoot(h.root), `${TODAY}-feat`))).fields.task_result).toBe('terminated')
    // 走 OpenSpec 的任务由 Tenon 调用 openspec archive，而不是自己 rename。
    expect(h.openspecCalls).toEqual(['feat'])

    const snapshot = (await reqGet(h.port, '/api/snapshot')).json<{
      change_count: number
      projects: { changes: { name: string }[] }[]
    }>()
    expect(snapshot.projects[0]?.changes.map((c) => c.name)).toEqual(['other'])
    expect(snapshot.change_count).toBe(1)

    const afk = (await reqGet(h.port, '/api/afk/snapshot')).json<{ cards: { name: string }[] }>()
    expect(afk.cards.map((card) => card.name)).not.toContain('feat')
  })

  it('answers 200 with the audit failure as a warning when the audit row cannot be written after the move', async () => {
    const h = await start(['feat'])
    await mkdir(join(h.root, '.tenon', 'users', alice.slug, 'local', 'audit.jsonl'), { recursive: true })
    const r = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root }, { headers: AUTH })
    expect(r.status).toBe(200)
    expect(r.json()).toMatchObject({
      ok: true,
      result: 'terminated',
      warnings: [expect.stringMatching(/审计记录没写进去.*EISDIR/su)],
    })
    expect(await exists(join(h.root, 'openspec', 'changes', 'feat'))).toBe(false)
  })

  it('commits only the moved task directory when the project is a git repository', async () => {
    const h = await start(['feat', 'other'])
    await commitAll(h.root)
    const r = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root }, { headers: AUTH })
    expect(r.status).toBe(200)
    expect(r.json()).toMatchObject({ commit: 'committed' })
    const { stdout: subject } = await execFileAsync('git', ['-C', h.root, 'log', '-1', '--format=%s'])
    expect(subject.trim()).toBe('chore(tenon): terminate feat')
    const { stdout: files } = await execFileAsync('git', ['-C', h.root, 'show', '--name-only', '--format=', 'HEAD'])
    for (const file of files.split('\n').filter((line) => line !== '')) {
      expect(file.startsWith('openspec/changes/feat/') || file.startsWith(`openspec/changes/archive/${TODAY}-feat/`), file).toBe(true)
    }
  })

  it('does not overwrite an earlier same-day archive of the same name', async () => {
    const h = await start(['feat'])
    expect((await reqPost(h.port, '/api/change/feat/terminate', { root: h.root }, { headers: AUTH })).status).toBe(200)
    await initChange(h.store, h.root, 'feat')
    const second = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root }, { headers: AUTH })
    expect(second.json()).toMatchObject({ archived_dir: `openspec/changes/archive/${TODAY}-feat-2` })
    expect((await readdir(archiveRoot(h.root))).sort()).toEqual([`${TODAY}-feat`, `${TODAY}-feat-2`])
    // 同日同名时 OpenSpec 拿到的是带序号的活跃名，它自己的「目标已存在」报错不会被撞上。
    expect(h.openspecCalls).toEqual(['feat', 'feat-2'])
  })

  it('refuses an unacknowledged confirmation, an unknown code and a blocker without writing', async () => {
    const h = await start(['feat'])
    const dir = join(h.root, 'openspec', 'changes', 'feat')
    await h.store.setMany(dir, { review_gate_status: 'pending' } as never)
    const pending = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root, acknowledged: [] }, { headers: AUTH })
    expect(pending.status).toBe(409)
    expect(pending.json()).toMatchObject({ code: 'confirmation-required', reasons: [{ code: 'review-pending' }] })
    expect(await exists(dir)).toBe(true)
    expect(await exists(archiveRoot(h.root))).toBe(false)

    const bad = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root, acknowledged: ['nope'] }, { headers: AUTH })
    expect(bad.status).toBe(400)

    await h.store.setMany(dir, { automation: 'queued' } as never)
    const blocked = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root, acknowledged: ['afk-queued', 'review-pending'] }, { headers: AUTH })
    expect(blocked.status).toBe(409)
    expect(blocked.json()).toMatchObject({ code: 'task-blocked', reasons: [{ code: 'afk-queued' }] })
    expect(await exists(dir)).toBe(true)

    await h.store.setMany(dir, { automation: '' } as never)
    const ok = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root, acknowledged: ['review-pending'] }, { headers: AUTH })
    expect(ok.status).toBe(200)
  })

  it('answers 500 archive-failed when openspec fails: the Change stays active and its state carries no task_result', async () => {
    const h = await start(['feat'], alice, 'archive_validation_failed')
    const dir = join(h.root, 'openspec', 'changes', 'feat')
    const r = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root }, { headers: AUTH })
    expect(r.status).toBe(500)
    expect(r.json()).toMatchObject({ ok: false, code: 'archive-failed', error: expect.stringContaining('archive_validation_failed') })
    expect(h.openspecCalls).toEqual(['feat'])
    expect(await exists(dir)).toBe(true)
    expect(await exists(archiveRoot(h.root))).toBe(false)
    expect((await h.store.read(dir)).fields.task_result).toBe('')
  })

  it('refuses a Change whose state machine already finished', async () => {
    const h = await start(['feat'])
    const dir = join(h.root, 'openspec', 'changes', 'feat')
    await h.store.setMany(dir, { phase: 'done', archived: 'true' } as never)
    const r = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root }, { headers: AUTH })
    expect(r.status).toBe(409)
    expect(r.json()).toMatchObject({ code: 'task-terminal' })
    expect(await exists(dir)).toBe(true)
  })

  it('answers 400 invalid-name for a malformed percent-encoded name instead of throwing', async () => {
    const h = await start(['feat'])
    const r = await reqPost(h.port, `/api/change/${MALFORMED_NAME}/terminate`, { root: h.root }, { headers: AUTH })
    expect([r.status, r.json<{ code: string }>().code]).toEqual([400, 'invalid-name'])
    expect(await exists(join(h.root, 'openspec', 'changes', 'feat'))).toBe(true)
    expect(await exists(archiveRoot(h.root))).toBe(false)
  })

  it('has no archive / unarchive route any more', async () => {
    const h = await start(['feat'])
    for (const sub of ['archive', 'unarchive']) {
      const r = await reqPost(h.port, `/api/change/feat/${sub}`, { root: h.root }, { headers: AUTH })
      expect(r.status, sub).toBe(404)
    }
    expect(await exists(join(h.root, 'openspec', 'changes', 'feat'))).toBe(true)
    expect(await exists(archiveRoot(h.root))).toBe(false)
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
    // 没有告警时响应里不带 warnings 键（与终止一致）。
    expect(r.json()).not.toHaveProperty('warnings')

    const snapshot = (await reqGet(h.port, '/api/snapshot')).json<{
      projects: { changes: { name: string }[]; uncommittedDeletions?: number }[]
    }>()
    expect(snapshot.projects[0]?.changes.map((c) => c.name)).toEqual(['other'])
    expect(snapshot.projects[0]?.uncommittedDeletions).toBe(1)
  })

  it('answers 200 with the audit failure as a warning when the audit row cannot be written after the removal', async () => {
    const h = await start(['feat'])
    await mkdir(join(h.root, '.tenon', 'users', alice.slug, 'audit.jsonl'), { recursive: true })
    const r = await reqDelete(h.port, `/api/change/feat?root=${encodeURIComponent(h.root)}`, { headers: AUTH })
    expect(r.status).toBe(200)
    expect(r.json()).toMatchObject({
      ok: true,
      removed: expect.arrayContaining(['openspec/changes/feat']),
      warnings: [expect.stringMatching(/审计记录没写进去.*EISDIR/su)],
    })
    expect(await exists(join(h.root, 'openspec', 'changes', 'feat'))).toBe(false)
  })

  it('delete and terminate also reclaim the generated host agent files nobody else uses (P2)', async () => {
    const h = await start(['feat', 'other'])
    await ensureHostAgentFiles({
      repoRoot: h.root, host: 'claude',
      agents: [{ name: 'x', definition: { name: 'x', description: 'd', role: 'reviewer', skills: [], tools: ['Read'], body: '\n正文\n' } }],
    })
    const file = join(h.root, '.claude', 'agents', 'tenon-x.md')
    expect(await exists(file)).toBe(true)
    const terminated = await reqPost(h.port, '/api/change/feat/terminate', { root: h.root, acknowledged: [] }, { headers: AUTH })
    expect(terminated.status).toBe(200)
    expect(await exists(file)).toBe(false)
    expect(await exists(join(h.root, '.claude'))).toBe(false)

    await ensureHostAgentFiles({
      repoRoot: h.root, host: 'claude',
      agents: [{ name: 'y', definition: { name: 'y', description: 'd', role: 'reviewer', skills: [], tools: ['Read'], body: '\n正文\n' } }],
    })
    const deleted = await reqDelete(h.port, `/api/change/other?root=${encodeURIComponent(h.root)}`, { headers: AUTH })
    expect(deleted.status).toBe(200)
    expect(await exists(join(h.root, '.claude', 'agents', 'tenon-y.md'))).toBe(false)
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

  it('answers 400 invalid-name for a malformed percent-encoded name instead of throwing', async () => {
    const h = await start(['feat'])
    const r = await reqDelete(h.port, `/api/change/${MALFORMED_NAME}?root=${encodeURIComponent(h.root)}`, { headers: AUTH })
    expect([r.status, r.json<{ code: string }>().code]).toEqual([400, 'invalid-name'])
    expect(await exists(join(h.root, 'openspec', 'changes', 'feat'))).toBe(true)
  })
})
