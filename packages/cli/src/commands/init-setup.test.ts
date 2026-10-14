import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTestSeal, sealRecordHead, sealSharedWrite, testSealPath, updateTestSeal, userSlug } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { inheritTrust, spawnSetup } from './init-setup.js'

const SLUG = userSlug('tester@tenon.test')
const OTHER_SLUG = userSlug('other@tenon.test')
const T1 = { digest: 'sha256:' + '1'.repeat(64), by: 'tester@tenon.test', at: '2026-01-01T00:00:00Z' }
const T2 = { digest: 'sha256:' + '2'.repeat(64), by: 'tester@tenon.test', at: '2026-01-02T00:00:00Z' }

describe('inheritTrust —— 把主检出里本用户的信任条目带进新 worktree 的封存', () => {
  const temps: string[] = []
  afterEach(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function tempRoot(): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'inherit-trust-')))
    temps.push(dir)
    return dir
  }

  /** 主检出的封存：两条信任，另有链头、共享文件写入记录与评审批准——后三类都不该被带走。 */
  async function sourceWithEverything(from: string): Promise<void> {
    await updateTestSeal(from, SLUG, (seal) => ({
      ...seal,
      trusted: [T1, T2],
      approvals: [{ change: 'demo', path: '.tenon/tests/known-failures.yaml', digest: 'sha256:abc', by: 'tester@tenon.test', at: '2026-01-03T00:00:00Z' }],
    }))
    await sealRecordHead(from, SLUG, 'demo', 'sha256:head')
    await sealSharedWrite(from, SLUG, [{ path: '.tenon/tests/baselines/x.json', digest: 'sha256:w' }], '2026-01-04T00:00:00Z')
  }

  test('只复制 trusted：approvals、writes、heads 都留空，返回复制的条目数', async () => {
    const from = await tempRoot()
    const to = await tempRoot()
    await sourceWithEverything(from)
    expect(await inheritTrust({ from, to, slug: SLUG })).toBe(2)
    const copied = await readTestSeal(to, SLUG)
    // 目标封存用目标自己的密钥封存，读回是有效的（不是把源文件原样拷过去）。
    expect(copied.state).toBe('ok')
    expect(copied.seal.trusted).toEqual([T1, T2])
    expect(copied.seal.approvals).toEqual([])
    expect(copied.seal.writes).toEqual({})
    expect(copied.seal.heads).toEqual({})
    // 源封存不受影响。
    const source = await readTestSeal(from, SLUG)
    expect(source.seal.trusted).toEqual([T1, T2])
    expect(source.seal.approvals).toHaveLength(1)
  })

  test('目标已有同一摘要的信任：不重复写，只数新增的', async () => {
    const from = await tempRoot()
    const to = await tempRoot()
    await sourceWithEverything(from)
    await updateTestSeal(to, SLUG, (seal) => ({ ...seal, trusted: [{ ...T1, by: 'someone@else.test' }] }))
    expect(await inheritTrust({ from, to, slug: SLUG })).toBe(1)
    const copied = await readTestSeal(to, SLUG)
    expect(copied.seal.trusted.map((entry) => entry.digest)).toEqual([T1.digest, T2.digest])
    expect(copied.seal.trusted[0]?.by).toBe('someone@else.test')
  })

  test('主检出没有封存：返回 0，不在目标创建封存文件', async () => {
    const from = await tempRoot()
    const to = await tempRoot()
    expect(await inheritTrust({ from, to, slug: SLUG })).toBe(0)
    expect(existsSync(testSealPath(to, SLUG))).toBe(false)
  })

  test('主检出封存没有信任条目：返回 0，不在目标创建封存文件', async () => {
    const from = await tempRoot()
    const to = await tempRoot()
    await sealRecordHead(from, SLUG, 'demo', 'sha256:head')
    expect(await inheritTrust({ from, to, slug: SLUG })).toBe(0)
    expect(existsSync(testSealPath(to, SLUG))).toBe(false)
  })

  test('主检出封存被改过（mac 不符）：按空封存处理，什么都不带走', async () => {
    const from = await tempRoot()
    const to = await tempRoot()
    await sourceWithEverything(from)
    const path = testSealPath(from, SLUG)
    const forged = (await readFile(path, 'utf8')).replace(T1.digest, 'sha256:' + 'f'.repeat(64))
    await writeFile(path, forged, 'utf8')
    expect(await inheritTrust({ from, to, slug: SLUG })).toBe(0)
    expect(existsSync(testSealPath(to, SLUG))).toBe(false)
  })

  test('只带本用户的信任：别的用户在主检出里的封存不会出现在目标', async () => {
    const from = await tempRoot()
    const to = await tempRoot()
    await updateTestSeal(from, OTHER_SLUG, (seal) => ({ ...seal, trusted: [T1] }))
    expect(await inheritTrust({ from, to, slug: SLUG })).toBe(0)
    expect(existsSync(testSealPath(to, OTHER_SLUG))).toBe(false)
    expect(existsSync(testSealPath(to, SLUG))).toBe(false)
  })
})

describe('spawnSetup —— 真执行器：输出逐行交给 log，退出码原样返回', () => {
  const temps: string[] = []
  afterEach(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function cwdDir(): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'spawn-setup-')))
    temps.push(dir)
    return dir
  }

  test('在 cwd 里执行；stdout 与 stderr 的行都进 log，没有换行结尾的最后一段也不丢；退出码 0', async () => {
    const cwd = await cwdDir()
    const lines: string[] = []
    const command = `node -e "console.log('out-1'); console.error('err-1'); process.stdout.write('tail-without-newline'); require('fs').writeFileSync('here','1')"`
    expect(await spawnSetup({ command, cwd, log: (line) => lines.push(line) })).toBe(0)
    expect([...lines].sort()).toEqual(['err-1', 'out-1', 'tail-without-newline'])
    expect(existsSync(join(cwd, 'here'))).toBe(true)
  })

  test('非零退出码原样返回，失败前的输出仍然交给 log', async () => {
    const cwd = await cwdDir()
    const lines: string[] = []
    const command = `node -e "console.error('about to fail'); process.exit(3)"`
    expect(await spawnSetup({ command, cwd, log: (line) => lines.push(line) })).toBe(3)
    expect(lines).toEqual(['about to fail'])
  })

  test('工作目录不存在：起不来，返回 127 并把原因交给 log，不抛错', async () => {
    const cwd = join(await cwdDir(), 'missing')
    const lines: string[] = []
    expect(await spawnSetup({ command: 'node -e "0"', cwd, log: (line) => lines.push(line) })).toBe(127)
    expect(lines.join('\n')).toMatch(/ENOENT/)
  })
})
