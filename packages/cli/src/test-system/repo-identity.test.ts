import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repoTrustIdentity } from './repo-identity.js'

const roots: string[] = []

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GIT_')) env[name] = value
  return env
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-repo-identity-')))
  roots.push(root)
  return root
}

/** 一个有一次提交的仓库。 */
async function repo(parent: string, name = 'main'): Promise<string> {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

/** 从 `start` 起到文件系统根，哪一级有 `.git`（文件、目录、链接都算）；都没有 = undefined。 */
async function gitAncestor(start: string): Promise<string | undefined> {
  for (let dir = start; ; dir = dirname(dir)) {
    try {
      await lstat(join(dir, '.git'))
      return dir
    } catch {
      if (dirname(dir) === dir) return undefined
    }
  }
}

const repoOf = (path: string): { readonly kind: 'repo'; readonly repo: string } => ({ kind: 'repo', repo: path })
const UNRESOLVED = { kind: 'unresolved' } as const
const NOT_REPO = { kind: 'not-repo' } as const

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('repoTrustIdentity：信任按仓库，不按检出目录', () => {
  it('主检出的身份是 git common dir 的真实路径', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    expect(await repoTrustIdentity(main)).toEqual(repoOf(join(main, '.git')))
  })

  it('主检出与 git worktree add 出来的 worktree 是同一个身份', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    const linked = join(parent, 'linked')
    git(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
    expect(await repoTrustIdentity(linked)).toEqual(await repoTrustIdentity(main))
    expect(await repoTrustIdentity(linked)).toEqual(repoOf(join(main, '.git')))
  })

  it('两个不同的仓库身份不同', async () => {
    const parent = await scratch()
    const first = await repo(parent, 'one')
    const second = await repo(parent, 'two')
    expect(await repoTrustIdentity(first)).not.toEqual(await repoTrustIdentity(second))
  })

  it('子目录 cwd：取所在检出的身份（主检出与 worktree 都一样）', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    await mkdir(join(main, 'src', 'deep'), { recursive: true })
    const linked = join(parent, 'linked')
    git(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
    await mkdir(join(linked, 'pkg'), { recursive: true })
    const expected = repoOf(join(main, '.git'))
    expect(await repoTrustIdentity(join(main, 'src', 'deep'))).toEqual(expected)
    expect(await repoTrustIdentity(join(linked, 'pkg'))).toEqual(expected)
  })

  it('伪造的检出：手写 .git 文件指向该仓库的 common dir，但检出根不在 worktree 列表里 → 读不出身份', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    const forged = join(parent, 'forged')
    await mkdir(forged)
    await writeFile(join(forged, '.git'), `gitdir: ${join(main, '.git')}\n`)
    await writeFile(join(forged, 'evil.txt'), 'x\n')
    // 前提：git 自己把它当作这个仓库的检出，所以这是借用而不是普通的非仓库目录。
    expect(git(forged, 'rev-parse', '--git-common-dir').trim()).toBe(join(main, '.git'))
    expect(await repoTrustIdentity(forged)).toEqual(UNRESOLVED)
    await mkdir(join(forged, 'sub'))
    expect(await repoTrustIdentity(join(forged, 'sub'))).toEqual(UNRESOLVED)
  })

  it('伪造的检出：.git 文件指向某个真实 worktree 的管理目录，但路径不是登记的那个 → 读不出身份', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    const linked = join(parent, 'linked')
    git(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
    const admin = git(linked, 'rev-parse', '--absolute-git-dir').trim()
    const forged = join(parent, 'forged')
    await mkdir(forged)
    await writeFile(join(forged, '.git'), `gitdir: ${admin}\n`)
    expect(await repoTrustIdentity(forged)).toEqual(UNRESOLVED)
    // 真实的那个不受影响。
    expect(await repoTrustIdentity(linked)).toEqual(repoOf(join(main, '.git')))
  })

  it('worktree 目录被直接删掉后留下 prunable 条目：不影响主检出；同一路径上新放的伪造目录仍读不出身份', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    const doomed = join(parent, 'doomed')
    git(main, 'worktree', 'add', '-q', '-b', 'doomed', doomed)
    await rm(doomed, { recursive: true, force: true })
    const listing = git(main, 'worktree', 'list', '--porcelain')
    expect(listing).toContain(doomed)
    expect(await repoTrustIdentity(main)).toEqual(repoOf(join(main, '.git')))
    // 目录不存在：有没有 .git 判不了，按有处理。
    expect(await repoTrustIdentity(doomed)).toEqual(UNRESOLVED)
    await mkdir(doomed)
    await writeFile(join(doomed, '.git'), `gitdir: ${join(main, '.git')}\n`)
    expect(await repoTrustIdentity(doomed)).toEqual(UNRESOLVED)
  })

  it('.git 文件内容损坏（git 自己也读不了）：读不出身份，不当成非仓库', async () => {
    const parent = await scratch()
    const broken = join(parent, 'broken')
    await mkdir(broken)
    await writeFile(join(broken, '.git'), 'this is not a gitfile\n')
    expect(await repoTrustIdentity(broken)).toEqual(UNRESOLVED)
  })

  it('检出目录及其所有上级都没有 .git：不是 git 仓库', async (context) => {
    const parent = await scratch()
    const plain = join(parent, 'plain')
    await mkdir(join(plain, 'sub'), { recursive: true })
    const ancestor = await gitAncestor(plain)
    if (ancestor !== undefined) context.skip(`临时目录的上级 ${ancestor} 有 .git，这台机器上造不出「不是 git 仓库」的夹具`)
    expect(await repoTrustIdentity(plain)).toEqual(NOT_REPO)
    expect(await repoTrustIdentity(join(plain, 'sub'))).toEqual(NOT_REPO)
  })

  it('目录不存在：读不出身份（失败关闭），不是「不是仓库」', async () => {
    const parent = await scratch()
    expect(await repoTrustIdentity(join(parent, 'missing'))).toEqual(UNRESOLVED)
  })

  it('上级有 .git 的普通子目录不算「不是仓库」：身份取上级仓库', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    const nested = join(main, 'a', 'b')
    await mkdir(nested, { recursive: true })
    expect(await repoTrustIdentity(nested)).toEqual(repoOf(join(main, '.git')))
  })

  it('有 .git 目录、但 PATH 里找不到 git：读不出身份（不退回旧封存）', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    const empty = join(parent, 'empty-bin')
    await mkdir(empty)
    const savedPath = process.env.PATH
    try {
      process.env.PATH = empty
      expect(await repoTrustIdentity(main)).toEqual(UNRESOLVED)
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
    }
    expect(await repoTrustIdentity(main)).toEqual(repoOf(join(main, '.git')))
  })

  it('裸仓库目录里没有 .git（它自己就是 git dir）：按规则不是「有 .git 的检出」', async (context) => {
    const parent = await scratch()
    const bare = join(parent, 'bare.git')
    git(parent, 'init', '-q', '--bare', bare)
    const ancestor = await gitAncestor(bare)
    if (ancestor !== undefined) context.skip(`临时目录的上级 ${ancestor} 有 .git，这台机器上造不出「不是 git 仓库」的夹具`)
    expect(await repoTrustIdentity(bare)).toEqual(NOT_REPO)
  })

  it('路径写法不同（符号链接别名）得到同一个身份，且是真实路径', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    const alias = join(parent, 'alias')
    await symlink(main, alias)
    expect(await repoTrustIdentity(alias)).toEqual(repoOf(join(main, '.git')))
    await mkdir(join(main, 'src'))
    expect(await repoTrustIdentity(join(alias, 'src'))).toEqual(repoOf(join(main, '.git')))
  })

  it.runIf(process.platform === 'darwin')('macOS 的 /var 与 /private/var 两种写法得到同一个身份', async () => {
    const parent = await scratch()
    const main = await repo(parent)
    expect(main.startsWith('/private/var/')).toBe(true)
    const logical = main.replace(/^\/private\/var\//u, '/var/')
    expect(logical).not.toBe(main)
    expect(await repoTrustIdentity(logical)).toEqual(await repoTrustIdentity(main))
    expect(await repoTrustIdentity(logical)).toEqual(repoOf(join(main, '.git')))
  })

  it('路径含空格与中文：照常识别', async () => {
    const parent = await scratch()
    const main = await repo(parent, '带 空格 的 仓库')
    const linked = join(parent, '另一个 worktree')
    git(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
    expect(await repoTrustIdentity(main)).toEqual(repoOf(join(main, '.git')))
    expect(await repoTrustIdentity(linked)).toEqual(repoOf(join(main, '.git')))
  })

  it('环境里的 GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE / GIT_CONFIG_* 不能把身份指到别处', async () => {
    const parent = await scratch()
    const trusted = await repo(parent, 'trusted')
    const other = await repo(parent, 'other')
    const names = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
    const saved = names.map((name) => [name, process.env[name]] as const)
    try {
      process.env.GIT_DIR = join(trusted, '.git')
      process.env.GIT_COMMON_DIR = join(trusted, '.git')
      process.env.GIT_WORK_TREE = trusted
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.worktree'
      process.env.GIT_CONFIG_VALUE_0 = trusted
      expect(await repoTrustIdentity(other)).toEqual(repoOf(join(other, '.git')))
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
