/**
 * 基准套件的识别：`*.bench.*` 文件（vitest bench）→ 建议套件，指标取自文件里 `bench('名字', …)` 的名字
 * （报告转换器把每个基准展开成 `<名字>.mean_ms`）。名字读不出来（动态拼的）时不硬猜指标，改给提示——
 * 基准套件必须声明指标与阈值，猜错了会在第一次运行时才暴露。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BenchmarkMetricSpec } from '@tenon/kernel'
import { metricName } from './parsers/benchmark.js'
import { idPrefix, makeSuite, readSmallText, type DiscoveredSuite, type ProjectDir } from './discover-support.js'

const BENCH_FILE = /\.(?:bench|benchmark)\.[cm]?[jt]sx?$/
const SKIP: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'test-results', 'playwright-report', '.tenon', 'openspec', '.pipeline', 'target', 'vendor', '.venv', '__pycache__'])
const MAX_DEPTH = 4
const MAX_FILES = 200
const MAX_METRICS = 24
const BENCH_CALL = /\bbench\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])+)\1/g

async function benchFiles(abs: string, rel: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isFile() && BENCH_FILE.test(entry.name)) out.push(path)
    else if (entry.isDirectory() && depth < MAX_DEPTH && !SKIP.has(entry.name) && !entry.name.startsWith('.')) await benchFiles(join(abs, entry.name), path, depth + 1, out)
  }
}

async function benchNames(dir: ProjectDir, files: readonly string[]): Promise<string[]> {
  const names: string[] = []
  for (const file of files) {
    const text = await readSmallText(join(dir.abs, file))
    if (text === undefined) continue
    for (const match of text.matchAll(BENCH_CALL)) {
      const name = match[2] ?? ''
      if (name !== '' && !name.includes('${')) names.push(name)
    }
  }
  return [...new Set(names)]
}

/** vitest 工程里的 bench 文件 → 一个基准套件建议；没有 bench 文件返回 undefined。 */
export async function discoverVitestBench(dir: ProjectDir, notes: string[]): Promise<DiscoveredSuite | undefined> {
  const files: string[] = []
  await benchFiles(dir.abs, '', 0, files)
  if (files.length === 0) return undefined
  const where = dir.rel === '.' ? '' : `${dir.rel}/`
  const names = await benchNames(dir, files)
  if (names.length === 0) {
    notes.push(`${where} 下有 bench 文件（${files.slice(0, 3).join('、')}）但读不出 bench('名字') 的名字：用 tenon test catalog add --kind benchmark --runner vitest-bench 手工登记并声明指标`)
    return undefined
  }
  const metrics: BenchmarkMetricSpec[] = [...new Set(names.map((name) => `${metricName(name)}.mean_ms`))].slice(0, MAX_METRICS)
    .map((name) => ({ name, unit: 'ms', better: 'lower' as const, max_regression_pct: 10 }))
  return {
    source: `${where}${files[0] ?? '*.bench.*'}`,
    suite: makeSuite({
      id: `${idPrefix(dir.rel)}bench`, label: '基准', kind: 'benchmark', runner: 'vitest-bench', cwd: dir.rel,
      command: 'npx vitest bench --run --outputJson=test-results/bench.json',
      files: ['**/*.{bench,benchmark}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'],
      report: { format: 'benchmark-json', path: 'test-results/bench.json' },
      artifacts: ['test-results'],
      benchmark: { runs: 1, warmup: 0, metrics },
    }),
  }
}
