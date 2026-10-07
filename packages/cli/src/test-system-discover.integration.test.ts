/**
 * 测试体系 v2 × discover 到运行（验收 A1 的「识别 vitest / Playwright / 基准脚本并生成目录」）：
 * 临时项目里同时有 vitest 单测、`*.bench.ts`（vitest bench）与 Playwright 配置，discover --write 生成的目录
 * 校验通过，且它写出的命令真的能跑——单测与基准都用本仓安装的 vitest 真执行、报告被解析成用例 / 指标。
 * Playwright 套件只验证被识别（真跑在 test-system-playwright.integration.test.ts 里）。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { VITEST5_BENCH_FILE, VITEST_FILES, commitAll, initGit, linkNodeModules, playwrightFiles, repoVitestMajor, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const SLUG = 'a-at-x.io'

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

/** vitest <=4 的 bench 写法（模块级 bench）；vitest 5 用 VITEST5_BENCH_FILE，按本仓装的主版本选。 */
const BENCH_FILE = `import { bench, describe } from 'vitest'
describe('sorting', () => {
  bench('native sort', () => { [3, 1, 2].sort() }, { time: 30, iterations: 5, warmupTime: 0, warmupIterations: 0 })
  bench('reverse sort', () => { [3, 1, 2].sort().reverse() }, { time: 30, iterations: 5, warmupTime: 0, warmupIterations: 0 })
})
`

describe('测试体系 v2 · discover 生成的目录可直接运行', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')

  test('A1：识别 vitest / Playwright / 基准，写进目录后单测与基准真跑通；首次基准提示建立基线', async () => {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, { ...VITEST_FILES, ...playwrightFiles({ port: 5199, projects: ['chromium'] }), 'bench/sort.bench.ts': (await repoVitestMajor()) >= 5 ? VITEST5_BENCH_FILE : BENCH_FILE })
    await linkNodeModules(harness.cwd)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'discovered.yaml'), WORKFLOW, 'utf8')
    expect(await tenon('init', 'demo', '--track', 'backend', '--workflow', 'discovered', '--preset', 'full'), err()).toBe(0)

    expect(await tenon('test', 'discover'), err()).toBe(0)
    expect(out()).toMatch(/unit\s+unit\/vitest/)
    expect(out()).toMatch(/e2e\s+playwright\/playwright/)
    expect(out()).toMatch(/bench\s+benchmark\/vitest-bench/)
    expect(await tenon('test', 'discover', '--write'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'validate'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'show', '--json')).toBe(0)
    const shown = JSON.parse(out()) as { suites: Array<{ id: string; kind: string; benchmark?: { metrics: Array<{ name: string }> } }> }
    expect(shown.suites.map((suite) => [suite.id, suite.kind])).toEqual([['unit', 'unit'], ['bench', 'benchmark'], ['e2e', 'playwright']])
    expect(shown.suites.find((suite) => suite.id === 'bench')?.benchmark?.metrics.map((metric) => metric.name))
      .toEqual(['native_sort.mean_ms', 'reverse_sort.mean_ms'])

    expect(await tenon('test', 'plan', 'demo', '--seed'), err()).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toContain('baseline-missing')
    const dir = join(harness.cwd, '.tenon', 'users', SLUG, 'tests', 'demo')
    const [file] = await readdir(dir)
    const record = JSON.parse(await readFile(join(dir, file ?? ''), 'utf8')) as {
      suites: Array<{ suite: string; result: string; totals: { cases: number; pass: number }; metrics: Array<{ name: string; samples: number[] }> }>
    }
    const unit = record.suites.find((suite) => suite.suite === 'unit')
    const bench = record.suites.find((suite) => suite.suite === 'bench')
    expect(unit).toMatchObject({ result: 'pass', totals: { cases: 2, pass: 2 } })
    expect(bench?.result).toBe('pass')
    expect(bench?.metrics.map((metric) => metric.name)).toEqual(['native_sort.mean_ms', 'reverse_sort.mean_ms'])
    expect(bench?.metrics.every((metric) => metric.samples.length === 1 && (metric.samples[0] ?? 0) > 0)).toBe(true)
  }, 240_000)
})
