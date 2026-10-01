/**
 * `tenon logs [--follow] [--lines N]` —— 看 Dashboard server 的日志文件（<state>/logs/dashboard.log 与它的两份轮转）。
 *
 * 只读、不联网。行已经在落盘前脱敏过，显示时再过一遍凭证脱敏，兜住旧版本或别的进程写进去的内容。
 * `--follow` 轮询当前文件：变大就读新增的整行，变小（被轮转）就从头读新文件。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { redactCredentials } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'

export const DEFAULT_LOG_LINES = 100
/** 每个日志文件最多读末尾这么多字节；server 的单个文件上限是 1 MiB，这里留足余量。 */
const MAX_TAIL_BYTES = 4 * 1024 * 1024
const FOLLOW_POLL_MS = 500

export interface LogsOpts {
  readonly follow?: boolean
  readonly lines?: string
}

export interface LogsRuntime {
  sleep(ms: number): Promise<void>
  /** 触发即结束 `--follow`；生产环境绑 SIGINT。 */
  readonly signal: AbortSignal
  /** 跟随结束后释放信号监听。 */
  dispose?(): void
}

/** 只在 `--follow` 时才创建：它会占用 SIGINT。 */
export function productionLogsRuntime(): LogsRuntime {
  const controller = new AbortController()
  const onInterrupt = (): void => controller.abort()
  process.once('SIGINT', onInterrupt)
  return {
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
    signal: controller.signal,
    dispose: () => { process.off('SIGINT', onInterrupt) },
  }
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

function readRange(path: string, start: number, end: number): string {
  const length = end - start
  if (length <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, start)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function tailText(path: string): string {
  const size = sizeOf(path)
  if (size === undefined) return ''
  const start = Math.max(0, size - MAX_TAIL_BYTES)
  const text = readRange(path, start, size)
  // 从中间截起的文件，第一行多半不完整：丢掉。
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
}

function shown(line: string): string {
  return redactCredentials(line).text
}

function parseLines(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_LOG_LINES
  return /^[1-9]\d{0,6}$/u.test(raw.trim()) ? Number(raw.trim()) : undefined
}

export async function cmdLogs(deps: CliDeps, opts: LogsOpts, runtime?: LogsRuntime): Promise<number> {
  const count = parseLines(opts.lines)
  if (count === undefined) {
    deps.io.err(`ERROR: ${msg(deps, 'logs.linesInvalid')}`)
    return 1
  }
  const path = deps.productPaths?.().dashboardLogPath
  if (path === undefined) {
    deps.io.err('ERROR: product paths are not wired')
    return 1
  }
  try {
    // 轮转顺序：.2 最老，.1 其次，当前文件最新。
    const text = [`${path}.2`, `${path}.1`, path].map(tailText).join('')
    const lines = text.split('\n').filter((line) => line !== '')
    if (lines.length === 0 && opts.follow !== true) {
      deps.io.err(msg(deps, 'logs.none', { path }))
      return 0
    }
    for (const line of lines.slice(-count)) deps.io.out(shown(line))
    if (opts.follow !== true) return 0
    if (lines.length === 0) deps.io.err(msg(deps, 'logs.none', { path }))
    deps.io.err(msg(deps, 'logs.following', { path }))
    const tracker = runtime ?? productionLogsRuntime()
    try {
      await follow(deps, path, tracker)
    } finally {
      tracker.dispose?.()
    }
    return 0
  } catch (error) {
    deps.io.err(`ERROR: ${msg(deps, 'logs.readFailed', { path, error: errMsg(error) })}`)
    return 1
  }
}

async function follow(deps: CliDeps, path: string, runtime: LogsRuntime): Promise<void> {
  let offset = sizeOf(path) ?? 0
  let pending = ''
  while (!runtime.signal.aborted) {
    await runtime.sleep(FOLLOW_POLL_MS)
    if (runtime.signal.aborted) return
    const size = sizeOf(path)
    if (size === undefined) continue
    // 变小 = 被轮转（或被清空）：新文件从头读。
    if (size < offset) {
      offset = 0
      pending = ''
    }
    if (size === offset) continue
    pending += readRange(path, offset, size)
    offset = size
    const complete = pending.split('\n')
    pending = complete.pop() ?? ''
    for (const line of complete) if (line !== '') deps.io.out(shown(line))
  }
}
