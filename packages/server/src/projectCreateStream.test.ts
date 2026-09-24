import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProjectRegistry, type TenonUserResolution } from '@tenon/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveServerPaths } from './paths.js'
import type { GitRunner } from './projectCreate.js'
import { createStepIds } from './projectCreateRun.js'
import { createDashboardServer } from './server.js'
import { reqPost } from './test-support.js'
import type { DashboardServer, ServerPaths } from './types.js'

const TOKEN = 'secret-token-stream'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const TEST_USER: TenonUserResolution = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared', slug: 'tester-at-tenon.test', source: 'env' }
const servers: DashboardServer[] = []
const dirs: string[] = []
const PATH = '/api/projects/create/stream'

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `tenon-create-stream-${label}-`))
  dirs.push(dir)
  return dir
}

/** runGit 走真 server 的注入口：测试里用它制造 git init 失败，再恢复成功。 */
async function start(runGit?: { current: GitRunner }): Promise<{ port: number; paths: ServerPaths }> {
  const home = await tempDir('home')
  const paths = resolveServerPaths({ home, env: {} })
  const srv = createDashboardServer({
    version: '9.9.9', hostHome: home, paths, token: TOKEN, registry: () => [], pollIntervalMs: 1000, cadence: false,
    manifestPath: fileURLToPath(new URL('../../../templates/manifest.yaml', import.meta.url)), resolveUser: () => TEST_USER,
    ...(runGit ? { projectCreateGit: (args: readonly string[], cwd: string) => runGit.current(args, cwd) } : {}),
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, paths }
}

interface Event { event: string; data: Record<string, unknown> }

function parse(body: string): Event[] {
  return body.split('\n\n').filter((block) => block.trim() !== '').map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1] ?? ''
    const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}'
    return { event, data: JSON.parse(data) as Record<string, unknown> }
  })
}

const instructions = (targets: string[]) => ({ text: '# shop\n', targets, base_digests: {} })

describe('POST /api/projects/create/stream', () => {
  it('写端点三闸：错误 Host 403、缺 token 401、非 JSON 400', async () => {
    const parent = await tempDir('parent')
    const { port } = await start()
    const body = { mode: 'empty', parent, name: 'shop', instructions: null }
    expect((await reqPost(port, PATH, body, { headers: { ...AUTH, Host: 'evil.example' } })).status).toBe(403)
    expect((await reqPost(port, PATH, body)).status).toBe(401)
    expect((await reqPost(port, PATH, body, { headers: { ...AUTH, 'Content-Type': 'text/plain' } })).status).toBe(400)
    expect(existsSync(join(parent, 'shop'))).toBe(false)
  })

  it('新建目录：plan → 每步 running/done → done；dry_run 被忽略', async () => {
    const parent = await tempDir('parent')
    const { port, paths } = await start()
    const result = await reqPost(port, PATH, {
      mode: 'empty', parent, name: 'shop', directories: ['sql/'], instructions: instructions(['CLAUDE.md', 'AGENTS.md']), dry_run: true,
    }, { headers: AUTH })
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toContain('text/event-stream')
    const events = parse(result.body)
    const steps = ['directory', 'git', 'skeleton', 'file:CLAUDE.md', 'file:AGENTS.md', 'register']
    expect(events[0]).toEqual({ event: 'plan', data: { steps } })
    expect(events.slice(1, -1).map((item) => `${String(item.data.id)}:${String(item.data.state)}`))
      .toEqual(steps.flatMap((id) => [`${id}:running`, `${id}:done`]))
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { ok: true, root: join(parent, 'shop'), git: 'init', registration: 'add' } })
    expect(await readFile(join(parent, 'shop', 'AGENTS.md'), 'utf8')).toContain('# shop')
    expect(readProjectRegistry(paths.registryPath)).toContain(join(parent, 'shop'))
  })

  it('步骤失败：带错误原文，后续步骤不开始，目录回滚；重试成功', async () => {
    const parent = await tempDir('parent')
    const git = { current: (async (args) => (args[0] === 'init' ? { code: 128, stderr: 'fatal: cannot init\n' } : { code: 0, stderr: '' })) as GitRunner }
    const { port } = await start(git)
    const body = { mode: 'empty', parent, name: 'shop', instructions: instructions(['CLAUDE.md']) }
    const failed = parse((await reqPost(port, PATH, body, { headers: AUTH })).body)
    expect(failed.find((item) => item.data.state === 'failed')).toEqual({ event: 'step', data: { id: 'git', state: 'failed', error: 'git init: fatal: cannot init' } })
    expect(failed.some((item) => item.data.id === 'file:CLAUDE.md')).toBe(false)
    expect(failed.at(-1)).toMatchObject({ event: 'failed', data: { ok: false, status: 500, code: 'project-create-failed', step: 'git-init' } })
    expect(existsSync(join(parent, 'shop'))).toBe(false)

    git.current = async () => ({ code: 0, stderr: '' })
    const retried = parse((await reqPost(port, PATH, body, { headers: AUTH })).body)
    expect(retried.at(-1)).toMatchObject({ event: 'done', data: { ok: true } })
  })

  it('执行前的失败仍是 JSON 错误与原状态码（目录已存在 409）', async () => {
    const parent = await tempDir('parent')
    await mkdir(join(parent, 'shop'))
    const { port } = await start()
    const result = await reqPost(port, PATH, { mode: 'empty', parent, name: 'shop', instructions: null }, { headers: AUTH })
    expect(result.status).toBe(409)
    expect(result.json<{ code: string }>().code).toBe('project-path-exists')
  })

  it('已有目录：逐个文件 + 登记；已登记的项目登记步骤直接完成', async () => {
    const root = await tempDir('existing')
    const { port } = await start()
    const body = { mode: 'existing', path: root, instructions: instructions(['GEMINI.md']) }
    const first = parse((await reqPost(port, PATH, body, { headers: AUTH })).body)
    expect(first[0]).toEqual({ event: 'plan', data: { steps: ['file:GEMINI.md', 'register'] } })
    expect(first.at(-1)).toMatchObject({ event: 'done', data: { registration: 'add' } })
    const again = parse((await reqPost(port, PATH, { ...body, instructions: null }, { headers: AUTH })).body)
    expect(again.at(-1)).toMatchObject({ event: 'done', data: { registration: 'already' } })
  })

  it('clients：作为「clients」步骤写入 .tenon/clients.json（去重排序）；未知 id 400；已有文件被覆盖', async () => {
    const parent = await tempDir('parent')
    const { port } = await start()
    const bad = await reqPost(port, PATH, { mode: 'empty', parent, name: 'shop', instructions: null, clients: ['claude', 'evil'] }, { headers: AUTH })
    expect([bad.status, bad.json<{ code: string }>().code]).toEqual([400, 'invalid'])
    const events = parse((await reqPost(port, PATH, {
      mode: 'empty', parent, name: 'shop', instructions: instructions(['AGENTS.md']), clients: ['codex', 'claude', 'codex'],
    }, { headers: AUTH })).body)
    expect(events[0]).toEqual({ event: 'plan', data: { steps: ['directory', 'git', 'file:AGENTS.md', 'clients', 'register'] } })
    expect(events.at(-1)).toMatchObject({ event: 'done' })
    const file = join(parent, 'shop', '.tenon', 'clients.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schema: 'tenon-clients/v1', enabled: ['claude', 'codex'] })

    const again = parse((await reqPost(port, PATH, { mode: 'existing', path: join(parent, 'shop'), instructions: null, clients: ['gemini'] }, { headers: AUTH })).body)
    expect(again[0]).toEqual({ event: 'plan', data: { steps: ['clients', 'register'] } })
    expect(again.at(-1)).toMatchObject({ event: 'done', data: { registration: 'already' } })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schema: 'tenon-clients/v1', enabled: ['gemini'] })
  })

  it('引用与追加：CLAUDE.md 只写 @AGENTS.md；追加保留原文且重试不重复；非法子集 400', async () => {
    const root = await tempDir('refs')
    await writeFile(join(root, 'AGENTS.md'), '# 我的规则\n')
    const { port } = await start()
    const request = {
      mode: 'existing', path: root,
      instructions: { text: '# shop\n', targets: ['AGENTS.md', 'CLAUDE.md'], references: ['CLAUDE.md'], append: ['AGENTS.md'], base_digests: {} },
    }
    const plan = await reqPost(port, '/api/projects/create', { ...request, dry_run: true }, { headers: AUTH })
    const planned = plan.json<{ files: { id: string; base_digest: string; next: string }[] }>().files
    expect(planned.map((file) => [file.id, file.next])).toEqual([['AGENTS.md', '# 我的规则\n\n# shop\n'], ['CLAUDE.md', '@AGENTS.md\n']])
    const digests = Object.fromEntries(planned.map((file) => [file.id, file.base_digest]))
    const body = { ...request, instructions: { ...request.instructions, base_digests: digests } }
    expect(parse((await reqPost(port, PATH, body, { headers: AUTH })).body).at(-1)).toMatchObject({ event: 'done' })
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# 我的规则\n\n# shop\n')
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')

    const replan = await reqPost(port, '/api/projects/create', { ...request, dry_run: true }, { headers: AUTH })
    const again = replan.json<{ files: { id: string; current: string; next: string }[] }>().files
    expect(again.every((file) => file.current === file.next)).toBe(true)

    const bad = { ...request, instructions: { ...request.instructions, references: ['AGENTS.md'] } }
    expect((await reqPost(port, PATH, bad, { headers: AUTH })).status).toBe(400)
  })

  it('已有目录不是 git 仓库：git_init=true 先 git init；缺省不动', async () => {
    const root = await tempDir('nogit')
    const { port } = await start()
    const plain = await reqPost(port, '/api/projects/create', { mode: 'existing', path: root, instructions: null, dry_run: true }, { headers: AUTH })
    expect(plain.json()).toMatchObject({ git: 'none' })
    const planned = await reqPost(port, '/api/projects/create', { mode: 'existing', path: root, instructions: null, git_init: true, dry_run: true }, { headers: AUTH })
    expect(planned.json()).toMatchObject({ git: 'init' })
    const events = parse((await reqPost(port, PATH, { mode: 'existing', path: root, instructions: null, git_init: true }, { headers: AUTH })).body)
    expect(events[0]).toEqual({ event: 'plan', data: { steps: ['git', 'register'] } })
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { git: 'init' } })
    expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true)
  })

  it('createStepIds：已有目录没有 directory / git / skeleton', () => {
    expect(createStepIds({ mode: 'existing', root: '/r', instructions: null, dryRun: false })).toEqual(['register'])
    expect(createStepIds({ mode: 'empty', root: '/p/r', parent: '/p', directories: [], instructions: null, dryRun: false }))
      .toEqual(['directory', 'git', 'register'])
  })
})
