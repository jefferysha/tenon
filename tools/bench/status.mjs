#!/usr/bin/env node
/**
 * 基准：`tenon status` 的端到端耗时（进程启动 + 读 change + 出摘要），指标 status_ms。
 * 用法：node tools/bench/status.mjs --json test-results/bench-status.json [--runs 15] [--warmup 2]
 */
import { spawn } from 'node:child_process'
import { TENON_CLI, isolatedNode } from '../lib/isolated-tenon.mjs'
import { createBenchFixture } from './fixture.mjs'
import { readOptions, sample, writeReport } from './measure.mjs'

function statusOnce(fixture) {
  const root = fixture.roots[0]
  return new Promise((resolveRun, reject) => {
    const child = spawn(isolatedNode(fixture.env), [TENON_CLI, 'status', 'change-1', '--json'], { cwd: root, env: fixture.env, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`tenon status 退出 ${code}`))))
  })
}

const options = readOptions(process.argv.slice(2))
const fixture = createBenchFixture({ projects: 1, changes: options.changes })
try {
  const samples = await sample(options, () => statusOnce(fixture))
  writeReport(options.json, { status_ms: samples }, { changes: options.changes, runs: options.runs, warmup: options.warmup })
  process.stderr.write(`status_ms: ${samples.length} 个样本，写入 ${options.json}\n`)
} finally {
  fixture.cleanup()
}
