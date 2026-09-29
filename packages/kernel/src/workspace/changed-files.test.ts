import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangedFilesUnavailableError, changedFilesSinceChangeStart, changedLinesSinceChangeStart, parseAddedLines,
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
