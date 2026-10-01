import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveProductPaths } from '@tenon/kernel'
import type { LogsRuntime } from './commands/logs.js'
import { realDeps } from './integration-harness.js'
import { buildProgram, CliExit } from './program.js'

let root = ''
let paths: ReturnType<typeof resolveProductPaths>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tenon-logs-'))
  mkdirSync(join(root, 'project'), { recursive: true })
  paths = resolveProductPaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: join(root, 'home') })
  mkdirSync(paths.logsRoot, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

async function run(args: string[], runtime?: LogsRuntime, env: Record<string, string> = {}): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const deps = realDeps(join(root, 'project'), out, err, { ...process.env, TENON_RUNTIME_HOME: join(root, 'runtime'), ...env })
  try {
    await buildProgram(deps, runtime === undefined ? {} : { logs: runtime }).parseAsync(args, { from: 'user' })
    return { code: 0, out, err }
  } catch (error) {
    if (error instanceof CliExit) return { code: error.code, out, err }
    throw error
  }
}

const lines = (from: number, to: number, label = 'line'): string =>
  Array.from({ length: to - from + 1 }, (_, index) => `${label}-${String(from + index).padStart(3, '0')}`).join('\n').concat('\n')

describe('tenon logs', () => {
  it('没有日志文件：给出位置与如何产生它，退出 0，stdout 保持干净', async () => {
    const result = await run(['logs'])
    expect(result.code).toBe(0)
    expect(result.out).toEqual([])
    expect(result.err.join('\n')).toContain(`还没有 Dashboard 日志：${paths.dashboardLogPath}`)
    const english = await run(['logs'], undefined, { TENON_LANG: 'en' })
    expect(english.err.join('\n')).toContain(`No Dashboard log yet: ${paths.dashboardLogPath}`)
  })

  it('默认最近 100 行，--lines 取最近 N 行；跨轮转文件按时间顺序接起来（.2 最老 → 当前最新）', async () => {
    writeFileSync(`${paths.dashboardLogPath}.2`, lines(1, 80, 'old'))
    writeFileSync(`${paths.dashboardLogPath}.1`, lines(81, 160, 'mid'))
    writeFileSync(paths.dashboardLogPath, lines(161, 200, 'new'))
    const all = await run(['logs'])
    expect(all.out).toHaveLength(100)
    expect(all.out[0]).toBe('mid-101')
    expect(all.out.at(-1)).toBe('new-200')
    const few = await run(['logs', '--lines', '45'])
    expect(few.out).toHaveLength(45)
    expect(few.out[0]).toBe('mid-156')
    expect(few.out.at(-1)).toBe('new-200')
    const short = await run(['logs', '-n', '3'])
    expect(short.out).toEqual(['new-198', 'new-199', 'new-200'])
  })

  it('--lines 不是正整数：退出 1', async () => {
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      const result = await run(['logs', '--lines', bad])
      expect(result.code, bad).toBe(1)
      expect(result.err.join('\n'), bad).toContain('--lines 必须是正整数')
    }
    expect((await run(['logs', '--lines', 'x'], undefined, { TENON_LANG: 'en' })).err.join('\n')).toContain('--lines must be a positive integer')
  })

  it('显示前再过一遍凭证脱敏：旧版本或别的进程写进去的 token 也不会打到终端', async () => {
    writeFileSync(paths.dashboardLogPath, [
      '2026-10-01T10:00:00.000Z out   open http://127.0.0.1:18765/session/start?code=SECRETCODE123456',
      '2026-10-01T10:00:01.000Z err   Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
      '2026-10-01T10:00:02.000Z out   fine line',
      '',
    ].join('\n'))
    const result = await run(['logs'])
    const printed = result.out.join('\n')
    expect(printed).not.toContain('SECRETCODE123456')
    expect(printed).not.toContain('ghp_')
    expect(printed).toContain('fine line')
  })

  it('--follow：先打印最近的行，再把新增的整行逐条打印；被轮转（变小）后从新文件头继续；Ctrl+C 即 abort 后退出 0', async () => {
    writeFileSync(paths.dashboardLogPath, lines(1, 3, 'before'))
    const controller = new AbortController()
    let polls = 0
    const runtime: LogsRuntime = {
      signal: controller.signal,
      sleep: async () => {
        polls += 1
        if (polls === 1) appendFileSync(paths.dashboardLogPath, 'after-1\nafter-2\npartial')
        if (polls === 2) appendFileSync(paths.dashboardLogPath, '-done\n')
        if (polls === 3) {
          // 轮转：当前文件挪成 .1，新文件从头写。
          renameSync(paths.dashboardLogPath, `${paths.dashboardLogPath}.1`)
          writeFileSync(paths.dashboardLogPath, 'rotated-1\n')
        }
        if (polls === 4) controller.abort()
      },
    }
    const result = await run(['logs', '--follow', '--lines', '2'], runtime)
    expect(result.code).toBe(0)
    expect(result.out).toEqual(['before-002', 'before-003', 'after-1', 'after-2', 'partial-done', 'rotated-1'])
    expect(result.err.join('\n')).toContain(`正在跟随 ${paths.dashboardLogPath}`)
  })

  it('--follow 在日志还不存在时等它出现，而不是报错退出', async () => {
    const controller = new AbortController()
    let polls = 0
    const runtime: LogsRuntime = {
      signal: controller.signal,
      sleep: async () => {
        polls += 1
        if (polls === 1) writeFileSync(paths.dashboardLogPath, 'first-line\n')
        if (polls === 2) controller.abort()
      },
    }
    const result = await run(['logs', '-f'], runtime)
    expect(result.code).toBe(0)
    expect(result.out).toEqual(['first-line'])
    expect(result.err.join('\n')).toContain('还没有 Dashboard 日志')
  })
})
