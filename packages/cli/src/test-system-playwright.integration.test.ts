/**
 * 测试体系 v2 × 真实 Playwright 工程（验收 A4）：Tenon 启动 dev server、等待就绪、跑 Playwright、失败截图与 trace
 * 进产物索引、运行结束后服务被回收；缺浏览器 project 判 browser-project-missing；服务起不来 / 端口被占判 service-not-ready。
 *
 * 需要本机装有 Chromium：没有时用例整体跳过；设置 TENON_E2E=1（CI）则缺浏览器直接失败，不允许悄悄跳过。
 * webkit 项目只在 TENON_E2E_WEBKIT=1 时加入（本机通常没装 webkit）；缺项目的判定用 config 里没有的 project 名验证。
 */
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { commitAll, initGit, linkNodeModules, playwrightFiles, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const SLUG = 'a-at-x.io'
const available = existsSync(chromium.executablePath())
const required = process.env.TENON_E2E === '1'
const webkit = process.env.TENON_E2E_WEBKIT === '1'
const projects = webkit ? ['chromium', 'webkit'] : ['chromium']

const WORKFLOW = `name: browsed
tracks:
  backend:
    steps:
      - id: verify
        label: 验证
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        test_policy:
          run: [playwright]
          scope: full
          browsers: [${projects.join(', ')}]
        transitions: []
`

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!available && !required)('测试体系 v2 · Playwright 工程', () => {
  let h: Harness | undefined
  let port = 0
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  test('本机有 Chromium（TENON_E2E=1 时必须有）', () => {
    expect(available, 'Playwright Chromium 未安装：npx playwright install chromium').toBe(true)
  })

  async function project(): Promise<Harness> {
    port = await freePort()
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, playwrightFiles({ port, projects }))
    await writeFiles(harness.cwd, { 'package.json': '{ "name": "web", "private": true }\n' })
    await linkNodeModules(harness.cwd)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'browsed.yaml'), WORKFLOW, 'utf8')
    const tenon = (...args: string[]): Promise<number> => harness.run(args, { env: USER })
    expect(await tenon('init', 'demo', '--track', 'backend', '--workflow', 'browsed', '--preset', 'full'), harness.err.join('\n')).toBe(0)
    expect(await tenon('test', 'discover', '--write'), harness.err.join('\n')).toBe(0)
    expect(await tenon('test', 'catalog', 'add', 'web-dev', '--service', '--start', 'node server.mjs', '--ready-url', `http://127.0.0.1:${port}/`, '--ready-timeout', '30'), harness.err.join('\n')).toBe(0)
    expect(await tenon('test', 'catalog', 'set', 'e2e', '--uses', 'web-dev'), harness.err.join('\n')).toBe(0)
    expect(await tenon('test', 'plan', 'demo', '--seed'), harness.err.join('\n')).toBe(0)
    return harness
  }
  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  type Run = {
    run_id: string
    services: Array<{ id: string; ready_ms: number | null; exit: string; log: string | null; leaked_pids: number[] }>
    suites: Array<{
      suite: string; result: string; projects: string[]; reasons: Array<{ code: string; detail?: string }>
      totals: { cases: number; pass: number; fail: number }
      cases: Array<{ file: string; name: string; project: string | null; status: string; artifacts: string[]; failure?: { message: string } }>
      artifacts: Array<{ path: string; media: string; bytes: number; entry?: true }>
    }>
  }
  async function latestRun(): Promise<Run> {
    const dir = join((h as Harness).cwd, '.tenon', 'users', SLUG, 'tests', 'demo')
    const records = await Promise.all((await readdir(dir)).map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as { finished_at: string }))
    return [...records].sort((left, right) => (left.finished_at < right.finished_at ? -1 : 1)).at(-1) as unknown as Run
  }

  test('A4：自动启动 dev server、等就绪、跑浏览器项目；结束后服务被回收，报告与产物可索引', async () => {
    await project()
    expect(await listening(port)).toBe(false)
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect(await listening(port)).toBe(false)
    const run = await latestRun()
    expect(run.services).toEqual([expect.objectContaining({ id: 'web-dev', exit: 'stopped', leaked_pids: [], log: 'services/web-dev.log' })])
    expect(run.services[0]?.ready_ms).toBeGreaterThanOrEqual(0)
    const suite = run.suites[0]
    expect(suite?.projects.sort()).toEqual([...projects].sort())
    // 记录只保留失败 / flaky / 已登记文件的用例；通过的用例进计数。
    expect(suite?.totals).toMatchObject({ cases: projects.length, pass: projects.length, fail: 0 })
    expect(suite?.artifacts.some((item) => item.entry === true && item.path.endsWith('playwright-report/index.html'))).toBe(true)
    const serviceLog = await readFile(join((h as Harness).cwd, '.tenon', 'users', SLUG, 'local', 'artifacts', 'demo', run.run_id, 'services', 'web-dev.log'), 'utf8')
    expect(serviceLog).toContain('server ready')
    expect((await tenon('test', 'status', 'demo', '--json'))).toBe(0)
  }, 240_000)

  test('A4：失败用例的截图与 trace 挂在用例上，按文件建索引，副本可打开', async () => {
    await project()
    await writeFile(join((h as Harness).cwd, 'e2e', 'home.spec.ts'), [
      "import { expect, test } from 'playwright/test'",
      "test('home page shows the title', async ({ page }) => {",
      "  await page.goto('/')",
      "  await expect(page.locator('#title')).toHaveText('Wrong Title', { timeout: 1500 })",
      '})', '',
    ].join('\n'), 'utf8')
    expect(await tenon('test', 'run', 'demo', '--stage')).toBe(2)
    expect(out()).toContain('e2e/home.spec.ts › home page shows the title')
    expect(await listening(port)).toBe(false)
    const run = await latestRun()
    const failed = run.suites[0]?.cases.find((item) => item.status === 'fail')
    expect(failed?.failure?.message).toContain('Wrong Title')
    const media = (failed?.artifacts ?? []).map((path) => run.suites[0]?.artifacts.find((item) => item.path === path)?.media)
    expect(media).toEqual(expect.arrayContaining(['image', 'trace']))
    const dir = join((h as Harness).cwd, '.tenon', 'users', SLUG, 'local', 'artifacts', 'demo', run.run_id)
    for (const path of failed?.artifacts ?? []) expect((await readFile(join(dir, ...path.split('/')))).length).toBeGreaterThan(0)
    const screenshot = (failed?.artifacts ?? []).find((path) => path.endsWith('.png'))
    expect(screenshot).toMatch(/^artifacts\/e2e\/test-results\//)
  }, 240_000)

  test('A4：目录要求的浏览器 project 在报告里缺失 → browser-project-missing', async () => {
    await project()
    expect(await tenon('test', 'catalog', 'set', 'e2e', '--browser', 'chromium', '--browser', 'firefox-nightly')).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--stage')).toBe(2)
    const suite = (await latestRun()).suites[0]
    expect(suite?.reasons.map((reason) => reason.code)).toContain('browser-project-missing')
    expect(suite?.reasons.find((reason) => reason.code === 'browser-project-missing')?.detail).toContain('firefox-nightly')
  }, 240_000)

  test('服务起不来 → service-not-ready，套件不运行，服务被回收', async () => {
    await project()
    expect(await tenon('test', 'catalog', 'set', 'web-dev', '--service', '--start', 'node -e "setInterval(() => {}, 1000)"', '--ready-timeout', '2')).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--stage')).toBe(2)
    const run = await latestRun()
    expect(run.services[0]).toMatchObject({ id: 'web-dev', exit: 'not-ready', leaked_pids: [] })
    expect(run.suites[0]?.reasons.map((reason) => reason.code)).toContain('service-not-ready')
    expect(run.suites[0]?.cases).toEqual([])
  }, 240_000)

  test('端口在启动前就被占用 → 拒绝复用，判 service-not-ready', async () => {
    await project()
    const blocker = createServer().listen(port, '127.0.0.1')
    await new Promise((resolveListen) => blocker.once('listening', resolveListen))
    try {
      // 占用者是裸 TCP：端口探测能连上，服务启动前就被判定为「别的进程占着」。
      expect(await tenon('test', 'catalog', 'set', 'web-dev', '--service', '--ready-port', String(port))).toBe(0)
      expect(await tenon('test', 'run', 'demo', '--stage')).toBe(2)
      const run = await latestRun()
      expect(run.suites[0]?.reasons.find((reason) => reason.code === 'service-not-ready')?.detail).toContain('已经在响应')
    } finally {
      await new Promise((resolveClose) => blocker.close(resolveClose))
    }
  }, 240_000)
})
