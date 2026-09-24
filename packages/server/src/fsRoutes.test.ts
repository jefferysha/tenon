import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { FolderChooser, FolderPick, FolderPickRequest } from './folderChooser.js'
import { FOLDER_LIST_MAX, listFolders } from './folderList.js'
import { resolveServerPaths } from './paths.js'
import { createDashboardServer } from './server.js'
import { reqGet, reqPost } from './test-support.js'
import type { DashboardServer } from './types.js'

const TOKEN = 'secret-token-fs'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const servers: DashboardServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `tenon-fs-${label}-`))
  dirs.push(dir)
  return dir
}

function fakeChooser(answer: FolderPick): FolderChooser & { requests: FolderPickRequest[] } {
  const requests: FolderPickRequest[] = []
  return { requests, choose: async (request) => { requests.push(request); return answer } }
}

async function start(chooser: FolderChooser): Promise<{ port: number; home: string }> {
  const home = await tempDir('home')
  const srv = createDashboardServer({
    version: '9.9.9', hostHome: home, paths: resolveServerPaths({ home, env: {} }), token: TOKEN, registry: () => [],
    pollIntervalMs: 1000, cadence: false, folderChooser: chooser,
    manifestPath: fileURLToPath(new URL('../../../templates/manifest.yaml', import.meta.url)),
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, home }
}

describe('listFolders', () => {
  it('只列子目录（不含文件、符号链接），默认隐藏点目录，按名排序', async () => {
    const dir = await tempDir('list')
    await mkdir(join(dir, 'beta'))
    await mkdir(join(dir, 'alpha'))
    await mkdir(join(dir, '.hidden'))
    await writeFile(join(dir, 'file.txt'), 'x')
    await symlink(join(dir, 'alpha'), join(dir, 'link'))
    const visible = listFolders(dir, false, '/home/me')
    expect(visible).toMatchObject({ status: 200, body: { ok: true, dir, parent: join(dir, '..'), home: '/home/me', truncated: false } })
    expect(visible.body.ok && visible.body.entries).toEqual([{ name: 'alpha', path: join(dir, 'alpha') }, { name: 'beta', path: join(dir, 'beta') }])
    const all = listFolders(dir, true, '/home/me')
    expect(all.body.ok && all.body.entries.map((entry) => entry.name)).toEqual(['.hidden', 'alpha', 'beta'])
  })

  it('空 dir = 主目录；根目录没有上一级', async () => {
    const home = await tempDir('home-list')
    expect(listFolders('', false, home).body).toMatchObject({ dir: home })
    expect(listFolders('/', false, home).body).toMatchObject({ dir: '/', parent: null })
  })

  it('拒绝相对路径、不存在的路径、文件与符号链接', async () => {
    const dir = await tempDir('bad')
    await writeFile(join(dir, 'file.txt'), 'x')
    await symlink(dir, join(dir, 'link'))
    expect(listFolders('relative', false, dir)).toMatchObject({ status: 400, body: { code: 'invalid-path' } })
    expect(listFolders(join(dir, 'missing'), false, dir)).toMatchObject({ status: 404, body: { code: 'path-missing' } })
    expect(listFolders(join(dir, 'file.txt'), false, dir)).toMatchObject({ status: 400, body: { code: 'not-directory' } })
    expect(listFolders(join(dir, 'link'), false, dir)).toMatchObject({ status: 400, body: { code: 'path-unsafe' } })
  })

  it(`超过 ${FOLDER_LIST_MAX} 项时截断并标 truncated`, async () => {
    const dir = await tempDir('many')
    await Promise.all(Array.from({ length: FOLDER_LIST_MAX + 1 }, (_, index) => mkdir(join(dir, `d${String(index).padStart(5, '0')}`))))
    const listed = listFolders(dir, false, dir)
    expect(listed.body.ok && listed.body.entries.length).toBe(FOLDER_LIST_MAX)
    expect(listed.body).toMatchObject({ truncated: true })
  })
})

describe('POST /api/fs/choose-folder', () => {
  it('写端点三闸：错误 Host 403、缺 token 401、非 JSON 400；都不调起对话框', async () => {
    const chooser = fakeChooser({ ok: true, path: '/x' })
    const { port } = await start(chooser)
    expect((await reqPost(port, '/api/fs/choose-folder', {}, { headers: { ...AUTH, Host: 'evil.example' } })).status).toBe(403)
    expect((await reqPost(port, '/api/fs/choose-folder', {})).status).toBe(401)
    expect((await reqPost(port, '/api/fs/choose-folder', {}, { headers: { ...AUTH, 'Content-Type': 'text/plain' } })).status).toBe(400)
    expect(chooser.requests).toEqual([])
  })

  it('返回选中路径；标题与已存在的起始目录透传，不存在的起始目录丢弃', async () => {
    const start_dir = await tempDir('start')
    const chooser = fakeChooser({ ok: true, path: start_dir })
    const { port } = await start(chooser)
    const picked = await reqPost(port, '/api/fs/choose-folder', { title: '选择父目录', start_dir }, { headers: AUTH })
    expect(picked.status).toBe(200)
    expect(picked.json()).toEqual({ ok: true, path: start_dir })
    await reqPost(port, '/api/fs/choose-folder', { start_dir: join(start_dir, 'missing') }, { headers: AUTH })
    expect(chooser.requests).toEqual([{ title: '选择父目录', startDir: start_dir }, { title: 'Tenon', startDir: null }])
  })

  it('取消 / 不可用原样返回 200；busy → 409 picker-busy；非法请求体 400', async () => {
    for (const answer of [{ ok: false, cancelled: true }, { ok: false, unavailable: true }] as const) {
      const { port } = await start(fakeChooser(answer))
      const result = await reqPost(port, '/api/fs/choose-folder', {}, { headers: AUTH })
      expect([result.status, result.json()]).toEqual([200, answer])
    }
    const { port } = await start(fakeChooser({ ok: false, busy: true }))
    const busy = await reqPost(port, '/api/fs/choose-folder', {}, { headers: AUTH })
    expect([busy.status, busy.json<{ code: string }>().code]).toEqual([409, 'picker-busy'])
    expect((await reqPost(port, '/api/fs/choose-folder', { start_dir: 'relative' }, { headers: AUTH })).status).toBe(400)
    expect((await reqPost(port, '/api/fs/choose-folder', { title: 'a\nb' }, { headers: AUTH })).status).toBe(400)
    expect((await reqPost(port, '/api/fs/choose-folder', { extra: 1 }, { headers: AUTH })).status).toBe(400)
  })
})

describe('GET /api/fs/list', () => {
  it('要 Host 守卫与 token；空 dir 列主目录', async () => {
    const { port, home } = await start(fakeChooser({ ok: false, cancelled: true }))
    await mkdir(join(home, 'code'))
    expect((await reqGet(port, '/api/fs/list', '127.0.0.1', { ...AUTH, Host: 'evil.example' })).status).toBe(403)
    expect((await reqGet(port, '/api/fs/list')).status).toBe(401)
    const listed = await reqGet(port, '/api/fs/list', '127.0.0.1', AUTH)
    expect(listed.status).toBe(200)
    expect(listed.json()).toMatchObject({ ok: true, dir: home, entries: [{ name: 'code', path: join(home, 'code') }] })
    const missing = await reqGet(port, `/api/fs/list?dir=${encodeURIComponent(join(home, 'missing'))}`, '127.0.0.1', AUTH)
    expect([missing.status, missing.json<{ code: string }>().code]).toEqual([404, 'path-missing'])
  })
})
