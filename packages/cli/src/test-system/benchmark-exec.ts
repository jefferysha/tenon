/**
 * 基准套件的执行：预热 warmup 次（结果丢弃）→ 采样 runs 次（每次读报告里的指标样本累加）→ 摘要（中位数 / p95 / MAD）。
 * 摘要离散度大于退化阈值一半（noisy）时自动再采一轮再判，只追加一轮；最终仍 noisy 的由判定层带出提示。
 * 基准始终全量运行；每次采样前删掉上一次的报告，读不到就是这次没产出。
 */
import {
  evaluateBenchmarkMetric, summarizeSamples,
  type BenchmarkMetricResult, type CatalogSuite, type SuiteReason, type TestBaselineV2,
} from '@tenon/kernel'
import type { TestProcessOutcome } from '../test-runner/process.js'
import type { Invoker } from './invoker.js'
import { exitText, processReasons } from './judge.js'
import { parseBenchmark, prepareOutputs, readReportFile, staleReportDetail } from './report-read.js'

export interface BenchmarkExecution {
  readonly outcomes: readonly TestProcessOutcome[]
  readonly metrics: readonly BenchmarkMetricResult[]
  readonly reasons: readonly SuiteReason[]
  readonly digest: string | null
  readonly noisyRerun: boolean
}

function collect(
  samples: Map<string, number[]>, found: Readonly<Record<string, readonly number[]>>, wanted: ReadonlySet<string>,
): void {
  for (const [name, values] of Object.entries(found)) {
    if (wanted.has(name)) samples.set(name, [...(samples.get(name) ?? []), ...values])
  }
}

function summarize(suite: CatalogSuite, samples: ReadonlyMap<string, readonly number[]>): BenchmarkMetricResult[] {
  return (suite.benchmark?.metrics ?? []).flatMap((spec) => {
    const values = samples.get(spec.name) ?? []
    const summary = summarizeSamples(values)
    if (summary === undefined) return []
    return [{
      name: spec.name, ...(spec.unit === undefined ? {} : { unit: spec.unit }), better: spec.better,
      samples: values, median: summary.median, p95: summary.p95, mad: summary.mad,
    }]
  })
}

function anyNoisy(suite: CatalogSuite, metrics: readonly BenchmarkMetricResult[], baseline: TestBaselineV2 | undefined): boolean {
  return (suite.benchmark?.metrics ?? []).some((spec) => {
    const result = metrics.find((metric) => metric.name === spec.name)
    if (result === undefined) return false
    const summary = { median: result.median, p95: result.p95, mad: result.mad, samples: result.samples.length }
    return evaluateBenchmarkMetric(spec, summary, baseline?.metrics[spec.name]?.median).noisy
  })
}

export async function executeBenchmark(input: {
  readonly suite: CatalogSuite
  readonly command: string
  readonly cwd: string
  readonly invoker: Invoker
  readonly baseline: TestBaselineV2 | undefined
}): Promise<BenchmarkExecution> {
  const { suite, invoker } = input
  const spec = suite.benchmark
  const outcomes: TestProcessOutcome[] = []
  const reasons: SuiteReason[] = []
  const samples = new Map<string, number[]>()
  const wanted = new Set((spec?.metrics ?? []).map((metric) => metric.name))
  let digest: string | null = null

  const sample = async (label: string, keep: boolean): Promise<boolean> => {
    const since = Date.now()
    await prepareOutputs(suite, input.cwd)
    const outcome = await invoker.invoke(input.command, label)
    outcomes.push(outcome)
    const fatal = processReasons(outcome, suite.timeout_s)
    reasons.push(...fatal)
    if (outcome.exitCode !== 0 && fatal.length === 0) reasons.push({ code: 'exit-code', detail: `${label}：退出码 ${exitText(outcome)}` })
    if (!keep) return true
    const read = await readReportFile(suite, input.cwd)
    if (read.state !== 'ok') {
      reasons.push({ code: read.state === 'missing' ? 'report-missing' : 'report-unreadable', detail: `${label}：${read.state === 'missing' ? `没有生成 ${suite.report.path ?? '报告'}` : read.reason}` })
      return false
    }
    digest = read.digest
    const stale = staleReportDetail(read, since, suite.report.path ?? '报告')
    if (stale !== undefined) {
      reasons.push({ code: 'report-untrusted', detail: `${label}：${stale}`.slice(0, 1900) })
      return false
    }
    const parsed = parseBenchmark(suite, read.text)
    if (!parsed.ok) {
      reasons.push({ code: 'report-unreadable', detail: `${label}：${parsed.reason}` })
      return false
    }
    collect(samples, parsed.metrics, wanted)
    return true
  }

  const runs = spec?.runs ?? 1
  for (let index = 0; index < (spec?.warmup ?? 0); index++) if (!(await sample(`预热 ${index + 1}`, false)) || outcomes.at(-1)?.interrupted === true) break
  let healthy = true
  for (let index = 0; index < runs && healthy; index++) {
    healthy = await sample(`采样 ${index + 1}/${runs}`, true)
    if (outcomes.at(-1)?.interrupted === true) healthy = false
  }
  let noisyRerun = false
  if (healthy && anyNoisy(suite, summarize(suite, samples), input.baseline)) {
    noisyRerun = true
    for (let index = 0; index < runs && healthy; index++) healthy = await sample(`噪声复跑 ${index + 1}/${runs}`, true)
  }
  return { outcomes, metrics: summarize(suite, samples), reasons, digest, noisyRerun }
}
