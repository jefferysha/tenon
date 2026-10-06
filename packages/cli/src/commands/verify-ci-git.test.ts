import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { commitAll, git } from '../integration-harness-tests.js'
import { candidateClues } from './verify-ci-git.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function put(dir: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true })
  await writeFile(join(dir, path), text, 'utf8')
}

/** C1（基线）→ 测试在 C1 上跑（工作区有未提交的实现）→ C2（交付提交）→ C3（之后又改了一个文件）。 */
async function history(): Promise<{ dir: string; c1: string; c2: string; c3: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'verify-ci-clues-'))
  dirs.push(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  await put(dir, '.gitignore', 'dist-ignored\ntest-results\n')
  await put(dir, 'src/base.js', 'export const base = 1\n')
  commitAll(dir, 'c1', '2026-01-01T00:00:00Z')
  const c1 = git(dir, ['rev-parse', 'HEAD']).trim()
  await put(dir, 'src/feature.js', 'export const feature = 1\n') // 测试时在工作区里，交付时一并提交
  commitAll(dir, 'c2 delivery', '2026-02-01T00:00:00Z')
  const c2 = git(dir, ['rev-parse', 'HEAD']).trim()
  await put(dir, 'src/later.js', 'export const later = 1\n')
  await put(dir, 'docs/notes.md', '# not a candidate file\n')
  commitAll(dir, 'c3 later', '2026-03-01T00:00:00Z')
  const c3 = git(dir, ['rev-parse', 'HEAD']).trim()
  return { dir, c1, c2, c3 }
}

describe('candidateClues', () => {
  test('记录里的 git_head：线索是它之后的第一个提交，之后又改的候选文件才点名，交付提交里的文件不算', async () => {
    const { dir, c1, c2 } = await history()
    const clues = await candidateClues(dir, { gitHead: c1, finishedAt: '2026-01-15T00:00:00Z', declared: [] })
    expect(clues.followedBy).toBe(c2.slice(0, 7))
    expect(clues.changedLater).toEqual(['src/later.js'])
    expect(clues.changedLaterMore).toBe(0)
    expect(clues.extraHere).toEqual([])
  })

  test('git_head 缺失或不在历史里：退回完成时间之后的第一个提交，结论相同', async () => {
    const { dir, c2 } = await history()
    for (const gitHead of [null, 'd'.repeat(40), 'not-a-sha']) {
      const clues = await candidateClues(dir, { gitHead, finishedAt: '2026-01-15T00:00:00Z', declared: [] })
      expect(clues.followedBy, String(gitHead)).toBe(c2.slice(0, 7))
      expect(clues.changedLater, String(gitHead)).toEqual(['src/later.js'])
    }
  })

  test('测试就是在 HEAD 上跑的、或之后没有提交：没有「之后的提交」，不去猜', async () => {
    const { dir, c3 } = await history()
    const atHead = await candidateClues(dir, { gitHead: c3, finishedAt: '2026-03-15T00:00:00Z', declared: [] })
    expect(atHead.followedBy).toBeUndefined()
    expect(atHead.changedLater).toEqual([])
    const afterAll = await candidateClues(dir, { gitHead: null, finishedAt: '2026-09-01T00:00:00Z', declared: [] })
    expect(afterAll.followedBy).toBeUndefined()
    expect(afterAll.changedLater).toEqual([])
  })

  test('只列最多 limit 个，其余计数；排除不属于候选范围的路径（文档、控制状态）', async () => {
    const { dir, c1 } = await history()
    for (let index = 0; index < 4; index++) await put(dir, `src/more${index}.js`, `export const more${index} = ${index}\n`)
    await put(dir, 'openspec/changes/x/.pipeline.yaml', 'phase: build\n')
    commitAll(dir, 'c4 more', '2026-04-01T00:00:00Z')
    const clues = await candidateClues(dir, { gitHead: c1, finishedAt: '2026-01-15T00:00:00Z', declared: [] }, 3)
    expect(clues.changedLater).toEqual(['src/later.js', 'src/more0.js', 'src/more1.js'])
    expect(clues.changedLaterMore).toBe(2)
  })

  test('本次检出里多出的未跟踪与被忽略文件：点名候选范围内的，声明的测试产物、依赖目录与文档不算', async () => {
    const { dir, c1 } = await history()
    await put(dir, 'dist/bundle.js', 'built\n')
    await put(dir, 'scratch.js', 'untracked\n')
    await put(dir, 'dist-ignored/out.js', 'ignored\n')
    await put(dir, 'test-results/unit.xml', '<x/>')
    await put(dir, 'node_modules/pkg/index.js', 'dep\n')
    await put(dir, 'reports/declared.json', '{}\n')
    const clues = await candidateClues(dir, { gitHead: c1, finishedAt: '2026-01-15T00:00:00Z', declared: ['reports/declared.json'] })
    expect(clues.extraHere).toEqual(['dist-ignored/', 'dist/', 'scratch.js'])
    expect(clues.extraHereMore).toBe(0)
  })
})
