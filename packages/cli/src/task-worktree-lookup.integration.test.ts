/**
 * 新任务建在 `.worktrees/<c>` 里之后，主检出怎么找到它（真临时 git 仓 + 真 CLI 装配，零 mock）：
 * `tenon list` 的 worktree 列、按名读取找不到任务时报错里的路径、`tenon workflow progress` 的回退查找，
 * 以及完结后 `finish-change` / `stop finished` 带的清理提示（Tenon 只提示，不自己删）。
 *
 * 全局 setup 给所有测试设了 TENON_INIT_IN_PLACE=1（既有用例都原地建立）；这里专测 worktree，
 * 所以在用例内删掉它、用完恢复。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { makeHarness, type Harness } from './integration-harness.js'
import { commitAll, git, writeFiles } from './integration-harness-tests.js'

const INIT = ['init', 'demo', '--track', 'backend', '--preset', 'full'] as const

let savedInPlace: string | undefined
let repo: string
let worktree: string
let main: Harness

beforeEach(async () => {
  savedInPlace = process.env.TENON_INIT_IN_PLACE
  delete process.env.TENON_INIT_IN_PLACE
  repo = await realpath(await mkdtemp(join(tmpdir(), 'tenon-worktree-lookup-')))
  git(repo, ['init', '-q', '-b', 'main'])
  await writeFiles(repo, { 'README.md': 'x\n' })
  commitAll(repo, 'base', '2026-01-01T00:00:00Z')
  worktree = join(repo, '.worktrees', 'demo')
  main = makeHarness(repo)
  expect(await main.run([...INIT]), main.err.join('\n')).toBe(0)
})

afterEach(async () => {
  if (savedInPlace === undefined) delete process.env.TENON_INIT_IN_PLACE
  else process.env.TENON_INIT_IN_PLACE = savedInPlace
  await rm(repo, { recursive: true, force: true })
})

interface ListJson {
  readonly changes: readonly { readonly name: string; readonly worktree: string | null }[]
}

describe('主检出里能找到建在 worktree 里的任务', () => {
  test('前提：任务在 .worktrees/demo 里，主检出的 openspec/changes 里没有它', () => {
    expect(existsSync(join(worktree, 'openspec', 'changes', 'demo'))).toBe(true)
    expect(existsSync(join(repo, 'openspec', 'changes', 'demo'))).toBe(false)
  })

  test('tenon list --json：包含 demo，worktree 是 .worktrees/demo 的绝对路径', async () => {
    expect(await main.run(['list', '--json']), main.err.join('\n')).toBe(0)
    const parsed = JSON.parse(main.out.join('\n')) as ListJson
    expect(parsed.changes).toEqual([expect.objectContaining({ name: 'demo', worktree })])
  })

  test('tenon list（人读）：WORKTREE 列写出路径', async () => {
    expect(await main.run(['list']), main.err.join('\n')).toBe(0)
    expect(main.out[0]).toMatch(/\bWORKTREE$/u)
    expect(main.out.join('\n')).toContain(worktree)
  })

  test('在 worktree 里 tenon list：它自己的任务 worktree 为 null', async () => {
    const inside = makeHarness(worktree)
    expect(await inside.run(['list', '--json']), inside.err.join('\n')).toBe(0)
    expect((JSON.parse(inside.out.join('\n')) as ListJson).changes).toEqual([expect.objectContaining({ name: 'demo', worktree: null })])
  })

  test.each([
    ['status', ['status', 'demo']],
    ['status --json', ['status', 'demo', '--json']],
    ['get', ['get', 'demo', 'phase']],
    ['check（按名作用于既有任务的命令）', ['check', 'demo']],
    ['workflow plan', ['workflow', 'plan', 'demo', '--json']],
  ])('tenon %s demo 在主检出里：exit 1，报错给出该路径', async (_label, args) => {
    expect(await main.run(args)).toBe(1)
    expect(main.err.join('\n')).toContain(worktree)
    expect(main.err.join('\n')).toContain('change 不存在: demo')
  })

  test('主检出里真的没有的任务名：仍是原来那一句，不带路径', async () => {
    expect(await main.run(['status', 'ghost'])).toBe(1)
    expect(main.err).toEqual(['ERROR: change 不存在: ghost'])
  })

  test('tenon workflow progress demo 在主检出里：输出该任务的一行清单（首步当前）', async () => {
    expect(await main.run(['workflow', 'progress', 'demo']), main.err.join('\n')).toBe(0)
    expect(main.out).toHaveLength(1)
    expect(main.out[0]).toMatch(/^立项 ● → /u)
    expect(main.err).toEqual([])
  })

  test('tenon workflow progress demo 在 worktree 里：与主检出里同一行清单', async () => {
    expect(await main.run(['workflow', 'progress', 'demo']), main.err.join('\n')).toBe(0)
    const fromMain = [...main.out]
    const inside = makeHarness(worktree)
    expect(await inside.run(['workflow', 'progress', 'demo']), inside.err.join('\n')).toBe(0)
    expect(inside.out).toEqual(fromMain)
  })

  test('主检出里没有该任务、任何 worktree 里也没有：workflow progress exit 1、stdout 为空', async () => {
    expect(await main.run(['workflow', 'progress', 'ghost'])).toBe(1)
    expect(main.out).toEqual([])
  })
})

/**
 * 完结之后 worktree 与分支还在：`finish-change` 附带 `cleanup`，工作区已干净时的 `stop finished` 同样带它。
 * 按 `cleanup` 之外的动作执行完（搬 change 目录、提交），`.worktrees/demo` 与分支 `tenon/demo` 仍然存在。
 */
describe('完结后提示清理 worktree', () => {
  interface Next { readonly action: string; readonly code?: string; readonly cleanup?: string | null; readonly commit?: { paths: string[]; untrack: string[]; message: string } | null }

  async function nextOf(inside: Harness): Promise<Next> {
    expect(await inside.run(['status', 'demo', '--json']), inside.err.join('\n')).toBe(0)
    const status = JSON.parse(inside.out.join('\n')) as { step: { next: Next[] } }
    return status.step.next[0] as Next
  }

  test('finish-change 带 cleanup；执行完提交与搬目录后 worktree 与分支仍在，stop finished 仍带 cleanup', async () => {
    const inside = makeHarness(worktree)
    await inside.seedPhase('demo', 'archive')
    await inside.seedArtifact('demo', 'archived', 'true')
    await inside.seedArtifact('demo', 'archived_at', '2026-09-20T00:00:00Z')

    const cleanup = `git worktree remove '${worktree}' && git branch -d 'tenon/demo'`
    const finish = await nextOf(inside)
    expect(finish).toMatchObject({ action: 'finish-change', cleanup })
    expect(finish.commit, '是 git 仓就带提交').toBeTruthy()

    // 照 finish-change 做：openspec archive 的搬移（CLI 不在测试环境里，按它的布局手动搬）+ 提交。
    const changes = join(worktree, 'openspec', 'changes')
    await mkdir(join(changes, 'archive'), { recursive: true })
    await rename(join(changes, 'demo'), join(changes, 'archive', '2026-09-20-demo'))
    const commit = finish.commit!
    git(worktree, ['add', '-A', '--', ...commit.paths])
    git(worktree, ['commit', '-q', '-m', commit.message])

    // Tenon 没有自己清理：worktree 目录、登记与分支都还在。
    expect(existsSync(worktree)).toBe(true)
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain('branch refs/heads/tenon/demo')
    expect(git(repo, ['rev-parse', '--verify', 'refs/heads/tenon/demo']).trim()).toMatch(/^[0-9a-f]{40}$/u)

    const after = await nextOf(inside)
    expect(after).toMatchObject({ action: 'stop', code: 'finished', cleanup })
  })

  test('原地建立的任务：finish-change 的 cleanup 是 null', async () => {
    const inPlace = makeHarness(repo)
    expect(await inPlace.run(['init', 'inplace', '--track', 'backend', '--preset', 'full', '--in-place']), inPlace.err.join('\n')).toBe(0)
    await inPlace.seedPhase('inplace', 'archive')
    await inPlace.seedArtifact('inplace', 'archived', 'true')
    expect(await inPlace.run(['status', 'inplace', '--json']), inPlace.err.join('\n')).toBe(0)
    const status = JSON.parse(inPlace.out.join('\n')) as { step: { next: Next[] } }
    expect(status.step.next[0]).toMatchObject({ action: 'finish-change', cleanup: null })
  })
})
