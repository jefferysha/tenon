/**
 * 测试体系 v2 × vitest 5 工程的 discover 到运行（A1 的 vitest 5 版）：vitest 5 重写了 bench，`vitest bench` 不再认
 * `--outputJson`，基准结果改挂在 json reporter 的用例上。临时项目里真装 vitest 5（`npm install`，要联网或有 npm 缓存），
 * discover --write 生成的基准命令真的能跑、json reporter 的报告被解析成指标——不是拿手写样例证明。
 *
 * 要联网装包，所以默认整体跳过；`TENON_VITEST5_BENCH=1` 才运行，并且这时 Node 不满足 vitest 5 的 engines
 * （^22.12 || ^24 || >=26）、装不上、装上的不是 5 都直接失败，不会悄悄跳过。
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

/** 在临时项目里真装 vitest 5；不继承 npm 自己的 npm_* 环境（从 `npm test` 里跑时它们会指向本仓）。 */
async function installVitest5(cwd: string): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_')))
  await promisify(execFile)('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], { cwd, env, timeout: 240_000 })
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
  }, 420_000)
})
