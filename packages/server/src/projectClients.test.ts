import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TenonUserResolution } from '@tenon/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveServerPaths } from './paths.js'
import { readProjectClients, writeProjectClients } from './projectClients.js'
import { createDashboardServer } from './server.js'
import { reqGet, reqPost } from './test-support.js'
import type { DashboardServer } from './types.js'
import { captureWorkflowRootAnchor, closeWorkflowRootAnchor } from './workflowRootAnchor.js'

const TOKEN = 'secret-token-abc'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const TEST_USER: TenonUserResolution = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared', slug: 'tester-at-tenon.test', source: 'env' }
const servers: DashboardServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function start(roots: readonly string[], resolveUser: (root: string) => TenonUserResolution = () => TEST_USER) {
  const home = await temp('tenon-clients-home-')
  const paths = resolveServerPaths({ home, env: {} })
  const srv = createDashboardServer({
    version: '9.9.9', hostHome: home, paths, token: TOKEN, registry: () => [...roots], pollIntervalMs: 1000, cadence: false, resolveUser,
    manifestPath: fileURLToPath(new URL('../../../templates/manifest.yaml', import.meta.url)),
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, paths }
}

const clientsFile = (root: string): string => join(root, '.tenon', 'clients.json')
const get = (port: number, root: string) => reqGet(port, `/api/projects/clients?root=${encodeURIComponent(root)}`)

describe('project clients · functions', () => {
  it('writeProjectClients：建 .tenon/、去重排序、原子整份替换', async () => {
    const root = await temp('tenon-clients-project-')
    const anchor = captureWorkflowRootAnchor(root)
    try {
      expect(readProjectClients(anchor)).toMatchObject({ ok: true, enabled: [], source: 'inferred' })
      expect(writeProjectClients(anchor, ['codex', 'claude', 'codex'])).toMatchObject({ ok: true, enabled: ['claude', 'codex'], digest_before: 'absent' })
      expect(JSON.parse(await readFile(clientsFile(root), 'utf8'))).toEqual({ schema: 'tenon-clients/v1', enabled: ['claude', 'codex'] })
      expect(writeProjectClients(anchor, [])).toMatchObject({ ok: true, enabled: [] })
      expect(readProjectClients(anchor)).toMatchObject({ ok: true, enabled: [], source: 'file' })
      expect(writeProjectClients(anchor, ['claude', 'vim'])).toMatchObject({ ok: false, status: 400, code: 'unknown-client', unknown: ['vim'] })
      expect(writeProjectClients(anchor, 'claude')).toMatchObject({ ok: false, status: 400, code: 'invalid' })
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })

  it('损坏的 clients.json：读失败（不静默推断），写入整份替换修好', async () => {
    const root = await temp('tenon-clients-project-')
    await mkdir(join(root, '.tenon'))
    await writeFile(clientsFile(root), '{"schema":"other"}')
    await writeFile(join(root, 'CLAUDE.md'), '# x\n')
    const anchor = captureWorkflowRootAnchor(root)
    try {
      expect(readProjectClients(anchor)).toMatchObject({ ok: false, status: 409, code: 'clients-file-invalid' })
      expect(writeProjectClients(anchor, ['gemini'])).toMatchObject({ ok: true, enabled: ['gemini'] })
      expect(readProjectClients(anchor)).toMatchObject({ ok: true, enabled: ['gemini'], source: 'file' })
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })

  it('clients.json 是 symlink：读写都拒绝，不跟随', async () => {
    const root = await temp('tenon-clients-project-')
    const outside = await temp('tenon-clients-outside-')
    await writeFile(join(outside, 'x.json'), '{}')
    await mkdir(join(root, '.tenon'))
    await symlink(join(outside, 'x.json'), clientsFile(root))
    const anchor = captureWorkflowRootAnchor(root)
    try {
      expect(readProjectClients(anchor)).toMatchObject({ ok: false, code: 'target-symlink' })
      expect(writeProjectClients(anchor, ['codex'])).toMatchObject({ ok: false, code: 'target-symlink' })
      expect(await readFile(join(outside, 'x.json'), 'utf8')).toBe('{}')
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })
})

describe('project clients · routes', () => {
  it('GET：没有文件时按现有文件推断（source=inferred）；有文件时 source=file', async () => {
    const root = await temp('tenon-clients-project-')
    await writeFile(join(root, 'AGENTS.md'), '# a\n')
    await writeFile(join(root, 'GEMINI.md'), '# g\n')
    const { port } = await start([root])
    expect((await get(port, root)).json()).toEqual({ enabled: ['codex', 'gemini'], source: 'inferred' })
    const posted = await reqPost(port, '/api/projects/clients', { root, enabled: ['zed', 'claude'] }, { headers: AUTH })
    expect(posted.status).toBe(200)
    expect(posted.json()).toEqual({ enabled: ['claude', 'zed'], source: 'file' })
    expect((await get(port, root)).json()).toEqual({ enabled: ['claude', 'zed'], source: 'file' })
  })

  it('写端点三闸与 root 锚：错误 Host 403、缺 token 401、非 JSON 400、未注册 root 404', async () => {
    const root = await temp('tenon-clients-project-')
    const other = await temp('tenon-clients-other-')
    const { port } = await start([root])
    const body = { root, enabled: ['codex'] }
    expect((await reqPost(port, '/api/projects/clients', body, { headers: { ...AUTH, Host: 'evil.example' } })).status).toBe(403)
    expect((await reqPost(port, '/api/projects/clients', body)).status).toBe(401)
    const wrongType = await reqPost(port, '/api/projects/clients', body, { headers: { ...AUTH, 'Content-Type': 'text/plain' } })
    expect(wrongType.status).toBe(400)
    expect(wrongType.json<{ error: string }>().error).toContain('application/json')
    expect((await reqPost(port, '/api/projects/clients', { root: other, enabled: ['codex'] }, { headers: AUTH })).status).toBe(404)
    expect((await reqGet(port, `/api/projects/clients?root=${encodeURIComponent(root)}`, '127.0.0.1', { Host: 'evil.example' })).status).toBe(403)
    expect((await get(port, other)).status).toBe(404)
    expect((await reqGet(port, '/api/projects/clients')).status).toBe(400)
    expect(existsSync(clientsFile(root))).toBe(false)
  })

  it('校验：未知客户端 400（带 unknown）、多余字段 400；不落盘', async () => {
    const root = await temp('tenon-clients-project-')
    const { port } = await start([root])
    const unknown = await reqPost(port, '/api/projects/clients', { root, enabled: ['codex', 'vim'] }, { headers: AUTH })
    expect(unknown.status).toBe(400)
    expect(unknown.json()).toMatchObject({ ok: false, code: 'unknown-client', unknown: ['vim'] })
    expect((await reqPost(port, '/api/projects/clients', { root, enabled: ['codex'], extra: 1 }, { headers: AUTH })).status).toBe(400)
    expect((await reqPost(port, '/api/projects/clients', { root, enabled: 'codex' }, { headers: AUTH })).status).toBe(400)
    expect(existsSync(clientsFile(root))).toBe(false)
  })

  it('缺声明身份 412 不落盘；写入追加一行审计', async () => {
    const root = await temp('tenon-clients-project-')
    const missing = await start([root], () => ({ missing: true }))
    const denied = await reqPost(missing.port, '/api/projects/clients', { root, enabled: ['codex'] }, { headers: AUTH })
    expect(denied.status).toBe(412)
    expect(existsSync(clientsFile(root))).toBe(false)

    const { port, paths } = await start([root])
    expect((await reqPost(port, '/api/projects/clients', { root, enabled: ['codex'] }, { headers: AUTH })).status).toBe(200)
    const rows = (await readFile(join(paths.configRoot, 'templates', 'instructions', 'audit.jsonl'), 'utf8')).trimEnd().split('\n')
      .map((line) => JSON.parse(line) as { action: string; target: string; digest_before: string })
    expect(rows).toEqual([expect.objectContaining({ action: 'project-clients', target: clientsFile(root), digest_before: 'absent' })])
  })
})
