import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsRm = vi.hoisted(() => vi.fn<(path: unknown, options?: unknown) => Promise<void>>(async () => undefined))
const realRm = vi.hoisted(() => ({ current: undefined as undefined | ((path: string, options?: object) => Promise<void>) }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  realRm.current = actual.rm
  return { ...actual, rm: fsRm }
})

const { rm } = await import('./integration-harness.js')

describe('integration harness rm', () => {
  beforeEach(() => {
    fsRm.mockClear()
    fsRm.mockImplementation(async () => undefined)
  })

  it('递归清理默认带重试：ENOTEMPTY 的收尾写竞争由 rm 自己重试掉', async () => {
    await rm('/tmp/some-dir', { recursive: true, force: true })
    expect(fsRm).toHaveBeenCalledWith('/tmp/some-dir', { maxRetries: 10, retryDelay: 100, recursive: true, force: true })
  })

  it('调用方显式传的重试选项优先', async () => {
    await rm('/tmp/some-dir', { recursive: true, maxRetries: 0, retryDelay: 1 })
    expect(fsRm).toHaveBeenCalledWith('/tmp/some-dir', { maxRetries: 0, retryDelay: 1, recursive: true })
  })

  it('不吞错：底层失败原样抛出', async () => {
    fsRm.mockRejectedValueOnce(Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' }))
    await expect(rm('/tmp/some-dir', { recursive: true })).rejects.toMatchObject({ code: 'ENOTEMPTY' })
  })

  it('落到真实文件系统：目录树被删净，缺失路径在 force 下不报错', async () => {
    fsRm.mockImplementation(async (path, options) => realRm.current?.(String(path), options as object))
    const dir = await mkdtemp(join(tmpdir(), 'harness-rm-'))
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    await writeFile(join(dir, 'a', 'b', 'c.txt'), 'x', 'utf8')
    await rm(dir, { recursive: true, force: true })
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(rm(dir, { recursive: true, force: true })).resolves.toBeUndefined()
  })
})
