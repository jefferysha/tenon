#!/usr/bin/env node
/**
 * 基准：dashboard 快照重建耗时，指标 snapshot_ms。
 * 真实路径：用已构建的 CLI 起 dashboard，每个样本先发一个非 GET 请求（server 对任何非 GET 都会丢掉快照缓存），
 * 再计时 GET /api/snapshot——这一次必然是现算（指纹 + 聚合所有已登记项目 + 序列化 + 回环 HTTP）。
 * 用法：node tools/bench/snapshot.mjs --json test-results/bench-snapshot.json [--runs 15] [--warmup 2] [--projects 2] [--changes 6]
 */
import { join } from 'node:path'
import { startDashboard, stopGroup } from '../lib/isolated-tenon.mjs'
import { createBenchFixture } from './fixture.mjs'
import { readOptions, sample, writeReport } from './measure.mjs'

const options = readOptions(process.argv.slice(2))
const fixture = createBenchFixture(options)
let server = null
try {
  server = await startDashboard({ env: fixture.env, cwd: fixture.scratch, logFile: join(fixture.scratch, 'dashboard.log') })
  let bytes = 0
  const rebuild = async () => {
    const headers = { Cookie: server.session.header }
    await fetch(`${server.url}/api/bench-invalidate`, { method: 'DELETE', headers })
    const response = await fetch(`${server.url}/api/snapshot`, { headers })
    if (!response.ok) throw new Error(`GET /api/snapshot 返回 ${response.status}`)
    bytes = (await response.arrayBuffer()).byteLength
  }
  const samples = await sample(options, rebuild)
  writeReport(options.json, { snapshot_ms: samples }, {
    projects: options.projects, changes: options.changes, runs: options.runs, warmup: options.warmup, snapshot_bytes: bytes,
  })
  process.stderr.write(`snapshot_ms: ${samples.length} 个样本（快照 ${bytes} 字节），写入 ${options.json}\n`)
} finally {
  if (server !== null) await stopGroup(server.child)
  fixture.cleanup()
}
