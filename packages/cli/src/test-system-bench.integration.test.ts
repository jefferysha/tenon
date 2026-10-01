/**
 * 测试体系 v2 × 基准套件（验收 A5）：预热 / 采样、噪声保护自动复跑、按机器画像存基线（进 git）、
 * 同画像退化超阈值被挡、换机器只提示不挡、首次提示建立基线。基准脚本是项目里的 node 脚本，报告是 Tenon 的最小格式。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { commitAll, initGit, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const SLUG = 'a-at-x.io'

const WORKFLOW = `name: benched
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
          run: [benchmark]
          scope: full
        transitions: []
`

/** 每次调用往 bench-calls.log 追加一行；BENCH_NOISY=first 时前三次采样（第 2~4 次调用，第 1 次是预热）给出离散度很大的样本。 */
const BENCH_SCRIPT = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
mkdirSync('test-results', { recursive: true })
const calls = existsSync('test-results/bench-calls.log') ? readFileSync('test-results/bench-calls.log', 'utf8').split('\\n').filter(Boolean).length : 0
appendFileSync('test-results/bench-calls.log', 'call\\n')
const p95 = Number(process.env.BENCH_P95 ?? 100)
const noisy = process.env.BENCH_NOISY === 'first' && calls >= 1 && calls <= 3
const samples = noisy ? [p95 - 40, p95 - 20, p95, p95 + 20, p95 + 40] : [p95, p95, p95, p95, p95]
writeFileSync('test-results/bench.json', JSON.stringify({ metrics: { p95_ms: samples, rps: [1000, 1000, 1000] } }))
`

describe('测试体系 v2 · 基准', () => {
  let h: Harness
  const tenon = (...args: string[]): Promise<number> => h.run(args, { env: USER })
  const out = (): string => h.out.join('\n')
  const err = (): string => h.err.join('\n')

  beforeEach(async () => {
    h = await freshHarness()
    await writeFiles(h.cwd, { 'package.json': '{ "name": "bench", "private": true }\n', 'bench/run.mjs': BENCH_SCRIPT })
    initGit(h.cwd)
    commitAll(h.cwd, 'base', '2026-01-01T00:00:00Z')
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'benched.yaml'), WORKFLOW, 'utf8')
    expect(await tenon('init', 'demo', '--track', 'backend', '--workflow', 'benched', '--preset', 'full'), err()).toBe(0)
    expect(await tenon(
      'test', 'catalog', 'add', 'bench', '--kind', 'benchmark', '--runner', 'custom', '--command', 'node bench/run.mjs',
      '--report-format', 'benchmark-json', '--report-path', 'test-results/bench.json', '--artifact', 'test-results',
      '--runs', '3', '--warmup', '1',
      '--metric', 'name=p95_ms,better=lower,max_regression_pct=10,unit=ms',
      '--metric', 'name=rps,better=higher,max_regression_pct=5,unit=req/s',
    ), err()).toBe(0)
    await writeFile(join(h.cwd, '.tenon', 'tests', 'catalog.yaml'), `profiles_env:\n  - BENCH_MACHINE\n${await readFile(join(h.cwd, '.tenon', 'tests', 'catalog.yaml'), 'utf8')}`, 'utf8')
    expect(await tenon('test', 'catalog', 'validate'), err()).toBe(0)
    expect(await tenon('test', 'plan', 'demo', '--seed'), err()).toBe(0)
    process.env.BENCH_MACHINE = 'laptop'
  })
  afterEach(async () => {
    for (const key of ['BENCH_P95', 'BENCH_NOISY', 'BENCH_MACHINE']) delete process.env[key]
    await rm(h.cwd, { recursive: true, force: true })
  })

  async function latestRun(): Promise<{ run_id: string; machine_profile: string; suites: Array<{ result: string; reasons: Array<{ code: string }>; metrics: Array<{ name: string; median: number; samples: number[] }> }> }> {
    const dir = join(h.cwd, '.tenon', 'users', SLUG, 'tests', 'demo')
    const records = await Promise.all((await readdir(dir)).map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as { finished_at: string; run_id: string; machine_profile: string; suites: never[] }))
    return [...records].sort((left, right) => (left.finished_at < right.finished_at ? -1 : 1)).at(-1) as never
  }
  async function verdicts(): Promise<Array<{ code: string; blocking: boolean; fix?: string }>> {
    expect([0, 2]).toContain(await tenon('test', 'status', 'demo', '--json'))
    return (JSON.parse(out()) as { policy: { blockers: Array<{ code: string; blocking: boolean; fix?: string }> } }).policy.blockers
  }

  test('首次运行提示建立基线（不挡）；登记基线后同画像退化超阈值被挡，未超的放行', async () => {
    process.env.BENCH_P95 = '100'
    expect(await tenon('test', 'run', 'demo', '--suite', 'bench'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toContain('p95_ms 中位数 100ms（15 个样本）')
    let first = await latestRun()
    expect(first.suites[0]?.reasons.map((reason) => reason.code)).toContain('baseline-missing')
    expect(first.suites[0]?.metrics.map((metric) => metric.name)).toEqual(['p95_ms', 'rps'])
    const blockers = await verdicts()
    expect(blockers.find((item) => item.code === 'baseline-missing')).toMatchObject({ blocking: false, fix: `tenon test baseline demo --suite bench --run ${first.run_id}` })

    expect(await tenon('test', 'baseline', 'demo', '--suite', 'bench', '--run', first.run_id), err()).toBe(0)
    const baselineDir = join(h.cwd, '.tenon', 'tests', 'baselines', 'bench')
    const [file] = await readdir(baselineDir)
    expect(file).toBe(`${first.machine_profile}.json`)
    expect(JSON.parse(await readFile(join(baselineDir, file ?? ''), 'utf8'))).toMatchObject({ suite: 'bench', metrics: { p95_ms: { median: 100, better: 'lower' } } })
    expect(await readFile(join(h.cwd, '.tenon', 'users', SLUG, 'audit.jsonl'), 'utf8')).toContain('"action":"test-baseline"')

    process.env.BENCH_P95 = '130'
    expect(await tenon('test', 'run', 'demo', '--suite', 'bench')).toBe(2)
    first = await latestRun()
    expect(first.suites[0]?.reasons.map((reason) => reason.code)).toContain('benchmark-regression')
    expect(out()).toContain('退化 30.00%')
    expect((await verdicts()).some((item) => item.code === 'benchmark-regression' && item.blocking)).toBe(true)

    process.env.BENCH_P95 = '105'
    expect(await tenon('test', 'run', 'demo', '--suite', 'bench'), `${out()}\n${err()}`).toBe(0)
    expect((await verdicts()).filter((item) => item.blocking)).toEqual([])
  }, 120_000)

  test('换机器画像：不同画像互不比较，只提示没有基线，不挡', async () => {
    process.env.BENCH_P95 = '100'
    await tenon('test', 'run', 'demo', '--suite', 'bench')
    const base = await latestRun()
    expect(await tenon('test', 'baseline', 'demo', '--suite', 'bench', '--run', base.run_id)).toBe(0)

    process.env.BENCH_MACHINE = 'ci-runner'
    process.env.BENCH_P95 = '300'
    expect(await tenon('test', 'run', 'demo', '--suite', 'bench'), `${out()}\n${err()}`).toBe(0)
    const other = await latestRun()
    expect(other.machine_profile).not.toBe(base.machine_profile)
    expect(other.suites[0]?.reasons.map((reason) => reason.code)).toContain('baseline-missing')
    expect(other.suites[0]?.result).toBe('pass')
    expect((await verdicts()).filter((item) => item.blocking)).toEqual([])
  }, 120_000)

  test('目录 profile: coarse：记录与基线用粗口径画像（OS-架构-核数-Node 主版本），同画像的下一次运行拿这份基线判退化', async () => {
    const catalogPath = join(h.cwd, '.tenon', 'tests', 'catalog.yaml')
    await writeFile(catalogPath, `profile: coarse\n${await readFile(catalogPath, 'utf8')}`, 'utf8')
    expect(await tenon('test', 'catalog', 'validate'), err()).toBe(0)

    process.env.BENCH_P95 = '100'
    expect(await tenon('test', 'run', 'demo', '--suite', 'bench'), `${out()}\n${err()}`).toBe(0)
    const first = await latestRun()
    expect(first.machine_profile).toMatch(/^[a-z0-9]+-[a-z0-9]+-\d+c-node\d+-[a-f0-9]{8}$/)
    expect(first.suites[0]?.reasons.map((reason) => reason.code)).toContain('baseline-missing')

    expect(await tenon('test', 'baseline', 'demo', '--suite', 'bench', '--run', first.run_id), err()).toBe(0)
    expect(await readdir(join(h.cwd, '.tenon', 'tests', 'baselines', 'bench'))).toEqual([`${first.machine_profile}.json`])

    process.env.BENCH_P95 = '130'
    expect(await tenon('test', 'run', 'demo', '--suite', 'bench')).toBe(2)
    const second = await latestRun()
    expect(second.machine_profile).toBe(first.machine_profile)
    expect(second.suites[0]?.reasons.map((reason) => reason.code)).toContain('benchmark-regression')
    expect(second.suites[0]?.reasons.map((reason) => reason.code)).not.toContain('baseline-missing')
  }, 120_000)

  test('噪声保护：样本离散度大 → 自动多采一轮再判；基线更新把旧值压进历史', async () => {
    process.env.BENCH_P95 = '140'
    process.env.BENCH_NOISY = 'first'
    expect(await tenon('test', 'run', 'demo', '--suite', 'bench'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toContain('波动大，已自动多采一轮')
    const calls = (await readFile(join(h.cwd, 'test-results', 'bench-calls.log'), 'utf8')).trim().split('\n')
    // 预热 1 + 采样 3 + 噪声复跑 3。
    expect(calls).toHaveLength(7)
    const run = await latestRun()
    expect(run.suites[0]?.metrics.find((metric) => metric.name === 'p95_ms')?.samples).toHaveLength(30)

    expect(await tenon('test', 'baseline', 'demo', '--suite', 'bench', '--run', run.run_id)).toBe(0)
    process.env.BENCH_NOISY = ''
    process.env.BENCH_P95 = '120'
    await tenon('test', 'run', 'demo', '--suite', 'bench')
    const second = await latestRun()
    expect(await tenon('test', 'baseline', 'demo', '--suite', 'bench', '--run', second.run_id)).toBe(0)
    const path = join(h.cwd, '.tenon', 'tests', 'baselines', 'bench', `${run.machine_profile}.json`)
    const baseline = JSON.parse(await readFile(path, 'utf8')) as { metrics: { p95_ms: { median: number } }; history: Array<{ metrics: { p95_ms: { median: number } } }> }
    expect(baseline.metrics.p95_ms.median).toBe(120)
    expect(baseline.history.map((entry) => entry.metrics.p95_ms.median)).toEqual([140])
  }, 120_000)

  test('失败的运行不能当基线；链上没有的运行不能当基线', async () => {
    process.env.BENCH_P95 = '100'
    await tenon('test', 'run', 'demo', '--suite', 'bench')
    const good = await latestRun()
    expect(await tenon('test', 'baseline', 'demo', '--suite', 'bench', '--run', good.run_id)).toBe(0)
    process.env.BENCH_P95 = '500'
    expect(await tenon('test', 'run', 'demo', '--suite', 'bench')).toBe(2)
    const bad = await latestRun()
    expect(await tenon('test', 'baseline', 'demo', '--suite', 'bench', '--run', bad.run_id)).toBe(1)
    expect(err()).toContain('没有通过，不能作为基线')
    expect(await tenon('test', 'baseline', 'demo', '--suite', 'bench', '--run', '20990101T000000Z-abcdef')).toBe(1)
    expect(err()).toContain('记录链上找不到')
  }, 120_000)
})
