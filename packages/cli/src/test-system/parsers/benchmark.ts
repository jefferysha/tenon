/**
 * 基准报告 → 指标样本。Tenon 自己的最小格式 `{"metrics":{"p95_ms":[12.1,11.8],"rps":950}}`（单值或多值）是标准形态，
 * 其余格式转换成同一形态：
 *   · hyperfine `--export-json`：`{"results":[{command,times:[秒…]}]}` → `time_ms`（一条命令）或 `<命令>.time_ms`（多条）
 *   · vitest bench `--outputJson`：`{"files":[{groups:[{benchmarks:[…]}]}]}` → `<基准名>.mean_ms` / `.p99_ms` / `.hz`
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

function vitestBenchMetrics(files: readonly unknown[]): BenchmarkReport {
  const out: Metrics = {}
  for (const file of files.filter(isRecord)) {
    for (const group of asArray(file.groups).filter(isRecord)) {
      for (const bench of asArray(group.benchmarks).filter(isRecord)) {
        const name = metricName(asString(bench.name) ?? asString(bench.id) ?? 'bench')
        const mean = asNumber(bench.mean)
        const p99 = asNumber(bench.p99)
        const hz = asNumber(bench.hz)
        if (mean !== undefined) out[`${name}.mean_ms`] = [mean]
        if (p99 !== undefined) out[`${name}.p99_ms`] = [p99]
        if (hz !== undefined) out[`${name}.hz`] = [hz]
      }
    }
  }
  return Object.keys(out).length === 0 ? { ok: false, reason: 'vitest bench 结果里没有 mean / p99 / hz' } : { ok: true, metrics: out }
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
  return nativeMetrics(root)
}
