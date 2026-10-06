import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { fingerprintWorkspaceTwins } from './fingerprint.js'
import { hostLocalTracking, isCaseInsensitiveRoot, skipUntrackedHostLocal, trackedHostLocalPaths } from './host-local.js'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-host-local-'))
  roots.push(root)
  return root
}

/** 一个有未被跟踪的宿主本地文件的项目（还不是 git 仓库）。 */
async function project(): Promise<string> {
  const root = await freshRoot()
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'app.js'), 'export const a = 1\n')
  await mkdir(join(root, '.claude'), { recursive: true })
  await writeFile(join(root, '.claude', 'settings.local.json'), '{}\n')
  return root
}

const settingsOf = (root: string): string => join(root, '.claude', 'settings.local.json')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** git 对这个目录说了什么（stderr）；它成功就返回空串。 */
function gitSays(root: string): string {
  try {
    execFileSync('git', ['ls-files', '-z', '--cached', '--', '.claude/settings.local.json'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    })
    return ''
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null ? Reflect.get(error, 'stderr') : undefined
    return typeof stderr === 'string' ? stderr : String(error)
  }
}

/** 宿主本地文件被算进可移植指纹：改它就动。 */
async function portableCounts(root: string): Promise<boolean> {
  await writeFile(settingsOf(root), '{ "edit": 1 }\n')
  const before = await fingerprintWorkspaceTwins(root)
  await writeFile(settingsOf(root), '{ "edit": 2 }\n')
  return (await fingerprintWorkspaceTwins(root)).portable !== before.portable
}

describe('git 说不出跟踪情况：只有真正的「不是仓库」才算什么都不跟踪', () => {
  test('普通的非仓库目录（没有 .git、上级也没有仓库）：什么都不跟踪，没跟踪的宿主本地文件不进可移植指纹', async () => {
    const root = await project()
    expect(await trackedHostLocalPaths(root)).toEqual(new Set())
    expect(await portableCounts(root), '没被跟踪：改它不动可移植指纹').toBe(false)
    const twins = await fingerprintWorkspaceTwins(root)
    expect(twins.portable).not.toBe(twins.full)
  })

  test('.git 是个 gitfile、gitdir 指向的目录不存在（fatal: not a git repository: <path>）：git 答不出来，一律照算', async () => {
    const root = await project()
    await writeFile(join(root, '.git'), `gitdir: ${join(root, 'missing-gitdir')}\n`)
    const says = gitSays(root)
    expect(says).toMatch(/not a git repository/iu)
    expect(says, '这条消息不带「(or any of the parent directories)」，所以不能当作「不是仓库」').not.toMatch(/parent directories/iu)

    expect(await trackedHostLocalPaths(root)).toBeUndefined()
    expect(await portableCounts(root), 'git 答不出来：宿主本地文件照算').toBe(true)
  })

  test.each([
    ['空的 .git 目录', async (root: string): Promise<void> => { await mkdir(join(root, '.git')) }],
    ['HEAD 写坏的 .git 目录', async (root: string): Promise<void> => {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      await writeFile(join(root, '.git', 'HEAD'), 'not a ref\n')
    }],
  ])('%s：git 报的是和「从来不是仓库」一样的消息，但根目录有 .git，所以答不出来，一律照算', async (_name, damage) => {
    const root = await project()
    await damage(root)
    expect(gitSays(root), '同一条消息：只靠消息分不开').toMatch(/not a git repository \(or any of the parent directories\)/iu)

    expect(await trackedHostLocalPaths(root)).toBeUndefined()
    expect(await portableCounts(root)).toBe(true)
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('读不了的 .git 目录（权限 000）：答不出来，一律照算', async () => {
    const root = await project()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    await chmod(join(root, '.git'), 0o000)
    try {
      expect(await trackedHostLocalPaths(root)).toBeUndefined()
      expect(await portableCounts(root)).toBe(true)
    } finally {
      await chmod(join(root, '.git'), 0o755)
    }
  })

  describe.skipIf(process.platform === 'win32')('git 的各种失败消息（脚本替身，不依赖 git 版本）', () => {
    const NOT_A_REPOSITORY = 'fatal: not a git repository (or any of the parent directories): .git'
    const MOUNT_POINT = 'fatal: not a git repository (or any parent up to mount point /mnt/other)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).'

    /** PATH 最前面放一个只会打印 `stderr` 并以 128 退出的 `git`，跑完 `run` 再还原环境。 */
    async function withFailingGit<T>(stderr: string, run: () => Promise<T>): Promise<T> {
      const bin = await freshRoot()
      const script = join(bin, 'git')
      await writeFile(script, '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_GIT_STDERR" >&2\nexit 128\n')
      await chmod(script, 0o755)
      const saved = { path: process.env.PATH, stderr: process.env.FAKE_GIT_STDERR }
      process.env.PATH = `${bin}${delimiter}${saved.path ?? ''}`
      process.env.FAKE_GIT_STDERR = stderr
      try {
        return await run()
      } finally {
        if (saved.path === undefined) delete process.env.PATH
        else process.env.PATH = saved.path
        if (saved.stderr === undefined) delete process.env.FAKE_GIT_STDERR
        else process.env.FAKE_GIT_STDERR = saved.stderr
      }
    }

    test('「not a git repository (or any of the parent directories)」且根目录没有 .git：什么都不跟踪', async () => {
      const root = await project()
      expect(await withFailingGit(NOT_A_REPOSITORY, () => trackedHostLocalPaths(root))).toEqual(new Set())
    })

    test('同一条消息，但根目录有 .git 条目（目录或 gitfile）：答不出来', async () => {
      const dir = await project()
      await mkdir(join(dir, '.git'))
      expect(await withFailingGit(NOT_A_REPOSITORY, () => trackedHostLocalPaths(dir))).toBeUndefined()

      const file = await project()
      await writeFile(join(file, '.git'), 'gitdir: elsewhere\n')
      expect(await withFailingGit(NOT_A_REPOSITORY, () => trackedHostLocalPaths(file))).toBeUndefined()
    })

    test('上级有仓库但在另一个文件系统上（git 在边界处停下，「or any parent up to mount point」）：答不出来，不是什么都不跟踪', async () => {
      const root = await project()
      expect(await withFailingGit(MOUNT_POINT, () => trackedHostLocalPaths(root))).toBeUndefined()
    })

    test.each([
      ['gitfile 的 gitdir 不存在', 'fatal: not a git repository: /gone/gitdir'],
      ['索引损坏', 'fatal: bad index file sha1 signature'],
      ['没有任何输出', ''],
    ])('%s：答不出来', async (_name, stderr) => {
      const root = await project()
      expect(await withFailingGit(stderr, () => hostLocalTracking(root))).toBeUndefined()
    })
  })
})

/** 同步探测：这个临时目录所在的文件系统是否把大小写当作同一个名字（与被测代码的探测互相独立）。 */
function foldsCaseHere(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-case-probe-'))
  try {
    writeFileSync(join(dir, 'Case-Probe.tmp'), '')
    return existsSync(join(dir, 'case-probe.TMP'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const FOLDS_CASE = foldsCaseHere()

describe('大小写不敏感的文件系统：索引拼写与磁盘拼写只差大小写', () => {
  test('skipUntrackedHostLocal：大小写不敏感时，被跟踪的路径按任意大小写拼写匹配；敏感时只认原样', () => {
    const tracked = new Set(['.Claude/Settings.local.json', 'CLAUDE.LOCAL.md', '.Claude/Worktrees/X.js'])
    const insensitive = skipUntrackedHostLocal(tracked, true)
    expect(insensitive('.claude/settings.local.json'), '索引拼写 .Claude/Settings.local.json：它是被跟踪的，要算').toBe(false)
    expect(insensitive('CLAUDE.local.md')).toBe(false)
    expect(insensitive('.claude/worktrees/x.js')).toBe(false)
    expect(insensitive('.claude/worktrees'), '装着被跟踪文件的目录').toBe(false)
    expect(insensitive('.claude/worktrees/other.js'), '同目录里没被跟踪的仍不算').toBe(true)
    expect(insensitive('.claude/settings.json'), '不在清单上').toBe(false)

    const sensitive = skipUntrackedHostLocal(tracked)
    expect(sensitive('.claude/settings.local.json'), '区分大小写的文件系统上它们是两个不同的路径').toBe(true)
    expect(sensitive('.Claude/Settings.local.json')).toBe(false)
  })

  test('探测与独立的探测一致（根目录有 .claude 或只有 CLAUDE.local.md 都行）；没有可探测的条目时按「不区分大小写」算（宁可多算）', async () => {
    const withDir = await project()
    expect(await isCaseInsensitiveRoot(withDir)).toBe(FOLDS_CASE)

    const withFile = await freshRoot()
    await writeFile(join(withFile, 'CLAUDE.local.md'), 'private\n')
    expect(await isCaseInsensitiveRoot(withFile)).toBe(FOLDS_CASE)

    expect(await isCaseInsensitiveRoot(await freshRoot()), '无从判断').toBe(true)
  })

  /** 磁盘上是 .claude/settings.local.json，索引里登记的是 .Claude/Settings.local.json。 */
  async function repoWithIndexSpelling(ignoreCase: 'true' | 'false'): Promise<string> {
    const root = await project()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'core.ignorecase', ignoreCase], { cwd: root })
    const blob = execFileSync('git', ['hash-object', '-w', '--', '.claude/settings.local.json'], { cwd: root, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},.Claude/Settings.local.json`], { cwd: root })
    return root
  }

  describe.skipIf(!FOLDS_CASE)('这个文件系统不区分大小写', () => {
    test.each(['true', 'false'] as const)('core.ignorecase=%s：索引拼写 .Claude/Settings.local.json 对磁盘上的 .claude/settings.local.json 算被跟踪，照算', async (ignoreCase) => {
      const root = await repoWithIndexSpelling(ignoreCase)
      expect(await trackedHostLocalPaths(root)).toEqual(new Set(['.Claude/Settings.local.json']))
      expect(await portableCounts(root), '被跟踪的文件改了，可移植指纹必须动').toBe(true)
    })

    test('没被跟踪的宿主本地文件仍然不算（探测没有把一切都放进候选）', async () => {
      const root = await project()
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      expect(await trackedHostLocalPaths(root)).toEqual(new Set())
      expect(await portableCounts(root)).toBe(false)
    })
  })

  describe.skipIf(FOLDS_CASE)('这个文件系统区分大小写', () => {
    test('.Claude/Settings.local.json 与 .claude/settings.local.json 是两个路径：磁盘上的那个没被跟踪，不算', async () => {
      const root = await repoWithIndexSpelling('false')
      expect(await trackedHostLocalPaths(root)).toEqual(new Set())
      expect(await portableCounts(root)).toBe(false)
    })
  })
})
