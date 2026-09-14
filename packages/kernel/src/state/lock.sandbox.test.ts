import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Codex's workspace-write sandbox denies /bin/ps (macOS) and a restricted /proc hides process start
// times (Linux). Simulate both so the lock cannot read any process start identity; every other file
// access stays real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: (command: string, ...rest: unknown[]) => String(command).endsWith('/ps')
      ? { status: null, stdout: '', stderr: '', error: Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }) }
      : (actual.spawnSync as (...args: unknown[]) => unknown)(command, ...rest),
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (file: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => String(file).startsWith('/proc/')
      ? Promise.reject(Object.assign(new Error('Operation not permitted'), { code: 'EACCES' }))
      : (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest),
  }
})

const { LOCK_DIR_NAME, LOCK_OWNER_FILE, withLock } = await import('./lock.js')

describe('withLock when no process start identity can be read', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tenon-lock-sandbox-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('still takes the lock, records only the pid, and releases it', async () => {
    let owner: Record<string, unknown> | undefined
    const result = await withLock(dir, async () => {
      owner = JSON.parse(await readFile(path.join(dir, LOCK_DIR_NAME, LOCK_OWNER_FILE), 'utf8')) as Record<string, unknown>
      return 'locked'
    })
    expect(result).toBe('locked')
    expect(owner).toMatchObject({ version: 1, pid: process.pid })
    expect(owner).not.toHaveProperty('pidStart')
    await expect(stat(path.join(dir, LOCK_DIR_NAME))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent holders without start identities', async () => {
    const order: string[] = []
    await Promise.all(['a', 'b'].map((id) => withLock(dir, async () => {
      order.push(`${id}:enter`)
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push(`${id}:exit`)
    })))
    expect(order).toHaveLength(4)
    expect(order[1]).toBe(`${order[0]?.split(':')[0]}:exit`)
  })
})
