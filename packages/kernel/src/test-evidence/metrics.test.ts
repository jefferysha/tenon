import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { evaluateMetricCriteria, flattenMetrics, lastJsonObjectLine, readMetrics } from './metrics.js'
import { TEST_BASELINE_SCHEMA, type TestBaselineV1 } from './types.js'

const dirs: string[] = []
const ACTOR = { id: 'a@x.io', name: 'A', trust: 'declared' } as const

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function baseline(metrics: Record<string, number>, command = 'npm run bench', cwd = '.'): TestBaselineV1 {
  return {
    schema: TEST_BASELINE_SCHEMA, test_id: 'bench', command, cwd, metrics,
    source: { change: 'c', run_id: '20260915T100000Z-000001' }, actor: ACTOR,
    updated_at: '2026-09-15T10:00:00Z', history: [],
  }
}

describe('指标读取', () => {
  test('嵌套对象摊平，非有限数字丢弃', () => {
    expect(flattenMetrics({ p95: 1, nested: { a: 2, b: 'x', c: Number.NaN }, list: [1, 2] }))
      .toEqual({ p95: 1, 'nested.a': 2 })
  })

  test('取日志里最后一行 JSON 对象', () => {
    const log = '正在运行\n{"p95":1}\n中间输出\n{"p95":2,"rss":3}\n完成\n'
    expect(lastJsonObjectLine(log)).toEqual({ p95: 2, rss: 3 })
    expect(lastJsonObjectLine('没有 JSON\n')).toBeUndefined()
  })

  test('metrics_path 优先于日志；文件缺失或不是对象读成 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenon-metrics-'))
    dirs.push(dir)
    const path = join(dir, 'benchmark.json')
    await writeFile(path, JSON.stringify({ p95_ms: 12.5 }))
    expect(await readMetrics({ metricsPath: path, logText: '{"p95_ms":99}' })).toEqual({ p95_ms: 12.5 })
    expect(await readMetrics({ metricsPath: join(dir, 'missing.json') })).toBeUndefined()
    await writeFile(path, '[1,2]')
    expect(await readMetrics({ metricsPath: path })).toBeUndefined()
    expect(await readMetrics({ logText: 'x\n{"p95_ms":7}\n' })).toEqual({ p95_ms: 7 })
  })
})

describe('指标判定', () => {
  const criterion = (extra: Record<string, number>) => [{ name: 'p95_ms', better: 'lower' as const, ...extra }]

  test('声明了标准但来源不可读 → metric-unreadable', () => {
    const result = evaluateMetricCriteria({
      criteria: criterion({ max: 100 }), metrics: undefined, baseline: undefined, command: 'c', cwd: '.',
    })
    expect(result.reasons).toEqual([{ code: 'metric-unreadable', detail: '指标来源缺失或不是 JSON 对象' }])
  })

  test('绝对上下限', () => {
    const over = evaluateMetricCriteria({
      criteria: criterion({ max: 100 }), metrics: { p95_ms: 120 }, baseline: undefined, command: 'c', cwd: '.',
    })
    expect(over.reasons.map((reason) => reason.code)).toEqual(['metric-threshold'])
    expect(over.metrics[0]?.ok).toBe(false)

    const under = evaluateMetricCriteria({
      criteria: criterion({ min: 90 }), metrics: { p95_ms: 80 }, baseline: undefined, command: 'c', cwd: '.',
    })
    expect(under.reasons.map((reason) => reason.code)).toEqual(['metric-threshold'])

    const pass = evaluateMetricCriteria({
      criteria: criterion({ max: 100 }), metrics: { p95_ms: 80, rss: 5 }, baseline: undefined, command: 'c', cwd: '.',
    })
    expect(pass.reasons).toEqual([])
    expect(pass.metrics.map((metric) => metric.name)).toEqual(['p95_ms', 'rss'])
  })

  test('退化比例：越低更优与越高更优符号相反', () => {
    const lower = evaluateMetricCriteria({
      criteria: criterion({ max_regression_pct: 10 }), metrics: { p95_ms: 120 },
      baseline: baseline({ p95_ms: 100 }), command: 'npm run bench', cwd: '.',
    })
    expect(lower.reasons.map((reason) => reason.code)).toEqual(['metric-regression'])
    expect(lower.metrics[0]?.delta_pct).toBe(20)

    const higher = evaluateMetricCriteria({
      criteria: [{ name: 'ops', better: 'higher', max_regression_pct: 10 }], metrics: { ops: 80 },
      baseline: baseline({ ops: 100 }), command: 'npm run bench', cwd: '.',
    })
    expect(higher.reasons.map((reason) => reason.code)).toEqual(['metric-regression'])
    expect(higher.metrics[0]?.delta_pct).toBe(20)

    const improved = evaluateMetricCriteria({
      criteria: [{ name: 'ops', better: 'higher', max_regression_pct: 10 }], metrics: { ops: 120 },
      baseline: baseline({ ops: 100 }), command: 'npm run bench', cwd: '.',
    })
    expect(improved.reasons).toEqual([])
    expect(improved.metrics[0]?.delta_pct).toBe(-20)
  })

  test('无基线只提示 baseline-missing；命令不同提示 baseline-mismatch 且不比较', () => {
    const missing = evaluateMetricCriteria({
      criteria: criterion({ max_regression_pct: 10 }), metrics: { p95_ms: 500 },
      baseline: undefined, command: 'npm run bench', cwd: '.',
    })
    expect(missing.reasons.map((reason) => reason.code)).toEqual(['baseline-missing'])
    expect(missing.metrics[0]?.ok).toBe(true)

    const mismatch = evaluateMetricCriteria({
      criteria: criterion({ max_regression_pct: 10 }), metrics: { p95_ms: 500 },
      baseline: baseline({ p95_ms: 100 }, 'npm run other'), command: 'npm run bench', cwd: '.',
    })
    expect(mismatch.reasons.map((reason) => reason.code)).toEqual(['baseline-mismatch'])
    expect(mismatch.metrics[0]?.baseline).toBeNull()
    expect(mismatch.metrics[0]?.ok).toBe(true)
  })

  test('声明的指标在来源里缺失 → metric-unreadable 并记录 null', () => {
    const result = evaluateMetricCriteria({
      criteria: criterion({ max: 100 }), metrics: { other: 1 }, baseline: undefined, command: 'c', cwd: '.',
    })
    expect(result.reasons).toEqual([{ code: 'metric-unreadable', detail: "指标 'p95_ms' 缺失" }])
    expect(result.metrics.find((metric) => metric.name === 'p95_ms')?.value).toBeNull()
  })
})
