#!/usr/bin/env node
/**
 * Dashboard e2e 的被测服务：目录里的 `dashboard-e2e` 服务（也可由 Playwright 的 globalSetup 直接拉起）。
 *
 * 做三件事，全程与开发机隔离（隔离方式见 tools/lib/isolated-tenon.mjs）：
 *   1. 在系统临时目录建一个独立根：HOME、TENON_RUNTIME_HOME 与两个种子项目都在里面。
 *   2. 用已构建的 CLI（packages/cli/dist/tenon.mjs）播种项目，再用同一个 CLI 的 `dashboard --port <空闲端口>` 启动服务。
 *   3. 服务健康后把地址与路径写到 test-results/dashboard-e2e-server/server.json，并打印一行
 *      `dashboard-e2e ready <url>`（目录的就绪探测读这行日志）。
 *
 * 收到 SIGTERM / SIGINT 时先杀整个服务进程组，再删掉临时根和状态文件；TENON_E2E_KEEP=1 保留临时根供排查。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, createScratch, isolatedEnv, removeScratch, startDashboard, stopGroup } from '../../../tools/lib/isolated-tenon.mjs'
import { seedDemo, seedSandbox } from './seed.mjs'

const STATE_DIR = join(REPO_ROOT, 'test-results', 'dashboard-e2e-server')
const STATE_FILE = join(STATE_DIR, 'server.json')
const LOG_FILE = join(STATE_DIR, 'dashboard.log')

async function main() {
  mkdirSync(STATE_DIR, { recursive: true })
  rmSync(STATE_FILE, { force: true })
  const { scratch, home, runtime, node } = createScratch('tenon-e2e')
  const project = join(scratch, 'demo')
  const sandbox = join(scratch, 'sandbox')
  mkdirSync(project)
  mkdirSync(sandbox)
  const env = isolatedEnv({ home, runtime, node })

  let server = null
  let stopping = false
  const cleanup = async () => {
    if (stopping) return
    stopping = true
    if (server !== null) await stopGroup(server.child)
    rmSync(STATE_FILE, { force: true })
    if (process.env.TENON_E2E_KEEP !== '1') removeScratch(scratch)
  }
  const shutdown = () => { void cleanup().finally(() => process.exit(0)) }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  try {
    seedSandbox({ env, sandbox })
    seedDemo({ env, project })
    server = await startDashboard({ env, cwd: scratch, logFile: LOG_FILE })
    writeFileSync(STATE_FILE, `${JSON.stringify({
      url: server.url, port: server.port, pid: process.pid, serverPid: server.child.pid, scratch, home, runtime, project, sandbox,
    }, null, 2)}\n`)
    process.stdout.write(`dashboard-e2e ready ${server.url}\n`)
    await new Promise((resolve) => server.child.once('exit', resolve))
    if (!stopping) throw new Error('dashboard 进程意外退出')
  } catch (error) {
    process.stderr.write(`dashboard-e2e failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    await cleanup()
    process.exit(1)
  }
}

void main()
