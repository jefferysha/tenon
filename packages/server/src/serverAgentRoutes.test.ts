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

async function start(): Promise<{ port: number; paths: ServerPaths }> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-agent-routes-'))
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

const agentFile = (name: string, description = `${name} 说明`): string =>
  ['---', `name: ${name}`, `description: ${description}`, 'tools: [Read]', '---', '', '正文', ''].join('\n')

interface Summary { name: string; source: string; description: string; digest: string }

describe('agent 库路由', () => {
  it('GET /api/agents 同步内建 agent 并返回摘要', async () => {
    const { port, paths } = await start()
    const res = await reqGet(port, '/api/agents')
    expect(res.status).toBe(200)
    const body = parse(res.body)
    const agents = body.agents as Summary[]
    expect(agents.map((agent) => agent.name)).toContain('security')
    expect(agents.every((agent) => agent.digest.startsWith('sha256:'))).toBe(true)
    expect(agents.find((agent) => agent.name === 'builder')?.source).toBe('builtin')
    expect(await readFile(join(paths.configRoot, 'agents', 'builtin', 'builder.md'), 'utf8')).toContain('name: builder')
  })

  it('GET /api/agents/:name 给出原文与引用位置，未知名 404、非法名 400', async () => {
    const { port } = await start()
    const res = await reqGet(port, '/api/agents/security')
    expect(res.status).toBe(200)
    const body = parse(res.body)
    expect(body.content).toContain('name: security')
    // default 的 frontend/backend verify 声明了 security 评审者。
    expect(body.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflow: 'default', track: 'backend', step: 'verify', role: 'reviewer' }),
    ]))
    expect((await reqGet(port, '/api/agents/ghost')).status).toBe(404)
    expect((await reqGet(port, '/api/agents/Bad')).status).toBe(400)
  })

  it('POST / PUT / DELETE 需要 token', async () => {
    const { port } = await start()
    expect((await reqPost(port, '/api/agents', { name: 'mine', content: agentFile('mine') })).status).toBe(401)
    expect((await reqPut(port, '/api/agents/mine', { content: agentFile('mine') })).status).toBe(401)
    expect((await reqDelete(port, '/api/agents/mine')).status).toBe(401)
  })

  it('新建、更新、复制自定义 agent；摘要不一致 409、内建只读 403', async () => {
    const { port } = await start()
    const created = await reqPost(port, '/api/agents', { name: 'mine', content: agentFile('mine') }, { headers: AUTH })
    expect(created.status, created.body).toBe(201)
    const digest = (parse(created.body).agent as Summary).digest
    expect((await reqPost(port, '/api/agents', { name: 'mine', content: agentFile('mine') }, { headers: AUTH })).status).toBe(409)

    const stale = await reqPut(port, '/api/agents/mine', { content: agentFile('mine', '新'), digest: 'sha256:0' }, AUTH)
    expect(stale.status).toBe(409)
    const updated = await reqPut(port, '/api/agents/mine', { content: agentFile('mine', '新'), digest }, AUTH)
    expect(updated.status, updated.body).toBe(200)
    expect((parse(updated.body).agent as Summary).description).toBe('新')

    const builtin = await reqPut(port, '/api/agents/security', { content: agentFile('security') }, AUTH)
    expect(builtin.status).toBe(403)
    expect((await reqDelete(port, '/api/agents/security', { headers: AUTH })).status).toBe(403)

    const copied = await reqPost(port, '/api/agents/security/copy', { name: 'my-security' }, { headers: AUTH })
    expect(copied.status, copied.body).toBe(201)
    expect((parse(copied.body).agent as Summary).source).toBe('custom')
    const listed = parse((await reqGet(port, '/api/agents')).body).agents as Summary[]
    expect(listed.map((agent) => agent.name)).toContain('my-security')
  })

  it('DELETE 拒绝被工作流引用的 agent 并给出引用位置', async () => {
    const { port, paths } = await start()
    expect((await reqPost(port, '/api/agents', { name: 'mine', content: agentFile('mine') }, { headers: AUTH })).status).toBe(201)
    const workflows = join(paths.configRoot, 'workflows', '.pipeline', 'workflows')
    await mkdir(workflows, { recursive: true })
    await writeFile(join(workflows, 'uses-mine.yaml'), `name: uses-mine
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      reviewers:
        - agent: mine
          required: true
          block_at: high
    guards: []
    transitions: []
`, 'utf8')
    const refused = await reqDelete(port, '/api/agents/mine', { headers: AUTH })
    expect(refused.status).toBe(409)
    const body = parse(refused.body)
    expect(body.error).toBe('agent 被工作流引用')
    expect(body.references).toEqual([
      { workflow: 'uses-mine', track: null, step: 'build', label: '实现', role: 'reviewer' },
    ])

    await rm(join(workflows, 'uses-mine.yaml'))
    expect((await reqDelete(port, '/api/agents/mine', { headers: AUTH })).status).toBe(200)
    const listed = parse((await reqGet(port, '/api/agents')).body).agents as Summary[]
    expect(listed.map((agent) => agent.name)).not.toContain('mine')
  })

  it('非法内容 400；name 与路径不一致 400', async () => {
    const { port } = await start()
    expect((await reqPost(port, '/api/agents', { name: 'mine', content: 'no frontmatter\n' }, { headers: AUTH })).status).toBe(400)
    expect((await reqPost(port, '/api/agents', { name: 'mine', content: agentFile('other') }, { headers: AUTH })).status).toBe(400)
    expect((await reqPost(port, '/api/agents', { name: 'mine' }, { headers: AUTH })).status).toBe(400)
  })
})
