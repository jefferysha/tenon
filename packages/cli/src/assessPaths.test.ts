import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { normalizeRepoPath, repoPathChanges } from './assessPaths.js'

describe('normalizeRepoPath', () => {
  test.each([
    ['src/a.ts', 'src/a.ts'],
    ['./src/a.ts', 'src/a.ts'],
    ['src//nested/./a.ts', 'src/nested/a.ts'],
    ['src/dir/', 'src/dir'],
    ['.hidden/..not-parent/...', '.hidden/..not-parent/...'],
    ['目录/文件.ts', '目录/文件.ts'],
  ])('%j 规整为 %j', (input, expected) => {
    expect(normalizeRepoPath(input)).toEqual({ ok: true, path: expected })
  })

  test.each([
    ['', 'empty'],
    ['  \t', 'empty'],
    ['.', 'empty'],
    ['./', 'empty'],
    ['a\0b', 'nul'],
    ['/etc/passwd', 'absolute'],
    ['C:\\Users\\me\\a.ts', 'absolute'],
    ['c:/a.ts', 'absolute'],
    ['\\\\server\\share\\a.ts', 'absolute'],
    ['..', 'parent'],
    ['../a.ts', 'parent'],
    ['a/../../b.ts', 'parent'],
    ['a/..', 'parent'],
    ['a\\..\\b.ts', 'parent'],
  ])('%j 被拒绝：%s', (input, problem) => {
    expect(normalizeRepoPath(input)).toEqual({ ok: false, problem })
  })
})

describe('repoPathChanges 的存在判定', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'assess-paths-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export {}\n', 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const failing = (code: string): (() => Promise<never>) => async () => {
    throw Object.assign(new Error(`${code}: simulated`), { code })
  }

  test('存在的是 modified，不存在的是 added', async () => {
    expect(await repoPathChanges(root, ['src/a.ts', 'src/new.ts'])).toEqual({
      ok: true,
      changes: [{ path: 'src/a.ts', status: 'modified' }, { path: 'src/new.ts', status: 'added' }],
    })
  })

  test('把文件当目录用（ENOTDIR）也只是不存在', async () => {
    expect(await repoPathChanges(root, ['src/a.ts/inner.ts'])).toEqual({
      ok: true,
      changes: [{ path: 'src/a.ts/inner.ts', status: 'added' }],
    })
  })

  test.each(['ENOENT', 'ENOTDIR'])('探测报 %s 算不存在', async (code) => {
    expect(await repoPathChanges(root, ['src/a.ts'], failing(code))).toEqual({
      ok: true,
      changes: [{ path: 'src/a.ts', status: 'added' }],
    })
  })

  test.each(['EACCES', 'EIO', 'ELOOP'])('探测报 %s 不能当不存在：失败关闭并带出路径与原因', async (code) => {
    expect(await repoPathChanges(root, ['src/a.ts'], failing(code))).toEqual({
      ok: false, path: 'src/a.ts', problem: 'unreadable', reason: code,
    })
  })

  test('没有 errno 码的探测失败也失败关闭，原因取错误文本', async () => {
    const result = await repoPathChanges(root, ['src/a.ts'], async () => { throw new Error('boom') })

    expect(result).toEqual({ ok: false, path: 'src/a.ts', problem: 'unreadable', reason: 'boom' })
  })

  test('第一条读不出来的路径即返回，之前的结果不外泄', async () => {
    let calls = 0
    const probe = async (): Promise<void> => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }

    const result = await repoPathChanges(root, ['src/a.ts', 'src/b.ts', 'src/c.ts'], probe)

    expect(result).toEqual({ ok: false, path: 'src/b.ts', problem: 'unreadable', reason: 'EACCES' })
    expect(calls).toBe(2)
  })
})
