import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateIntegrity } from '../test-system/integrity.js'
import { createChangedFilesSession } from './changed-files.js'
import { parseFileLineDiffs } from './file-diffs.js'

describe('parseFileLineDiffs', () => {
  it('按文件拆出新增行与删除行；文件头只认第一个 @@ 之前，内容里的 "++ " / "-- " 行照常计入', () => {
    const diff = [
      'diff --git a/src/a.test.ts b/src/a.test.ts',
      'index 111..222 100644',
      '--- a/src/a.test.ts',
      '+++ b/src/a.test.ts',
      '@@ -3 +3,2 @@ describe',
      "-  it('old', () => {})",
      "+  it('new', () => {})",
      '+++ not a header',
      '@@ -9 +10 @@',
      '--- not a header either',
      '+  expect(a).toBe(1)',
      '\\ No newline at end of file',
      'diff --git a/gone.test.ts b/gone.test.ts',
      'deleted file mode 100644',
      '--- a/gone.test.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      "-it('x', () => {})",
      'diff --git a/shot.png b/shot.png',
      'Binary files a/shot.png and b/shot.png differ',
    ].join('\n')
    const parsed = parseFileLineDiffs(diff)
    expect(parsed.get('src/a.test.ts')).toEqual({
      added: ["  it('new', () => {})", '++ not a header', '  expect(a).toBe(1)'],
      removed: ["  it('old', () => {})", '-- not a header either'],
    })
    expect(parsed.get('gone.test.ts')).toEqual({ added: [], removed: ["it('x', () => {})"] })
    expect(parsed.has('shot.png')).toBe(false)
  })

  it('含空格的路径：git 在文件头补的制表符被去掉', () => {
    const parsed = parseFileLineDiffs(['diff --git a/a b.txt b/a b.txt', '--- a/a b.txt\t', '+++ b/a b.txt\t', '@@ -1 +1 @@', '-x', '+y'].join('\n'))
    expect(parsed.get('a b.txt')).toEqual({ added: ['y'], removed: ['x'] })
  })
})

describe('createChangedFilesSession().fileDiffs —— 真实版本库', () => {
  let repo = ''
  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
    })
  const put = async (path: string, text: string | Buffer): Promise<void> => {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), text)
  }
  const START = { baseBranch: 'main', createdAt: '2026-06-01T00:00:00Z' }

  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-diffs-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  async function seed(): Promise<void> {
    run(['init', '-q', '-b', 'main'])
    await put('src/keep.test.ts', "it('a', () => { expect(1).toBe(1) })\nit('b', () => { expect(2).toBe(2) })\n")
    await put('src/gone.test.ts', "it('x', () => {})\nit('y', () => {})\nit('z', () => {})\n")
    await put('src/__snapshots__/keep.test.ts.snap', 'exports[`a 1`] = `old`;\n')
    await put('e2e/home.spec.ts-snapshots/home.png', Buffer.from([0, 1, 2, 3]))
    await put('src/util.ts', 'export const a = 1\n')
    await put('vitest.config.ts', 'export default { coverage: { thresholds: { lines: 80 } } }\n')
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'base'], { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' })
  }

  it('读出改动、删除、二进制与未跟踪文件的行；无关文件不读', async () => {
    await seed()
    await put('src/keep.test.ts', "it.skip('a', () => { expect(1).toBe(1) })\n")
    await rm(join(repo, 'src/gone.test.ts'))
    await put('src/__snapshots__/keep.test.ts.snap', 'exports[`a 1`] = `new`;\n')
    await put('e2e/home.spec.ts-snapshots/home.png', Buffer.from([9, 9, 9, 9]))
    await put('src/util.ts', 'export const a = 2\n')
    await put('vitest.config.ts', 'export default { coverage: { thresholds: { lines: 60 } } }\n')
    await put('src/new.test.ts', "it('n', () => {})\nit.todo('later')\n")
    const accept = (path: string): boolean => path !== 'src/util.ts'
    const result = await createChangedFilesSession(repo).fileDiffs(START, accept, 100)
    expect(result.truncated).toBeUndefined()
    const byPath = new Map(result.files.map((entry) => [entry.path, entry]))
    expect([...byPath.keys()]).toEqual([
      'e2e/home.spec.ts-snapshots/home.png', 'src/__snapshots__/keep.test.ts.snap', 'src/gone.test.ts',
      'src/keep.test.ts', 'src/new.test.ts', 'vitest.config.ts',
    ])
    expect(byPath.get('src/keep.test.ts')).toMatchObject({ status: 'modified', removed: [expect.stringContaining("it('a'"), expect.stringContaining("it('b'")], added: [expect.stringContaining('it.skip')] })
    expect(byPath.get('src/gone.test.ts')).toMatchObject({ status: 'deleted', added: [], removed: ["it('x', () => {})", "it('y', () => {})", "it('z', () => {})"] })
    expect(byPath.get('e2e/home.spec.ts-snapshots/home.png')).toEqual({ path: 'e2e/home.spec.ts-snapshots/home.png', status: 'modified', added: [], removed: [] })
    expect(byPath.get('src/new.test.ts')).toEqual({ path: 'src/new.test.ts', status: 'added', added: ["it('n', () => {})", "it.todo('later')"], removed: [] })
  })

  it('读出的改动行直接喂完整性判定：跳过、删文件、快照改写、门槛降低全部命中', async () => {
    await seed()
    await put('src/keep.test.ts', "it.skip('a', () => { })\n")
    await rm(join(repo, 'src/gone.test.ts'))
    await put('src/__snapshots__/keep.test.ts.snap', 'exports[`a 1`] = `new`;\n')
    await put('e2e/home.spec.ts-snapshots/home.png', Buffer.from([9, 9, 9, 9]))
    await put('vitest.config.ts', 'export default { coverage: { thresholds: { lines: 60 } } }\n')
    const diff = await createChangedFilesSession(repo).fileDiffs(START, () => true, 100)
    const report = evaluateIntegrity({ diff, runs: [], suiteOf: () => undefined }, 'notice')
    expect(report.signals.map((signal) => `${signal.code}:${signal.subject}`)).toEqual([
      'test-file-deleted:src/gone.test.ts',
      'tests-removed:src/keep.test.ts',
      'test-skipped:src/keep.test.ts',
      'snapshot-rewritten:e2e/home.spec.ts-snapshots/home.png',
      'snapshot-rewritten:src/__snapshots__/keep.test.ts.snap',
      'coverage-threshold-lowered:vitest.config.ts',
    ])
  })

  it('相关文件超过上限：只读前 N 个并带出 found / limit', async () => {
    await seed()
    for (const name of ['a', 'b', 'c']) await put(`src/${name}.test.ts`, "it('n', () => {})\n")
    const result = await createChangedFilesSession(repo).fileDiffs(START, (path) => path.endsWith('.test.ts') && path !== 'src/keep.test.ts', 2)
    expect(result.files.map((entry) => entry.path)).toEqual(['src/a.test.ts', 'src/b.test.ts'])
    expect(result.truncated).toEqual({ found: 3, limit: 2 })
  })

  it('不是版本库 → 抛错（调用方据此失败关闭或提示）', async () => {
    await expect(createChangedFilesSession(repo).fileDiffs(START, () => true, 10)).rejects.toThrow()
  })

  it('同一个会话里相同的读取只跑一次版本库命令', async () => {
    await seed()
    await put('src/keep.test.ts', "it('a', () => {})\n")
    const calls: string[] = []
    const session = createChangedFilesSession(repo, {
      runGit: async (args, options) => {
        calls.push(args.join(' '))
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
          try {
            resolve({ stdout: execFileSync('git', [...args], { cwd: options.cwd, encoding: 'utf8', maxBuffer: options.maxBuffer }) })
          } catch (error) {
            reject(error)
          }
        })
        return { stdout }
      },
    })
    await session.fileDiffs(START, () => true, 100)
    const first = calls.length
    await session.fileDiffs(START, () => true, 100)
    expect(calls.length).toBe(first)
  })
})
