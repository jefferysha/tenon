import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRotatingLog, mirrorProcessOutput } from './serverLog.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tenon-server-log-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const CLOCK = (): string => '2026-10-01T10:00:00.000Z'

describe('createRotatingLog', () => {
  it('每行带时间戳与来源，写进 logs 目录（0600）', () => {
    const path = join(dir, 'logs', 'dashboard.log')
    const log = createRotatingLog({ path, clock: CLOCK })
    log.write('err', 'WARN: history 写入失败: EACCES\n')
    log.write('out', 'one\ntwo\n')
    expect(readFileSync(path, 'utf8')).toBe([
      '2026-10-01T10:00:00.000Z err   WARN: history 写入失败: EACCES',
      '2026-10-01T10:00:00.000Z out   one',
      '2026-10-01T10:00:00.000Z out   two',
      '',
    ].join('\n'))
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('按大小轮转，最多 3 个文件（当前 + .1 + .2），最新的在当前文件里', () => {
    const path = join(dir, 'dashboard.log')
    const log = createRotatingLog({ path, clock: CLOCK, maxBytes: 200 })
    for (let index = 0; index < 40; index++) log.write('out', `line-${String(index).padStart(3, '0')}`)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(true)
    expect(existsSync(`${path}.3`)).toBe(false)
    for (const file of [path, `${path}.1`, `${path}.2`]) expect(statSync(file).size).toBeLessThanOrEqual(200)
    const current = readFileSync(path, 'utf8')
    expect(current).toContain('line-039')
    expect(readFileSync(`${path}.1`, 'utf8')).not.toContain('line-039')
    // 轮转按时间顺序往后挪：.2 里的行都比 .1 里的老。
    const first = (file: string): number => Number(/line-(\d{3})/u.exec(readFileSync(file, 'utf8'))?.[1])
    expect(first(`${path}.2`)).toBeLessThan(first(`${path}.1`))
    expect(first(`${path}.1`)).toBeLessThan(first(path))
  })

  it('既有的日志文件接着写，大小从磁盘算起', () => {
    const path = join(dir, 'dashboard.log')
    writeFileSync(path, `${'x'.repeat(150)}\n`)
    const log = createRotatingLog({ path, clock: CLOCK, maxBytes: 180 })
    log.write('out', 'after restart')
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('x'.repeat(150))
    expect(readFileSync(path, 'utf8')).toContain('after restart')
  })

  it('凭证落盘前脱敏：登录链接里的一次性 code、cookie、token 都不进文件', () => {
    const path = join(dir, 'dashboard.log')
    const log = createRotatingLog({ path, clock: CLOCK })
    log.write('out', '[dashboard-server] 登录链接（一次性，2 分钟内有效）：http://127.0.0.1:18765/session/start?code=ABCDEFG1234567\n')
    log.write('err', 'Set-Cookie: tenon_session_18765=0123456789abcdef; Max-Age=604800\nTOKEN=abc123xyz\n')
    const text = readFileSync(path, 'utf8')
    for (const secret of ['ABCDEFG1234567', '0123456789abcdef', 'abc123xyz']) expect(text).not.toContain(secret)
    expect(text).toContain('/session/start?code=[REDACTED:token]')
  })

  it('目录不可写：write 不抛，只提示一次', () => {
    const blocker = join(dir, 'file')
    writeFileSync(blocker, 'not a directory')
    const messages: string[] = []
    const log = createRotatingLog({ path: join(blocker, 'dashboard.log'), clock: CLOCK, onFailure: (message) => messages.push(message) })
    expect(() => { log.write('out', 'a'); log.write('out', 'b') }).not.toThrow()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('日志文件不可写')
  })
})

describe('mirrorProcessOutput', () => {
  it('镜像 stdout / stderr 并原样写出，撤销后不再镜像', () => {
    const path = join(dir, 'dashboard.log')
    const log = createRotatingLog({ path, clock: CLOCK })
    const seen: string[] = []
    const stream = (label: string): NodeJS.WriteStream => ({
      write: (chunk: string | Uint8Array): boolean => { seen.push(`${label}:${String(chunk)}`); return true },
    }) as unknown as NodeJS.WriteStream
    const fake = { stdout: stream('out'), stderr: stream('err') } as unknown as NodeJS.Process
    const restore = mirrorProcessOutput(log, fake)
    fake.stdout.write('hello\n')
    fake.stderr.write(Buffer.from('WARN: x\n'))
    restore()
    fake.stdout.write('not mirrored\n')
    expect(seen).toEqual(['out:hello\n', 'err:WARN: x\n', 'out:not mirrored\n'])
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('out   hello')
    expect(text).toContain('err   WARN: x')
    expect(text).not.toContain('not mirrored')
  })
})
