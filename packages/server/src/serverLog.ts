/**
 * Dashboard server 的日志文件：把 server 进程自己写给 stdout / stderr 的每一行镜像进
 * `<state>/logs/dashboard.log`，按大小轮转，最多 3 个文件（当前 + `.1` + `.2`）。
 *
 * 为什么镜像而不是只写文件：受管后台进程的 stdio 是 ignore，服务里到处都是 `process.stderr.write('WARN: …')`，
 * 镜像让这些既有输出第一次有了去处，不用逐处改写。落盘前经 kernel 的凭证脱敏：登录链接里的一次性 code、
 * 会话 cookie、token 都不会进文件（同步写，进程崩溃前的最后几行也在）。日志本身不能让服务挂掉：
 * 任何写盘错误只提示一次，之后静默。
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactCredentials } from '@tenon/kernel'

export const LOG_MAX_BYTES = 1_048_576
export const LOG_FILE_COUNT = 3

export interface RotatingLogOptions {
  readonly path: string
  /** 当前文件超过这个大小就轮转；默认 1 MiB。 */
  readonly maxBytes?: number
  /** 保留的文件总数（含当前）；默认 3。 */
  readonly files?: number
  /** ISO 时间戳来源；默认系统时钟。 */
  readonly clock?: () => string
  /** 日志自身出问题时的一次性提示；默认 stderr 原始写入。 */
  readonly onFailure?: (message: string) => void
}

export interface RotatingLog {
  readonly path: string
  /** 记一行（或多行）文本；每行加时间戳与来源，凭证脱敏，必要时先轮转。 */
  write(source: 'out' | 'err' | 'event', text: string): void
}

function siblingPath(path: string, index: number): string {
  return index === 0 ? path : `${path}.${index}`
}

export function createRotatingLog(options: RotatingLogOptions): RotatingLog {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES
  const files = Math.max(1, options.files ?? LOG_FILE_COUNT)
  const clock = options.clock ?? ((): string => new Date().toISOString())
  const path = options.path
  let size = -1
  let failed = false

  const fail = (error: unknown): void => {
    if (failed) return
    failed = true
    const detail = error instanceof Error ? error.message : String(error)
    options.onFailure?.(`[dashboard-server] 日志文件不可写，之后只输出到终端：${detail}`)
  }

  const currentSize = (): number => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  const rotate = (): void => {
    // 最老的文件最先让位：.2 删除，.1 → .2，当前 → .1。
    rmSync(siblingPath(path, files - 1), { force: true })
    for (let index = files - 2; index >= 0; index--) {
      try {
        renameSync(siblingPath(path, index), siblingPath(path, index + 1))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    size = 0
  }

  return {
    path,
    write(source, text) {
      if (failed) return
      try {
        const stamp = clock()
        const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '')
        if (lines.length === 0) return
        const body = lines
          .map((line) => `${stamp} ${source.padEnd(5)} ${redactCredentials(line).text}\n`)
          .join('')
        if (size < 0) {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
          size = currentSize()
        }
        if (size > 0 && size + Buffer.byteLength(body) > maxBytes) rotate()
        appendFileSync(path, body, { encoding: 'utf8', mode: 0o600 })
        size += Buffer.byteLength(body)
      } catch (error) {
        fail(error)
      }
    },
  }
}

type WriteFn = typeof process.stdout.write

/**
 * 把进程的 stdout / stderr 镜像进日志。原始输出一字不改地照常写；返回的函数撤销镜像（测试与优雅退出用）。
 */
export function mirrorProcessOutput(log: RotatingLog, target: NodeJS.Process = process): () => void {
  const originals: Array<[NodeJS.WriteStream, WriteFn]> = []
  for (const [stream, source] of [[target.stdout, 'out'], [target.stderr, 'err']] as const) {
    const original = stream.write.bind(stream) as WriteFn
    originals.push([stream, stream.write])
    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') log.write(source, chunk)
      else if (chunk instanceof Uint8Array) log.write(source, Buffer.from(chunk).toString('utf8'))
      return (original as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
    }) as WriteFn
  }
  return () => {
    for (const [stream, write] of originals) stream.write = write
  }
}
