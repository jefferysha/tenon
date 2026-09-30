#!/usr/bin/env node
/**
 * 基准：dashboard 快照的重建耗时与载荷。真实路径：用已构建的 CLI 起 dashboard，经回环 HTTP 取页面加载的那份列表快照
 * （GET /api/snapshot?view=list）。
 *
 * 场景（--scenarios，逗号分隔，默认 cold）：
 *   cold    先发一个不带 root 的非 GET 请求（server 据此丢掉全部缓存），再计时列表快照——所有项目都要现算。指标 snapshot_ms。
 *   write   先取一次把缓存暖起来；每个样本先用真实 CLI 改一个项目里的一个 change（`tenon set`，写完才开始计时），再计时列表快照——
 *           只有被改的那个项目需要重建，其余走缓存。这是「有人在终端里动了一个任务，页面多久看到」。指标 snapshot_write_ms。
 *   detail  每个样本先丢掉一个项目的缓存（带 root 的非 GET），再计时该项目一个 change 的详情（GET /api/change/:name/snapshot）。指标 change_detail_ms。
 * 载荷指标 snapshot_bytes：列表快照的原始字节数（每个样本一个值）；meta.snapshot_wire_bytes 是响应头 Content-Length（gzip 后）。
 *
 * --max-p95-ms：主指标（有 write 场景取 snapshot_write_ms，否则取 snapshot_ms）的 p95 超过它就以非零退出，目录套件据此判失败。
 *
 * 用法：node tools/bench/snapshot.mjs --json test-results/bench-snapshot.json [--runs 15] [--warmup 2] [--projects 2] [--changes 6]
 *         [--scenarios cold,write,detail] [--max-p95-ms 1500] [--fixture-dir <目录，开发机复用夹具>]
 */
import { join } from 'node:path'
import { runTenon, startDashboard, stopGroup } from '../lib/isolated-tenon.mjs'
import { createBenchFixture } from './fixture.mjs'
import { percentile, readOptions, sample, writeReport } from './measure.mjs'

const SCENARIOS = ['cold', 'write', 'detail']

const options = readOptions(process.argv.slice(2))
const scenarios = options.scenarios
const unknown = scenarios.filter((name) => !SCENARIOS.includes(name))
if (scenarios.length === 0 || unknown.length > 0) throw new Error(`--scenarios 只能是 ${SCENARIOS.join(' / ')} 的逗号组合（收到 '${scenarios.join(',')}'）`)
const fixture = await createBenchFixture(options)
let server = null
try {
  server = await startDashboard({ env: fixture.env, cwd: fixture.scratch, logFile: join(fixture.scratch, 'dashboard.log') })
  const stats = { bytes: 0, wire: 0 }
  const byteSamples = []
  const listSnapshot = async () => {
    const response = await fetch(`${server.url}/api/snapshot?view=list`)
    if (!response.ok) throw new Error(`GET /api/snapshot?view=list 返回 ${response.status}`)
    stats.bytes = (await response.arrayBuffer()).byteLength
    stats.wire = Number(response.headers.get('content-length') ?? 0)
    byteSamples.push(stats.bytes)
    return response.headers.get('etag')
  }
  const dropProject = (root) => fetch(`${server.url}/api/bench-invalidate?root=${encodeURIComponent(root)}`, { method: 'DELETE' })
  const metrics = {}

  if (scenarios.includes('cold')) {
    metrics.snapshot_ms = await sample(options, async () => {
      await fetch(`${server.url}/api/bench-invalidate`, { method: 'DELETE' })
      await listSnapshot()
    })
  }

  if (scenarios.includes('write')) {
    await listSnapshot()
    let written = 0
    let lastEtag = null
    const timedWrite = async () => {
      const root = fixture.roots[written % fixture.roots.length]
      runTenon(fixture.env, root, ['set', 'change-1', 'pr_url', `https://example.test/bench/${written++}`])
      const started = performance.now()
      const etag = await listSnapshot()
      const elapsed = performance.now() - started
      if (etag !== null && etag === lastEtag) throw new Error('写入之后列表快照没有变化：缓存没有发现这次写入')
      lastEtag = etag
      return elapsed
    }
    for (let index = 0; index < options.warmup; index++) await timedWrite()
    metrics.snapshot_write_ms = []
    for (let index = 0; index < options.runs; index++) metrics.snapshot_write_ms.push(Number((await timedWrite()).toFixed(3)))
  }

  if (scenarios.includes('detail')) {
    let next = 0
    const timedDetail = async () => {
      const root = fixture.roots[next++ % fixture.roots.length]
      await dropProject(root)
      const started = performance.now()
      const response = await fetch(`${server.url}/api/change/change-1/snapshot?root=${encodeURIComponent(root)}`)
      if (!response.ok) throw new Error(`GET /api/change/change-1/snapshot 返回 ${response.status}`)
      await response.arrayBuffer()
      return performance.now() - started
    }
    for (let index = 0; index < options.warmup; index++) await timedDetail()
    metrics.change_detail_ms = []
    for (let index = 0; index < options.runs; index++) metrics.change_detail_ms.push(Number((await timedDetail()).toFixed(3)))
  }

  metrics.snapshot_bytes = byteSamples.length === 0 ? [stats.bytes] : byteSamples.slice(-options.runs)
  const gated = metrics.snapshot_write_ms ?? metrics.snapshot_ms
  const p95 = gated === undefined ? undefined : percentile(gated, 95)
  writeReport(options.json, metrics, {
    projects: options.projects, changes: options.changes, runs: options.runs, warmup: options.warmup, scenarios,
    snapshot_bytes: stats.bytes, snapshot_wire_bytes: stats.wire,
    ...(p95 === undefined ? {} : { gated_p95_ms: Number(p95.toFixed(1)) }),
  })
  process.stderr.write(`${scenarios.join('+')}: 列表快照 ${stats.bytes} 字节（传输 ${stats.wire} 字节）${p95 === undefined ? '' : `，主指标 p95 ${p95.toFixed(0)} ms`}，写入 ${options.json}\n`)
  if (options.maxP95Ms !== undefined && p95 !== undefined && p95 >= options.maxP95Ms) {
    process.stderr.write(`主指标 p95 ${p95.toFixed(0)} ms 超过上限 ${options.maxP95Ms} ms\n`)
    process.exitCode = 1
  }
} finally {
  if (server !== null) await stopGroup(server.child)
  fixture.cleanup()
}
