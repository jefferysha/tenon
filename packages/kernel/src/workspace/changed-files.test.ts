import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangedFilesUnavailableError, changeStartOfFields, changedFilesForState, changedFilesResultForState,
  changedFilesSinceChangeStart, changedLinesSinceChangeStart, createChangedFilesSession, parseAddedLines,
  resolveChangeStart, type ChangedFilesSessionOptions,
} from './changed-files.js'

let repo = ''

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  })
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true })
  await writeFile(join(repo, path), text, 'utf8')
}

function commit(message: string, date: string): void {
  git(['add', '-A'])
  git(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
}

beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-changed-')) })
afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

describe('changedFilesSinceChangeStart', () => {
  it('不是 git 仓库 → 抛 ChangedFilesUnavailableError（调用方据此阻塞）', async () => {
    await expect(changedFilesSinceChangeStart(repo, { baseBranch: 'main', createdAt: '2026-01-01T00:00:00Z' }))
      .rejects.toBeInstanceOf(ChangedFilesUnavailableError)
  })

  it('还没有任何提交：全部文件都算新增', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('src/a.ts', 'a\n')
    await put('e2e/x.spec.ts', 'x\n')
    expect(await changedFilesSinceChangeStart(repo, { baseBranch: 'main', createdAt: '2026-01-01T00:00:00Z' }))
      .toEqual(['e2e/x.spec.ts', 'src/a.ts'])
  })

  it('任务分支：merge-base 之后的提交 + 暂存 + 未暂存 + 未跟踪都算，基线分支上原有文件不算，删除的文件不算', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('src/base.ts', 'base\n')
    await put('src/gone.ts', 'gone\n')
    commit('base', '2026-01-01T00:00:00Z')
    git(['checkout', '-q', '-b', 'feature'])
    await put('src/committed.test.ts', 'c\n')
    commit('feature work', '2026-02-01T00:00:00Z')
    await put('src/base.ts', 'base changed\n')
    await put('src/staged.spec.ts', 's\n')
    git(['add', 'src/staged.spec.ts'])
    await put('src/untracked.test.ts', 'u\n')
    await rm(join(repo, 'src/gone.ts'))
    expect(await changedFilesSinceChangeStart(repo, { baseBranch: 'main', createdAt: '2026-01-15T00:00:00Z' })).toEqual([
      'src/base.ts', 'src/committed.test.ts', 'src/staged.spec.ts', 'src/untracked.test.ts',
    ])
  })

  it('直接在基线分支上做：起点是任务创建时刻之前的最后一个提交', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('src/old.test.ts', 'old\n')
    commit('before the change', '2026-01-01T00:00:00Z')
    await put('src/new.test.ts', 'new\n')
    commit('during the change', '2026-09-01T00:00:00Z')
    await put('src/wip.ts', 'wip\n')
    expect(await changedFilesSinceChangeStart(repo, { baseBranch: 'main', createdAt: '2026-06-01T00:00:00Z' }))
      .toEqual(['src/new.test.ts', 'src/wip.ts'])
    expect(await changedFilesSinceChangeStart(repo, { baseBranch: '', createdAt: '2026-06-01T00:00:00Z' }))
      .toEqual(['src/new.test.ts', 'src/wip.ts'])
  })

  it('没有基线分支也没有创建时间 → 定不出起点，抛错而不是当作没有改动', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('src/a.ts', 'a\n')
    commit('a', '2026-01-01T00:00:00Z')
    await expect(changedFilesSinceChangeStart(repo, { baseBranch: 'null', createdAt: '' })).rejects.toThrow(/定不出起点/)
  })

  it('创建时间早于全部提交 → 空树起点，所有文件都算', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('src/a.ts', 'a\n')
    commit('a', '2026-05-01T00:00:00Z')
    expect(await changedFilesSinceChangeStart(repo, { baseBranch: '', createdAt: '2026-01-01T00:00:00Z' })).toEqual(['src/a.ts'])
  })
})

describe('state 字段 → 任务起点', () => {
  it('base_branch / created_at 取标量（列表用逗号拼），缺失当空串；changedFilesForState 用它读 diff', async () => {
    expect(changeStartOfFields({ base_branch: 'main', created_at: '2026-01-01T00:00:00Z' })).toEqual({ baseBranch: 'main', createdAt: '2026-01-01T00:00:00Z' })
    expect(changeStartOfFields({ base_branch: ['a', 'b'] })).toEqual({ baseBranch: 'a,b', createdAt: '' })
    git(['init', '-q', '-b', 'main'])
    await put('src/a.test.ts', 'a\n')
    commit('base', '2026-01-01T00:00:00Z')
    await put('src/b.test.ts', 'b\n')
    expect(await changedFilesForState(repo, { fields: { base_branch: 'main', created_at: '2026-06-01T00:00:00Z' } })).toEqual(['src/b.test.ts'])
  })
})

describe('changedLinesSinceChangeStart', () => {
  it('修改行、新增行按新文件行号，未跟踪文件每一行都算', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('src/m.ts', 'l1\nl2\nl3\nl4\n')
    commit('base', '2026-01-01T00:00:00Z')
    git(['checkout', '-q', '-b', 'feature'])
    await put('src/m.ts', 'l1\nCHANGED\nl3\nl4\nl5\nl6\n')
    await put('src/new.ts', 'a\nb\n')
    const lines = await changedLinesSinceChangeStart(repo, { baseBranch: 'main', createdAt: '2026-01-15T00:00:00Z' })
    expect([...(lines.get('src/m.ts') ?? [])]).toEqual([2, 5, 6])
    expect([...(lines.get('src/new.ts') ?? [])]).toEqual([1, 2])
  })

  it('parseAddedLines：单行 hunk、多行 hunk、删除文件与纯删除 hunk', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -3 +3 @@', '-a', '+b', '@@ -10,2 +10,3 @@',
      'diff --git a/y.ts b/y.ts', '--- a/y.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@',
      'diff --git a/z.ts b/z.ts', '--- a/z.ts', '+++ b/z.ts', '@@ -5,2 +4,0 @@',
    ].join('\n')
    const parsed = parseAddedLines(diff)
    expect([...(parsed.get('x.ts') ?? [])]).toEqual([3, 10, 11, 12])
    expect(parsed.has('y.ts')).toBe(false)
    expect([...(parsed.get('z.ts') ?? [])]).toEqual([])
  })
})

type RunGit = NonNullable<ChangedFilesSessionOptions['runGit']>

/** 真 git，但把每次调用的参数记下来：数子进程个数用。 */
function countingGit(calls: string[][]): RunGit {
  return async (args, options) => {
    calls.push([...args])
    return { stdout: execFileSync('git', [...args], { cwd: options.cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }) }
  }
}

describe('createChangedFilesSession：同一个仓库的多个任务共用 git 调用', () => {
  it('N 个起点不同的任务只跑 O(1) 个 git 子进程，结果与逐个读取一致', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('src/old.test.ts', 'old\n')
    commit('base', '2026-01-01T00:00:00Z')
    await put('src/mid.test.ts', 'mid\n')
    commit('mid', '2026-03-01T00:00:00Z')
    await put('src/wip.ts', 'wip\n')
    const inputs = ['2026-01-15T00:00:00Z', '2026-02-01T00:00:00Z', '2026-03-15T00:00:00Z', '2026-04-01T00:00:00Z', '2025-12-01T00:00:00Z']
      .map((createdAt) => ({ baseBranch: 'main', createdAt }))
    const calls: string[][] = []
    const session = createChangedFilesSession(repo, { runGit: countingGit(calls) })
    const results = await Promise.all(inputs.map((input) => session.changedFiles(input)))
    for (const [index, input] of inputs.entries()) {
      expect(results[index]?.files).toEqual(await changedFilesSinceChangeStart(repo, input))
    }
    const verbs = calls.map((args) => args[0])
    expect(verbs.filter((verb) => verb === 'rev-parse')).toHaveLength(1)
    expect(verbs.filter((verb) => verb === 'merge-base')).toHaveLength(1)
    expect(verbs.filter((verb) => verb === 'rev-list')).toHaveLength(1)
    expect(verbs.filter((verb) => verb === 'ls-files')).toHaveLength(1)
    // 五个任务落在三个不同的起点（早于全部提交 = 空树），每个起点只 diff 一次。
    expect(verbs.filter((verb) => verb === 'diff')).toHaveLength(3)
    expect(calls.length).toBeLessThanOrEqual(7)
  })

  it('创建时间落在乱序提交时间、合并提交之间：与逐个 rev-list --before 的结果一致', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('a.txt', '1\n')
    commit('c1', '2026-01-10T00:00:00Z')
    git(['checkout', '-q', '-b', 'side'])
    await put('side.txt', 's\n')
    commit('side work', '2026-05-20T00:00:00Z')
    git(['checkout', '-q', 'main'])
    await put('main.txt', 'm\n')
    commit('main work with an older clock', '2026-02-01T00:00:00Z')
    git(['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', 'side', '-m', 'merge'], { GIT_AUTHOR_DATE: '2026-03-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-03-01T00:00:00Z' })
    for (const createdAt of ['2026-01-05T00:00:00Z', '2026-01-10T00:00:00Z', '2026-01-20T00:00:00Z', '2026-02-15T00:00:00Z', '2026-04-01T00:00:00Z', '2026-06-01T00:00:00Z']) {
      const expected = git(['rev-list', '-1', `--before=${new Date(createdAt).toISOString()}`, 'HEAD']).trim()
      const start = await resolveChangeStart(repo, { baseBranch: '', createdAt })
      expect(start, createdAt).toBe(expected === '' ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : expected)
    }
  })

  it('git 超时：抛出带原因的 ChangedFilesUnavailableError，之后的命令直接放弃而不是各等一遍', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('src/a.ts', 'a\n')
    commit('a', '2026-01-01T00:00:00Z')
    const calls: string[][] = []
    const runGit: RunGit = async (args, options) => {
      calls.push([...args])
      if (args[0] === 'diff') throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null, stdout: '' })
      return countingGit([])(args, options)
    }
    const session = createChangedFilesSession(repo, { timeoutMs: 3_000, runGit })
    const a = { baseBranch: 'main', createdAt: '2026-06-01T00:00:00Z' }
    const b = { baseBranch: 'main', createdAt: '2026-07-01T00:00:00Z' }
    await expect(session.changedFiles(a)).rejects.toThrow(/git diff 超时（超过 3 秒）/)
    const before = calls.length
    await expect(session.changedFiles(b)).rejects.toBeInstanceOf(ChangedFilesUnavailableError)
    expect(calls.length).toBe(before)
  })

  it('普通失败（非超时）沿用原来的措辞', async () => {
    git(['init', '-q', '-b', 'main'])
    const runGit: RunGit = async (args) => {
      if (args[0] === 'ls-files') throw Object.assign(new Error('boom'), { code: 128, stdout: '' })
      return { stdout: args[0] === 'rev-parse' ? 'true\n' : '' }
    }
    const session = createChangedFilesSession(repo, { runGit })
    await expect(session.changedFiles({ baseBranch: '', createdAt: '2026-06-01T00:00:00Z' })).rejects.toThrow('git ls-files 失败')
  })

  it('未跟踪文件超过上限：只读前 limit 个，并显式带出被截断的个数', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('README.md', 'r\n')
    commit('base', '2026-01-01T00:00:00Z')
    for (const name of ['a', 'b', 'c', 'd', 'e']) await put(`untracked/${name}.test.ts`, `${name}\n`)
    const session = createChangedFilesSession(repo, { untrackedLimit: 3 })
    const result = await session.changedFiles({ baseBranch: '', createdAt: '2026-06-01T00:00:00Z' })
    expect(result.files).toEqual(['untracked/a.test.ts', 'untracked/b.test.ts', 'untracked/c.test.ts'])
    expect(result.untrackedTruncated).toEqual({ found: 5, limit: 3 })
    const full = await createChangedFilesSession(repo).changedFiles({ baseBranch: '', createdAt: '2026-06-01T00:00:00Z' })
    expect(full.untrackedTruncated).toBeUndefined()
    expect(full.files).toHaveLength(5)
  })

  it('changedFilesResultForState 与 changedFilesForState 同一份文件列表', async () => {
    git(['init', '-q', '-b', 'main'])
    await put('src/a.test.ts', 'a\n')
    commit('base', '2026-01-01T00:00:00Z')
    await put('src/b.test.ts', 'b\n')
    const state = { fields: { base_branch: 'main', created_at: '2026-06-01T00:00:00Z' } }
    expect((await changedFilesResultForState(repo, state)).files).toEqual(await changedFilesForState(repo, state))
  })
})
