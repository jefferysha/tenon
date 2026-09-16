import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { countUncommittedTaskDeletions } from './uncommitted-deletions.js'

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
    expect(await countUncommittedTaskDeletions(plain, async () => ({ code: 128, stdout: '' }))).toBeNull()
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
