import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCK_DIR_NAME } from './lock.js'
import { withProjectCoordinationLock } from './project-lock.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pl-project-lock-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('withProjectCoordinationLock（项目级协调锁：<repo>/.pipeline 目录锁）', () => {
  it('锁的是 <repo>/.pipeline/.pipeline.lock/，目录不存在时先建；执行中持有、结束后释放，透传返回值', async () => {
    const lockDir = path.join(root, '.pipeline', LOCK_DIR_NAME)
    const result = await withProjectCoordinationLock(root, async () => {
      expect((await stat(lockDir)).isDirectory()).toBe(true)
      return 7
    })
    expect(result).toBe(7)
    await expect(stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('回调抛错时仍释放锁', async () => {
    await expect(withProjectCoordinationLock(root, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(stat(path.join(root, '.pipeline', LOCK_DIR_NAME))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('同一仓库的两段临界区不交错（server 的 workflow 删除 / 保存靠它与建任务互斥）', async () => {
    const events: string[] = []
    await Promise.all([
      withProjectCoordinationLock(root, async () => {
        events.push('first-in')
        await new Promise((resolve) => setTimeout(resolve, 60))
        events.push('first-out')
      }),
      withProjectCoordinationLock(root, async () => {
        events.push('second-in')
        events.push('second-out')
      }),
    ])
    // 谁先拿到锁取决于两边 mkdir 的完成顺序；互斥只要求两段临界区各自连续、不交错。
    expect([
      ['first-in', 'first-out', 'second-in', 'second-out'],
      ['second-in', 'second-out', 'first-in', 'first-out'],
    ]).toContainEqual(events)
  })
})
