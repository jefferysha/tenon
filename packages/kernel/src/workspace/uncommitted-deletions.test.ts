import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  countUncommittedTaskDeletions, isProcessLocalFdPath, probeUncommittedTaskDeletions,
} from './uncommitted-deletions.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, maxBuffer: 65_536 })
}

async function seedChange(root: string, relative: string): Promise<void> {
  const dir = join(root, 'openspec', 'changes', relative)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'proposal.md'), `# ${relative}\n`, 'utf8')
  await writeFile(join(dir, 'tasks.md'), '- [ ] one\n', 'utf8')
}

async function repositoryWithTwoChanges(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-uncommitted-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await git(root, 'config', 'user.email', 'tenon-tests@example.invalid')
  await git(root, 'config', 'user.name', 'Tenon tests')
  await seedChange(root, 'add-login')
  await seedChange(root, 'add-signup')
  await seedChange(root, join('archive', 'old-change'))
  await git(root, 'add', '-A')
  await git(root, 'commit', '-qm', 'seed')
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('countUncommittedTaskDeletions', () => {
  it('counts a Change removed from the working tree only', async () => {
    const root = await repositoryWithTwoChanges()
    expect(await countUncommittedTaskDeletions(root)).toBe(0)
    await rm(join(root, 'openspec', 'changes', 'add-login'), { recursive: true, force: true })
    expect(await countUncommittedTaskDeletions(root)).toBe(1)
  })

  it('still counts a staged removal and stops counting after the commit', async () => {
    const root = await repositoryWithTwoChanges()
    await git(root, 'rm', '-r', '-q', 'openspec/changes/add-login')
    expect(await countUncommittedTaskDeletions(root)).toBe(1)
    await git(root, 'commit', '-qm', 'delete add-login')
    expect(await countUncommittedTaskDeletions(root)).toBe(0)
  })

  it('counts each Change once and ignores a surviving directory or the archive', async () => {
    const root = await repositoryWithTwoChanges()
    await rm(join(root, 'openspec', 'changes', 'add-login'), { recursive: true, force: true })
    await rm(join(root, 'openspec', 'changes', 'add-signup', 'tasks.md'))
    await rm(join(root, 'openspec', 'changes', 'archive', 'old-change'), { recursive: true, force: true })
    expect(await countUncommittedTaskDeletions(root)).toBe(1)
  })

  it('reports null outside a git repository and when git fails', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'tenon-uncommitted-plain-'))
    roots.push(plain)
    expect(await countUncommittedTaskDeletions(plain)).toBeNull()
    const repo = await repositoryWithTwoChanges()
    expect(await countUncommittedTaskDeletions(repo, async () => ({ code: 128, stdout: '' }))).toBeNull()
  })

  it('skips the source path of a rename entry', async () => {
    const root = await repositoryWithTwoChanges()
    const runner = async (): Promise<{ code: number; stdout: string }> => ({
      code: 0,
      stdout: 'R  openspec/changes/kept/proposal.md\0openspec/changes/gone/proposal.md\0 D openspec/changes/add-login/tasks.md\0',
    })
    expect(await countUncommittedTaskDeletions(root, runner)).toBe(0)
    await rm(join(root, 'openspec', 'changes', 'add-login'), { recursive: true, force: true })
    expect(await countUncommittedTaskDeletions(root, runner)).toBe(1)
  })
})
describe('probeUncommittedTaskDeletions', () => {
  it('separates "no repository here" from "the probe failed", and quotes git', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'tenon-probe-plain-'))
    roots.push(plain)
    const absent = await probeUncommittedTaskDeletions(plain)
    expect(absent.kind).toBe('absent')
    expect(absent.kind === 'absent' && absent.reason).toContain(plain)

    const repo = await repositoryWithTwoChanges()
    expect(await probeUncommittedTaskDeletions(repo)).toEqual({ kind: 'ok', count: 0 })

    const failed = await probeUncommittedTaskDeletions(repo, async () => ({
      code: 128, stdout: '', stderr: 'fatal: not a git repository\n',
    }))
    expect(failed.kind).toBe('unavailable')
    expect(failed.kind === 'unavailable' && failed.reason).toContain('128')
    expect(failed.kind === 'unavailable' && failed.reason).toContain('fatal: not a git repository')
  })

  /**
   * A `/proc/self/fd/<n>` path is an entry in *this* process's descriptor table; a spawned git resolves it
   * against its own table and fails with a misleading ENOENT. Refusing it by name is what turns that
   * Linux-only silence into a reason a caller can print.
   */
  it('refuses a process-local fd path by name instead of spawning git against it', async () => {
    let spawned = 0
    const runner = async (): Promise<{ code: number; stdout: string }> => {
      spawned += 1
      return { code: 0, stdout: '' }
    }
    for (const path of ['/proc/self/fd/18', '/proc/4121/fd/7', '/dev/fd/3', '/proc/self/fd/18/openspec']) {
      expect(isProcessLocalFdPath(path)).toBe(true)
      const probe = await probeUncommittedTaskDeletions(path, runner)
      expect(probe.kind).toBe('unavailable')
      expect(probe.kind === 'unavailable' && probe.reason).toContain(path)
      expect(await countUncommittedTaskDeletions(path, runner)).toBeNull()
    }
    expect(spawned).toBe(0)

    for (const path of ['/tmp/repo', '/dev/fdx/3', '/home/a/proc/self/fd/2', '/dev/fd/abc']) {
      expect(isProcessLocalFdPath(path)).toBe(false)
    }
  })
})
