/**
 * 基准报告 → 指标样本。Tenon 自己的最小格式 `{"metrics":{"p95_ms":[12.1,11.8],"rps":950}}`（单值或多值）是标准形态，
 * 其余格式转换成同一形态：
 *   · hyperfine `--export-json`：`{"results":[{command,times:[秒…]}]}` → `time_ms`（一条命令）或 `<命令>.time_ms`（多条）
 *   · vitest ≤4 bench `--outputJson`：`{"files":[{groups:[{benchmarks:[…]}]}]}` → `<基准名>.mean_ms` / `.p99_ms` / `.hz`
 *   · vitest 5 bench `--reporter=json`：`{"testResults":[{assertionResults:[{benchmarks:[{tasks:[{name,latency,throughput}]}]}]}]}`
 *     （vitest 5 删掉了 `--outputJson`，基准结果改挂在 json reporter 的用例上）→ 同样的 `<基准名>.mean_ms` / `.p99_ms` / `.hz`，
 *     指标名与 vitest ≤4 一致，目录里声明的指标不用改（两个版本的统计引擎不同，数值不保证可比，升级主版本后重建基线）：
 *     mean_ms / p99_ms 取 `latency.mean` / `latency.p99`（毫秒），hz 取 vitest 自己算的 `throughput.mean`（次/秒，就是 vitest 表格里的
 *     hz 列），不是由 1000 / latency.mean 反推的；`bench.from()` 读回的存档结果（`fromStore`）不是这次测的，跳过
 *   · vitest 的基准名就是指标名：两个 vitest 版本里重名的基准（或只有标点不同的名字）都判解析失败并点名，不让后一个悄悄盖掉前一个
 *   · k6 `--summary-export`：`{"metrics":{"http_req_duration":{"p(95)":…}}}` → `http_req_duration.p95`（括号去掉）
 *   · lighthouse：`audits[*].numericValue` → `<审计 id>`；`categories[*].score` → `<类别>_score`（百分制）
 * 指标名只留 `[A-Za-z0-9_.-]`，与目录的指标名规则一致。
 */
import { asArray, asNumber, asString, isRecord, parseJson, type JsonRecord } from './json.js'
import type { BenchmarkReport, BenchmarkReportFormat } from './types.js'

type Metrics = Record<string, readonly number[]>

const MAX_METRICS = 512
const MAX_SAMPLES = 100_000

export function metricName(raw: string): string {
  const cleaned = raw.replace(/\(([^)]*)\)/g, '$1').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '')
  return (cleaned === '' ? 'metric' : cleaned).slice(0, 128)
}

function samplesOf(value: unknown): number[] | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? [value] : undefined
  if (!Array.isArray(value)) return undefined
  const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
  return numbers.length === 0 || numbers.length !== value.length ? undefined : numbers.slice(0, MAX_SAMPLES)
}

function nativeMetrics(root: JsonRecord): BenchmarkReport {
  if (!isRecord(root.metrics)) return { ok: false, reason: '缺少 metrics 对象' }
  const out: Metrics = {}
  for (const [name, value] of Object.entries(root.metrics)) {
    const samples = samplesOf(value)
    if (samples === undefined) return { ok: false, reason: `指标 '${name}' 必须是数字或数字数组` }
    out[name] = samples
  }
  return Object.keys(out).length === 0 ? { ok: false, reason: 'metrics 里没有指标' } : { ok: true, metrics: out }
}

function hyperfineMetrics(results: readonly unknown[]): BenchmarkReport {
  const rows = results.filter(isRecord)
  const out: Metrics = {}
  for (const row of rows) {
    const times = samplesOf(row.times) ?? samplesOf(row.mean)
    if (times === undefined) continue
    const label = metricName(asString(row.command) ?? `cmd${Object.keys(out).length + 1}`)
    out[rows.length === 1 ? 'time_ms' : `${label}.time_ms`] = times.map((seconds) => Number((seconds * 1000).toFixed(6)))
  }
  return Object.keys(out).length === 0 ? { ok: false, reason: 'hyperfine 结果里没有 times / mean' } : { ok: true, metrics: out }
}

/** 基准名（指标名去掉 `.mean_ms` 等后缀）→ 它在报告里出现的位置。指标名取自基准名，重名的基准不能让后一个悄悄盖掉前一个。 */
type BenchSeen = Map<string, string[]>

const MAX_DUPLICATES_SHOWN = 3

function putVitestBench(
  out: Metrics, seen: BenchSeen, rawName: string | undefined, where: string,
  mean: number | undefined, p99: number | undefined, hz: number | undefined,
): void {
  if (mean === undefined && p99 === undefined && hz === undefined) return
  const name = metricName(rawName ?? 'bench')
  seen.set(name, [...(seen.get(name) ?? []), where])
  if (mean !== undefined) out[`${name}.mean_ms`] = [mean]
  if (p99 !== undefined) out[`${name}.p99_ms`] = [p99]
  if (hz !== undefined) out[`${name}.hz`] = [hz]
}

/** 有重名的基准就失败并点名：宁可让套件红着提示改名，也不报一个被悄悄覆盖的指标。名字只有标点不同也算重名（指标名只留 `[A-Za-z0-9_.-]`）。 */
function duplicateBenchReason(label: string, seen: BenchSeen): string | undefined {
  const duplicated = [...seen].filter(([, places]) => places.length > 1)
  if (duplicated.length === 0) return undefined
  const shown = duplicated.slice(0, MAX_DUPLICATES_SHOWN)
    .map(([name, places]) => `'${name}'（${places.length} 处：${places.slice(0, MAX_DUPLICATES_SHOWN).join('、')}）`)
  const more = duplicated.length > MAX_DUPLICATES_SHOWN ? ` 等 ${duplicated.length} 个` : ''
  return `${label} 结果里有重名的基准：${shown.join('；')}${more}。指标名取自基准名，重名会互相覆盖——给每个 bench() 起不同的名字`
}

function vitestBenchMetrics(files: readonly unknown[]): BenchmarkReport {
  const out: Metrics = {}
  const seen: BenchSeen = new Map()
  for (const file of files.filter(isRecord)) {
    for (const group of asArray(file.groups).filter(isRecord)) {
      const where = asString(group.fullName) ?? asString(file.filepath) ?? '?'
      for (const bench of asArray(group.benchmarks).filter(isRecord)) {
        putVitestBench(out, seen, asString(bench.name) ?? asString(bench.id), where, asNumber(bench.mean), asNumber(bench.p99), asNumber(bench.hz))
      }
    }
  }
  const duplicate = duplicateBenchReason('vitest bench', seen)
  if (duplicate !== undefined) return { ok: false, reason: duplicate }
  return Object.keys(out).length === 0 ? { ok: false, reason: 'vitest bench 结果里没有 mean / p99 / hz' } : { ok: true, metrics: out }
}

/**
 * vitest 5 json reporter：每个 task 一组指标。`hz` 直接取 vitest 自己算的 `throughput.mean`（vitest 表格里的 hz 列），
 * 不是由 `latency.mean` 反推的 1000 / mean：throughput.mean 是逐样本吞吐的均值，有离群样本时与 1000 / latency.mean 差一个数量级
 * （captured 夹具里 native sort 的 hz 约 1.25e7，而 1000 / latency.mean ≈ 9e5）。
 */
function vitest5BenchMetrics(testResults: readonly unknown[]): BenchmarkReport {
  const out: Metrics = {}
  const seen: BenchSeen = new Map()
  for (const file of testResults.filter(isRecord)) {
    for (const assertion of asArray(file.assertionResults).filter(isRecord)) {
      for (const bench of asArray(assertion.benchmarks).filter(isRecord)) {
        const where = `${(asString(file.name) ?? '?').split(/[\\/]/u).at(-1)} > ${asString(bench.name) ?? '?'}`
        for (const task of asArray(bench.tasks).filter(isRecord)) {
          if (task.fromStore === true) continue
          const latency = isRecord(task.latency) ? task.latency : {}
          const throughput = isRecord(task.throughput) ? task.throughput : {}
          putVitestBench(out, seen, asString(task.name), where, asNumber(latency.mean), asNumber(latency.p99), asNumber(throughput.mean))
        }
      }
    }
  }
  const duplicate = duplicateBenchReason('vitest 5 bench', seen)
  if (duplicate !== undefined) return { ok: false, reason: duplicate }
  return Object.keys(out).length === 0 ? { ok: false, reason: 'vitest 5 bench 结果里没有 latency.mean / latency.p99 / throughput.mean（json reporter 的用例上没有 benchmarks：是用 vitest bench 跑的吗）' } : { ok: true, metrics: out }
}

function k6Metrics(root: JsonRecord): BenchmarkReport {
  if (!isRecord(root.metrics)) return { ok: false, reason: '缺少 metrics：不是 k6 summary' }
  const out: Metrics = {}
  for (const [metric, body] of Object.entries(root.metrics)) {
    if (!isRecord(body)) continue
    const values = isRecord(body.values) ? body.values : body
    for (const [key, value] of Object.entries(values)) {
      const number = asNumber(value)
      if (number !== undefined && Object.keys(out).length < MAX_METRICS) out[`${metricName(metric)}.${metricName(key)}`] = [number]
    }
  }
  return Object.keys(out).length === 0 ? { ok: false, reason: 'k6 summary 里没有数值指标' } : { ok: true, metrics: out }
}

function lighthouseMetrics(root: JsonRecord): BenchmarkReport {
  const out: Metrics = {}
  if (isRecord(root.audits)) {
    for (const [id, audit] of Object.entries(root.audits)) {
      const value = isRecord(audit) ? asNumber(audit.numericValue) : undefined
      if (value !== undefined && Object.keys(out).length < MAX_METRICS) out[metricName(id)] = [value]
    }
  }
  if (isRecord(root.categories)) {
    for (const [id, category] of Object.entries(root.categories)) {
      const score = isRecord(category) ? asNumber(category.score) : undefined
      if (score !== undefined) out[`${metricName(id)}_score`] = [Number((score * 100).toFixed(4))]
    }
  }
  return Object.keys(out).length === 0 ? { ok: false, reason: 'lighthouse 报告里没有 audits / categories 数值' } : { ok: true, metrics: out }
}

export function parseBenchmarkReport(format: BenchmarkReportFormat, text: string): BenchmarkReport {
  const parsed = parseJson(text)
  if (!parsed.ok) return parsed
  const root = parsed.value
  if (!isRecord(root)) return { ok: false, reason: '报告顶层必须是对象' }
  if (format === 'k6-summary') return k6Metrics(root)
  if (format === 'lighthouse-json') return lighthouseMetrics(root)
  if (Array.isArray(root.results)) return hyperfineMetrics(root.results)
  if (Array.isArray(root.files)) return vitestBenchMetrics(root.files)
  if (Array.isArray(root.testResults)) return vitest5BenchMetrics(root.testResults)
  return nativeMetrics(root)
}
