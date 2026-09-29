import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendTestRunRecordV2, baselineV2Path, nextBaselineV2, serializeKnownFailures, testRunArtifactsDir,
  testRunRecordsDir, testSystemPaths, writeTestBaselineV2, writeTestPlan, emptyTestPlan,
} from '@tenon/kernel'
import {
  DESIGN_CATALOG, fixtureCase, fixtureRecordDraft, fixtureSuiteRun,
} from '@tenon/kernel/test-system/test-support'
import { resolveServerPaths } from './paths.js'
import { createDashboardServer } from './server.js'
import { reqGet } from './test-support.js'
import type { DashboardServer } from './types.js'

const TOKEN = 'secret-token-abc'
const SLUG = 'tester-at-tenon.test'
const CHANGE = 'demo'
const ACTOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const }
const servers: DashboardServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function start(): Promise<{ port: number; root: string }> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-test-system-home-'))
  const root = await mkdtemp(join(tmpdir(), 'tenon-test-system-root-'))
  dirs.push(home, root)
  const srv = createDashboardServer({
    version: '9.9.9', hostHome: home, paths: resolveServerPaths({ home, env: {} }), token: TOKEN,
    registry: () => [root], pollIntervalMs: 1000, cadence: false,
    manifestPath: fileURLToPath(new URL('../../../templates/manifest.yaml', import.meta.url)),
  })
  servers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root }
}

function get<T = Record<string, unknown>>(port: number, root: string, route: string, extra = ''): Promise<{ status: number; body: T; raw: string }> {
  return reqGet(port, `${route}?root=${encodeURIComponent(root)}${extra}`).then((res) => ({
    status: res.status, raw: res.body, body: (res.body.startsWith('{') ? JSON.parse(res.body) : {}) as T,
  }))
}

async function writeCatalog(root: string, text = DESIGN_CATALOG): Promise<void> {
  const path = testSystemPaths(root).catalog
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

describe('GET /api/tests/catalog', () => {
  it('没有目录：三项都是显式的 missing，最近结果为空', async () => {
    const h = await start()
    const res = await get(h.port, h.root, '/api/tests/catalog')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, catalog: { state: 'missing' }, knownFailures: { state: 'missing' }, latest: [] })
  })

  it('目录无效：逐条问题带行号，不冒充 missing', async () => {
    const h = await start()
    await writeCatalog(h.root, 'schema: tenon-test-catalog/v1\nsuites:\n  - id: Bad Id\n    kind: unit\n')
    const res = await get<{ catalog: { state: string; issues: string[] } }>(h.port, h.root, '/api/tests/catalog')
    expect(res.body.catalog.state).toBe('invalid')
    expect(res.body.catalog.issues.length).toBeGreaterThan(0)
    expect(res.body.catalog.issues[0]).toMatch(/^catalog\.yaml:\d+:/u)
  })

  it('目录有效：套件字段、服务、基准指标；已知失败带过期标记；最近结果取每个套件最新的一次', async () => {
    const h = await start()
    await writeCatalog(h.root)
    const known = serializeKnownFailures([
      { suite: 'web-unit', test: 'src/a.test.ts › old', reason: '上游 bug', expires: '2000-01-01', added_by: 'a@x.io' },
      { suite: 'web-e2e', test: 'e2e/login.spec.ts › slow', reason: '环境', link: 'https://example.test/1', expires: '2999-12-31', added_by: 'a@x.io' },
    ])
    await mkdir(join(testSystemPaths(h.root).knownFailures, '..'), { recursive: true })
    await writeFile(testSystemPaths(h.root).knownFailures, known, 'utf8')
    await appendTestRunRecordV2(h.root, SLUG, fixtureRecordDraft({
      change: CHANGE, finished_at: '2026-09-29T10:00:00.000Z',
      suites: [fixtureSuiteRun({ suite: 'web-unit', result: 'fail', cases: [fixtureCase({ file: 'src/a.test.ts', name: 'x', status: 'fail' })] })],
    }))
    await appendTestRunRecordV2(h.root, SLUG, fixtureRecordDraft({
      change: CHANGE, finished_at: '2026-09-29T11:00:00.000Z',
      suites: [
        fixtureSuiteRun({ suite: 'web-unit' }),
        fixtureSuiteRun({ suite: 'web-e2e', kind: 'playwright', runner: 'playwright', cases: [fixtureCase({ file: 'e2e/a.spec.ts', name: 'flaky one', status: 'flaky' })] }),
      ],
    }))

    const res = await get<{
      catalog: { state: 'ok'; suites: Array<Record<string, unknown>>; services: Array<Record<string, unknown>> }
      knownFailures: { state: 'ok'; entries: Array<Record<string, unknown>> }
      latest: Array<{ suite: string; result: string; totals: { flaky: number }; change: string }>
    }>(h.port, h.root, '/api/tests/catalog')
    expect(res.body.catalog.suites.map((suite) => suite.id)).toEqual(['web-unit', 'web-e2e', 'api-bench', 'types'])
    const bench = res.body.catalog.suites.find((suite) => suite.id === 'api-bench')
    expect(bench).toMatchObject({
      kind: 'benchmark', runner: 'custom', report: { format: 'benchmark-json' },
      benchmark: { runs: 5, metrics: [{ name: 'p95_ms', better: 'lower', maxRegressionPct: 10, max: 250 }, { name: 'rps' }] },
    })
    expect(res.body.catalog.suites.find((suite) => suite.id === 'web-unit')).toMatchObject({
      label: '前端单测', services: ['web-dev'], coverage: { format: 'istanbul-summary' }, timeoutS: 900,
    })
    expect(res.body.catalog.services).toEqual([{ id: 'web-dev', start: 'npm run dev -- --port 5178', cwd: 'packages/dashboard-app', ready: { kind: 'url', value: 'http://127.0.0.1:5178/', timeoutS: 60 }, stop: 'SIGTERM' }])
    expect(res.body.knownFailures.entries).toEqual([
      { suite: 'web-e2e', test: 'e2e/login.spec.ts › slow', reason: '环境', link: 'https://example.test/1', expires: '2999-12-31', addedBy: 'a@x.io', expired: false },
      { suite: 'web-unit', test: 'src/a.test.ts › old', reason: '上游 bug', expires: '2000-01-01', addedBy: 'a@x.io', expired: true },
    ])
    expect(res.body.latest.map((item) => [item.suite, item.result, item.totals.flaky, item.change]))
      .toEqual([['web-e2e', 'pass', 1, CHANGE], ['web-unit', 'pass', 0, CHANGE]])
    // 响应不带绝对路径、环境变量值或摘要。
    expect(res.raw).not.toContain(h.root)
    expect(res.raw).not.toContain('sha256:')
  })

  it('已知失败清单损坏：invalid 带问题，不当成空清单', async () => {
    const h = await start()
    await mkdir(testSystemPaths(h.root).root, { recursive: true })
    await writeFile(testSystemPaths(h.root).knownFailures, 'schema: nope\n', 'utf8')
    const res = await get<{ knownFailures: { state: string; issues: string[] } }>(h.port, h.root, '/api/tests/catalog')
    expect(res.body.knownFailures.state).toBe('invalid')
    expect(res.body.knownFailures.issues[0]).toContain('known-failures.yaml')
  })

  it('root 缺失 400、未登记 404', async () => {
    const h = await start()
    expect((await reqGet(h.port, '/api/tests/catalog')).status).toBe(400)
    const missing = await get(h.port, join(h.root, 'nope'), '/api/tests/catalog')
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ ok: false, code: 'root-unregistered' })
  })
})

describe('GET /api/tests/baselines', () => {
  const metric = { median: 12, p95: 15, mad: 1, samples: 5, better: 'lower' as const, unit: 'ms' }
  const entry = (median: number, at: string) => ({
    metrics: { p95_ms: { ...metric, median } }, source: { change: CHANGE, run_id: '20260929T100000Z-abcdef', commit: null }, actor: ACTOR, updated_at: at,
  })

  it('按机器画像列出基线与历史（新的在前）；坏文件进 corrupt', async () => {
    const h = await start()
    const profile = 'darwin-arm64-m3max-node22-1a2b3c4d'
    const first = nextBaselineV2(undefined, { suite: 'api-bench', profile, profile_label: 'darwin-arm64-m3max-node22', ...entry(12, '2026-09-01T00:00:00Z') })
    const second = nextBaselineV2(first, { suite: 'api-bench', profile, profile_label: 'darwin-arm64-m3max-node22', ...entry(11, '2026-09-10T00:00:00Z') })
    await writeTestBaselineV2(baselineV2Path(h.root, 'api-bench', profile), second)
    await writeFile(join(baselineV2Path(h.root, 'api-bench', profile), '..', 'linux-x64-ci-node22-deadbeef.json'), '{ broken', 'utf8')

    const res = await get<{
      baselines: Array<{ profile: string; profileLabel: string; metrics: Record<string, { median: number; unit?: string }>; history: Array<{ updatedAt: string }> }>
      corrupt: string[]
    }>(h.port, h.root, '/api/tests/baselines', '&suite=api-bench')
    expect(res.status).toBe(200)
    expect(res.body.baselines).toHaveLength(1)
    expect(res.body.baselines[0]).toMatchObject({ profile, profileLabel: 'darwin-arm64-m3max-node22' })
    expect(res.body.baselines[0]?.metrics.p95_ms).toMatchObject({ median: 11, unit: 'ms' })
    expect(res.body.baselines[0]?.history.map((item) => item.updatedAt)).toEqual(['2026-09-01T00:00:00Z'])
    expect(res.body.corrupt).toEqual(['linux-x64-ci-node22-deadbeef'])
  })

  it('没有基线是空列表；suite 非法 400', async () => {
    const h = await start()
    const empty = await get<{ baselines: unknown[]; corrupt: string[] }>(h.port, h.root, '/api/tests/baselines', '&suite=web-unit')
    expect(empty.body).toMatchObject({ ok: true, suite: 'web-unit', baselines: [], corrupt: [] })
    expect((await get(h.port, h.root, '/api/tests/baselines', '&suite=../x')).status).toBe(400)
    expect((await get(h.port, h.root, '/api/tests/baselines')).status).toBe(400)
  })
})

describe('GET /api/tests/plan', () => {
  it('缺失 → missing；CLI 写入 → ok 且套件带目录种类；手改文件 → tampered', async () => {
    const h = await start()
    await writeCatalog(h.root)
    const changeDir = join(h.root, 'openspec', 'changes', CHANGE)
    await mkdir(changeDir, { recursive: true })
    const missing = await get<{ plan: { state: string } }>(h.port, h.root, '/api/tests/plan', `&change=${CHANGE}`)
    expect(missing.body.plan).toEqual({ state: 'missing' })

    await writeTestPlan(changeDir, {
      ...emptyTestPlan(CHANGE),
      suites: [{ suite: 'web-unit', scope: 'changed' }],
      files: [{ path: 'src/a.test.ts', suite: 'web-unit', kind: 'unit' }],
      cases: [{ covers: 'task:1.1', tests: ['src/a.test.ts › works'] }],
      waivers: [{ kind: 'benchmark', reason: '纯文案', approved_by: null }],
    }, { actor: ACTOR, recordedAt: '2026-09-29T00:00:00Z' })
    const ok = await get<{ plan: { state: string; suites: unknown[]; files: unknown[]; cases: unknown[]; waivers: unknown[] } }>(h.port, h.root, '/api/tests/plan', `&change=${CHANGE}`)
    expect(ok.body.plan).toMatchObject({
      state: 'ok',
      suites: [{ suite: 'web-unit', kind: 'unit', scope: 'changed' }],
      files: [{ path: 'src/a.test.ts', suite: 'web-unit', kind: 'unit' }],
      cases: [{ covers: 'task:1.1', tests: ['src/a.test.ts › works'] }],
      waivers: [{ kind: 'benchmark', reason: '纯文案', approvedBy: null }],
    })

    const planFile = join(changeDir, 'test-plan.yaml')
    await writeFile(planFile, `${await readFile(planFile, 'utf8')}# hand edit\n`, 'utf8')
    const tampered = await get<{ plan: { state: string; reason: string } }>(h.port, h.root, '/api/tests/plan', `&change=${CHANGE}`)
    expect(tampered.body.plan.state).toBe('tampered')
    expect(tampered.body.plan.reason).not.toBe('')
  })

  it('change 参数非法 400', async () => {
    const h = await start()
    expect((await get(h.port, h.root, '/api/tests/plan', '&change=..%2Fx')).status).toBe(400)
    expect((await get(h.port, h.root, '/api/tests/plan')).status).toBe(400)
  })
})

describe('GET /api/tests/records 与 /api/tests/record', () => {
  async function seedTwo(root: string): Promise<{ first: string; second: string }> {
    const first = await appendTestRunRecordV2(root, SLUG, fixtureRecordDraft({
      change: CHANGE, step: 'build', finished_at: '2026-09-29T10:00:00.000Z',
      suites: [fixtureSuiteRun({ suite: 'web-unit' })],
    }))
    const second = await appendTestRunRecordV2(root, SLUG, fixtureRecordDraft({
      change: CHANGE, step: 'verify', result: 'fail', finished_at: '2026-09-29T11:00:00.000Z',
      suites: [
        fixtureSuiteRun({
          suite: 'web-e2e', kind: 'playwright', runner: 'playwright', result: 'fail', exit_code: 1,
          projects: ['chromium'],
          cases: [
            fixtureCase({ file: 'e2e/login.spec.ts', line: 12, name: '登录成功跳转首页', status: 'fail', project: 'chromium', failure: { message: 'expected /home', stack: 'at login.spec.ts:12', expected: '/home', actual: '/login' }, artifacts: ['shots/fail.png'] }),
          ],
          coverage: { lines: 81.5, branches: 70 },
          metrics: [{ name: 'p95_ms', unit: 'ms', better: 'lower', samples: [10, 12], median: 11, p95: 12, mad: 1 }],
          artifacts: [
            { path: 'shots/fail.png', bytes: 3, digest: `sha256:${'a'.repeat(64)}`, media: 'image' },
            { path: 'trace.zip', bytes: 2, digest: `sha256:${'b'.repeat(64)}`, media: 'trace' },
            { path: 'report/index.html', bytes: 6, digest: `sha256:${'c'.repeat(64)}`, media: 'html', entry: true },
            { path: 'gone.png', bytes: 1, digest: `sha256:${'d'.repeat(64)}`, media: 'image' },
          ],
          log: { artifact: 'suite.log', bytes_total: 4, bytes_kept: 4, truncated: false, digest: `sha256:${'e'.repeat(64)}` },
        }),
      ],
      services: [{ id: 'web-dev', ready_ms: 2310, exit: 'stopped', log: 'services/web-dev.log', leaked_pids: [] }],
    }))
    return { first: first.record.run_id, second: second.record.run_id }
  }

  it('列表新的在前、按套件过滤；链完好时 trusted 全为真', async () => {
    const h = await start()
    const ids = await seedTwo(h.root)
    const all = await get<{ users: Array<{ user: string; chain: string }>; runs: Array<{ runId: string; step: string; trusted: boolean; suites: Array<{ suite: string }> }> }>(
      h.port, h.root, '/api/tests/records', `&change=${CHANGE}`)
    expect(all.status).toBe(200)
    expect(all.body.users).toEqual([{ user: SLUG, chain: 'intact' }])
    expect(all.body.runs.map((run) => [run.runId, run.step, run.trusted])).toEqual([[ids.second, 'verify', true], [ids.first, 'build', true]])
    const filtered = await get<{ runs: Array<{ runId: string }> }>(h.port, h.root, '/api/tests/records', `&change=${CHANGE}&suite=web-e2e`)
    expect(filtered.body.runs.map((run) => run.runId)).toEqual([ids.second])
    expect((await get(h.port, h.root, '/api/tests/records', `&change=${CHANGE}&suite=Bad`)).status).toBe(400)
  })

  it('记录被改动 → 链断：users 标 broken，记录 trusted:false', async () => {
    const h = await start()
    const ids = await seedTwo(h.root)
    const file = join(testRunRecordsDir(h.root, SLUG, CHANGE), `${ids.first}.json`)
    await writeFile(file, (await readFile(file, 'utf8')).replace('"result": "pass"', '"result": "fail"'), 'utf8')
    const all = await get<{ users: Array<{ chain: string; reason?: string }>; runs: Array<{ trusted: boolean }> }>(
      h.port, h.root, '/api/tests/records', `&change=${CHANGE}`)
    expect(all.body.users[0]?.chain).toBe('broken')
    expect(all.body.users[0]?.reason).toBeTruthy()
    expect(all.body.runs.every((run) => !run.trusted)).toBe(true)
  })

  it('明细：用例失败详情、覆盖率、指标、服务、产物索引与本机是否仍在', async () => {
    const h = await start()
    const ids = await seedTwo(h.root)
    const runDir = testRunArtifactsDir(h.root, SLUG, CHANGE, ids.second)
    await mkdir(join(runDir, 'shots'), { recursive: true })
    await mkdir(join(runDir, 'report'), { recursive: true })
    await mkdir(join(runDir, 'services'), { recursive: true })
    await writeFile(join(runDir, 'shots', 'fail.png'), 'png', 'utf8')
    await writeFile(join(runDir, 'trace.zip'), 'PK', 'utf8')
    await writeFile(join(runDir, 'report', 'index.html'), '<html/>', 'utf8')
    await writeFile(join(runDir, 'suite.log'), 'logs', 'utf8')
    await writeFile(join(runDir, 'services', 'web-dev.log'), 'svc', 'utf8')

    const res = await get<{
      record: {
        runId: string; trusted: boolean; step: string; machineLabel: string; artifactsDir: string
        services: Array<{ id: string; readyMs: number; logPresent: boolean }>
        suites: Array<{
          suite: string; exitCode: number; coverage: { lines: number }; log: { present: boolean }
          cases: Array<{ file: string; line: number; failure: { message: string; expected: string; actual: string; stack: string } }>
          metrics: Array<{ name: string; median: number; samples: number }>
          artifacts: Array<{ path: string; present: boolean; media: string; entry: boolean }>
        }>
      }
    }>(h.port, h.root, '/api/tests/record', `&change=${CHANGE}&user=${SLUG}&run=${ids.second}`)
    expect(res.status).toBe(200)
    const record = res.body.record
    expect(record).toMatchObject({ runId: ids.second, trusted: true, step: 'verify' })
    expect(record.artifactsDir.endsWith(`/local/artifacts/${CHANGE}/${ids.second}`)).toBe(true)
    expect(record.artifactsDir.startsWith('/')).toBe(false)
    expect(record.services).toEqual([{ id: 'web-dev', readyMs: 2310, exit: 'stopped', log: 'services/web-dev.log', logPresent: true, leaked: 0 }])
    const suite = record.suites[0]
    expect(suite).toMatchObject({ suite: 'web-e2e', exitCode: 1, coverage: { lines: 81.5 }, log: { present: true } })
    expect(suite?.cases[0]).toMatchObject({ file: 'e2e/login.spec.ts', line: 12, failure: { message: 'expected /home', expected: '/home', actual: '/login', stack: 'at login.spec.ts:12' } })
    expect(suite?.metrics).toEqual([{ name: 'p95_ms', unit: 'ms', better: 'lower', median: 11, p95: 12, mad: 1, samples: 2 }])
    expect(suite?.artifacts.map((item) => [item.path, item.present, item.media, item.entry])).toEqual([
      ['shots/fail.png', true, 'image', false], ['trace.zip', true, 'trace', false],
      ['report/index.html', true, 'html', true], ['gone.png', false, 'image', false],
    ])
    expect(res.raw).not.toContain(h.root)
  })

  it('明细：不存在 404、坏记录 422、参数非法 400', async () => {
    const h = await start()
    const ids = await seedTwo(h.root)
    const base = `&change=${CHANGE}&user=${SLUG}`
    expect((await get(h.port, h.root, '/api/tests/record', `${base}&run=20260929T000000Z-ffffff`)).status).toBe(404)
    expect((await get(h.port, h.root, '/api/tests/record', `${base.replace(SLUG, 'someone-at-x.io')}&run=${ids.first}`)).status).toBe(404)
    expect((await get(h.port, h.root, '/api/tests/record', `${base}&run=nope`)).status).toBe(400)
    expect((await get(h.port, h.root, '/api/tests/record', `&change=${CHANGE}&user=..%2Fx&run=${ids.first}`)).status).toBe(400)
    await writeFile(join(testRunRecordsDir(h.root, SLUG, CHANGE), `${ids.first}.json`), '{ broken', 'utf8')
    const broken = await get(h.port, h.root, '/api/tests/record', `${base}&run=${ids.first}`)
    expect(broken.status).toBe(422)
    expect(broken.body).toMatchObject({ ok: false, code: 'record-unreadable' })
  })
})

describe('v2 产物下载（目录内逐文件）', () => {
  async function seedArtifacts(root: string): Promise<{ query: string; runDir: string }> {
    const result = await appendTestRunRecordV2(root, SLUG, fixtureRecordDraft({ change: CHANGE }))
    const runDir = testRunArtifactsDir(root, SLUG, CHANGE, result.record.run_id)
    await mkdir(join(runDir, 'test-results', 'shots'), { recursive: true })
    await mkdir(join(runDir, 'playwright-report'), { recursive: true })
    await writeFile(join(runDir, 'test-results', 'shots', 'a.png'), 'png', 'utf8')
    await writeFile(join(runDir, 'test-results', 'video.webm'), 'webm', 'utf8')
    await writeFile(join(runDir, 'test-results', 'trace.zip'), 'PK', 'utf8')
    await writeFile(join(runDir, 'playwright-report', 'index.html'), '<script>alert(1)</script>', 'utf8')
    return { query: `root=${encodeURIComponent(root)}&change=${CHANGE}&user=${SLUG}&run=${result.record.run_id}`, runDir }
  }

  it('截图内联、视频内联、trace 与 HTML 报告只作附件；一律带 nosniff 与 sandbox', async () => {
    const h = await start()
    const { query } = await seedArtifacts(h.root)
    const fetchPath = (path: string) => reqGet(h.port, `/api/tests/artifact?${query}&path=${encodeURIComponent(path)}`)
    const image = await fetchPath('test-results/shots/a.png')
    expect(image.status).toBe(200)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.headers['content-disposition']).toBeUndefined()
    const video = await fetchPath('test-results/video.webm')
    expect(video.headers['content-type']).toBe('video/webm')
    expect(video.headers['content-disposition']).toBeUndefined()
    const trace = await fetchPath('test-results/trace.zip')
    expect(trace.headers['content-disposition']).toBe('attachment')
    const report = await fetchPath('playwright-report/index.html')
    expect(report.status).toBe(200)
    expect(report.headers['content-disposition']).toBe('attachment')
    for (const res of [image, video, trace, report]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toBe('sandbox')
    }
  })

  it('逃逸、绝对路径、目录、符号链接（文件与目录）、别的用户与别的运行都被拒', async () => {
    const h = await start()
    const { query, runDir } = await seedArtifacts(h.root)
    const outside = join(h.root, 'outside.txt')
    await writeFile(outside, 'secret', 'utf8')
    await symlink(outside, join(runDir, 'test-results', 'link.txt'))
    await symlink(h.root, join(runDir, 'test-results', 'dir-link'))
    const status = async (path: string, swap?: [string, string]): Promise<number> =>
      (await reqGet(h.port, `/api/tests/artifact?${swap === undefined ? query : query.replace(swap[0], swap[1])}&path=${encodeURIComponent(path)}`)).status

    expect(await status('../../../outside.txt')).toBe(400)
    expect(await status('/etc/passwd')).toBe(400)
    expect(await status('test-results/../../x')).toBe(400)
    expect(await status('test-results\\a.png')).toBe(400)
    expect(await status('test-results')).toBe(403)
    expect(await status('test-results/link.txt')).toBe(403)
    expect(await status('test-results/dir-link/outside.txt')).toBe(403)
    expect(await status('test-results/none.png')).toBe(404)
    expect(await status('test-results/shots/a.png', [`user=${SLUG}`, 'user=someone-at-x.io'])).toBe(404)
    expect(await status('test-results/shots/a.png', [/run=[^&]+/u.exec(query)?.[0] ?? '', 'run=20260929T000000Z-ffffff'])).toBe(404)
    expect((await readdir(runDir)).length).toBeGreaterThan(0)
  })

  it('未登记的 root 一律 404，不碰文件系统', async () => {
    const h = await start()
    const { query } = await seedArtifacts(h.root)
    const foreign = query.replace(encodeURIComponent(h.root), encodeURIComponent(join(h.root, 'other')))
    expect((await reqGet(h.port, `/api/tests/artifact?${foreign}&path=test-results/shots/a.png`)).status).toBe(404)
  })
})

describe('测试体系读路由的信任锚', () => {
  it('伪造 Host（DNS 重绑定）一律 403，包括产物字节', async () => {
    const h = await start()
    const q = `root=${encodeURIComponent(h.root)}`
    const paths = [
      `/api/tests/catalog?${q}`,
      `/api/tests/baselines?${q}&suite=web-unit`,
      `/api/tests/plan?${q}&change=${CHANGE}`,
      `/api/tests/records?${q}&change=${CHANGE}`,
      `/api/tests/record?${q}&change=${CHANGE}&user=${SLUG}&run=20260929T100000Z-abcdef`,
      `/api/tests/artifact?${q}&change=${CHANGE}&user=${SLUG}&run=20260929T100000Z-abcdef&path=output.log`,
    ]
    for (const path of paths) {
      const res = await reqGet(h.port, path, '127.0.0.1', { Host: 'evil.example.com' })
      expect(res.status, `${path} 应被 Host 守卫拒绝`).toBe(403)
    }
  })

  it('未登记的 root 对每条路由都是 404', async () => {
    const h = await start()
    const foreign = encodeURIComponent(join(h.root, 'other'))
    for (const path of ['catalog', 'baselines&suite=web-unit', 'plan&change=demo', 'records&change=demo', 'record&change=demo']) {
      const [route, ...rest] = path.split('&')
      const res = await reqGet(h.port, `/api/tests/${route}?root=${foreign}${rest.map((part) => `&${part}`).join('')}`)
      expect(res.status, path).toBe(404)
    }
  })
})
