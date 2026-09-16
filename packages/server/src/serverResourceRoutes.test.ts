import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveServerPaths } from './paths.js'
import { createDashboardServer } from './server.js'
import { resolveResourceMutation } from './serverResourceRoutes.js'
import { reqDelete, reqGet, reqPost } from './test-support.js'
import type { DashboardServer, ServerPaths } from './types.js'

const TOKEN = 'secret-token-abc'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const servers: DashboardServer[] = []
const homes: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function start(): Promise<{ port: number; paths: ServerPaths }> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-resource-routes-'))
  homes.push(home)
  const paths = resolveServerPaths({ home, env: {} })
  const srv = createDashboardServer({
    version: '9.9.9', hostHome: home, paths, token: TOKEN, registry: () => [], pollIntervalMs: 1000, cadence: false,
    manifestPath: fileURLToPath(new URL('../../../templates/manifest.yaml', import.meta.url)),
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, paths }
}

function reqPut(port: number, path: string, payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload)
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...headers },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const parse = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>

function entryYaml(id: string, name = id): string {
  return [
    'schema: tenon-resource/v1',
    `id: ${id}`,
    `name: ${name}`,
    'category: icons',
    'frameworks: [react]',
    'styling: []',
    'baseline: false',
    'license:',
    '  spdx: MIT',
    '  url: https://example.com/LICENSE',
    '  redistributable: true',
    '  attribution: false',
    '  commercial: free',
    'install: []',
    'skills: []',
    'links:',
    '  home: https://example.com',
    'verified_at: 2026-09-16',
    '',
  ].join('\n')
}

describe('资源目录路由', () => {
  it('GET /api/resources 同步内建条目并返回封闭形状', async () => {
    const { port, paths } = await start()
    const res = await reqGet(port, '/api/resources')
    expect(res.status).toBe(200)
    const body = parse(res.body)
    expect(body.schema_version).toBe('resource-catalog/v1')
    expect(body.errors).toEqual([])
    const entries = body.entries as { id: string; source: string; revision: string }[]
    expect(entries.find((entry) => entry.id === 'gsap')).toMatchObject({ source: 'builtin' })
    expect(entries.every((entry) => entry.revision.startsWith('sha256:'))).toBe(true)
    expect(await readFile(join(paths.configRoot, 'resources', 'builtin', 'gsap.yaml'), 'utf8')).toContain('id: gsap')
  })

  it('GET /api/resources/:id 给出原文，未知 id 404', async () => {
    const { port } = await start()
    const res = await reqGet(port, '/api/resources/lucide')
    expect(res.status).toBe(200)
    expect(parse(res.body).yaml).toContain('id: lucide')
    expect((await reqGet(port, '/api/resources/ghost')).status).toBe(404)
  })

  it('PUT 新建并更新自定义条目，冲突时 409', async () => {
    const { port } = await start()
    const created = await reqPut(port, '/api/resources/mine', { yaml: entryYaml('mine') }, AUTH)
    expect(created.status).toBe(200)
    const revision = (parse(created.body).entry as { revision: string }).revision
    const updated = await reqPut(port, '/api/resources/mine', { yaml: entryYaml('mine', 'Mine 2'), revision }, AUTH)
    expect(updated.status).toBe(200)
    expect((parse(updated.body).entry as { name: string }).name).toBe('Mine 2')
    const stale = await reqPut(port, '/api/resources/mine', { yaml: entryYaml('mine'), revision }, AUTH)
    expect(stale.status).toBe(409)
    expect(parse(stale.body).code).toBe('conflict')
  })

  it('PUT 不合法条目 400，内建条目 409，超限 413，无 token 401', async () => {
    const { port } = await start()
    const invalid = await reqPut(port, '/api/resources/mine', { yaml: 'schema: tenon-resource/v1\n' }, AUTH)
    expect(invalid.status).toBe(400)
    expect(parse(invalid.body).errors).toBeDefined()
    expect((await reqPut(port, '/api/resources/lucide', { yaml: entryYaml('lucide') }, AUTH)).status).toBe(409)
    const huge = `${entryYaml('mine')}# ${'x'.repeat(70 * 1024)}\n`
    expect((await reqPut(port, '/api/resources/mine', { yaml: huge }, AUTH)).status).toBe(413)
    expect((await reqPut(port, '/api/resources/mine', { yaml: entryYaml('mine') })).status).toBe(401)
  })

  it('POST copy 复制成自定义条目', async () => {
    const { port } = await start()
    const copied = await reqPost(port, '/api/resources/lucide/copy', {}, { headers: AUTH })
    expect(copied.status).toBe(200)
    expect(parse(copied.body).id).toBe('lucide-copy')
    const read = await reqGet(port, '/api/resources/lucide-copy')
    expect((parse(read.body).entry as { source: string }).source).toBe('custom')
  })

  it('DELETE 自定义条目后 GET 404；内建条目 409', async () => {
    const { port } = await start()
    await reqPut(port, '/api/resources/mine', { yaml: entryYaml('mine') }, AUTH)
    expect((await reqDelete(port, '/api/resources/mine', { headers: AUTH })).status).toBe(200)
    expect((await reqGet(port, '/api/resources/mine')).status).toBe(404)
    const builtin = await reqDelete(port, '/api/resources/lucide', { headers: AUTH })
    expect(builtin.status).toBe(409)
    expect(parse(builtin.body).code).toBe('builtin-readonly')
  })
})

/** 起步端点直接按模块调用：注册表与抓取器都注入，不碰网络。 */
describe('DESIGN.md 起步端点', () => {
  function seedDeps(paths: ServerPaths, root: string | null, text = '# Claude\n') {
    return {
      isLocalHost: () => true,
      boundPort: () => 0,
      paths,
      readJsonBody: async () => ({ root: root ?? '/nope', resource: 'design-md-claude' }),
      workflowRootForRequest: (requested: string) => (root !== null && requested === root
        ? { ok: true as const, anchor: {} as never }
        : { ok: false as const, code: 403, error: 'root 未注册' }),
      designSeedFetch: async () => ({ ok: true, status: 200, text }),
    }
  }

  const call = async (deps: ReturnType<typeof seedDeps>) => {
    const pending = resolveResourceMutation({ headers: {}, url: '/api/design/seed' } as never, 'POST', '/api/design/seed', deps)
    if (pending === null) throw new Error('seed route not matched')
    return pending
  }

  it('写到已注册项目根，已存在时 409', async () => {
    const { paths } = await start()
    const project = await mkdtemp(join(tmpdir(), 'tenon-design-project-'))
    homes.push(project)
    const first = await call(seedDeps(paths, project))
    expect(first.status).toBe(200)
    expect(await readFile(join(project, 'DESIGN.md'), 'utf8')).toBe('# Claude\n')
    expect((await call(seedDeps(paths, project))).status).toBe(409)
  })

  it('未注册的 root 直接拒绝', async () => {
    const { paths } = await start()
    const denied = await call(seedDeps(paths, null))
    expect(denied.status).toBe(403)
  })

  it('非 DESIGN.md 资源 400', async () => {
    const { paths } = await start()
    const project = await mkdtemp(join(tmpdir(), 'tenon-design-project-'))
    homes.push(project)
    const deps = {
      ...seedDeps(paths, project),
      readJsonBody: async () => ({ root: project, resource: 'lucide' }),
    }
    const result = await call(deps)
    expect(result.status).toBe(400)
    expect(parse(JSON.stringify(result.body)).code).toBe('not-design-md')
  })
})
