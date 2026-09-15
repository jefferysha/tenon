import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveServerPaths } from './paths.js'
import { createDashboardServer } from './server.js'
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

async function start(): Promise<{ port: number; paths: ServerPaths; library: string }> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-instruction-routes-'))
  homes.push(home)
  const paths = resolveServerPaths({ home, env: {} })
  const srv = createDashboardServer({
    version: '9.9.9', hostHome: home, paths, token: TOKEN, registry: () => [], pollIntervalMs: 1000, cadence: false,
    manifestPath: fileURLToPath(new URL('../../../templates/manifest.yaml', import.meta.url)),
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, paths, library: join(paths.configRoot, 'templates', 'instructions') }
}

function reqPut(port: number, path: string, text: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'PUT',
      headers: { 'Content-Type': 'text/markdown', 'Content-Length': String(Buffer.byteLength(text)), ...headers },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.write(text)
    req.end()
  })
}

const CUSTOM = '---\nid: mine\ncategory: backend\ntitle: 我的后端\n---\n## 后端（我的后端）\n\n- 规则一\n'

interface Listed { ok: boolean; sync: { id: string; state: string } | null; templates: { source: string; category: string; id: string; title: string; digest: string; errors: string[] }[] }

describe('instruction template routes', () => {
  it('每个写端点：错误 Host → 403，缺 token → 401', async () => {
    const { port } = await start()
    const badHost = { Host: 'evil.example' }
    expect((await reqPut(port, '/api/instruction-templates/custom/backend/mine', CUSTOM, { ...AUTH, ...badHost, 'If-Match': 'absent' })).status).toBe(403)
    expect((await reqPut(port, '/api/instruction-templates/custom/backend/mine', CUSTOM, { 'If-Match': 'absent' })).status).toBe(401)
    for (const path of ['/api/instruction-templates/copy', '/api/instruction-templates/compose']) {
      expect((await reqPost(port, path, {}, { headers: { ...AUTH, ...badHost } })).status).toBe(403)
      expect((await reqPost(port, path, {})).status).toBe(401)
    }
    expect((await reqDelete(port, '/api/instruction-templates/custom/backend/mine?digest=x', { headers: { ...AUTH, ...badHost } })).status).toBe(403)
    expect((await reqDelete(port, '/api/instruction-templates/custom/backend/mine?digest=x')).status).toBe(401)
    expect((await reqGet(port, '/api/instruction-templates', '127.0.0.1', badHost)).status).toBe(403)
  })

  it('列表：同步内建模板，自定义文件解析失败时带 errors', async () => {
    const { port, library } = await start()
    await mkdir(join(library, 'custom', 'backend'), { recursive: true })
    await writeFile(join(library, 'custom', 'backend', 'bad.md'), 'no frontmatter\n')
    const listed = (await reqGet(port, '/api/instruction-templates')).json<Listed>()
    expect(listed.sync).toEqual({ id: 'instruction-templates', state: 'updated' })
    expect(listed.templates.filter((row) => row.source === 'builtin')).toHaveLength(32)
    const bad = listed.templates.find((row) => row.source === 'custom' && row.id === 'bad')
    expect(bad?.errors.length).toBeGreaterThan(0)
    expect((await reqGet(port, '/api/instruction-templates')).json<Listed>().sync?.state).toBe('unchanged')
  })

  it('读取单个模板：正文、摘要与变量', async () => {
    const { port } = await start()
    const read = await reqGet(port, '/api/instruction-templates/builtin/backend/java-spring-boot-ddd')
    expect(read.status).toBe(200)
    const body = read.json<{ text: string; digest: string; block: { variables: { key: string; default: string | null }[] }; errors: string[] }>()
    expect(body.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(body.block.variables).toContainEqual({ key: 'app', default: 'app' })
    expect(body.errors).toEqual([])
    expect((await reqGet(port, '/api/instruction-templates/builtin/backend/missing')).status).toBe(404)
    expect((await reqGet(port, '/api/instruction-templates/other/backend/go')).status).toBe(400)
  })

  it('保存：内建只读、If-Match 必填与冲突、非法内容不落盘', async () => {
    const { port, library } = await start()
    const path = '/api/instruction-templates/custom/backend/mine'
    expect((await reqPut(port, '/api/instruction-templates/builtin/backend/go', CUSTOM, { ...AUTH, 'If-Match': 'absent' })).status).toBe(409)
    expect((await reqPut(port, path, CUSTOM, AUTH)).status).toBe(428)

    const invalid = await reqPut(port, '/api/instruction-templates/custom/backend/broken', 'not a block\n', { ...AUTH, 'If-Match': 'absent' })
    expect(invalid.status).toBe(400)
    expect(JSON.parse(invalid.body).code).toBe('invalid')
    expect(existsSync(join(library, 'custom', 'backend', 'broken.md'))).toBe(false)

    const created = await reqPut(port, path, CUSTOM, { ...AUTH, 'If-Match': 'absent' })
    expect(created.status).toBe(200)
    const digest = JSON.parse(created.body).digest as string
    expect(await readFile(join(library, 'custom', 'backend', 'mine.md'), 'utf8')).toBe(CUSTOM)

    const stale = await reqPut(port, path, `${CUSTOM}- 规则二\n`, { ...AUTH, 'If-Match': 'absent' })
    expect(stale.status).toBe(409)
    expect(JSON.parse(stale.body)).toMatchObject({ code: 'template-changed', digest })
    expect((await reqPut(port, path, `${CUSTOM}- 规则二\n`, { ...AUTH, 'If-Match': digest })).status).toBe(200)
  })

  it('复制内建模板：改写 id，重复复制 409', async () => {
    const { port, library } = await start()
    const body = { from: { source: 'builtin', category: 'backend', id: 'go' }, id: 'go-team' }
    expect((await reqPost(port, '/api/instruction-templates/copy', body, { headers: AUTH })).status).toBe(200)
    expect(await readFile(join(library, 'custom', 'backend', 'go-team.md'), 'utf8')).toMatch(/^---\nid: go-team\n/)
    const again = await reqPost(port, '/api/instruction-templates/copy', body, { headers: AUTH })
    expect(again.status).toBe(409)
    expect(again.json<{ code: string }>().code).toBe('template-exists')
    const listed = (await reqGet(port, '/api/instruction-templates')).json<Listed>()
    expect(listed.templates.some((row) => row.source === 'custom' && row.id === 'go-team')).toBe(true)
  })

  it('删除：摘要不符 409，符合则删除，内建 409', async () => {
    const { port, library } = await start()
    const created = await reqPut(port, '/api/instruction-templates/custom/backend/mine', CUSTOM, { ...AUTH, 'If-Match': 'absent' })
    const digest = JSON.parse(created.body).digest as string
    expect((await reqDelete(port, '/api/instruction-templates/custom/backend/mine?digest=sha256:0', { headers: AUTH })).status).toBe(409)
    expect((await reqDelete(port, '/api/instruction-templates/builtin/backend/go?digest=x', { headers: AUTH })).status).toBe(409)
    expect((await reqDelete(port, `/api/instruction-templates/custom/backend/mine?digest=${encodeURIComponent(digest)}`, { headers: AUTH })).status).toBe(200)
    expect(existsSync(join(library, 'custom', 'backend', 'mine.md'))).toBe(false)
    expect((await reqDelete(port, `/api/instruction-templates/custom/backend/mine?digest=${encodeURIComponent(digest)}`, { headers: AUTH })).status).toBe(404)
  })

  it('拼合：React + Java DDD + PostgreSQL + REST 返回合成文件；框架不匹配 400', async () => {
    const { port } = await start()
    const pick = (category: string, id: string) => ({ source: 'builtin', category, id, values: {} })
    const composed = await reqPost(port, '/api/instruction-templates/compose', {
      project_name: 'shop',
      selections: [
        pick('common', 'base'), pick('frontend', 'typescript-react'), pick('state', 'zustand'), pick('styling', 'tailwind'),
        pick('backend', 'java-spring-boot-ddd'), pick('api', 'rest-v1-unified-response'), pick('database', 'postgresql'),
      ],
    }, { headers: AUTH })
    expect(composed.status).toBe(200)
    const body = composed.json<{ markdown: string; directories: { path: string }[]; bytes: number }>()
    expect(body.markdown.startsWith('# shop\n')).toBe(true)
    for (const fragment of ['## 前端', '## 后端', '/api/v1', '| `sql/` |']) expect(body.markdown).toContain(fragment)
    expect(body.directories.map((entry) => entry.path)).toEqual(['frontend/', 'backend/', 'sql/'])
    expect(body.bytes).toBe(Buffer.byteLength(body.markdown))

    const mismatch = await reqPost(port, '/api/instruction-templates/compose', {
      project_name: 'shop', selections: [pick('frontend', 'typescript-react'), pick('state', 'pinia')],
    }, { headers: AUTH })
    expect(mismatch.status).toBe(400)
    expect(mismatch.json<{ errors: string[] }>().errors[0]).toContain('framework-mismatch')
  })
})
