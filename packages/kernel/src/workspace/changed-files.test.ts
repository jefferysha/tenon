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
    // stderr 收进管道：没有上游的分支解析 `@{upstream}` 会让 git 打 fatal，那是预期内的失败，不该漏到测试输出里。
    return { stdout: execFileSync('git', [...args], { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }) }
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
    // rev-parse：仓库探针一次 + 基线分支的上游解析一次（同一个基线只解析一次，与任务个数无关）。
    expect(verbs.filter((verb) => verb === 'rev-parse')).toHaveLength(2)
    expect(verbs.filter((verb) => verb === 'merge-base')).toHaveLength(1)
    expect(verbs.filter((verb) => verb === 'rev-list')).toHaveLength(1)
    expect(verbs.filter((verb) => verb === 'ls-files')).toHaveLength(1)
    // 五个任务落在三个不同的起点（早于全部提交 = 空树），每个起点只 diff 一次。
    expect(verbs.filter((verb) => verb === 'diff')).toHaveLength(3)
    expect(calls.length).toBeLessThanOrEqual(8)
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

describe('state 字段 start_sha → 任务起点输入', () => {
  it('changeStartOfFields 读 start_sha；没有这个字段时结果里没有 startSha 键', () => {
    const sha = 'a'.repeat(40)
    expect(changeStartOfFields({ base_branch: 'main', created_at: '2026-01-01T00:00:00Z', start_sha: sha }))
      .toEqual({ baseBranch: 'main', createdAt: '2026-01-01T00:00:00Z', startSha: sha })
    expect(changeStartOfFields({ base_branch: 'main', start_sha: '' })).not.toHaveProperty('startSha')
    expect(changeStartOfFields({ base_branch: 'main' })).not.toHaveProperty('startSha')
  })
})

describe('任务起点：记录 start_sha 并跟随上游', () => {
  /** 临时目录里的 bare 仓（origin）与另一个克隆（模拟别人推送）；工作仓 `repo` 的 main 跟踪 origin/main。 */
  let origin = ''
  let other = ''
  let baseSha = ''
  /** 任务建在 main 上，created_at 早于下面各用例里「别人推送 / 本地提交」的时间。 */
  const MAIN = { baseBranch: 'main', createdAt: '2026-02-01T00:00:00Z' }

  function gitIn(cwd: string, args: string[], env: Record<string, string> = {}): string {
    return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
    })
  }

  async function commitIn(root: string, path: string, message: string, date: string): Promise<string> {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), `${message}\n`, 'utf8')
    gitIn(root, ['add', '-A'])
    gitIn(root, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
    return gitIn(root, ['rev-parse', 'HEAD']).trim()
  }

  /** 别人往 origin/main 推了一个提交。 */
  async function pushUpstream(path: string, message: string, date: string): Promise<void> {
    gitIn(other, ['pull', '-q', '--ff-only'])
    await commitIn(other, path, message, date)
    gitIn(other, ['push', '-q', 'origin', 'main'])
  }

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), 'tenon-origin-'))
    other = await mkdtemp(join(tmpdir(), 'tenon-other-'))
    gitIn(origin, ['init', '-q', '--bare', '-b', 'main'])
    git(['init', '-q', '-b', 'main'])
    git(['remote', 'add', 'origin', origin])
    baseSha = await commitIn(repo, 'src/base.ts', 'base', '2026-01-01T00:00:00Z')
    git(['push', '-q', '-u', 'origin', 'main'])
    gitIn(other, ['clone', '-q', origin, '.'])
  })
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  })

  it('快进拉取：建任务后上游新增的提交（含测试文件）不算本任务的改动', async () => {
    await put('src/mine.ts', 'mine\n')
    await pushUpstream('src/other.test.ts', 'merged by another task', '2026-03-01T00:00:00Z')
    git(['pull', '-q', '--ff-only'])
    expect(await changedFilesSinceChangeStart(repo, { ...MAIN, startSha: baseSha })).toEqual(['src/mine.ts'])
  })

  it('建任务前已有的本地未推送提交不算：起点不早于 start_sha（提交时间晚于 created_at 超过 60 秒的 start_sha 另见下面的读取时校验）', async () => {
    const local = await commitIn(repo, 'src/before-task.ts', 'local before the task', '2026-01-20T00:00:00Z')
    await put('src/wip.ts', 'wip\n')
    expect(await changedFilesSinceChangeStart(repo, { ...MAIN, startSha: local })).toEqual(['src/wip.ts'])
  })

  it('本任务自己的本地提交（未推送）仍算', async () => {
    await commitIn(repo, 'src/mine.test.ts', 'task work', '2026-03-01T00:00:00Z')
    await put('src/wip.ts', 'wip\n')
    expect(await changedFilesSinceChangeStart(repo, { ...MAIN, startSha: baseSha })).toEqual(['src/mine.test.ts', 'src/wip.ts'])
  })

  it('旧任务没有 start_sha：HEAD 与上游一致时起点是上游，建任务后拉进来的提交不算', async () => {
    await put('src/wip.ts', 'wip\n')
    await pushUpstream('src/other.test.ts', 'merged by another task', '2026-03-01T00:00:00Z')
    git(['pull', '-q', '--ff-only'])
    expect(await changedFilesSinceChangeStart(repo, MAIN)).toEqual(['src/wip.ts'])
  })

  it('start_sha 不是 HEAD 的祖先（用户切了分支）：不入选、不报错，按其余候选取起点', async () => {
    git(['checkout', '-q', '-b', 'feat'])
    const elsewhere = await commitIn(repo, 'src/feat-only.ts', 'work on another branch', '2026-02-10T00:00:00Z')
    git(['checkout', '-q', 'main'])
    await commitIn(repo, 'src/after-switch.ts', 'local commit after switching back', '2026-03-01T00:00:00Z')
    await put('src/wip.ts', 'wip\n')
    const input = { ...MAIN, startSha: elsewhere }
    expect(await resolveChangeStart(repo, input)).toBe(baseSha)
    expect(await changedFilesSinceChangeStart(repo, input)).toEqual(['src/after-switch.ts', 'src/wip.ts'])
  })

  it('两个候选不成链（HEAD 是合并提交，start_sha 在一侧、上游在另一侧）：起点取二者的共同祖先，宁可多算', async () => {
    const mine = await commitIn(repo, 'src/x.ts', 'local work when the task was created', '2026-02-01T00:00:00Z')
    await pushUpstream('src/y.test.ts', 'upstream work', '2026-02-02T00:00:00Z')
    git(['pull', '-q', '--no-rebase', '--no-ff', '--no-edit'], { GIT_AUTHOR_DATE: '2026-03-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-03-01T00:00:00Z' })
    const input = { baseBranch: 'main', createdAt: '2026-03-15T00:00:00Z', startSha: mine }
    expect(await resolveChangeStart(repo, input)).toBe(baseSha)
    expect(await changedFilesSinceChangeStart(repo, input)).toEqual(['src/x.ts', 'src/y.test.ts'])
  })

  it('已知限制：原地任务把自己的提交推到 base 的上游后，这些提交不再算本任务的改动（起点前移到上游）', async () => {
    await commitIn(repo, 'src/mine.test.ts', 'task work', '2026-03-01T00:00:00Z')
    git(['push', '-q', 'origin', 'main'])
    await put('src/wip.ts', 'wip\n')
    expect(await changedFilesSinceChangeStart(repo, { ...MAIN, startSha: baseSha })).toEqual(['src/wip.ts'])
  })

  it('任务分支有自己的提交：分叉点之后的提交都算，不受上游前进影响', async () => {
    git(['checkout', '-q', '-b', 'tenon/demo'])
    await commitIn(repo, 'src/branch-work.ts', 'branch work', '2026-03-01T00:00:00Z')
    await pushUpstream('src/other.test.ts', 'merged by another task', '2026-03-02T00:00:00Z')
    git(['fetch', '-q', 'origin'])
    expect(await changedFilesSinceChangeStart(repo, { ...MAIN, startSha: baseSha })).toEqual(['src/branch-work.ts'])
  })

  it('有 start_sha 且 created_at 可用时不再依赖基线分支：此前缺基线会抛「定不出起点」', async () => {
    await put('src/wip.ts', 'wip\n')
    expect(await resolveChangeStart(repo, { baseBranch: '', createdAt: MAIN.createdAt, startSha: baseSha })).toBe(baseSha)
  })

  it('同一会话里 start_sha 不同的任务各得各的起点（缓存键含 start_sha）', async () => {
    const later = await commitIn(repo, 'src/later.ts', 'later local commit', '2026-01-20T00:00:00Z')
    const session = createChangedFilesSession(repo)
    expect(await session.resolveStart({ ...MAIN, startSha: baseSha })).toBe(baseSha)
    expect(await session.resolveStart({ ...MAIN, startSha: later })).toBe(later)
    expect(await session.resolveStart(MAIN)).toBe(baseSha)
  })

  it('start_sha 不是合法提交 id 时一律忽略，也不会被当成 git 参数传出去', async () => {
    await commitIn(repo, 'src/later.ts', 'later local commit', '2026-03-01T00:00:00Z')
    const calls: string[][] = []
    const session = createChangedFilesSession(repo, { runGit: countingGit(calls) })
    const expected = (await session.changedFiles(MAIN)).files
    const bogus = ['--all', '--output=/tmp/x', baseSha.slice(0, 12), baseSha.toUpperCase(), `${baseSha}\n--all`, `${baseSha} `, 'main']
    for (const startSha of bogus) {
      expect((await session.changedFiles({ ...MAIN, startSha })).files, startSha).toEqual(expected)
    }
    expect(bogus.filter((value) => value !== 'main' && calls.flat().includes(value))).toEqual([])
    expect(calls.filter((args) => args.includes('--is-ancestor'))).toEqual([])
  })

  describe('start_sha 读取时校验：提交时间不得晚于 created_at + 60 秒（伴随文件被改写或删除只会让范围变宽）', () => {
    it('建任务之后的提交 C 被写成 start_sha（伴随文件被改写）→ 起点不是 C，C 的改动仍算本任务的', async () => {
      await commitIn(repo, 'src/a.ts', 'task work', '2026-03-01T00:00:00Z')
      const tampered = await commitIn(repo, 'src/c.ts', 'commit made after the task was created', '2026-03-02T00:00:00Z')
      const input = { ...MAIN, startSha: tampered }
      expect(await resolveChangeStart(repo, input)).toBe(baseSha)
      expect(await changedFilesSinceChangeStart(repo, input)).toEqual(['src/a.ts', 'src/c.ts'])
      // 对照：真实的 start_sha（建任务时的 HEAD）行为不变。
      expect(await resolveChangeStart(repo, { ...MAIN, startSha: baseSha })).toBe(baseSha)
      expect(await changedFilesSinceChangeStart(repo, { ...MAIN, startSha: baseSha })).toEqual(['src/a.ts', 'src/c.ts'])
    })

    it('提交时间等于 created_at + 60 秒仍入选，晚 1 秒即被丢弃', async () => {
      const edge = await commitIn(repo, 'src/edge.ts', 'at the skew limit', '2026-02-01T00:01:00Z')
      expect(await resolveChangeStart(repo, { ...MAIN, startSha: edge })).toBe(edge)
      const late = await commitIn(repo, 'src/late.ts', 'one second past the skew limit', '2026-02-01T00:01:01Z')
      expect(await resolveChangeStart(repo, { ...MAIN, startSha: late })).toBe(baseSha)
      expect(await changedFilesSinceChangeStart(repo, { ...MAIN, startSha: late })).toEqual(['src/edge.ts', 'src/late.ts'])
    })

    it('建任务之前的提交（时间早于 created_at）照常入选，包括未推送的本地提交', async () => {
      const local = await commitIn(repo, 'src/before-task.ts', 'local before the task', '2026-01-20T00:00:00Z')
      expect(await resolveChangeStart(repo, { ...MAIN, startSha: local })).toBe(local)
    })

    it('created_at 不可用：start_sha 不入选，按其余候选（上游 / 基线 merge-base）取起点', async () => {
      const local = await commitIn(repo, 'src/before-task.ts', 'local before the task', '2026-01-20T00:00:00Z')
      for (const createdAt of ['', 'not-a-date']) {
        expect(await resolveChangeStart(repo, { baseBranch: 'main', createdAt, startSha: local }), createdAt).toBe(baseSha)
      }
      // 没有别的候选时和以前一样抛错（失败关闭），不是拿一个无法校验的 start_sha 当起点。
      await expect(resolveChangeStart(repo, { baseBranch: '', createdAt: '', startSha: baseSha }))
        .rejects.toBeInstanceOf(ChangedFilesUnavailableError)
    })

    it('读不到提交时间（git show 失败）→ 不入选；git show 超时 → 抛 ChangedFilesUnavailableError，不当成「没有候选」', async () => {
      const local = await commitIn(repo, 'src/before-task.ts', 'local before the task', '2026-01-20T00:00:00Z')
      const failing: RunGit = async (args, options) => {
        if (args[0] === 'show') throw Object.assign(new Error('bad object'), { killed: false, signal: null, code: 128, stdout: '' })
        return countingGit([])(args, options)
      }
      expect(await createChangedFilesSession(repo, { runGit: failing }).resolveStart({ ...MAIN, startSha: local })).toBe(baseSha)
      const timingOut: RunGit = async (args, options) => {
        if (args[0] === 'show') throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null, stdout: '' })
        return countingGit([])(args, options)
      }
      await expect(createChangedFilesSession(repo, { timeoutMs: 3_000, runGit: timingOut }).resolveStart({ ...MAIN, startSha: local }))
        .rejects.toThrow(/git show 超时（超过 3 秒）/)
    })

    it('提交时间只经 argv 数组读取：start_sha 先过提交 id 校验，读时间的命令里只有这一个 sha', async () => {
      const calls: string[][] = []
      const session = createChangedFilesSession(repo, { runGit: countingGit(calls) })
      await session.resolveStart({ ...MAIN, startSha: baseSha })
      expect(calls.filter((args) => args[0] === 'show')).toEqual([['show', '-s', '--format=%ct', baseSha]])
    })
  })

  it('git 超时：候选判定（是否祖先、解析上游）超时时抛 ChangedFilesUnavailableError，不当成「没有候选」继续', async () => {
    const timeout = (): never => { throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null, stdout: '' }) }
    const onAncestor: RunGit = async (args, options) => {
      if (args.includes('--is-ancestor')) timeout()
      return countingGit([])(args, options)
    }
    await expect(createChangedFilesSession(repo, { timeoutMs: 3_000, runGit: onAncestor }).resolveStart({ ...MAIN, startSha: baseSha }))
      .rejects.toThrow(/git merge-base 超时（超过 3 秒）/)
    const onUpstream: RunGit = async (args, options) => {
      if (args[0] === 'rev-parse' && args.some((arg) => arg.endsWith('@{upstream}'))) timeout()
      return countingGit([])(args, options)
    }
    await expect(createChangedFilesSession(repo, { timeoutMs: 3_000, runGit: onUpstream }).resolveStart(MAIN))
      .rejects.toBeInstanceOf(ChangedFilesUnavailableError)
  })
})
