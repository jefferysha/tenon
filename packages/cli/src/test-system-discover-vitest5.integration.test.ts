/**
 * 测试体系 v2 × vitest 5 工程的 discover 到运行（A1 的 vitest 5 版）：vitest 5 重写了 bench，`vitest bench` 不再认
 * `--outputJson`，基准结果改挂在 json reporter 的用例上。临时项目里真装 vitest 5（`npm install`，要联网或有 npm 缓存），
 * discover --write 生成的基准命令真的能跑、json reporter 的报告被解析成指标——不是拿手写样例证明。
 *
 * 要联网装包，所以真装的那条默认跳过；`TENON_VITEST5_BENCH=1` 才运行，并且这时 Node 不满足 vitest 5 的 engines
 * （^22.12 || ^24 || >=26）、装不上、装上的不是 5 都直接失败，不会悄悄跳过。安装只重试一次（间隔 5 s，仓库源偶发抖动不该让 CI 红），
 * 两次都失败照样失败；重试辅助 `retryOnce` 自己不联网，它的用例始终运行。
 * 手动：TENON_VITEST5_BENCH=1 npx vitest run packages/cli/src/test-system-discover-vitest5.integration.test.ts
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { VITEST5_BENCH_FILE, VITEST_FILES, commitAll, initGit, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const SLUG = 'a-at-x.io'
const enabled = process.env.TENON_VITEST5_BENCH === '1'
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number)
const nodeRunsVitest5 = nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 12)

const WORKFLOW = `name: discovered
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
          run: [unit, benchmark]
          scope: full
        transitions: []
`

const INSTALL_RETRY_DELAY_MS = 5_000

/**
 * 失败后隔一会儿重试一次，只重试一次：仓库源偶发的网络抖动不该让 CI 红，但两次都失败就是真失败——抛出的错误带两次的原因。
 * 只包住安装这一步；基准命令、解析等断言失败不重试。
 */
async function retryOnce<T>(attempt: () => Promise<T>, delayMs: number): Promise<T> {
  try {
    return await attempt()
  } catch (first) {
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, delayMs) })
    try {
      return await attempt()
    } catch (second) {
      const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 400)
      throw new Error(`两次尝试都失败：第一次：${reason(first)}；第二次：${reason(second)}`, { cause: second })
    }
  }
}

/** 在临时项目里真装 vitest 5；不继承 npm 自己的 npm_* 环境（从 `npm test` 里跑时它们会指向本仓）。 */
async function installVitest5(cwd: string): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_')))
  await retryOnce(
    () => promisify(execFile)('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], { cwd, env, timeout: 240_000 }),
    INSTALL_RETRY_DELAY_MS,
  )
}

describe.skipIf(!enabled)('测试体系 v2 · vitest 5 工程（TENON_VITEST5_BENCH=1，要联网装 vitest 5）', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')

  test('A1-vitest5：真装 vitest 5，discover 的基准命令真跑通，json reporter 的报告被解析成指标', async () => {
    expect(nodeRunsVitest5, `Node ${process.versions.node} 跑不了 vitest 5（engines ^22.12 || ^24 || >=26）`).toBe(true)
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, {
      ...VITEST_FILES,
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', devDependencies: { vitest: '^5.0.0' } }),
      'bench/sort.bench.ts': VITEST5_BENCH_FILE,
    })
    await installVitest5(harness.cwd)
    const installed = JSON.parse(await readFile(join(harness.cwd, 'node_modules', 'vitest', 'package.json'), 'utf8')) as { version: string }
    expect(Number(installed.version.split('.')[0]), `装上的 vitest ${installed.version} 不是 5`).toBeGreaterThanOrEqual(5)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'discovered.yaml'), WORKFLOW, 'utf8')
    expect(await tenon('init', 'demo', '--track', 'backend', '--workflow', 'discovered', '--preset', 'full'), err()).toBe(0)

    expect(await tenon('test', 'discover'), err()).toBe(0)
    expect(out()).toMatch(/unit\s+unit\/vitest/)
    expect(out()).toMatch(/bench\s+benchmark\/vitest-bench/)
    expect(await tenon('test', 'discover', '--write'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'validate'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'show', '--json')).toBe(0)
    const shown = JSON.parse(out()) as { suites: Array<{ id: string; command: string; benchmark?: { metrics: Array<{ name: string }> } }> }
    const bench = shown.suites.find((suite) => suite.id === 'bench')
    expect(bench?.command).toContain('--reporter=json')
    expect(bench?.command).not.toContain('--outputJson')
    expect(bench?.benchmark?.metrics.map((metric) => metric.name)).toEqual(['native_sort.mean_ms', 'reverse_sort.mean_ms'])

    expect(await tenon('test', 'plan', 'demo', '--seed'), err()).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toContain('baseline-missing')
    const dir = join(harness.cwd, '.tenon', 'users', SLUG, 'tests', 'demo')
    const [file] = await readdir(dir)
    const record = JSON.parse(await readFile(join(dir, file ?? ''), 'utf8')) as {
      suites: Array<{ suite: string; result: string; command: string; totals: { cases: number; pass: number }; metrics: Array<{ name: string; samples: number[] }> }>
    }
    const unit = record.suites.find((suite) => suite.suite === 'unit')
    const ran = record.suites.find((suite) => suite.suite === 'bench')
    expect(unit).toMatchObject({ result: 'pass', totals: { cases: 2, pass: 2 } })
    expect(ran?.result).toBe('pass')
    expect(ran?.command).toContain('--reporter=json')
    expect(ran?.metrics.map((metric) => metric.name)).toEqual(['native_sort.mean_ms', 'reverse_sort.mean_ms'])
    expect(ran?.metrics.every((metric) => metric.samples.length === 1 && (metric.samples[0] ?? 0) > 0)).toBe(true)
    // 两次安装各最多 240 s、中间隔 5 s，再加上运行与解析，留足余量。
  }, 600_000)
})

// 重试辅助本身不联网，始终运行（上面那组才受 TENON_VITEST5_BENCH 控制）。
describe('retryOnce：安装失败只重试一次，两次都失败照样失败', () => {
  test('第一次就成功：不重试，不等待', async () => {
    const calls: string[] = []
    const started = Date.now()
    await expect(retryOnce(async () => { calls.push('ok'); return 'done' }, 60_000)).resolves.toBe('done')
    expect(calls).toEqual(['ok'])
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('第一次失败、第二次成功：恰好重试一次并返回第二次的结果', async () => {
    const calls: string[] = []
    const result = await retryOnce(async () => { calls.push('try'); if (calls.length === 1) throw new Error('ECONNRESET'); return 'second' }, 1)
    expect(result).toBe('second')
    expect(calls).toHaveLength(2)
  })

  test('两次都失败：恰好尝试两次，抛出的错误带两次的原因，不吞掉', async () => {
    const calls: string[] = []
    const attempt = async (): Promise<string> => {
      calls.push(`boom-${calls.length + 1}`)
      throw new Error(calls.at(-1))
    }
    const error = await retryOnce(attempt, 1).then(() => undefined, (caught: unknown) => caught)
    expect(calls).toEqual(['boom-1', 'boom-2'])
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('boom-1')
    expect((error as Error).message).toContain('boom-2')
    expect((error as Error).cause).toMatchObject({ message: 'boom-2' })
  })

  test('重试前等待给定的间隔', async () => {
    let calls = 0
    const started = Date.now()
    await retryOnce(async () => { if (++calls === 1) throw new Error('flaky'); return 'ok' }, 80)
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
  })
})
