import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addTrustEntries, readTrustStore, testTrustPaths, type TrustEntry } from './trust-store.js'

const execFileAsync = promisify(execFile)
const SLUG = 'a-at-x.io'
const roots: string[] = []

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-trust-store-'))
  roots.push(root)
  return root
}

function entry(index: number, overrides: Partial<TrustEntry> = {}): TrustEntry {
  const stamp = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString()
  return {
    repo: '/work/repo/.git', digest: `sha256:${String(index).padStart(64, '0')}`,
    command: `套件 s${index}  $ npm run t${index}`, by: 'a@x.io', at: stamp, ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('用户级测试信任存储', () => {
  it('没有文件读成空；写入后读回，路径在 <stateRoot>/test-trust/<slug>.json，密钥在同目录', async () => {
    const root = await stateRoot()
    expect(await readTrustStore(root, SLUG)).toEqual([])
    await addTrustEntries(root, SLUG, [entry(1), entry(2)])
    expect(await readTrustStore(root, SLUG)).toEqual([entry(1), entry(2)])
    const paths = testTrustPaths(root, SLUG)
    expect(paths).toEqual({ file: join(root, 'test-trust', `${SLUG}.json`), key: join(root, 'test-trust', `${SLUG}.key`) })
    expect((await readFile(paths.key, 'utf8')).trim()).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('文件与密钥是 0600，目录是 0700', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    const paths = testTrustPaths(root, SLUG)
    expect((await stat(paths.file)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.key)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'test-trust'))).mode & 0o777).toBe(0o700)
  })

  it('再次写入（含替换文件）后文件仍是 0600', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    await addTrustEntries(root, SLUG, [entry(2)])
    expect((await stat(testTrustPaths(root, SLUG).file)).mode & 0o777).toBe(0o600)
  })

  it('改一个字节：整份读成空（封印不符）', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    const { file } = testTrustPaths(root, SLUG)
    const forged = (await readFile(file, 'utf8')).replace('npm run t1', 'npm run t2')
    expect(forged).not.toBe(await readFile(file, 'utf8'))
    await writeFile(file, forged)
    expect(await readTrustStore(root, SLUG)).toEqual([])
  })

  it('另写一个条目但沿用旧封印：不被承认', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    const { file } = testTrustPaths(root, SLUG)
    const body = JSON.parse(await readFile(file, 'utf8')) as { entries: TrustEntry[]; mac: string }
    body.entries.push(entry(9))
    await writeFile(file, JSON.stringify(body))
    expect(await readTrustStore(root, SLUG)).toEqual([])
  })

  it('密钥缺失、被换、或不是普通文件：读成空', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    const { key } = testTrustPaths(root, SLUG)
    const original = await readFile(key, 'utf8')
    await writeFile(key, `${'0'.repeat(64)}\n`, { mode: 0o600 })
    expect(await readTrustStore(root, SLUG)).toEqual([])
    await rm(key)
    expect(await readTrustStore(root, SLUG)).toEqual([])
    await writeFile(key, original, { mode: 0o600 })
    expect(await readTrustStore(root, SLUG)).toEqual([entry(1)])
  })

  it('密钥对组或其他用户可读：失败关闭，读成空', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    const { key } = testTrustPaths(root, SLUG)
    await chmod(key, 0o644)
    expect(await readTrustStore(root, SLUG)).toEqual([])
    await chmod(key, 0o600)
    expect(await readTrustStore(root, SLUG)).toEqual([entry(1)])
  })

  // process.getuid 在原生 Windows 不存在：那里没有属主概念，产品也不支持原生 Windows，无从构造「别的用户」。
  it.skipIf(typeof process.getuid !== 'function')(
    '目录与密钥的属主不是当前用户（共享 stateRoot 里别人放进来的）：读成空，写入拒绝；属主对得上后读回正常',
    async () => {
      const root = await stateRoot()
      await addTrustEntries(root, SLUG, [entry(1)])
      const spy = vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1)
      try {
        expect(await readTrustStore(root, SLUG)).toEqual([])
        await expect(addTrustEntries(root, SLUG, [entry(2)])).rejects.toThrow('属主不是当前用户')
      } finally {
        spy.mockRestore()
      }
      expect(await readTrustStore(root, SLUG)).toEqual([entry(1)])
    },
  )

  it('存储文件是符号链接：读成空，写入拒绝', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    const { file } = testTrustPaths(root, SLUG)
    const elsewhere = join(root, 'elsewhere.json')
    await writeFile(elsewhere, await readFile(file, 'utf8'))
    await rm(file)
    await symlink(elsewhere, file)
    expect(await readTrustStore(root, SLUG)).toEqual([])
    await expect(addTrustEntries(root, SLUG, [entry(2)])).rejects.toThrow()
  })

  it('垃圾内容、空文件、过大的文件：读成空，永不抛错', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    const { file } = testTrustPaths(root, SLUG)
    for (const content of ['', 'not json', '[]', '{"schema":"x","entries":[],"mac":"00"}', 'x'.repeat(9 * 1024 * 1024)]) {
      await writeFile(file, content)
      expect(await readTrustStore(root, SLUG)).toEqual([])
    }
  })

  it('已被改动的存储再写入：从空起步，旧信任作废，新条目有效', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    const { file } = testTrustPaths(root, SLUG)
    await writeFile(file, (await readFile(file, 'utf8')).replace('npm run t1', 'npm run evil'))
    await addTrustEntries(root, SLUG, [entry(2)])
    expect(await readTrustStore(root, SLUG)).toEqual([entry(2)])
  })

  // root 与 Windows 不受 0o000 约束，读得出来就测不到读错误。
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '锁内读存储遇到 I/O 错误（读不了，既不是缺失也不是损坏）：抛错、不写盘，已有信任不被清空；读者仍读成空',
    async () => {
      const root = await stateRoot()
      await addTrustEntries(root, SLUG, [entry(1), entry(2)])
      const { file } = testTrustPaths(root, SLUG)
      await chmod(file, 0o000)
      try {
        expect(await readTrustStore(root, SLUG)).toEqual([])
        await expect(addTrustEntries(root, SLUG, [entry(3)])).rejects.toThrow()
      } finally {
        await chmod(file, 0o600)
      }
      expect(await readTrustStore(root, SLUG)).toEqual([entry(1), entry(2)])
      // 抛错没有留下锁：恢复读权限后下一次写入照常。
      await addTrustEntries(root, SLUG, [entry(3)])
      expect(await readTrustStore(root, SLUG)).toEqual([entry(1), entry(2), entry(3)])
    },
  )

  it('存储文件不存在或损坏（不是 I/O 错误）：写入从空起步', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    const { file } = testTrustPaths(root, SLUG)
    await rm(file)
    await addTrustEntries(root, SLUG, [entry(2)])
    expect(await readTrustStore(root, SLUG)).toEqual([entry(2)])
    await writeFile(file, 'not json')
    await addTrustEntries(root, SLUG, [entry(3)])
    expect(await readTrustStore(root, SLUG)).toEqual([entry(3)])
  })

  it('同一 (仓库, 摘要) 只记一条；摘要相同但仓库不同各自记', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    await addTrustEntries(root, SLUG, [entry(1, { command: '改过的显示文字', at: '2027-01-01T00:00:00.000Z' }), entry(1, { repo: '/other/.git' })])
    const read = await readTrustStore(root, SLUG)
    expect(read).toHaveLength(2)
    expect(read[0]).toEqual(entry(1))
    expect(read[1]?.repo).toBe('/other/.git')
  })

  it('超过 2000 条：保留最新的 2000 条，淘汰最旧的', async () => {
    const root = await stateRoot()
    const first = Array.from({ length: 1500 }, (_, index) => entry(index))
    const second = Array.from({ length: 501 }, (_, index) => entry(1500 + index))
    await addTrustEntries(root, SLUG, first)
    await addTrustEntries(root, SLUG, second)
    const read = await readTrustStore(root, SLUG)
    expect(read).toHaveLength(2000)
    expect(read.some((item) => item.digest === entry(0).digest)).toBe(false)
    expect(read.some((item) => item.digest === entry(1).digest)).toBe(true)
    expect(read.some((item) => item.digest === entry(2000).digest)).toBe(true)
  })

  it('按时间淘汰：晚写入但时间更早的条目先被淘汰', async () => {
    const root = await stateRoot()
    const recent = Array.from({ length: 2000 }, (_, index) => entry(10 + index))
    await addTrustEntries(root, SLUG, recent)
    await addTrustEntries(root, SLUG, [entry(0)])
    const read = await readTrustStore(root, SLUG)
    expect(read).toHaveLength(2000)
    expect(read.some((item) => item.digest === entry(0).digest)).toBe(false)
  })

  it('不同用户的存储互不可见', async () => {
    const root = await stateRoot()
    await addTrustEntries(root, SLUG, [entry(1)])
    expect(await readTrustStore(root, 'b-at-x.io')).toEqual([])
  })

  it('用户目录名不合法：抛错，不会逃出 test-trust 目录', () => {
    for (const slug of ['', '../x-at-y', 'a/b-at-c', 'no-separator', 'A-at-X']) {
      expect(() => testTrustPaths('/state', slug)).toThrow()
    }
  })

  it('进程内并发写：每个调用的条目都在，封印有效', async () => {
    const root = await stateRoot()
    await Promise.all(Array.from({ length: 12 }, (_, index) => addTrustEntries(root, SLUG, [entry(index)])))
    const read = await readTrustStore(root, SLUG)
    expect(read.map((item) => item.digest).sort()).toEqual(Array.from({ length: 12 }, (_, index) => entry(index).digest).sort())
    expect((await readdir(join(root, 'test-trust'))).sort()).toEqual([`${SLUG}.json`, `${SLUG}.key`])
  })

  it('两个真实进程同时写（两个 worktree 同时 tenon test trust）：条目都在，封印有效', async () => {
    const root = await stateRoot()
    const helper = join(process.cwd(), 'packages/kernel/src/test-system/trust-store.crossprocess.helper.ts')
    const viteNode = join(process.cwd(), 'node_modules/.bin/vite-node')
    const run = (from: number): Promise<unknown> => execFileAsync(viteNode, [helper, root, SLUG, String(from), '6'], { cwd: process.cwd(), env: process.env })
    await Promise.all([run(0), run(100)])
    const read = await readTrustStore(root, SLUG)
    expect(read).toHaveLength(12)
  }, 60_000)
})
