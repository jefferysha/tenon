import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { GitRunner } from './task-worktree.js'
import { listTaskWorktrees } from './task-worktree-list.js'

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

/** 测试用的 git 执行器：退出码非零不抛错（kernel 不自己起 git 进程）。 */
const runGit: GitRunner = (args, cwd) => new Promise((resolve) => {
  execFile('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
    resolve({ code, stdout, stderr })
  })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: GIT_ENV,
  })
}

function repoWithCommit(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'README.md'), 'x\n', 'utf8')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

/** 在 worktree 里放一个任务的状态（旧式 `.pipeline.yaml` 投影，足以让存在性判定成立）。 */
function seedChange(worktree: string, change: string): void {
  const dir = join(worktree, 'openspec', 'changes', change)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.pipeline.yaml'), 'phase: build\n', 'utf8')
}

let root: string
let repo: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tenon-task-worktree-list-'))
  repo = join(root, 'repo')
  repoWithCommit(repo)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('listTaskWorktrees', () => {
  test('只返回 .worktrees/ 下含任务的 worktree：普通 worktree 与 .worktrees/ 外的 worktree 都不算', async () => {
    const withTask = join(repo, '.worktrees', 'demo')
    const plain = join(repo, '.worktrees', 'plain')
    const outside = join(root, 'outside')
    git(repo, ['worktree', 'add', '-q', '-b', 'tenon/demo', withTask])
    git(repo, ['worktree', 'add', '-q', '-b', 'tenon/plain', plain])
    git(repo, ['worktree', 'add', '-q', '-b', 'tenon/outside', outside])
    seedChange(withTask, 'demo')
    seedChange(outside, 'elsewhere')

    expect(await listTaskWorktrees({ repoRoot: repo, git: runGit })).toEqual([
      { path: withTask, branch: 'tenon/demo', changes: ['demo'] },
    ])
  })

  test('主检出自己的任务不在结果里', async () => {
    seedChange(repo, 'main-task')
    expect(await listTaskWorktrees({ repoRoot: repo, git: runGit })).toEqual([])
  })

  test('一个 worktree 多个任务：按名排序；archive 目录与没有状态的目录不算', async () => {
    const worktree = join(repo, '.worktrees', 'demo')
    git(repo, ['worktree', 'add', '-q', '-b', 'tenon/demo', worktree])
    seedChange(worktree, 'zeta')
    seedChange(worktree, 'alpha')
    seedChange(worktree, 'archive')
    mkdirSync(join(worktree, 'openspec', 'changes', 'no-state'), { recursive: true })
    mkdirSync(join(worktree, 'openspec', 'changes', 'bad name'), { recursive: true })
    writeFileSync(join(worktree, 'openspec', 'changes', 'bad name', '.pipeline.yaml'), 'phase: build\n', 'utf8')
    writeFileSync(join(worktree, 'openspec', 'changes', 'note.md'), 'x\n', 'utf8')

    const [entry] = await listTaskWorktrees({ repoRoot: repo, git: runGit })
    expect(entry?.changes).toEqual(['alpha', 'zeta'])
  })

  test('任务状态在 .pipeline-run/current.json 里（新式存储）同样算', async () => {
    const worktree = join(repo, '.worktrees', 'demo')
    git(repo, ['worktree', 'add', '-q', '-b', 'tenon/demo', worktree])
    const runDir = join(worktree, 'openspec', 'changes', 'demo', '.pipeline-run')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'current.json'), '{}', 'utf8')

    const [entry] = await listTaskWorktrees({ repoRoot: repo, git: runGit })
    expect(entry?.changes).toEqual(['demo'])
  })

  test('repoRoot 是符号链接（macOS 的 /var 与 /private/var）：路径比较先 realpath，返回的路径沿用调用方给的根', async () => {
    const worktree = join(repo, '.worktrees', 'demo')
    git(repo, ['worktree', 'add', '-q', '-b', 'tenon/demo', worktree])
    seedChange(worktree, 'demo')
    const link = join(root, 'link')
    symlinkSync(repo, link)

    expect(await listTaskWorktrees({ repoRoot: link, git: runGit })).toEqual([
      { path: join(link, '.worktrees', 'demo'), branch: 'tenon/demo', changes: ['demo'] },
    ])
  })

  test('HEAD 分离的 worktree：分支为空串', async () => {
    const worktree = join(repo, '.worktrees', 'demo')
    git(repo, ['worktree', 'add', '-q', '--detach', worktree])
    seedChange(worktree, 'demo')

    expect(await listTaskWorktrees({ repoRoot: repo, git: runGit })).toEqual([
      { path: worktree, branch: '', changes: ['demo'] },
    ])
  })

  test('worktree 目录已被手动删掉（git 仍登记着）：跳过，不抛错', async () => {
    const worktree = join(repo, '.worktrees', 'demo')
    git(repo, ['worktree', 'add', '-q', '-b', 'tenon/demo', worktree])
    seedChange(worktree, 'demo')
    rmSync(worktree, { recursive: true, force: true })

    expect(await listTaskWorktrees({ repoRoot: repo, git: runGit })).toEqual([])
  })

  test('不是 git 仓库、没有 .worktrees、git 失败：都返回空数组', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(await listTaskWorktrees({ repoRoot: plain, git: runGit })).toEqual([])
    expect(await listTaskWorktrees({ repoRoot: repo, git: runGit })).toEqual([])
    expect(await listTaskWorktrees({ repoRoot: join(root, 'missing'), git: runGit })).toEqual([])
    const failing: GitRunner = async () => ({ code: 128, stdout: '', stderr: 'fatal' })
    expect(await listTaskWorktrees({ repoRoot: repo, git: failing })).toEqual([])
  })
})
