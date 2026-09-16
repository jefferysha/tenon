import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readActiveChange, writeActiveChange } from './active-change.js'
import { ensureUserLocalDir, userProjectPaths } from './user-paths.js'

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tenon-user-paths-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('userProjectPaths / ensureUserLocalDir', () => {
  it('derives every per-user path from the slug', () => {
    const root = join(repo, '.tenon', 'users', 'a-at-x.io')
    expect(userProjectPaths(repo, 'a-at-x.io')).toEqual({
      userRoot: root,
      testsDir: join(root, 'tests'),
      baselinesDir: join(root, 'baselines'),
      audit: join(root, 'audit.jsonl'),
      localDir: join(root, 'local'),
      activeChange: join(root, 'local', 'active-change'),
      authority: join(root, 'local', 'authority'),
      archived: join(root, 'local', 'archived.json'),
      localAudit: join(root, 'local', 'audit.jsonl'),
      deletingDir: join(root, 'local', 'deleting'),
      artifactsDir: join(root, 'local', 'artifacts'),
    })
    for (const bad of ['..', 'a-at-x/..', 'jeff', 'A-at-x.io', '']) {
      expect(() => userProjectPaths(repo, bad)).toThrow('用户目录名非法')
    }
  })

  it('creates .tenon/.gitignore once and never overwrites it', async () => {
    const paths = await ensureUserLocalDir(repo, 'a-at-x.io')
    expect(await readFile(join(repo, '.tenon', '.gitignore'), 'utf8')).toBe('users/*/local/\n')
    expect((await stat(paths.localDir)).mode & 0o777).toBe(0o700)
    await writeFile(join(repo, '.tenon', '.gitignore'), 'custom\n')
    await ensureUserLocalDir(repo, 'b-at-x.io')
    expect(await readFile(join(repo, '.tenon', '.gitignore'), 'utf8')).toBe('custom\n')
  })

  it('refuses a symlinked local directory', async () => {
    const outside = join(repo, 'outside')
    await mkdir(outside)
    await mkdir(join(repo, '.tenon', 'users', 'a-at-x.io'), { recursive: true })
    await symlink(outside, join(repo, '.tenon', 'users', 'a-at-x.io', 'local'))
    await expect(ensureUserLocalDir(repo, 'a-at-x.io')).rejects.toThrow('目录不是普通目录')
    await expect(writeActiveChange(repo, 'a-at-x.io', 'demo')).rejects.toThrow('目录不是普通目录')
    await writeFile(join(outside, 'active-change'), 'demo\n')
    expect(await readActiveChange(repo, 'a-at-x.io')).toBeNull()
  })
})

describe('active change pointer', () => {
  it('each user has an independent pointer', async () => {
    await writeActiveChange(repo, 'a-at-x.io', 'alpha')
    await writeActiveChange(repo, 'b-at-x.io', 'beta')
    expect(await readActiveChange(repo, 'a-at-x.io')).toBe('alpha')
    expect(await readActiveChange(repo, 'b-at-x.io')).toBe('beta')
    const file = userProjectPaths(repo, 'a-at-x.io').activeChange
    expect(await readFile(file, 'utf8')).toBe('alpha\n')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('absent or invalid content reads as null; an invalid name is never written', async () => {
    expect(await readActiveChange(repo, 'a-at-x.io')).toBeNull()
    const paths = await ensureUserLocalDir(repo, 'a-at-x.io')
    await writeFile(paths.activeChange, '../escape\n')
    expect(await readActiveChange(repo, 'a-at-x.io')).toBeNull()
    await expect(writeActiveChange(repo, 'a-at-x.io', 'bad/name')).rejects.toThrow('非法字符')
  })
})
