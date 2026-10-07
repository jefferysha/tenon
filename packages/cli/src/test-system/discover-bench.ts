/**
 * 基准套件的识别：`*.bench.*` 文件（vitest bench）→ 建议套件，指标取自文件里 `bench('名字', …)` 的名字
 * （报告转换器把每个基准展开成 `<名字>.mean_ms`）。名字读不出来（动态拼的）时不硬猜指标，改给提示——
 * 基准套件必须声明指标与阈值，猜错了会在第一次运行时才暴露。
 *
 * 命令按工程的 vitest 主版本选（vitest-version.ts）：vitest 5 重写了 bench，删掉 `--outputJson`，基准结果改挂在
 * json reporter 的用例上（解析见 parsers/benchmark.ts）。版本读不出来时不生成套件而给提示——同一条命令在两边必有一边直接
 * 退出 1，而 `discover --write` 会把它原样写进目录，宁可不建议，也不建议一条可能是错的命令。vitest ≥5 的工程里只要有 bench 文件还在用
 * vitest ≤4 的模块级 `bench()`，同样不生成套件：那份文件必然 "bench is not a function"，整个套件必然红。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BenchmarkMetricSpec } from '@tenon/kernel'
import { metricName } from './parsers/benchmark.js'
import { idPrefix, makeSuite, readSmallText, type DiscoveredSuite, type ProjectDir } from './discover-support.js'
import { detectVitestVersion } from './vitest-version.js'

const BENCH_FILE = /\.(?:bench|benchmark)\.[cm]?[jt]sx?$/
const SKIP: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'test-results', 'playwright-report', '.tenon', 'openspec', '.pipeline', 'target', 'vendor', '.venv', '__pycache__'])
const MAX_DEPTH = 4
const MAX_FILES = 200
const MAX_METRICS = 24
const REPORT_PATH = 'test-results/bench.json'
/** vitest ≤4：`--outputJson` 直接写基准结果。 */
const COMMAND_OUTPUT_JSON = `npx vitest bench --run --outputJson=${REPORT_PATH}`
/** vitest ≥5：没有 `--outputJson`，用 json reporter 写；同时保留 default reporter，终端里仍有基准表。 */
const COMMAND_JSON_REPORTER = `npx vitest bench --run --reporter=default --reporter=json --outputFile.json=${REPORT_PATH}`
/** 第一个删掉 `--outputJson` 的 vitest 主版本。 */
const FIRST_JSON_REPORTER_MAJOR = 5
const LEGACY_BENCH_IMPORT = /^[ \t]*(?:import\s+(?!type\b)\{[^}]*\bbench\b[^}]*\}\s*from|(?:const|let|var)\s*\{[^}]*\bbench\b[^}]*\}\s*=\s*require\()\s*['"]vitest['"]/m
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

interface BenchSource {
  readonly file: string
  readonly text: string
}

async function readBenchSources(dir: ProjectDir, files: readonly string[]): Promise<BenchSource[]> {
  const sources: BenchSource[] = []
  for (const file of files) {
    const text = await readSmallText(join(dir.abs, file))
    if (text !== undefined) sources.push({ file, text })
  }
  return sources
}

function benchNames(sources: readonly BenchSource[]): string[] {
  const names: string[] = []
  for (const { text } of sources) {
    for (const match of text.matchAll(BENCH_CALL)) {
      const name = match[2] ?? ''
      if (name !== '' && !name.includes('${')) names.push(name)
    }
  }
  return [...new Set(names)]
}

/**
 * 文件是否还在用 vitest ≤4 的模块级 `bench`：从 'vitest' 导入名字 `bench`（含 `bench as b`、多行导入、CommonJS 解构 require）。
 * vitest 5 没有这个导出（`bench` 变成测试里的 fixture），调用时才报 "bench is not a function"。只认行首的导入，
 * 注释里的、`import type` 的不算。
 */
export function usesModuleLevelBench(text: string): boolean {
  return LEGACY_BENCH_IMPORT.test(text)
}

/** vitest 工程里的 bench 文件 → 一个基准套件建议；没有 bench 文件返回 undefined。 */
export async function discoverVitestBench(dir: ProjectDir, notes: string[]): Promise<DiscoveredSuite | undefined> {
  const files: string[] = []
  await benchFiles(dir.abs, '', 0, files)
  if (files.length === 0) return undefined
  const where = dir.rel === '.' ? '' : `${dir.rel}/`
  const sources = await readBenchSources(dir, files)
  const names = benchNames(sources)
  if (names.length === 0) {
    notes.push(`${where} 下有 bench 文件（${files.slice(0, 3).join('、')}）但读不出 bench('名字') 的名字：用 tenon test catalog add --kind benchmark --runner vitest-bench 手工登记并声明指标`)
    return undefined
  }
  const version = await detectVitestVersion(dir)
  if (version === undefined) {
    const cwdFlag = dir.rel === '.' ? '' : ` --cwd ${dir.rel}`
    const register = (command: string): string => `tenon test catalog add ${idPrefix(dir.rel)}bench --kind benchmark --runner vitest-bench --command "${command}"${cwdFlag} `
      + `--report-format benchmark-json --report-path ${REPORT_PATH} --artifact test-results --metric name=${metricName(names[0] ?? 'bench')}.mean_ms,better=lower,max_regression_pct=10,unit=ms`
    notes.push(`${where === '' ? '项目根' : where} 下有 bench 文件但读不出 vitest 主版本（node_modules/vitest 没装，package.json 也没有能解析出主版本的 vitest 范围），没有生成基准套件：`
      + 'vitest 5 起 vitest bench 删掉了 --outputJson，命令因版本而异，不猜。装好依赖后重跑 tenon test discover；或按版本手工登记——'
      + `vitest ≤4：${register(COMMAND_OUTPUT_JSON)}；vitest ≥5：${register(COMMAND_JSON_REPORTER)}`)
    return undefined
  }
  const legacy = version.major >= FIRST_JSON_REPORTER_MAJOR ? sources.filter((source) => usesModuleLevelBench(source.text)).map((source) => source.file) : []
  if (legacy.length > 0) {
    notes.push(`${where === '' ? '项目根' : where} 下的 bench 文件还在用 vitest ≤4 的模块级 bench()（从 'vitest' 导入 bench）：${legacy.slice(0, 3).map((file) => `${where}${file}`).join('、')}`
      + `${legacy.length > 3 ? ` 等 ${legacy.length} 个` : ''}。vitest ${version.major} 没有这个导出，运行会报 "bench is not a function"，所以没有生成基准套件。`
      + "改成测试里的 fixture 写法再重跑 tenon test discover：test('…', async ({ bench }) => { await bench('名字', fn).run() })（选项放第二个参数：bench(名字, 选项, fn)）")
    return undefined
  }
  const metrics: BenchmarkMetricSpec[] = [...new Set(names.map((name) => `${metricName(name)}.mean_ms`))].slice(0, MAX_METRICS)
    .map((name) => ({ name, unit: 'ms', better: 'lower' as const, max_regression_pct: 10 }))
  return {
    source: `${where}${files[0] ?? '*.bench.*'}`,
    suite: makeSuite({
      id: `${idPrefix(dir.rel)}bench`, label: '基准', kind: 'benchmark', runner: 'vitest-bench', cwd: dir.rel,
      command: version.major >= FIRST_JSON_REPORTER_MAJOR ? COMMAND_JSON_REPORTER : COMMAND_OUTPUT_JSON,
      files: ['**/*.{bench,benchmark}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'],
      report: { format: 'benchmark-json', path: REPORT_PATH },
      artifacts: ['test-results'],
      benchmark: { runs: 1, warmup: 0, metrics },
    }),
  }
}
