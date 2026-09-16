import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { GRACE_MS, LOG_TAIL_BYTES, MAX_LOG_BYTES, runTestProcess } from './process.js'

const dirs: string[] = []

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-test-process-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function request(dir: string, command: string, overrides: Record<string, unknown> = {}) {
  return {
    command,
    cwd: dir,
    env: { ...process.env, TENON_TEST_PROBE: '1' },
    timeoutMs: 30_000,
    graceMs: GRACE_MS,
    logPath: join(dir, 'output.log'),
    maxLogBytes: MAX_LOG_BYTES,
    tailBytes: LOG_TAIL_BYTES,
    ...overrides,
  }
}

describe('runTestProcess', () => {
  test('记录退出码、日志内容与摘要，环境变量可见', async () => {
    const dir = await freshDir()
    const outcome = await runTestProcess(request(dir, 'printf "%s\\n" "$TENON_TEST_PROBE"; exit 3'))
    expect(outcome.exitCode).toBe(3)
    expect(outcome.signal).toBeNull()
    expect(outcome.timedOut).toBe(false)
    expect(outcome.interrupted).toBe(false)
    expect(outcome.log.truncated).toBe(false)
    expect(outcome.tail.trim()).toBe('1')
    const bytes = await readFile(join(dir, 'output.log'))
    expect(bytes.toString('utf8')).toBe('1\n')
    expect(outcome.log.sha256).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    expect(outcome.log.bytesTotal).toBe(2)
    expect(Date.parse(outcome.finishedAt) >= Date.parse(outcome.startedAt)).toBe(true)
  })

  test('stderr 与 stdout 交错写进同一份日志', async () => {
    const dir = await freshDir()
    const outcome = await runTestProcess(request(dir, 'echo out; echo err 1>&2'))
    expect(outcome.exitCode).toBe(0)
    const log = await readFile(join(dir, 'output.log'), 'utf8')
    expect(log).toContain('out')
    expect(log).toContain('err')
  })

  test('超时对整个进程组生效：孙子进程也被杀掉', async () => {
    const dir = await freshDir()
    const pidFile = join(dir, 'child.pid')
    const outcome = await runTestProcess(request(
      dir,
      `sh -c 'sleep 30 & echo $! > ${pidFile}; wait' `,
      { timeoutMs: 300, graceMs: 200 },
    ))
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode === null || outcome.exitCode !== 0).toBe(true)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(Number.isInteger(pid)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    if (alive) process.kill(pid, 'SIGKILL')
    expect(alive).toBe(false)
  })

  test('中断信号（AbortSignal）标记 interrupted 并终止进程组', async () => {
    const dir = await freshDir()
    const controller = new AbortController()
    const running = runTestProcess(request(dir, 'sleep 30', { graceMs: 200, signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    const outcome = await running
    expect(outcome.interrupted).toBe(true)
    expect(outcome.timedOut).toBe(false)
  })

  test('超量输出保留头部、省略标记与滚动尾部，摘要与落盘文件一致', async () => {
    const dir = await freshDir()
    const outcome = await runTestProcess(request(
      dir,
      'i=0; while [ $i -lt 90 ]; do printf "%09d" $i; i=$((i+1)); done; printf "END"',
      { maxLogBytes: 200, tailBytes: 100 },
    ))
    expect(outcome.exitCode).toBe(0)
    expect(outcome.log.truncated).toBe(true)
    expect(outcome.log.bytesTotal).toBe(90 * 9 + 3)
    const bytes = await readFile(join(dir, 'output.log'))
    expect(bytes.length).toBe(outcome.log.bytesKept)
    expect(bytes.toString('utf8')).toContain('[tenon] 省略中间')
    expect(bytes.toString('utf8').endsWith('END')).toBe(true)
    expect(outcome.log.sha256).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
  })

  test('命令不存在保留 127；spawn 失败带 spawnError', async () => {
    const dir = await freshDir()
    const missing = await runTestProcess(request(dir, 'tenon-no-such-command-xyz'))
    expect(missing.exitCode).toBe(127)
    const badCwd = await runTestProcess(request(dir, 'echo hi', { cwd: join(dir, 'missing') }))
    expect(badCwd.spawnError).toBeDefined()
    expect(badCwd.exitCode).toBeNull()
  })
})
