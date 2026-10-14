import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mainCheckoutOf } from './main-checkout.js'

let root: string

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

function repoWithCommit(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'README.md'), 'x\n', 'utf8')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tenon-main-checkout-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('mainCheckoutOf', () => {
  test('linked worktree 里 → 主检出根（git 给出的真实路径）', async () => {
    const main = join(root, 'main')
    const linked = join(root, 'wt')
    repoWithCommit(main)
    git(main, ['worktree', 'add', '-q', '-b', 'tenon/demo', linked])
    expect(await mainCheckoutOf(linked)).toBe(realpathSync(main))
  })

  test('linked worktree 的子目录里也能找到主检出', async () => {
    const main = join(root, 'main')
    const linked = join(root, 'wt')
    repoWithCommit(main)
    git(main, ['worktree', 'add', '-q', '-b', 'tenon/demo', linked])
    mkdirSync(join(linked, 'sub'), { recursive: true })
    expect(await mainCheckoutOf(join(linked, 'sub'))).toBe(realpathSync(main))
  })

  test('就在主检出里 → undefined（没有另一个主检出）', async () => {
    const main = join(root, 'main')
    repoWithCommit(main)
    expect(await mainCheckoutOf(main)).toBeUndefined()
  })

  test('不是 git 仓库 → undefined，不抛错', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(await mainCheckoutOf(plain)).toBeUndefined()
  })

  test('目录不存在 → undefined，不抛错', async () => {
    expect(await mainCheckoutOf(join(root, 'missing'))).toBeUndefined()
  })

  test('裸仓库的 worktree：公共目录不叫 .git → undefined', async () => {
    const main = join(root, 'main')
    repoWithCommit(main)
    const bare = join(root, 'bare.git')
    execFileSync('git', ['clone', '-q', '--bare', main, bare], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    const linked = join(root, 'bare-wt')
    git(bare, ['worktree', 'add', '-q', linked, 'main'])
    expect(await mainCheckoutOf(linked)).toBeUndefined()
  })
})
