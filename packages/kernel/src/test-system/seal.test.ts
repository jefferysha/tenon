import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { userProjectPaths } from '../users/user-paths.js'
import {
  EMPTY_TEST_SEAL, isApproved, isTrusted, readTestSeal, sealRecordHead, sealSharedWrite, testSealPath, updateTestSeal,
} from './seal.js'

const SLUG = 'a-at-x.io'
const roots: string[] = []

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-seal-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('本机封存文件', () => {
  it('没有文件读成空封存；写入后读回，四类内容各自保留', async () => {
    const root = await repo()
    expect(await readTestSeal(root, SLUG)).toEqual({ state: 'missing', seal: EMPTY_TEST_SEAL })
    await sealRecordHead(root, SLUG, 'demo', 'sha256:head')
    await sealSharedWrite(root, SLUG, [{ path: '.tenon/tests/known-failures.yaml', digest: 'sha256:kf' }], '2026-10-01T00:00:00Z')
    await updateTestSeal(root, SLUG, (seal) => ({
      ...seal,
      approvals: [{ change: 'demo', path: '.tenon/tests/catalog.yaml', digest: 'sha256:c1', by: 'a@x.io', at: '2026-10-01T00:00:00Z' }],
      trusted: [{ digest: 'sha256:exec', by: 'a@x.io', at: '2026-10-01T00:00:00Z' }],
    }))
    const read = await readTestSeal(root, SLUG)
    expect(read.state).toBe('ok')
    expect(read.seal.heads).toEqual({ demo: 'sha256:head' })
    expect(read.seal.writes['.tenon/tests/known-failures.yaml']?.digest).toBe('sha256:kf')
    expect(isApproved(read.seal, 'demo', '.tenon/tests/catalog.yaml', 'sha256:c1')).toBe(true)
    expect(isApproved(read.seal, 'other', '.tenon/tests/catalog.yaml', 'sha256:c1')).toBe(false)
    expect(isApproved(read.seal, 'demo', '.tenon/tests/catalog.yaml', 'sha256:c2')).toBe(false)
    expect(isTrusted(read.seal, 'sha256:exec')).toBe(true)
    expect(isTrusted(read.seal, 'sha256:other')).toBe(false)
  })

  it('文件与密钥都是 0600 的本机文件，路径在 gitignored 的 local 目录', async () => {
    const root = await repo()
    await sealRecordHead(root, SLUG, 'demo', 'sha256:h')
    const paths = userProjectPaths(root, SLUG)
    expect(testSealPath(root, SLUG)).toBe(join(paths.localDir, 'test-seal.json'))
    expect((await readFile(paths.envKey, 'utf8')).trim()).toMatch(/^[a-f0-9]{64}$/)
    const { stat } = await import('node:fs/promises')
    expect((await stat(paths.envKey)).mode & 0o777).toBe(0o600)
  })

  it('内容被改动（哪怕只改一个摘要）就整份不被承认：信任、批准、链头全部作废', async () => {
    const root = await repo()
    await sealRecordHead(root, SLUG, 'demo', 'sha256:real')
    const path = testSealPath(root, SLUG)
    const forged = (await readFile(path, 'utf8')).replace('sha256:real', 'sha256:forged')
    await writeFile(path, forged)
    expect(await readTestSeal(root, SLUG)).toEqual({ state: 'invalid', seal: EMPTY_TEST_SEAL })
  })

  it('有人往封存里塞一条批准并保留旧 mac：不被承认', async () => {
    const root = await repo()
    await sealRecordHead(root, SLUG, 'demo', 'sha256:h')
    const path = testSealPath(root, SLUG)
    const body = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    body.approvals = [{ change: 'demo', path: '.tenon/tests/known-failures.yaml', digest: 'sha256:x', by: 'agent', at: 't' }]
    await writeFile(path, JSON.stringify(body))
    const read = await readTestSeal(root, SLUG)
    expect(read.state).toBe('invalid')
    expect(read.seal.approvals).toEqual([])
  })

  it('密钥被换、文件损坏、不是对象：都读成空封存，不抛错', async () => {
    const root = await repo()
    await sealRecordHead(root, SLUG, 'demo', 'sha256:h')
    const paths = userProjectPaths(root, SLUG)
    await writeFile(paths.envKey, 'another-key\n')
    expect((await readTestSeal(root, SLUG)).state).toBe('invalid')
    await writeFile(testSealPath(root, SLUG), '{not json')
    expect((await readTestSeal(root, SLUG)).state).toBe('invalid')
    await writeFile(testSealPath(root, SLUG), '[]')
    expect((await readTestSeal(root, SLUG)).state).toBe('invalid')
  })

  it('封存不可信时下一次写入从空封存起步（旧批准作废），并重新封存', async () => {
    const root = await repo()
    await updateTestSeal(root, SLUG, (seal) => ({ ...seal, trusted: [{ digest: 'sha256:old', by: 'a', at: 't' }] }))
    await writeFile(testSealPath(root, SLUG), '{broken')
    await sealRecordHead(root, SLUG, 'demo', 'sha256:new')
    const read = await readTestSeal(root, SLUG)
    expect(read.state).toBe('ok')
    expect(read.seal.trusted).toEqual([])
    expect(read.seal.heads).toEqual({ demo: 'sha256:new' })
  })

  it('并发写入不丢更新', async () => {
    const root = await repo()
    await Promise.all(Array.from({ length: 8 }, (_, index) => sealRecordHead(root, SLUG, `c${index}`, `sha256:h${index}`)))
    const read = await readTestSeal(root, SLUG)
    expect(Object.keys(read.seal.heads).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `c${index}`))
  })
})
