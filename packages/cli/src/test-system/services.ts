/**
 * 依赖服务的生命周期：启动（独立进程组，输出进服务日志）→ 就绪探测（URL 2xx / 端口可连 / 日志出现文本）→ 回收
 * （停止信号发给整个进程组，宽限后 SIGKILL，再核对进程组里没有残留）。
 *
 * 启动前先探测一次就绪条件：URL / 端口已经在响应说明有别的进程占着，测试会打到旧代码上，直接判 not-ready 并说明，
 * 不悄悄复用。回收结果写进记录（exit + leaked_pids）：留下孤儿进程是记录里可见的事实，不是静默泄漏。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CatalogService, ServiceExit, ServiceRunV2 } from '@tenon/kernel'

const run = promisify(execFile)
const POLL_MS = 200
const STOP_GRACE_MS = 5_000
const LOG_TAIL_CHARS = 2_000

export interface RunningService {
  readonly service: CatalogService
  readonly child: ChildProcess
  readonly logPath: string
  readyMs: number | null
  exit: ServiceExit
  leaked: number[]
  stopping: boolean
  exited: boolean
}

export interface ServiceStart {
  readonly id: string
  readonly ok: boolean
  /** 未就绪时的原因（含服务日志尾部）。 */
  readonly failure?: string
}

/** 一次就绪探测的结果；未就绪时 `detail` 说明这次看到了什么（状态码 / 超时 / 连接错误）。 */
interface Probe {
  readonly ok: boolean
  readonly detail: string
  /** 永远不会就绪的原因（如 URL 端口在 fetch 规范的禁用表里）：不必等满超时。 */
  readonly fatal?: boolean
}

const PROBE_TIMEOUT_MS = 1_500

function fetchFailure(url: string, error: unknown): Probe {
  if (error instanceof Error && error.name === 'TimeoutError') return { ok: false, detail: `探测超时（${PROBE_TIMEOUT_MS / 1000}s 内没有响应）` }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined
  const message = cause?.message ?? (error instanceof Error ? error.message : String(error))
  if (message === 'bad port') {
    const port = new URL(url).port
    return {
      ok: false, fatal: true,
      detail: `端口 ${port} 在 fetch 规范的禁用端口表里，探测请求不会发出，服务再怎么起来也判不了就绪；换一个端口`,
    }
  }
  return { ok: false, detail: message }
}

async function probeUrl(url: string): Promise<Probe> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' })
    await response.body?.cancel()
    const ok = response.status >= 200 && response.status < 400
    return { ok, detail: `HTTP ${response.status}` }
  } catch (error) {
    return fetchFailure(url, error)
  }
}

function probePort(port: number): Promise<Probe> {
  return new Promise((resolveProbe) => {
    let settled = false
    const done = (probe: Probe): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(probe)
    }
    const socket = connect({ port, host: '127.0.0.1' })
    socket.setTimeout(1_000)
    socket.once('connect', () => done({ ok: true, detail: '已连上' }))
    socket.once('timeout', () => done({ ok: false, detail: `连接 127.0.0.1:${port} 超时` }))
    socket.once('error', (error) => done({ ok: false, detail: error.message }))
  })
}

export function logTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-LOG_TAIL_CHARS).trim()
  } catch {
    return ''
  }
}

async function probeReady(service: CatalogService, logPath: string): Promise<Probe> {
  const ready = service.ready
  if ('url' in ready) return probeUrl(ready.url)
  if ('port' in ready) return probePort(ready.port)
  try {
    const found = readFileSync(logPath, 'utf8').includes(ready.log)
    return { ok: found, detail: found ? '日志已出现' : `服务日志里还没出现 "${ready.log}"` }
  } catch {
    return { ok: false, detail: '服务日志读不到' }
  }
}

async function alreadyServing(service: CatalogService): Promise<boolean> {
  const ready = service.ready
  if ('url' in ready) return (await probeUrl(ready.url)).ok
  if ('port' in ready) return (await probePort(ready.port)).ok
  return false
}

function describeProbe(service: CatalogService): string {
  const ready = service.ready
  return 'url' in ready ? ready.url : 'port' in ready ? `端口 ${ready.port}` : `日志出现 "${ready.log}"`
}

/** 启动一个服务并等到就绪；失败时服务已被回收，返回原因。 */
export async function startService(
  service: CatalogService,
  options: { readonly repoRoot: string; readonly logPath: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly running: RunningService; readonly start: ServiceStart }> {
  mkdirSync(dirname(options.logPath), { recursive: true })
  const fd = openSync(options.logPath, 'w', 0o600)
  const cwd = resolve(options.repoRoot, service.cwd)
  const preexisting = await alreadyServing(service)
  const child = spawn('/bin/sh', ['-c', service.start], {
    cwd, env: options.env, detached: true, stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  const running: RunningService = { service, child, logPath: options.logPath, readyMs: null, exit: 'stopped', leaked: [], stopping: false, exited: false }
  child.once('exit', () => { running.exited = true })
  child.once('error', () => { running.exited = true })
  if (preexisting) {
    running.exit = 'not-ready'
    await stopService(running)
    running.exit = 'not-ready'
    return { running, start: { id: service.id, ok: false, failure: `${describeProbe(service)} 在启动前就已经在响应：有别的进程占着，测试会打到旧代码上；先停掉它` } }
  }
  const started = Date.now()
  const deadline = started + service.ready.timeout_s * 1000
  let last: Probe = { ok: false, detail: '还没有探测过' }
  while (Date.now() < deadline) {
    if (running.exited) {
      running.exit = 'crashed'
      return { running, start: { id: service.id, ok: false, failure: `服务在就绪前退出。日志尾部：\n${logTail(options.logPath)}` } }
    }
    last = await probeReady(service, options.logPath)
    if (last.ok) {
      running.readyMs = Date.now() - started
      return { running, start: { id: service.id, ok: true } }
    }
    if (last.fatal === true) break
    await sleep(POLL_MS)
  }
  await stopService(running)
  running.exit = 'not-ready'
  const waited = last.fatal === true ? '就绪探测不可能成功' : `${service.ready.timeout_s}s 内没等到 ${describeProbe(service)}`
  const tail = logTail(options.logPath)
  return {
    running,
    start: { id: service.id, ok: false, failure: `${waited}。最后一次探测：${last.detail}。日志尾部：${tail === '' ? '（服务没有输出）' : `\n${tail}`}` },
  }
}

async function groupMembers(pgid: number): Promise<number[]> {
  try {
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,pgid='], { timeout: 5_000 })
    return stdout.split('\n').flatMap((line) => {
      const [pid, group] = line.trim().split(/\s+/).map(Number)
      return group === pgid && Number.isInteger(pid) && pid !== undefined && pid !== process.pid ? [pid] : []
    })
  } catch {
    return []
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // 进程已经不在了。
    }
  }
}

/** 回收：停止信号发给整个进程组，宽限后 SIGKILL，最后核对进程组是否清空。 */
export async function stopService(running: RunningService): Promise<void> {
  const pid = running.child.pid
  if (pid === undefined || running.stopping) return
  running.stopping = true
  if (process.platform === 'win32') {
    running.child.kill()
    return
  }
  const crashed = running.exited && running.exit !== 'not-ready'
  signalGroup(pid, running.service.stop)
  const graceEnd = Date.now() + STOP_GRACE_MS
  while (Date.now() < graceEnd && (await groupMembers(pid)).length > 0) await sleep(100)
  if ((await groupMembers(pid)).length > 0) {
    signalGroup(pid, 'SIGKILL')
    await sleep(300)
  }
  const left = await groupMembers(pid)
  if (left.length > 0) {
    running.leaked = left
    running.exit = 'leaked'
  } else if (crashed) {
    running.exit = 'crashed'
  }
}

export function serviceRecord(running: RunningService, logIndexPath: string | null): ServiceRunV2 {
  return { id: running.service.id, ready_ms: running.readyMs, exit: running.exit, log: logIndexPath, leaked_pids: running.leaked }
}
