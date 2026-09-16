import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveServerPaths } from './paths.js'
import { createDashboardServer } from './server.js'
import { reqDelete, reqGet } from './test-support.js'
import type { DashboardServer, ServerPaths } from './types.js'

const TOKEN = 'secret-token-abc'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const SLUG = 'a-at-x.io'
const CHANGE = 'my-change'
const RUN_ID = '20260915T101530Z-ab12cd'
const CANDIDATE = `workspace:sha256:${'a'.repeat(64)}`
const servers: DashboardServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function start(): Promise<{ port: number; root: string; paths: ServerPaths }> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-test-routes-home-'))
  const root = await mkdtemp(join(tmpdir(), 'tenon-test-routes-root-'))
  dirs.push(home, root)
  const paths = resolveServerPaths({ home, env: {} })
  const srv = createDashboardServer({
    version: '9.9.9', hostHome: home, paths, token: TOKEN, registry: () => [root],
    pollIntervalMs: 1000, cadence: false,
    manifestPath: fileURLToPath(new URL('../../../templates/manifest.yaml', import.meta.url)),
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, paths }
}

function putText(port: number, path: string, text: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'PUT',
      headers: { 'Content-Type': 'text/yaml', 'Content-Length': String(Buffer.byteLength(text)), ...headers },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.write(text)
    req.end()
  })
}

function testRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'tenon-test-run-v1', run_id: RUN_ID, change: CHANGE, workflow_run_id: 'run-1',
    workflow: 'default', workflow_fingerprint: 'b'.repeat(64), track: 'backend', step: 'build',
    step_visit: { run_id: 'run-1', transition_sequence: 1 }, test_id: 'unit',
    test_digest: `sha256:${'c'.repeat(64)}`, direction: 'unit', command: 'npm test', cwd: '.',
    timeout_s: 900, required: true, actor: { id: 'a@x.io', name: 'A', trust: 'declared' },
    host: { kind: 'terminal', sandbox: null }, candidate_before: CANDIDATE, candidate: CANDIDATE,
    git_head: null, build_sha: null, started_at: '2026-09-15T10:15:20Z', finished_at: '2026-09-15T10:15:30Z',
    duration_ms: 10_000, exit_code: 0, signal: null, result: 'pass', reasons: [], inputs: [],
    outputs: [{
      path: 'test-results/junit.xml', kind: 'report', required: true, present: true,
      digest: `sha256:${'e'.repeat(64)}`, bytes: 12, files: 1, artifact: 'outputs/test-results/junit.xml',
    }],
    metrics: [],
    log: { artifact: 'output.log', bytes_total: 4, bytes_kept: 4, truncated: false, digest: `sha256:${'f'.repeat(64)}` },
    ...overrides,
  }
}

async function seedRun(root: string, record = testRecord()): Promise<{ runsDir: string; runDir: string }> {
  const runId = String(record.run_id)
  const runsDir = join(root, '.tenon', 'users', SLUG, 'tests', CHANGE)
  const runDir = join(root, '.tenon', 'users', SLUG, 'local', 'artifacts', CHANGE, runId)
  await mkdir(runsDir, { recursive: true })
  await mkdir(join(runDir, 'outputs', 'test-results'), { recursive: true })
  await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(record), 'utf8')
  await writeFile(join(runDir, 'output.log'), 'logs', 'utf8')
  await writeFile(join(runDir, 'outputs', 'test-results', 'junit.xml'), '<testsuite/>', 'utf8')
  return { runsDir, runDir }
}

describe('GET /api/tests/runs|run', () => {
  it('列出全部用户的运行；参数非法 400，未登记 root 404', async () => {
    const h = await start()
    await seedRun(h.root)
    const listed = await reqGet(h.port, `/api/tests/runs?root=${encodeURIComponent(h.root)}&change=${CHANGE}&test=unit`)
    expect(listed.status).toBe(200)
    const body = JSON.parse(listed.body) as { runs: { user: string; runId: string; artifacts: boolean }[] }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]).toMatchObject({ user: SLUG, runId: RUN_ID, artifacts: true })

    expect((await reqGet(h.port, `/api/tests/runs?root=${encodeURIComponent(h.root)}&change=${CHANGE}&test=bad%20id`)).status).toBe(400)
    expect((await reqGet(h.port, `/api/tests/runs?change=${CHANGE}&test=unit`)).status).toBe(400)
    expect((await reqGet(h.port, `/api/tests/runs?root=${encodeURIComponent(join(h.root, 'nope'))}&change=${CHANGE}&test=unit`)).status).toBe(404)
  })

  it('回记录与本机产物清单；缺失 404、损坏 422', async () => {
    const h = await start()
    const { runsDir } = await seedRun(h.root)
    const query = `root=${encodeURIComponent(h.root)}&change=${CHANGE}&user=${SLUG}`
    const found = await reqGet(h.port, `/api/tests/run?${query}&run=${RUN_ID}`)
    expect(found.status).toBe(200)
    const body = JSON.parse(found.body) as {
      record: { test_id: string }
      artifacts: { log: boolean; files: string[] }
    }
    expect(body.record.test_id).toBe('unit')
    expect(body.artifacts).toEqual({ log: true, files: ['outputs/test-results/junit.xml'] })

    expect((await reqGet(h.port, `/api/tests/run?${query}&run=20260915T101530Z-ffffff`)).status).toBe(404)
    await writeFile(join(runsDir, `${RUN_ID}.json`), '{ broken', 'utf8')
    expect((await reqGet(h.port, `/api/tests/run?${query}&run=${RUN_ID}`)).status).toBe(422)
  })
})

describe('GET /api/tests/artifact', () => {
  it('原始字节 + 安全响应头 + tail；类型白名单；逃逸与符号链接被拒', async () => {
    const h = await start()
    const { runDir } = await seedRun(h.root)
    const query = `root=${encodeURIComponent(h.root)}&change=${CHANGE}&user=${SLUG}&run=${RUN_ID}`
    const log = await reqGet(h.port, `/api/tests/artifact?${query}&path=output.log`)
    expect(log.status).toBe(200)
    expect(log.body).toBe('logs')
    expect(log.headers['x-content-type-options']).toBe('nosniff')
    expect(log.headers['content-security-policy']).toBe('sandbox')
    expect(String(log.headers['content-type'])).toContain('text/plain')

    expect((await reqGet(h.port, `/api/tests/artifact?${query}&path=output.log&tail=2`)).body).toBe('gs')

    await writeFile(join(runDir, 'trace.zip'), 'PK', 'utf8')
    const zip = await reqGet(h.port, `/api/tests/artifact?${query}&path=trace.zip`)
    expect(zip.headers['content-type']).toBe('application/zip')
    expect(zip.headers['content-disposition']).toBe('attachment')

    await writeFile(join(runDir, 'shot.png'), 'png', 'utf8')
    expect((await reqGet(h.port, `/api/tests/artifact?${query}&path=shot.png`)).headers['content-type']).toBe('image/png')

    expect((await reqGet(h.port, `/api/tests/artifact?${query}&path=../../escape`)).status).toBe(400)
    expect((await reqGet(h.port, `/api/tests/artifact?${query}&path=output.log&tail=0`)).status).toBe(400)
    expect((await reqGet(h.port, `/api/tests/artifact?${query}&path=missing.log`)).status).toBe(404)
    await symlink(join(h.root, '.tenon'), join(runDir, 'link'))
    expect((await reqGet(h.port, `/api/tests/artifact?${query}&path=link`)).status).toBe(403)
  })
})

describe('测试方向库路由', () => {
  it('GET 内建在前；PUT/DELETE 只写 custom；内建 409，无 token 401，非法 YAML 400', async () => {
    const h = await start()
    const builtin = join(h.paths.configRoot, 'test-directions', 'builtin')
    await mkdir(builtin, { recursive: true })
    await writeFile(join(builtin, 'unit.yaml'), 'id: unit\ncommand: npm test\nlabel: 单测\n', 'utf8')

    const listed = JSON.parse((await reqGet(h.port, '/api/test-directions')).body) as {
      directions: { id: string; source: string; label: string }[]
    }
    expect(listed.directions).toHaveLength(1)
    expect(listed.directions[0]).toMatchObject({ id: 'unit', source: 'builtin', label: '单测' })

    const mine = 'id: mine\ncommand: npm run mine\nlabel: 我的\n'
    expect((await putText(h.port, '/api/test-directions/mine', mine)).status).toBe(401)
    expect((await putText(h.port, '/api/test-directions/mine', mine, AUTH)).status).toBe(200)
    const afterPut = JSON.parse((await reqGet(h.port, '/api/test-directions')).body) as {
      directions: { id: string; source: string }[]
    }
    expect(afterPut.directions.map((entry) => [entry.id, entry.source]))
      .toEqual([['unit', 'builtin'], ['mine', 'custom']])

    expect((await putText(h.port, '/api/test-directions/unit', mine, AUTH)).status).toBe(409)
    expect((await putText(h.port, '/api/test-directions/mine', 'id: other\ncommand: x\nlabel: y\n', AUTH)).status).toBe(400)
    expect((await putText(h.port, '/api/test-directions/mine', 'nonsense\n', AUTH)).status).toBe(400)

    expect((await reqDelete(h.port, '/api/test-directions/unit', { headers: AUTH })).status).toBe(409)
    expect((await reqDelete(h.port, '/api/test-directions/mine')).status).toBe(401)
    expect((await reqDelete(h.port, '/api/test-directions/mine', { headers: AUTH })).status).toBe(200)
    expect((await reqDelete(h.port, '/api/test-directions/mine', { headers: AUTH })).status).toBe(404)
  })
})
