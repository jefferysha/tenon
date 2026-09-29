/**
 * 一个套件在一次 `tenon test run` 里可能执行多次（首次、失败重跑、基准预热与采样）。每次调用写自己的日志片段，
 * 结束时按顺序拼成一份 `logs/<套件>.log`（每段前有一行标题），记录里的日志摘要覆盖整份。
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CatalogSuite, TestRunLog } from '@tenon/kernel'
import { GRACE_MS, LOG_TAIL_BYTES, MAX_LOG_BYTES, runTestProcess, type TestProcessOutcome } from '../test-runner/process.js'

export interface Invoker {
  invoke(command: string, label: string): Promise<TestProcessOutcome>
  finish(): Promise<{ readonly log: TestRunLog; readonly tail: string }>
}

export function createInvoker(input: {
  readonly suite: CatalogSuite
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly runDir: string
  readonly signal: AbortSignal
}): Invoker {
  const logsDir = join(input.runDir, 'logs')
  const parts: Array<{ readonly path: string; readonly label: string; readonly outcome: TestProcessOutcome }> = []
  return {
    async invoke(command, label) {
      await mkdir(logsDir, { recursive: true })
      const path = join(logsDir, `${input.suite.id}-${parts.length + 1}.part`)
      const outcome = await runTestProcess({
        command, cwd: input.cwd, env: input.env, timeoutMs: input.suite.timeout_s * 1000, graceMs: GRACE_MS,
        logPath: path, maxLogBytes: MAX_LOG_BYTES, tailBytes: LOG_TAIL_BYTES, signal: input.signal,
      })
      parts.push({ path, label, outcome })
      return outcome
    },
    async finish() {
      await mkdir(logsDir, { recursive: true })
      const target = join(logsDir, `${input.suite.id}.log`)
      await writeFile(target, '', { mode: 0o600 })
      let bytesTotal = 0
      for (const part of parts) {
        await appendFile(target, `\n=== ${part.label}\n`)
        await appendFile(target, await readFile(part.path))
        await rm(part.path, { force: true })
        bytesTotal += part.outcome.log.bytesTotal
      }
      const bytes = await readFile(target)
      return {
        log: {
          artifact: `logs/${input.suite.id}.log`,
          bytes_total: bytesTotal,
          bytes_kept: bytes.length,
          truncated: parts.some((part) => part.outcome.log.truncated),
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
        tail: parts.at(-1)?.outcome.tail ?? '',
      }
    },
  }
}
