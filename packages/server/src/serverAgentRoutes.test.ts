import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveServerPaths } from './paths.js'
import { createTestDashboardServer } from './test-server.js'
import { withSession } from './test-support.js'
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

async function start(roots: readonly string[] = []): Promise<{ port: number; paths: ServerPaths; home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-agent-routes-'))
  homes.push(home)
  const paths = resolveServerPaths({ home, env: {} })
  const srv = createTestDashboardServer({
    version: '9.9.9', hostHome: home, paths, token: TOKEN, registry: () => [...roots], pollIntervalMs: 1000, cadence: false,
    manifestPath: fileURLToPath(new URL('../../../templates/manifest.yaml', import.meta.url)),
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, paths, home }
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-agent-project-'))
  homes.push(root)
  return root
}

function reqPut(port: number, path: string, payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload)
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...withSession(port, headers) },
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
  ['---', `name: ${name}`, `description: ${description}`, 'role: reviewer', 'tools: [Read]', '---', '', '正文', ''].join('\n')

async function seedCustom(paths: ServerPaths, name: string, text = agentFile(name)): Promise<void> {
  await mkdir(join(paths.configRoot, 'agents', 'custom'), { recursive: true })
  await writeFile(join(paths.configRoot, 'agents', 'custom', `${name}.md`), text, 'utf8')
}

async function seedProject(root: string, name: string, text = agentFile(name)): Promise<void> {
  await mkdir(join(root, '.tenon', 'agents'), { recursive: true })
  await writeFile(join(root, '.tenon', 'agents', `${name}.md`), text, 'utf8')
}

interface Summary {
  name: string; source: string; role?: string; version?: string; description: string; digest: string; shadowed_by?: string
}

describe('agent 库路由', () => {
  it('GET /api/agents 同步官方 agent 并返回摘要（身份、版本、来源）', async () => {
    const { port, paths } = await start()
    const res = await reqGet(port, '/api/agents')
    expect(res.status).toBe(200)
    const agents = parse(res.body).agents as Summary[]
    expect(agents.map((agent) => agent.name)).toContain('security')
    expect(agents.every((agent) => agent.digest.startsWith('sha256:'))).toBe(true)
    expect(agents.find((agent) => agent.name === 'builder')).toMatchObject({ source: 'builtin', role: 'executor', version: '1.0.0' })
    expect(await readFile(join(paths.configRoot, 'agents', 'builtin', 'builder.md'), 'utf8')).toContain('name: builder')
  })

  it('GET /api/agents/:name 给出原文与引用位置，未知名 404、非法名 400', async () => {
    const { port } = await start()
    const res = await reqGet(port, '/api/agents/security')
    expect(res.status).toBe(200)
    const body = parse(res.body)
    expect(body.content).toContain('name: security')
    expect(body.runs).toEqual([])
    // default 的 frontend/backend verify 声明了 security 评审者。
    expect(body.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflow: 'default', track: 'backend', step: 'verify', role: 'reviewer' }),
    ]))
    expect((await reqGet(port, '/api/agents/ghost')).status).toBe(404)
    expect((await reqGet(port, '/api/agents/Bad')).status).toBe(400)
  })

  it('带 root：列出项目层（覆盖同名自定义）；未注册的 root 404', async () => {
    const root = await project()
    const { port, paths } = await start([root])
    await seedCustom(paths, 'team', agentFile('team', '用户级'))
    await seedProject(root, 'team', agentFile('team', '项目级'))
    const agents = parse((await reqGet(port, `/api/agents?root=${encodeURIComponent(root)}`)).body).agents as Summary[]
    expect(agents.filter((agent) => agent.name === 'team').map((agent) => `${agent.source}:${agent.shadowed_by ?? ''}`))
      .toEqual(['custom:project', 'project:'])
    const detail = parse((await reqGet(port, `/api/agents/team?root=${encodeURIComponent(root)}`)).body)
    expect(detail.source).toBe('project')
    expect(detail.content).toContain('项目级')
    expect((await reqGet(port, `/api/agents?root=${encodeURIComponent(join(root, 'elsewhere'))}`)).status).toBe(404)
    const global = parse((await reqGet(port, '/api/agents')).body).agents as Summary[]
    expect(global.filter((agent) => agent.name === 'team').map((agent) => agent.source)).toEqual(['custom'])
  })

  it('带 root 的详情给出该项目最近运行', async () => {
    const root = await project()
    const { port } = await start([root])
    const changeDir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(changeDir, { recursive: true })
    const row = (runId: string, startedAt: string, status: string) => JSON.stringify({
      schema: 'agent-run/v1', run_id: runId, agent: 'security', agent_digest: `sha256:${'0'.repeat(64)}`,
      role: 'reviewer', step: 'verify', step_visit: '["r",1]', candidate: `sha256:${'1'.repeat(64)}`, status,
      result: status === 'finished' ? 'pass' : null, findings: [], report_path: 'r.md', report_digest: null,
      actor: { id: 'a@x.io', name: 'A', trust: 'declared' }, started_at: startedAt, finished_at: null,
      subagent: { host: 'claude', type: 'tenon-security', native: true },
    })
    await writeFile(join(changeDir, '.pipeline-agent-runs.jsonl'), [
      row('a', '2026-09-20T01:00:00Z', 'running'), row('a', '2026-09-20T01:00:00Z', 'finished'), row('b', '2026-09-21T01:00:00Z', 'running'), '',
    ].join('\n'))
    const runs = parse((await reqGet(port, `/api/agents/security?root=${encodeURIComponent(root)}`)).body).runs as Record<string, unknown>[]
    expect(runs.map((run) => `${String(run.started_at)}:${String(run.status)}`)).toEqual(['2026-09-21T01:00:00Z:running', '2026-09-20T01:00:00Z:finished'])
    expect(runs[0]).toMatchObject({ change: 'demo', step: 'verify', subagent: { type: 'tenon-security', native: true } })
  })

  it('POST / PUT / DELETE 需要 token；POST 新建已移到终端', async () => {
    const { port } = await start()
    expect((await reqPut(port, '/api/agents/mine', { content: agentFile('mine') })).status).toBe(401)
    expect((await reqDelete(port, '/api/agents/mine')).status).toBe(401)
    const create = await reqPost(port, '/api/agents', { name: 'mine', content: agentFile('mine') }, { headers: AUTH })
    expect(create.status).toBe(404)
    expect(parse(create.body).error).toContain('tenon agent new')
  })

  it('更新、复制自定义 agent；摘要不一致 409、官方只读 403', async () => {
    const { port, paths } = await start()
    await seedCustom(paths, 'mine')
    const listed = parse((await reqGet(port, '/api/agents')).body).agents as Summary[]
    const digest = listed.find((agent) => agent.name === 'mine')?.digest ?? ''

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
    expect(await readFile(join(paths.configRoot, 'agents', 'custom', 'my-security.md'), 'utf8')).toContain('name: my-security')
  })

  it('PUT source=project 保存项目级正文（摘要校验）；缺 root 400', async () => {
    const root = await project()
    const { port } = await start([root])
    await seedProject(root, 'team')
    const listed = parse((await reqGet(port, `/api/agents?root=${encodeURIComponent(root)}`)).body).agents as Summary[]
    const digest = listed.find((agent) => agent.name === 'team')?.digest ?? ''
    const saved = await reqPut(port, '/api/agents/team', { content: agentFile('team', '改'), digest, source: 'project', root }, AUTH)
    expect(saved.status, saved.body).toBe(200)
    expect((parse(saved.body).agent as Summary).source).toBe('project')
    expect(await readFile(join(root, '.tenon', 'agents', 'team.md'), 'utf8')).toContain('description: 改')
    expect((await reqPut(port, '/api/agents/team', { content: agentFile('team'), source: 'project' }, AUTH)).status).toBe(400)
    expect((await reqPut(port, '/api/agents/team', { content: agentFile('team'), source: 'nope' }, AUTH)).status).toBe(400)
  })

  it('DELETE 拒绝被工作流引用的 agent 并给出引用位置', async () => {
    const { port, paths } = await start()
    await seedCustom(paths, 'mine')
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
    const { port, paths } = await start()
    await seedCustom(paths, 'mine')
    expect((await reqPut(port, '/api/agents/mine', { content: 'no frontmatter\n' }, AUTH)).status).toBe(400)
    expect((await reqPut(port, '/api/agents/mine', { content: agentFile('other') }, AUTH)).status).toBe(400)
    expect((await reqPut(port, '/api/agents/mine', { digest: 'x' }, AUTH)).status).toBe(400)
  })
})
