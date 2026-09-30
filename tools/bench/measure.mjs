/**
 * 基准脚本的共用件：参数、计时、benchmark-json 落盘。
 *
 * 报告是 Tenon 的最小基准格式 `{"metrics":{"<指标>":[毫秒…]}}`（多个样本，目录判定取中位数并记录 p95 与离散度）；
 * 额外的 `meta` 只给人看，解析器不读它。样本数、预热次数和夹具规模都从命令行来，默认值就是 CI 用的那组。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

export const DEFAULT_RUNS = 15
export const DEFAULT_WARMUP = 2
export const DEFAULT_PROJECTS = 2
export const DEFAULT_CHANGES = 6

export function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'string' },
      runs: { type: 'string', default: String(DEFAULT_RUNS) },
      warmup: { type: 'string', default: String(DEFAULT_WARMUP) },
      projects: { type: 'string', default: String(DEFAULT_PROJECTS) },
      changes: { type: 'string', default: String(DEFAULT_CHANGES) },
    },
  })
  const positive = (name, raw, min) => {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min) throw new Error(`--${name} 必须是 >= ${min} 的整数（收到 '${raw}'）`)
    return value
  }
  if (values.json === undefined || values.json === '') throw new Error('缺少 --json <报告路径>（例如 test-results/bench-status.json）')
  return {
    json: resolve(values.json),
    runs: positive('runs', values.runs, 1),
    warmup: positive('warmup', values.warmup, 0),
    projects: positive('projects', values.projects, 1),
    changes: positive('changes', values.changes, 1),
  }
}

/** 计时一次异步操作，返回毫秒（保留三位小数）。 */
export async function timed(operation) {
  const started = performance.now()
  await operation()
  return Number((performance.now() - started).toFixed(3))
}

/** 先预热再采样；采样按顺序返回，预热的结果丢弃。 */
export async function sample({ runs, warmup }, operation) {
  for (let index = 0; index < warmup; index++) await operation()
  const out = []
  for (let index = 0; index < runs; index++) out.push(await timed(operation))
  return out
}

export function writeReport(path, metrics, meta) {
  mkdirSync(dirname(path), { recursive: true })
  const body = { metrics, meta: { node: process.version, platform: `${process.platform}-${process.arch}`, ...meta } }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`)
}
