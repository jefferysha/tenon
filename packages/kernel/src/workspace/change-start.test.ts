import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isGitCommitId, readHeadCommit, usableBase, usableSha } from './change-start.js'

let repo = ''

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-change-start-')) })
afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

describe('start_sha 校验', () => {
  it('isGitCommitId 只接受 40 位（SHA-1）或 64 位（SHA-256）小写十六进制', () => {
    expect(isGitCommitId('a'.repeat(40))).toBe(true)
    expect(isGitCommitId('0123456789abcdef'.repeat(4))).toBe(true)
    for (const bad of ['', 'HEAD', 'main', '--all', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'A'.repeat(40), `${'a'.repeat(40)}\n`, `${'a'.repeat(39)}g`, ` ${'a'.repeat(40)}`]) {
      expect(isGitCommitId(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('usableSha / usableBase 把不可用的值归一成 undefined', () => {
    expect(usableSha('a'.repeat(40))).toBe('a'.repeat(40))
    expect(usableSha(undefined)).toBeUndefined()
    expect(usableSha('HEAD')).toBeUndefined()
    expect(usableBase(' main ')).toBe('main')
    for (const bad of ['', 'null', '--all', '-x']) expect(usableBase(bad), bad).toBeUndefined()
  })
})

describe('readHeadCommit', () => {
  it('有提交返回 HEAD；不是仓库、还没有提交都返回 undefined（不抛错）', async () => {
    expect(await readHeadCommit(repo)).toBeUndefined()
    git(['init', '-q', '-b', 'main'])
    expect(await readHeadCommit(repo)).toBeUndefined()
    await writeFile(join(repo, 'a.ts'), 'a\n', 'utf8')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'a'])
    expect(await readHeadCommit(repo)).toBe(git(['rev-parse', 'HEAD']).trim())
  })

  it('目录不存在也返回 undefined', async () => {
    expect(await readHeadCommit(join(repo, 'missing'))).toBeUndefined()
  })
})
