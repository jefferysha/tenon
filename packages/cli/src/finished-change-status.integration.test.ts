/**
 * 回归锚（v0.1.1 验收 D21 / #6）：已完结的 change 在 status / check / list 里口径一致。
 *
 * 真机：`openspec archive` 把目录搬进 archive/ 之后，`tenon check` 按归档前路径报 11 个 FAIL、
 * exit 2；`tenon status <c> --json` 仍把它列在 active_changes、step 为 null。`transition archived`
 * 之后、`openspec archive` 之前，`list --finished` 已显示它而 status 仍把它当活跃。
 *
 * 完结由状态机的 `archived` 转换落值；这里用 kernel store 白盒置位（harness.seedArtifact 走的就是
 * store.set），目录搬移照 `openspec archive` 的布局做——主题是展示口径，不是转换本身。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'finished'
let h: Harness

beforeEach(async () => {
  h = await freshHarness()
  expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full']), h.err.join('\n')).toBe(0)
  await h.seedPhase(CHANGE, 'archive')
  await h.seedArtifact(CHANGE, 'archived', 'true')
  await h.seedArtifact(CHANGE, 'archived_at', '2026-09-20T00:00:00Z')
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

async function moveToArchive(): Promise<void> {
  const root = join(h.cwd, 'openspec', 'changes')
  await mkdir(join(root, 'archive'), { recursive: true })
  await rename(join(root, CHANGE), join(root, 'archive', `2026-09-20-${CHANGE}`))
}

interface Commit { readonly paths: readonly string[]; readonly message: string }
interface StatusJson {
  readonly active_changes: readonly { readonly name: string }[]
  readonly finished_changes?: readonly { readonly name: string; readonly archived_at: string }[]
  readonly step?: {
    readonly archived: boolean
    readonly next: readonly { readonly action: string; readonly commit?: Commit | null }[]
  }
}

const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false']
function git(args: readonly string[]): { readonly status: number | null; readonly output: string } {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd: h.cwd, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

async function statusOf(): Promise<StatusJson> {
  expect(await h.run(['status', CHANGE, '--json']), h.err.join('\n')).toBe(0)
  return JSON.parse(h.out.join('\n')) as StatusJson
}

async function finishedNames(): Promise<readonly string[]> {
  expect(await h.run(['list', '--finished', '--json'])).toBe(0)
  return (JSON.parse(h.out.join('\n')) as { finished: readonly { name: string }[] }).finished.map((row) => row.name)
}

describe('已完结的 change：status / check / list 同一口径', () => {
  test('transition archived 之后、openspec archive 之前：不在 active_changes，next 是 finish-change', async () => {
    const status = await statusOf()
    expect(status.active_changes).toEqual([])
    expect(status.finished_changes).toEqual([expect.objectContaining({ name: CHANGE, archived_at: '2026-09-20T00:00:00Z' })])
    expect(status.step?.next.map((action) => action.action)).toEqual(['finish-change'])
    expect(await finishedNames()).toEqual([CHANGE])
    expect(await h.run(['status', '--json'])).toBe(0)
    expect(JSON.parse(h.out.join('\n'))).toEqual({ active_changes: [] })
    expect(await h.run(['check', CHANGE])).toBe(0)
    expect(h.out.join('\n')).toBe(`change '${CHANGE}' 已完结（已归档），无需检查`)
  })

  test('openspec archive 搬走目录之后：check 不再报 FAIL，status 不再当它活跃', async () => {
    await moveToArchive()
    expect(await h.run(['check', CHANGE])).toBe(0)
    expect(h.out.join('\n')).toBe(`change '${CHANGE}' 已完结（已归档），无需检查`)
    expect(h.out.join('\n')).not.toContain('FAIL')
    const status = await statusOf()
    expect(status.active_changes).toEqual([])
    expect(status.finished_changes?.map((row) => row.name)).toEqual([CHANGE])
    expect(status.step).toBeUndefined()
    expect(await finishedNames()).toEqual([CHANGE])
  })
})

/**
 * 真机（第二轮）：照 finish-change 执行 `git add -A -- openspec/changes/<c> openspec/changes/archive`
 * 报 `fatal: pathspec … did not match any files`（exit 128）——原目录从未被 git 跟踪，已被
 * `openspec archive` 搬走。下发的提交命令必须在原目录已跟踪 / 未跟踪两种情况下都一次成功。
 */
describe('finish-change 的提交：一次成功', () => {
  async function commitOf(): Promise<Commit> {
    const status = await statusOf()
    expect(status.step?.archived, '已完结的 change：step.archived 为 true').toBe(true)
    const action = status.step?.next[0]
    expect(action?.action).toBe('finish-change')
    expect(action?.commit, '是 git 仓就必须带提交').toBeTruthy()
    return action!.commit!
  }

  function commitAsInstructed(commit: Commit): void {
    const add = git(['add', '-A', '--', ...commit.paths])
    expect(add.status, add.output).toBe(0)
    const done = git(['commit', '-q', '-m', commit.message])
    expect(done.status, done.output).toBe(0)
    expect(git(['status', '--porcelain', '--', 'openspec/changes']).output).toBe('')
  }

  test('原目录从未被跟踪：paths 不点名它，搬走之后 add + commit 一次成功（旧 paths 在同一现场 exit 128）', async () => {
    expect(git(['init', '-q']).status).toBe(0)
    const commit = await commitOf()
    expect(commit).toEqual({ paths: ['openspec/changes/archive'], message: `chore(openspec): archive ${CHANGE}` })
    await moveToArchive()
    // 回归证据：上一版下发的 paths 在这里整条失败。
    const legacy = git(['add', '-A', '--', `openspec/changes/${CHANGE}`, 'openspec/changes/archive'])
    expect(legacy.status).toBe(128)
    expect(legacy.output).toContain('did not match any files')
    commitAsInstructed(commit)
  })

  test('原目录已被跟踪：paths 带上它，删除与新目录在同一次提交里', async () => {
    expect(git(['init', '-q']).status).toBe(0)
    expect(git(['add', '-A']).status).toBe(0)
    expect(git(['commit', '-q', '-m', 'ship']).status).toBe(0)
    const commit = await commitOf()
    expect(commit).toEqual({
      paths: [`openspec/changes/${CHANGE}`, 'openspec/changes/archive'],
      message: `chore(openspec): archive ${CHANGE}`,
    })
    await moveToArchive()
    commitAsInstructed(commit)
    expect(git(['ls-files', '--', `openspec/changes/${CHANGE}`]).output).toBe('')
  })

  test('不是 git 仓：不发提交（commit: null），不给一条必然失败的命令', async () => {
    const status = await statusOf()
    expect(status.step?.next[0]).toMatchObject({ action: 'finish-change', commit: null })
  })
})
