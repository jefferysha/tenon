/**
 * 测试命令的进程运行器：一条 shell 命令、独立进程组、有界日志。
 *
 * 模式沿用 automation 的 detached spawn + `process.kill(-pid)`（triage/codex-provider.ts）与
 * 滚动尾部（runner/boundedTail.ts），但落盘而非留在内存：日志先写前 8 MiB，之后只记字节数并留
 * 1 MiB 滚动尾部，退出时补一行省略标记再接尾部。摘要按写入顺序增量计算，不回读文件。
 * 超时与中断都对整个进程组先 SIGTERM、宽限后 SIGKILL；stdin 关闭，命令文本不做任何插值。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'

export const MAX_LOG_BYTES = 8 * 1024 * 1024
export const LOG_TAIL_BYTES = 1024 * 1024
export const OUTCOME_TAIL_BYTES = 64 * 1024
export const GRACE_MS = 10_000

export interface TestProcessRequest {
  readonly command: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly graceMs: number
  readonly logPath: string
  readonly maxLogBytes: number
  readonly tailBytes: number
  readonly signal?: AbortSignal
}

export interface TestProcessOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly interrupted: boolean
  readonly spawnError?: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly log: {
    readonly bytesTotal: number
    readonly bytesKept: number
    readonly truncated: boolean
    readonly sha256: string
  }
  /** 末尾若干字节，仅在内存中：失败时打印、沙箱拦截模式匹配用。 */
  readonly tail: string
}

/** 定长滚动字节尾部：总长超上限时从头逐出，必要时切掉最旧一块的前缀。 */
class ByteTail {
  private readonly chunks: Buffer[] = []
  private total = 0

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const bounded = chunk.length > this.max ? chunk.subarray(chunk.length - this.max) : chunk
    this.chunks.push(bounded)
    this.total += bounded.length
    while (this.total > this.max && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      if (dropped === undefined) break
      this.total -= dropped.length
    }
    const only = this.chunks[0]
    if (this.total > this.max && only !== undefined) {
      const trimmed = only.subarray(only.length - this.max)
      this.chunks[0] = trimmed
      this.total = trimmed.length
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function shellFor(command: string): { readonly file: string; readonly args: readonly string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

export function runTestProcess(request: TestProcessRequest): Promise<TestProcessOutcome> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const hash = createHash('sha256')
  const stream = createWriteStream(request.logPath, { flags: 'w', mode: 0o600 })
  const omittedTail = new ByteTail(request.tailBytes)
  const outcomeTail = new ByteTail(OUTCOME_TAIL_BYTES)
  let bytesTotal = 0
  let bytesKept = 0

  const write = (chunk: Buffer): void => {
    bytesTotal += chunk.length
    outcomeTail.push(chunk)
    const room = request.maxLogBytes - bytesKept
    if (room > 0) {
      const head = chunk.length <= room ? chunk : chunk.subarray(0, room)
      stream.write(head)
      hash.update(head)
      bytesKept += head.length
      if (chunk.length > room) omittedTail.push(chunk.subarray(room))
      return
    }
    omittedTail.push(chunk)
  }

  return new Promise<TestProcessOutcome>((resolve) => {
    const detached = process.platform !== 'win32'
    const shell = shellFor(request.command)
    let settled = false
    let timedOut = false
    let interrupted = false
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: string): void => {
      if (settled) return
      settled = true
      if (forceKill !== undefined) clearTimeout(forceKill)
      if (deadline !== undefined) clearTimeout(deadline)
      request.signal?.removeEventListener('abort', onAbort)
      const truncated = bytesTotal > bytesKept
      if (truncated) {
        const omitted = Buffer.from(`\n[tenon] 省略中间 ${bytesTotal - bytesKept} 字节 …\n`, 'utf8')
        const tail = omittedTail.toBuffer()
        stream.write(omitted)
        stream.write(tail)
        hash.update(omitted)
        hash.update(tail)
        bytesKept += omitted.length + tail.length
      }
      stream.end(() => {
        const finishedAtMs = Date.now()
        resolve({
          exitCode,
          signal,
          timedOut,
          interrupted,
          ...(spawnError === undefined ? {} : { spawnError }),
          startedAt,
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: finishedAtMs - startedAtMs,
          log: { bytesTotal, bytesKept, truncated, sha256: `sha256:${hash.digest('hex')}` },
          tail: outcomeTail.toBuffer().toString('utf8'),
        })
      })
    }

    const child = spawn(shell.file, [...shell.args], {
      cwd: request.cwd,
      env: request.env,
      detached,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const killGroup = (signal: NodeJS.Signals): void => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // 子进程可能还没进入自己的进程组；直接杀进程本身是安全兜底。
        }
      }
      child.kill(signal)
    }

    const stop = (): void => {
      killGroup('SIGTERM')
      forceKill = setTimeout(() => killGroup('SIGKILL'), request.graceMs)
      forceKill.unref?.()
    }

    function onAbort(): void {
      interrupted = true
      stop()
    }

    if (request.signal?.aborted === true) onAbort()
    else request.signal?.addEventListener('abort', onAbort, { once: true })

    deadline = setTimeout(() => {
      timedOut = true
      stop()
    }, request.timeoutMs)
    deadline.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => write(chunk))
    child.once('error', (error) => finish(null, null, error.message))
    child.once('close', (code, signal) => finish(code, signal))
  })
}
