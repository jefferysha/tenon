/**
 * 基准指标的统计与判定（纯函数）。多次运行取中位数与 p95，离散度用 MAD（中位绝对偏差）。
 *
 * 判定：
 *   · 绝对上下限（max / min）始终生效，与有没有基线无关；
 *   · 同画像有基线时按 `better` 方向算相对中位数的退化百分比，超过 max_regression_pct 判退化；
 *   · 离散度（MAD / 中位数）超过退化阈值一半时标记 noisy——runner 据此自动再跑一轮再判，
 *     判定层只把仍然 noisy 的结果作为提示带出。
 */
import type { BenchmarkMetricSpec } from './catalog-types.js'

export interface MetricSummary {
  readonly median: number
  readonly p95: number
  readonly mad: number
  readonly samples: number
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right)
}

export function median(values: readonly number[]): number {
  const list = sorted(values)
  if (list.length === 0) return Number.NaN
  const middle = Math.floor(list.length / 2)
  return list.length % 2 === 1 ? list[middle] ?? Number.NaN : ((list[middle - 1] ?? 0) + (list[middle] ?? 0)) / 2
}

/** 线性插值分位数（p ∈ [0,100]）。 */
export function percentile(values: readonly number[], p: number): number {
  const list = sorted(values)
  if (list.length === 0) return Number.NaN
  if (list.length === 1) return list[0] ?? Number.NaN
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (list.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  const low = list[lower] ?? 0
  const high = list[upper] ?? low
  return low + (high - low) * (rank - lower)
}

export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const center = median(values)
  return median(values.map((value) => Math.abs(value - center)))
}

export function summarizeSamples(samples: readonly number[]): MetricSummary | undefined {
  const finite = samples.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return undefined
  return {
    median: median(finite),
    p95: percentile(finite, 95),
    mad: medianAbsoluteDeviation(finite),
    samples: finite.length,
  }
}

/** 退化百分比：正数 = 变差（lower 方向变大、higher 方向变小）。基线为 0 时无意义，返回 null。 */
export function regressionPct(value: number, base: number, better: 'lower' | 'higher'): number | null {
  if (base === 0 || !Number.isFinite(base) || !Number.isFinite(value)) return null
  const raw = ((value - base) / Math.abs(base)) * 100
  return better === 'higher' ? -raw : raw
}

export interface BenchmarkMetricVerdict {
  readonly name: string
  readonly unit?: string
  readonly better: 'lower' | 'higher'
  readonly summary: MetricSummary | null
  readonly baseline: number | null
  readonly delta_pct: number | null
  /** 退化或越过绝对阈值（阻塞）。 */
  readonly failed: boolean
  /** 需要退化比较却没有同画像基线。 */
  readonly baselineMissing: boolean
  readonly noisy: boolean
  readonly details: readonly string[]
}

export function evaluateBenchmarkMetric(
  spec: BenchmarkMetricSpec,
  summary: MetricSummary | undefined,
  baselineMedian: number | undefined,
): BenchmarkMetricVerdict {
  const base = {
    name: spec.name,
    ...(spec.unit === undefined ? {} : { unit: spec.unit }),
    better: spec.better,
  }
  if (summary === undefined) {
    return {
      ...base, summary: null, baseline: baselineMedian ?? null, delta_pct: null, failed: true,
      baselineMissing: false, noisy: false, details: [`指标 '${spec.name}' 没有读到样本`],
    }
  }
  const details: string[] = []
  let failed = false
  const unit = spec.unit === undefined ? '' : ` ${spec.unit}`
  if (spec.max !== undefined && summary.median > spec.max) {
    failed = true
    details.push(`指标 '${spec.name}' 中位数 ${summary.median}${unit} 超过上限 ${spec.max}${unit}`)
  }
  if (spec.min !== undefined && summary.median < spec.min) {
    failed = true
    details.push(`指标 '${spec.name}' 中位数 ${summary.median}${unit} 低于下限 ${spec.min}${unit}`)
  }
  const wantsBaseline = spec.max_regression_pct !== undefined
  const delta = baselineMedian === undefined ? null : regressionPct(summary.median, baselineMedian, spec.better)
  if (wantsBaseline && delta !== null && spec.max_regression_pct !== undefined && delta > spec.max_regression_pct) {
    failed = true
    details.push(`指标 '${spec.name}' 相对基线退化 ${delta.toFixed(2)}%（上限 ${spec.max_regression_pct}%）`)
  }
  const spread = summary.median === 0 ? 0 : (summary.mad / Math.abs(summary.median)) * 100
  const noisy = spec.max_regression_pct !== undefined && spread > spec.max_regression_pct / 2
  return {
    ...base,
    summary,
    baseline: baselineMedian ?? null,
    delta_pct: delta,
    failed,
    baselineMissing: wantsBaseline && baselineMedian === undefined,
    noisy,
    details,
  }
}
