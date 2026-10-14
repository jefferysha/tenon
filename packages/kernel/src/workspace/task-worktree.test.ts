import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  TaskWorktreeConflictError,
  createTaskWorktree,
  planTaskWorktree,
  rollbackTaskWorktree,
  type GitRunner,
  type TaskWorktreePlan,
} from './task-worktree.js'

type CreatePlan = Extract<TaskWorktreePlan, { kind: 'create' }>

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

/** 测试用的 git 执行器：只给调用方传入（kernel 不自己起 git 进程），退出码非零不抛错。 */
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

function repoWithCommit(dir: string, gitignore?: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'README.md'), 'x\n', 'utf8')
  if (gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), gitignore, 'utf8')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

let root: string
let repo: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tenon-task-worktree-'))
  repo = join(root, 'repo')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function planCreate(change = 'demo'): Promise<CreatePlan> {
  const plan = await planTaskWorktree({ repoRoot: repo, change, inPlace: false, git: runGit })
  if (plan.kind !== 'create') throw new Error(`期望 create，实际 ${plan.reason}`)
  return plan
}

describe('planTaskWorktree', () => {
  test('main 上有提交：给出路径、分支、来源分支与 HEAD', async () => {
    repoWithCommit(repo)
    const plan = await planTaskWorktree({ repoRoot: repo, change: 'demo', inPlace: false, git: runGit })
    expect(plan).toEqual({
      kind: 'create',
      repoRoot: repo,
      path: join(repo, '.worktrees', 'demo'),
      branch: 'tenon/demo',
      sourceBranch: 'main',
      head: git(repo, ['rev-parse', 'HEAD']).trim(),
    })
  })

  test('不是 git 仓库：not-git', async () => {
    mkdirSync(repo, { recursive: true })
    expect(await planTaskWorktree({ repoRoot: repo, change: 'demo', inPlace: false, git: runGit }))
      .toEqual({ kind: 'in-place', reason: 'not-git' })
  })

  test('目录不存在：not-git，不抛错', async () => {
    expect(await planTaskWorktree({ repoRoot: join(root, 'missing'), change: 'demo', inPlace: false, git: runGit }))
      .toEqual({ kind: 'in-place', reason: 'not-git' })
  })

  test('仓库里的子目录不是项目根：not-git，原地建立不嵌套新建', async () => {
    repoWithCommit(repo)
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true })
    expect(await planTaskWorktree({ repoRoot: join(repo, 'packages', 'app'), change: 'demo', inPlace: false, git: runGit }))
      .toEqual({ kind: 'in-place', reason: 'not-git' })
  })

  test('git init 之后还没有提交：no-commits', async () => {
    mkdirSync(repo, { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    expect(await planTaskWorktree({ repoRoot: repo, change: 'demo', inPlace: false, git: runGit }))
      .toEqual({ kind: 'in-place', reason: 'no-commits' })
  })

  test('HEAD 分离：detached-head', async () => {
    repoWithCommit(repo)
    git(repo, ['checkout', '-q', '--detach'])
    expect(await planTaskWorktree({ repoRoot: repo, change: 'demo', inPlace: false, git: runGit }))
      .toEqual({ kind: 'in-place', reason: 'detached-head' })
  })

  test('当前目录本身是 linked worktree：linked-worktree，不嵌套', async () => {
    repoWithCommit(repo)
    const linked = join(root, 'linked')
    git(repo, ['worktree', 'add', '-q', '-b', 'feature', linked])
    expect(await planTaskWorktree({ repoRoot: linked, change: 'demo', inPlace: false, git: runGit }))
      .toEqual({ kind: 'in-place', reason: 'linked-worktree' })
  })

  test('inPlace:true：requested，连 git 都不必探测', async () => {
    const calls: string[][] = []
    const spying: GitRunner = (args, cwd) => { calls.push([...args]); return runGit(args, cwd) }
    expect(await planTaskWorktree({ repoRoot: repo, change: 'demo', inPlace: true, git: spying }))
      .toEqual({ kind: 'in-place', reason: 'requested' })
    expect(calls).toEqual([])
  })
})

describe('createTaskWorktree', () => {
  test('建好后 worktree list 含该路径与 tenon/demo 分支，worktree 的 HEAD 就是计划里的 HEAD', async () => {
    repoWithCommit(repo)
    const plan = await planCreate()
    await createTaskWorktree(plan, runGit)
    const listed = git(repo, ['worktree', 'list', '--porcelain'])
    expect(listed).toContain(`worktree ${realpathSync(plan.path)}`)
    expect(listed).toContain('branch refs/heads/tenon/demo')
    expect(git(plan.path, ['rev-parse', 'HEAD']).trim()).toBe(plan.head)
    expect(readFileSync(join(plan.path, 'README.md'), 'utf8')).toBe('x\n')
  })

  test('分支 tenon/demo 已存在：抛 TaskWorktreeConflictError，.worktrees/demo 不存在', async () => {
    repoWithCommit(repo)
    git(repo, ['branch', 'tenon/demo'])
    const plan = await planCreate()
    await expect(createTaskWorktree(plan, runGit)).rejects.toBeInstanceOf(TaskWorktreeConflictError)
    expect(existsSync(plan.path)).toBe(false)
  })

  test('.worktrees/demo 已是普通目录：抛冲突，目录内容不变，也没有留下分支', async () => {
    repoWithCommit(repo)
    const plan = await planCreate()
    mkdirSync(plan.path, { recursive: true })
    writeFileSync(join(plan.path, 'mine.txt'), '用户自己的文件\n', 'utf8')
    await expect(createTaskWorktree(plan, runGit)).rejects.toBeInstanceOf(TaskWorktreeConflictError)
    expect(readFileSync(join(plan.path, 'mine.txt'), 'utf8')).toBe('用户自己的文件\n')
    expect(git(repo, ['branch', '--list', 'tenon/demo']).trim()).toBe('')
  })

  test('.gitignore 不含 .worktrees/：写进 .git/info/exclude，主检出 git status 为空', async () => {
    repoWithCommit(repo)
    const plan = await planCreate()
    await createTaskWorktree(plan, runGit)
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain('.worktrees/')
    expect(git(repo, ['status', '--short']).trim()).toBe('')
  })

  test('exclude 文件末尾没有换行：新条目另起一行，已有内容保留', async () => {
    repoWithCommit(repo)
    mkdirSync(join(repo, '.git', 'info'), { recursive: true })
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.log', 'utf8')
    const plan = await planCreate()
    await createTaskWorktree(plan, runGit)
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe('*.log\n.worktrees/\n')
  })

  test('.gitignore 已忽略 .worktrees/：不动 .git/info/exclude', async () => {
    repoWithCommit(repo, '.worktrees/\n')
    const plan = await planCreate()
    await createTaskWorktree(plan, runGit)
    const exclude = join(repo, '.git', 'info', 'exclude')
    expect(!existsSync(exclude) || !readFileSync(exclude, 'utf8').includes('.worktrees/')).toBe(true)
    expect(git(repo, ['status', '--short']).trim()).toBe('')
  })

  test('git worktree add 失败：抛错，不留下 worktree 目录与分支', async () => {
    repoWithCommit(repo)
    const plan = { ...await planCreate(), head: 'f'.repeat(40) }
    await expect(createTaskWorktree(plan, runGit)).rejects.toThrow()
    expect(existsSync(plan.path)).toBe(false)
    expect(git(repo, ['branch', '--list', 'tenon/demo']).trim()).toBe('')
  })

  test('git 在检出阶段失败（排除文件是目录）：抛错，git 顺手留下的分支也清掉', async () => {
    repoWithCommit(repo)
    // git init 自带一份 exclude 文件；换成同名目录，worktree add 会建出分支后在检出阶段失败。
    rmSync(join(repo, '.git', 'info', 'exclude'), { force: true })
    mkdirSync(join(repo, '.git', 'info', 'exclude'), { recursive: true })
    const plan = await planCreate()
    await expect(createTaskWorktree(plan, runGit)).rejects.toThrow('git worktree add 失败')
    expect(existsSync(plan.path)).toBe(false)
    expect(git(repo, ['branch', '--list', 'tenon/demo']).trim()).toBe('')
    expect(git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
  })

  test.skipIf(process.getuid?.() === 0)('worktree 已建好但写不进 exclude（只读）：抛错并回滚刚建的 worktree 与分支', async () => {
    repoWithCommit(repo)
    const exclude = join(repo, '.git', 'info', 'exclude')
    writeFileSync(exclude, '*.log\n', 'utf8')
    chmodSync(exclude, 0o444)
    const plan = await planCreate()
    await expect(createTaskWorktree(plan, runGit)).rejects.toThrow(/EACCES/)
    expect(existsSync(plan.path)).toBe(false)
    expect(git(repo, ['branch', '--list', 'tenon/demo']).trim()).toBe('')
    expect(git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
  })
})

describe('rollbackTaskWorktree', () => {
  test('删除 worktree 目录（含里面的任务文件）与 tenon/demo 分支', async () => {
    repoWithCommit(repo)
    const plan = await planCreate()
    await createTaskWorktree(plan, runGit)
    mkdirSync(join(plan.path, 'openspec', 'changes', 'demo'), { recursive: true })
    writeFileSync(join(plan.path, 'openspec', 'changes', 'demo', '.pipeline.yaml'), 'phase: open\n', 'utf8')
    await rollbackTaskWorktree(plan, runGit)
    expect(existsSync(plan.path)).toBe(false)
    expect(git(repo, ['branch', '--list', 'tenon/demo']).trim()).toBe('')
    expect(git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
  })

  test('已经回滚过（什么都不剩）再回滚一次：不抛错', async () => {
    repoWithCommit(repo)
    const plan = await planCreate()
    await createTaskWorktree(plan, runGit)
    await rollbackTaskWorktree(plan, runGit)
    await expect(rollbackTaskWorktree(plan, runGit)).resolves.toBeUndefined()
  })
})
