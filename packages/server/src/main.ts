#!/usr/bin/env node
/**
 * bin 入口：全机唯一 Global dashboard server 的启动装配（B4 版本抢占 + 会话登录）。
 *
 * 启动序（对位老仓 dashboard-server.py main，但补上版本抢占与会话登录）：
 *   1. 从 kernel 单一模型解析宿主 home 与 Tenon data/state/config 路径。
 *   2. 探测既有 :port 的 /api/health（含 version）→ decidePreemption：
 *        bind → 直接监听；reuse → 让位退出 0；preempt → SIGTERM 旧实例后监听。
 *   3. listen 固定端口（TENON_DASHBOARD_PORT ?? 18765，绑 127.0.0.1）。
 *   4. 删除旧版本遗留的 token 握手文件（不再写任何凭证文件）+ pidfile（pid/port/version，供后来者抢占判定）；
 *      启动者的终端（stdout 是 TTY，或显式 TENON_DASHBOARD_PRINT_LINK=1）会收到一条一次性登录链接。
 *   5. SIGTERM/SIGINT 优雅停：关 server + 清 pidfile。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTraceStore } from '@tenon/tap'
import { createOrchestrationLedger, fingerprintWorkspace, machineStateScopeId, syncBuiltinLibraries } from '@tenon/kernel'
import { createDashboardServer } from './server.js'
import { resolveServerPaths } from './paths.js'
import { decidePreemption, preemptOldServer, probeHealth } from './preempt.js'
import { resolvePayloadReleaseId, resolveReleaseVersion } from './version.js'
import { resolveDashboardPort } from './port.js'
import { parseDashboardServerArgs } from './server-args.js'

function serverPort(): number {
  return resolveDashboardPort(process.env.TENON_DASHBOARD_PORT)
}

function cadencePollInterval(): number {
  const raw = Number.parseInt(process.env.TENON_CADENCE_POLL_MS ?? '', 10)
  return Number.isSafeInteger(raw) && raw >= 100 ? raw : 30_000
}

function managedTransactionId(): string | undefined {
  const value = process.env.TENON_MANAGED_TRANSACTION_ID
  if (value === undefined || value === '') return undefined
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('TENON_MANAGED_TRANSACTION_ID 格式非法')
  }
  return value
}

/** dist/dashboard.mjs → 插件仓根（dist → server → packages → 根）。 */
function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

function manifestPath(): string {
  return join(pluginRoot(), 'templates', 'manifest.yaml')
}

function gitHeadSha(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd }, (_err, stdout) => resolve((stdout ?? '').trim()))
  })
}

async function main(): Promise<void> {
  const argumentMode = parseDashboardServerArgs(process.argv.slice(2))
  if (argumentMode.mode === 'help') {
    process.stdout.write(
      'Tenon Dashboard server is an internal managed-runtime entrypoint.\n'
      + 'Use `tenon dashboard` to start or inspect the product.\n',
    )
    return
  }
  if (argumentMode.mode === 'invalid') {
    process.stderr.write(`[dashboard-server] ${argumentMode.detail}\n`)
    process.exitCode = 2
    return
  }
  const paths = resolveServerPaths()
  const host = '127.0.0.1'
  const port = serverPort()
  // Use the marketplace plugin manifest as the release truth.  This lets a freshly auto-updated
  // bundle preempt an older dashboard process instead of falsely reusing it under a stale constant.
  const root = pluginRoot()
  const version = resolveReleaseVersion(root)
  const releaseId = resolvePayloadReleaseId(root)
  const transactionId = managedTransactionId()
  const stateScopeId = machineStateScopeId(paths.stateRoot)

  // Product state must exist before pid publication. Failure is fatal: a server without
  // durable ownership metadata must never bind the singleton port.
  mkdirSync(paths.stateRoot, { recursive: true, mode: 0o700 })

  // 内建库（模板等）按摘要同步到全局 config：覆盖宿主插件市场绕过 `tenon update` 的更新。失败只记日志，不阻止启动。
  for (const result of await syncBuiltinLibraries(root, paths.configRoot)) {
    if (result.state === 'failed') process.stderr.write(`[dashboard-server] 内建库 ${result.id} 同步失败：${result.detail}\n`)
  }

  // ── B4 版本抢占 ──
  const existing = await probeHealth(port, host, 400)
  const decision = decidePreemption(existing, version, releaseId, stateScopeId, transactionId)
  if (decision === 'reuse') {
    process.stdout.write(`[dashboard-server] 复用既有 Global server :${port}（版本 ${existing?.version} ≥ ${version}）\n`)
    process.stdout.write('[dashboard-server] 页面需要登录：运行 tenon dashboard --open，浏览器会自动打开并登录。\n')
    return
  }
  if (decision === 'preempt') {
    process.stdout.write(`[dashboard-server] 抢占旧版本 ${existing?.version} → 本版本 ${version}\n`)
    // 0.1.x wrote no pidfile.  Its health endpoint still exposes its own pid;
    // preemptOldServer additionally verifies that pid owns this TCP listener
    // before signalling it, so the legacy migration path remains fail-closed.
    const freed = await preemptOldServer(paths.pidfilePath, port, host, {
      waitMs: 4000,
      legacyPid: existing?.pid,
      transactionId,
    })
    if (!freed) {
      process.stderr.write('[dashboard-server] 旧实例未在期限内让出端口，启动失败\n')
      process.exitCode = 1
      return
    }
  }

  const srv = createDashboardServer({
    version,
    releaseId,
    transactionId,
    paths,
    hostHome: paths.homeDir,
    manifestPath: manifestPath(),
    gitHeadSha,
    workspaceFingerprint: (cwd) => fingerprintWorkspace(cwd),
    // dashboard-app 构建产物（BACKLOG #26c）：存在则服务真 SPA，否则回退最小落地页
    webRoot: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard-app', 'dist'),
    // tap 流量查看器数据源：只读 sessions/records/timeline；完整 reader 才声明 traffic=true。
    // tap capture 默认 OFF，无捕获时返回空会话——数据端仍在线（#34e：只读本地、不外发）
    traceStore: createTraceStore(),
    // H15：生产 server 显式启用真实 cadence；执行复用已构建 CLI，不在 server 复制 runner。
    cadence: { pollIntervalMs: cadencePollInterval() },
    orchestrationLedger: createOrchestrationLedger(),
  })

  try {
    await srv.listen(port, host)
  } catch (e) {
    process.stderr.write(`[dashboard-server] 监听 :${port} 失败：${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
    return
  }

  // 旧版本把写 token 放在 0600 文件里；现在没有任何凭证落盘，遗留文件按迁移规则直接删除。
  try { rmSync(paths.tokenPath, { force: true }) } catch { /* best-effort */ }

  // pidfile（供后来者版本抢占读旧 pid）
  try {
    writeFileSync(paths.pidfilePath, JSON.stringify({
      pid: process.pid,
      port,
      version,
      started: Date.now(),
      ...(transactionId === undefined ? {} : { transactionId }),
    }), 'utf8')
  } catch { /* best-effort */ }

  process.stdout.write(
    `[dashboard-server] Global server http://${host}:${port}  version=${version}` +
    `${releaseId === undefined ? '' : ` release=${releaseId}`}\n`,
  )
  // 一次性登录链接只交给启动这个进程的人：交互终端，或自动化显式声明自己会读日志。后台托管进程的
  // stdout 被丢弃，用户走 `tenon dashboard --open`（server 自己开浏览器，链接不经任何响应返回）。
  if (process.stdout.isTTY === true || process.env.TENON_DASHBOARD_PRINT_LINK === '1') {
    process.stdout.write(`[dashboard-server] 登录链接（一次性，2 分钟内有效）：${srv.issueLoginUrl()}\n`)
  }

  const shutdown = (): void => {
    void srv.close().finally(() => {
      try { unlinkSync(paths.pidfilePath) } catch { /* 已清 */ }
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main()
