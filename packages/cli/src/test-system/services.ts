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

async function probeUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500), redirect: 'manual' })
    await response.body?.cancel()
    return response.status >= 200 && response.status < 400
  } catch {
    return false
  }
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(value)
    }
    const socket = connect({ port, host: '127.0.0.1' })
    socket.setTimeout(1_000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export function logTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-LOG_TAIL_CHARS).trim()
  } catch {
    return ''
  }
}

async function probeReady(service: CatalogService, logPath: string): Promise<boolean> {
  const ready = service.ready
  if ('url' in ready) return probeUrl(ready.url)
  if ('port' in ready) return probePort(ready.port)
  try {
    return readFileSync(logPath, 'utf8').includes(ready.log)
  } catch {
    return false
  }
}

function alreadyServing(service: CatalogService): Promise<boolean> {
  const ready = service.ready
  if ('url' in ready) return probeUrl(ready.url)
  if ('port' in ready) return probePort(ready.port)
  return Promise.resolve(false)
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
  while (Date.now() < deadline) {
    if (running.exited) {
      running.exit = 'crashed'
      return { running, start: { id: service.id, ok: false, failure: `服务在就绪前退出。日志尾部：\n${logTail(options.logPath)}` } }
    }
    if (await probeReady(service, options.logPath)) {
      running.readyMs = Date.now() - started
      return { running, start: { id: service.id, ok: true } }
    }
    await sleep(POLL_MS)
  }
  await stopService(running)
  running.exit = 'not-ready'
  return { running, start: { id: service.id, ok: false, failure: `${service.ready.timeout_s}s 内没等到 ${describeProbe(service)}。日志尾部：\n${logTail(options.logPath)}` } }
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
  if (pid === undefined) return
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
