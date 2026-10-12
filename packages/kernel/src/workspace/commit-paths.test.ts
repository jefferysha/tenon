/**
 * 只提交给定路径：别处已暂存的、未暂存的、未跟踪的改动一概不进这次提交。真 git、真临时仓库。
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitOnlyPaths } from './commit-paths.js'
import { gitStatusRunner } from './uncommitted-deletions.js'

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tenon-commit-paths-'))
  git('init', '-q')
  git('config', 'user.email', 'tenon-tests@example.invalid')
  git('config', 'user.name', 'Tenon tests')
  await mkdir(join(repo, 'a'), { recursive: true })
  await writeFile(join(repo, 'a', 'one.txt'), 'one\n', 'utf8')
  await writeFile(join(repo, 'other.txt'), 'other\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'seed')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('commitOnlyPaths', () => {
  it('提交这些路径的改动（含新文件与删除），别处的改动原样留着', async () => {
    await writeFile(join(repo, 'a', 'one.txt'), 'changed\n', 'utf8')
    await writeFile(join(repo, 'a', 'new.txt'), 'new\n', 'utf8')
    await writeFile(join(repo, 'other.txt'), 'edited elsewhere\n', 'utf8')
    await writeFile(join(repo, 'staged.txt'), 'staged\n', 'utf8')
    git('add', 'staged.txt')
    expect(await commitOnlyPaths(repo, gitStatusRunner, ['a'], 'chore: only a')).toEqual({ kind: 'committed' })
    expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').filter((line) => line !== '').sort())
      .toEqual(['a/new.txt', 'a/one.txt'])
    const status = git('status', '--porcelain')
    expect(status).toContain(' M other.txt')
    expect(status).toContain('A  staged.txt')
  })

  it('路径下没有可提交的改动 → skipped，不产生空提交', async () => {
    const head = git('rev-parse', 'HEAD')
    const outcome = await commitOnlyPaths(repo, gitStatusRunner, ['a'], 'chore: nothing')
    expect(outcome).toMatchObject({ kind: 'skipped' })
    expect(git('rev-parse', 'HEAD')).toBe(head)
  })

  it('没有路径、或不是 git 仓库 → skipped', async () => {
    expect(await commitOnlyPaths(repo, gitStatusRunner, [], 'chore: none')).toMatchObject({ kind: 'skipped' })
    const plain = await mkdtemp(join(tmpdir(), 'tenon-not-a-repo-'))
    try {
      expect(await commitOnlyPaths(plain, gitStatusRunner, ['a'], 'chore: none')).toMatchObject({ kind: 'skipped' })
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('git add 失败（路径不存在）→ failed 并带出 git 的话', async () => {
    const outcome = await commitOnlyPaths(repo, gitStatusRunner, ['no-such-dir'], 'chore: missing')
    expect(outcome).toMatchObject({ kind: 'failed', detail: expect.stringContaining('git add') })
  })
})
