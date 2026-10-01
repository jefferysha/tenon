import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { totalRedactions } from '@tenon/kernel'
import { buildSupportBundle, MANIFEST_NAME, SUPPORT_BUNDLE_MAX_BYTES, type BundleSource } from './bundle.js'
import { createTarGz } from './tar.js'
import { textOf, unpackTarGz } from './test-support.js'

const AT = '2026-10-01T10:00:00Z'
const redaction = { homeDirs: ['/Users/zhangsan'], userNames: ['zhangsan'] }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function build(sources: BundleSource[], extra: { maxBytes?: number; rawBudget?: number } = {}) {
  return buildSupportBundle({ createdAt: AT, sources, redaction, notIncluded: ['project source'], ...extra })
}

describe('createTarGz', () => {
  it('输出标准 ustar：自写的读取器与系统 tar 都能解开，内容与时间戳不变', () => {
    const archive = createTarGz([
      { name: 'a.txt', content: Buffer.from('hello\n'), mtime: 1_700_000_000 },
      { name: 'logs/b.log', content: Buffer.alloc(1500, 'x'), mtime: 1_700_000_001 },
    ])
    const entries = unpackTarGz(archive)
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'logs/b.log'])
    expect(entries[0]?.content.toString()).toBe('hello\n')
    expect(entries[1]?.content.length).toBe(1500)
    expect(entries[0]?.mode).toBe(0o600)
    expect(entries[0]?.mtime).toBe(1_700_000_000)

    const dir = mkdtempSync(join(tmpdir(), 'tenon-tar-'))
    dirs.push(dir)
    const file = join(dir, 'x.tar.gz')
    writeFileSync(file, archive)
    const listing = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' })
    if (listing.error === undefined) {
      expect(listing.status).toBe(0)
      expect(listing.stdout.trim().split('\n')).toEqual(['a.txt', 'logs/b.log'])
    }
  })

  it('拒绝会逃出归档的名字', () => {
    for (const name of ['/etc/passwd', '../x', 'a/../../b', '', 'n'.repeat(101)]) {
      expect(() => createTarGz([{ name, content: Buffer.alloc(0), mtime: 0 }]), name).toThrow()
    }
  })
})

describe('buildSupportBundle', () => {
  it('清单第一个，列出每个文件的大小、截断与不可用原因，以及脱敏计数', () => {
    const built = build([
      { kind: 'text', name: 'version.json', text: '{"tenon":"0.3.0"}\n' },
      { kind: 'unavailable', name: 'hook-timings.jsonl', reason: 'no hook timing records' },
    ])
    const entries = unpackTarGz(built.archive)
    expect(entries.map((entry) => entry.name)).toEqual([MANIFEST_NAME, 'version.json'])
    const manifest: unknown = JSON.parse(entries[0]?.content.toString() ?? '{}')
    expect(manifest).toMatchObject({
      schema: 'tenon-support-bundle/v1',
      created_at: AT,
      max_bytes: SUPPORT_BUNDLE_MAX_BYTES,
      entries: [
        { name: 'version.json', bytes: 18, original_bytes: 18, truncated: false },
        { name: 'hook-timings.jsonl', bytes: 0, original_bytes: 0, truncated: false, unavailable: 'no hook timing records' },
      ],
      not_included: ['project source'],
    })
    expect(built.entries.map((entry) => entry.name)).toEqual(['version.json', 'hook-timings.jsonl'])
  })

  it('进包前脱敏：凭证、cookie、邮箱、home 路径、用户名都不在任何一个文件里', () => {
    const secrets = [
      'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      '0123456789abcdef0123',
      'hunter2-password',
      'zhangsan@example.com',
      'ZHANGSAN-LAPTOP',
    ]
    const log = [
      '2026-10-01T10:00:00Z out   [dashboard-server] 登录链接：http://127.0.0.1:18765/session/start?code=Zm9vYmFyMTIzNDU2',
      `2026-10-01T10:00:01Z err   WARN: clone failed https://zhangsan:${secrets[3]}@github.com/x/y.git`,
      `2026-10-01T10:00:02Z err   Set-Cookie: tenon_session_18765=${secrets[2]}; Max-Age=604800`,
      `2026-10-01T10:00:03Z out   Authorization: Bearer ${secrets[0]}`,
      `2026-10-01T10:00:04Z out   key=${secrets[1]} owner ${secrets[4]} host ${secrets[5]} cwd /Users/zhangsan/work/app`,
    ].join('\n')
    const built = build([
      { kind: 'text', name: 'logs/dashboard.log', text: log, keep: 'tail' },
      { kind: 'text', name: 'config-summary.json', text: JSON.stringify({ roots: { state: '/Users/zhangsan/Library/tenon/state' } }) },
      { kind: 'unavailable', name: 'doctor.json', reason: 'probe failed in /Users/zhangsan/code with token=abc123def' },
    ])
    const everything = textOf(unpackTarGz(built.archive))
    for (const secret of [...secrets, 'Zm9vYmFyMTIzNDU2', 'abc123def', 'zhangsan']) {
      expect(everything, secret).not.toContain(secret)
    }
    expect(everything).toContain('~/work/app')
    expect(everything).toContain('/session/start?code=[REDACTED:token]')
    expect(totalRedactions(built.redactions)).toBeGreaterThanOrEqual(9)
    expect(built.redactions.email).toBe(1)
    expect(built.redactions['credential-url']).toBe(1)
  })

  it('日志超预算时留结尾（最近的才有用），标明截断，且截断后的内容同样已脱敏', () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `2026-10-01T10:00:00Z out   line-${String(index).padStart(4, '0')} /Users/zhangsan/x token=abc${index}`)
    const text = `${lines.join('\n')}\n`
    const built = build([{ kind: 'text', name: 'logs/dashboard.log', text, keep: 'tail', maxBytes: 20_000 }])
    const log = unpackTarGz(built.archive).find((entry) => entry.name === 'logs/dashboard.log')?.content.toString() ?? ''
    expect(built.entries[0]).toMatchObject({ name: 'logs/dashboard.log', truncated: true })
    expect(built.entries[0]?.originalBytes).toBeGreaterThan(100_000)
    expect(log.startsWith('[tenon] truncated: kept the last')).toBe(true)
    expect(log).toContain('line-1999')
    expect(log).not.toContain('line-0000')
    expect(log).not.toContain('zhangsan')
    expect(log).not.toMatch(/token=abc\d/u)
    // 截断从中间开始：第一行必须是完整的行。
    expect(log.split('\n')[1]).toMatch(/^2026-10-01T10:00:00Z out {3}line-\d{4}/u)
  })

  it('文本总预算按顺序分配：靠前的文件先拿，靠后的日志被截或丢到 0 字节', () => {
    const big = (label: string) => `${label}\n${`${'y'.repeat(999)}\n`.repeat(60)}`
    const built = build([
      { kind: 'text', name: 'a', text: big('a'), keep: 'tail' },
      { kind: 'text', name: 'b', text: big('b'), keep: 'tail' },
      { kind: 'text', name: 'c', text: big('c'), keep: 'tail' },
    ], { rawBudget: 100_000 })
    const [a, b, c] = built.entries
    expect(a?.truncated).toBe(false)
    expect(b?.truncated).toBe(true)
    expect(c?.truncated).toBe(true)
    expect((a?.bytes ?? 0) + (b?.bytes ?? 0) + (c?.bytes ?? 0)).toBeLessThanOrEqual(100_000 + 500)
  })

  it('压缩后超过 5 MiB 上限就收紧预算重来：真正不可压缩的 20 MB 日志也打不爆上限', () => {
    const random = randomBytes(15 * 1024 * 1024).toString('base64')
    const built = build([{ kind: 'text', name: 'logs/dashboard.log', text: random.replace(/(.{120})/gu, '$1\n'), keep: 'tail' }], {
      maxBytes: 1024 * 1024,
    })
    expect(built.archive.length).toBeLessThanOrEqual(1024 * 1024)
    expect(built.entries[0]?.truncated).toBe(true)
    const defaultCap = build([{ kind: 'text', name: 'logs/dashboard.log', text: random.replace(/(.{120})/gu, '$1\n'), keep: 'tail' }])
    expect(defaultCap.archive.length).toBeLessThanOrEqual(SUPPORT_BUNDLE_MAX_BYTES)
  })

  it('同一输入同一输出（时间戳取自 createdAt，不取系统时钟）', () => {
    const sources: BundleSource[] = [{ kind: 'text', name: 'version.json', text: '{}\n' }]
    expect(build(sources).archive.equals(build(sources).archive)).toBe(true)
  })
})
