/**
 * 指标读取与判定。来源二选一：声明的 `metrics_path` JSON 文件，或保留日志里最后一行能解析成
 * JSON 对象的 stdout。嵌套对象用 `.` 摊平，只保留有限数字。基准比较只对当前用户的基线做
 * （机器不同，跨用户比较没有意义）。
 */
import { readFile, stat } from 'node:fs/promises'
import type { TestMetricCriterion } from '../workflow/types.js'
import type { TestBaselineV1, TestMetricRecord, TestRunReason } from './types.js'

const MAX_METRICS = 200
const MAX_METRICS_BYTES = 1024 * 1024

/** 嵌套对象摊平成 `a.b.c`；非有限数字与非法类型直接丢弃。 */
export function flattenMetrics(value: unknown, prefix = ''): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, item] of Object.entries(value)) {
    const name = prefix === '' ? key : `${prefix}.${key}`
    if (typeof item === 'number') {
      if (Number.isFinite(item) && Object.keys(out).length < MAX_METRICS) out[name] = item
      continue
    }
    for (const [nested, number] of Object.entries(flattenMetrics(item, name))) {
      if (Object.keys(out).length < MAX_METRICS) out[nested] = number
    }
  }
  return out
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 日志里最后一行能解析成 JSON 对象的行；找不到返回 undefined。 */
export function lastJsonObjectLine(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = (lines[index] ?? '').trim()
    if (!line.startsWith('{')) continue
    const parsed = parseObject(line)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

export async function readMetrics(input: {
  readonly metricsPath?: string
  readonly logText?: string
}): Promise<Record<string, number> | undefined> {
  if (input.metricsPath !== undefined) {
    try {
      const entry = await stat(input.metricsPath)
      if (!entry.isFile() || entry.size > MAX_METRICS_BYTES) return undefined
      const parsed = parseObject(await readFile(input.metricsPath, 'utf8'))
      return parsed === undefined ? undefined : flattenMetrics(parsed)
    } catch {
      return undefined
    }
  }
  if (input.logText === undefined) return undefined
  const parsed = lastJsonObjectLine(input.logText)
  return parsed === undefined ? undefined : flattenMetrics(parsed)
}

export interface MetricEvaluation {
  readonly metrics: readonly TestMetricRecord[]
  readonly reasons: readonly TestRunReason[]
}

function regressionPct(value: number, base: number, better: 'lower' | 'higher'): number {
  const raw = ((value - base) / Math.abs(base)) * 100
  return better === 'higher' ? -raw : raw
}

/**
 * 记录每个读到的指标，并对声明了标准的指标判定。绝对上下限失败 → metric-threshold；
 * 相对退化失败 → metric-regression；来源缺失或指标缺失 → metric-unreadable。
 */
export function evaluateMetricCriteria(input: {
  readonly criteria: readonly (TestMetricCriterion & { readonly better: 'lower' | 'higher' })[]
  readonly metrics: Readonly<Record<string, number>> | undefined
  readonly baseline: TestBaselineV1 | undefined
  readonly command: string
  readonly cwd: string
}): MetricEvaluation {
  const reasons: TestRunReason[] = []
  if (input.criteria.length > 0 && input.metrics === undefined) {
    return { metrics: [], reasons: [{ code: 'metric-unreadable', detail: '指标来源缺失或不是 JSON 对象' }] }
  }
  const values = input.metrics ?? {}
  const baselineUsable = input.baseline !== undefined
    && input.baseline.command === input.command
    && input.baseline.cwd === input.cwd
  if (input.baseline !== undefined && !baselineUsable
    && input.criteria.some((criterion) => criterion.max_regression_pct !== undefined)) {
    reasons.push({ code: 'baseline-mismatch', detail: '基线的命令或目录与本次不同' })
  }
  const byName = new Map(input.criteria.map((criterion) => [criterion.name, criterion]))
  const records: TestMetricRecord[] = []
  const emit = (name: string, value: number | null): void => {
    const criterion = byName.get(name)
    const better = criterion?.better ?? 'lower'
    const base = baselineUsable && criterion?.max_regression_pct !== undefined
      ? input.baseline?.metrics[name] ?? null
      : null
    const delta = value !== null && base !== null && base !== 0 ? regressionPct(value, base, better) : null
    let ok = true
    if (value === null) {
      ok = false
      reasons.push({ code: 'metric-unreadable', detail: `指标 '${name}' 缺失` })
    } else if (criterion !== undefined) {
      if (criterion.max !== undefined && value > criterion.max) {
        ok = false
        reasons.push({ code: 'metric-threshold', detail: `指标 '${name}' ${value} 超过上限 ${criterion.max}` })
      }
      if (criterion.min !== undefined && value < criterion.min) {
        ok = false
        reasons.push({ code: 'metric-threshold', detail: `指标 '${name}' ${value} 低于下限 ${criterion.min}` })
      }
      if (criterion.max_regression_pct !== undefined) {
        if (base === null) {
          if (baselineUsable || input.baseline === undefined) {
            reasons.push({ code: 'baseline-missing', detail: `指标 '${name}' 没有基线` })
          }
        } else if (delta !== null && delta > criterion.max_regression_pct) {
          ok = false
          reasons.push({
            code: 'metric-regression',
            detail: `指标 '${name}' 相对基线退化 ${delta.toFixed(2)}%，上限 ${criterion.max_regression_pct}%`,
          })
        }
      }
    }
    records.push({
      name,
      value,
      baseline: base,
      delta_pct: delta,
      ...(criterion?.max === undefined ? {} : { max: criterion.max }),
      ...(criterion?.min === undefined ? {} : { min: criterion.min }),
      ...(criterion?.max_regression_pct === undefined ? {} : { max_regression_pct: criterion.max_regression_pct }),
      better,
      ok,
    })
  }
  for (const name of Object.keys(values)) emit(name, values[name] ?? null)
  for (const criterion of input.criteria) {
    if (!Object.hasOwn(values, criterion.name)) emit(criterion.name, null)
  }
  return { metrics: records, reasons }
}
