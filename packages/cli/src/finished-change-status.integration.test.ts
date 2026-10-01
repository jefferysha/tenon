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
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
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

interface Commit { readonly paths: readonly string[]; readonly untrack: readonly string[]; readonly message: string }
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
    expect(status.step?.archived).toBe(true)
    expect(status.step?.next).toEqual([expect.objectContaining({ action: 'stop', code: 'finished' })])
    expect(await finishedNames()).toEqual([CHANGE])
  })
})

/**
 * 真机（第二轮）：照 finish-change 执行 `git add -A -- openspec/changes/<c> openspec/changes/archive`
 * 报 `fatal: pathspec … did not match any files`（exit 128）——原目录从未被 git 跟踪，已被
 * `openspec archive` 搬走。下发的提交命令必须在原目录已跟踪 / 未跟踪两种情况下都一次成功。
 */
describe('finish-change 的提交：一次成功', () => {
  /** init 之后磁盘上已有的状态目录 .gitignore（它们首次生成后未跟踪，要随收尾一起提交）。 */
  function housekeeping(): readonly string[] {
    return ['.pipeline/.gitignore', '.tenon/.gitignore', 'openspec/.gitignore']
      .filter((path) => existsSync(join(h.cwd, path)))
  }

  async function commitOf(): Promise<Commit> {
    const status = await statusOf()
    expect(status.step?.archived, '已完结的 change：step.archived 为 true').toBe(true)
    const action = status.step?.next[0]
    expect(action?.action).toBe('finish-change')
    expect(action?.commit, '是 git 仓就必须带提交').toBeTruthy()
    return action!.commit!
  }

  /** 照动作原样执行：add → （untrack 非空时）rm --cached → commit，每条都必须一次成功，之后工作区干净。 */
  function commitAsInstructed(commit: Commit): void {
    const add = git(['add', '-A', '--', ...commit.paths])
    expect(add.status, add.output).toBe(0)
    if (commit.untrack.length > 0) {
      const untrack = git(['rm', '--cached', '-q', '--ignore-unmatch', '--', ...commit.untrack])
      expect(untrack.status, untrack.output).toBe(0)
    }
    const done = git(['commit', '-q', '-m', commit.message])
    expect(done.status, done.output).toBe(0)
    // 夹具项目里别的文件（DESIGN.md 等）与收尾无关；任务相关的三处必须干净。
    expect(git(['status', '--porcelain', '--', 'openspec', '.pipeline', '.tenon']).output).toBe('')
  }

  test('原目录从未被跟踪：paths 不点名它，搬走之后 add + commit 一次成功（旧 paths 在同一现场 exit 128）', async () => {
    expect(git(['init', '-q']).status).toBe(0)
    const commit = await commitOf()
    expect(commit).toEqual({
      paths: ['openspec/changes/archive', ...housekeeping()],
      untrack: [],
      message: `chore(openspec): archive ${CHANGE}`,
    })
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
      paths: [`openspec/changes/${CHANGE}`, 'openspec/changes/archive', ...housekeeping()],
      untrack: [],
      message: `chore(openspec): archive ${CHANGE}`,
    })
    await moveToArchive()
    commitAsInstructed(commit)
    expect(git(['ls-files', '--', `openspec/changes/${CHANGE}`]).output).toBe('')
  })

  /**
   * 状态目录自己的 .gitignore 首次生成后未跟踪：存在且没被忽略的一起提交，收尾后 git status 才干净；
   * 被上层规则忽略的（`git add` 会 exit 1）不列。
   */
  test('状态目录的 .gitignore：未跟踪的一起提交；被忽略的不列', async () => {
    await writeFile(join(h.cwd, '.pipeline', '.gitignore'), '*.lock\n', 'utf8')
    await mkdir(join(h.cwd, '.tenon'), { recursive: true })
    await writeFile(join(h.cwd, '.tenon', '.gitignore'), 'users/*/local/\n', 'utf8')
    await writeFile(join(h.cwd, 'openspec', '.gitignore'), '.pipeline-terminal-activity.*\n', 'utf8')
    // 仓库根把 .tenon/ 整个忽略：.tenon/.gitignore 不能出现在 paths 里。
    await writeFile(join(h.cwd, '.gitignore'), '.tenon/\n', 'utf8')
    expect(git(['init', '-q']).status).toBe(0)
    expect(git(['add', '.gitignore']).status).toBe(0)
    expect(git(['commit', '-q', '-m', 'root ignore']).status).toBe(0)
    const commit = await commitOf()
    expect(commit.paths).toEqual(['openspec/changes/archive', '.pipeline/.gitignore', 'openspec/.gitignore'])
    await moveToArchive()
    commitAsInstructed(commit)
    expect(git(['ls-files', '--', '.pipeline/.gitignore', 'openspec/.gitignore']).output.trim().split('\n'))
      .toEqual(['.pipeline/.gitignore', 'openspec/.gitignore'])
  })

  /**
   * 旧版本把终端心跳 `.pipeline-terminal-activity.json` 提交进了 git；后来加的忽略规则不会取消跟踪。
   * 已跟踪且已被忽略的心跳进 untrack，`git rm --cached --ignore-unmatch` 移出索引（本 change 的那份
   * 已随目录搬走也不报错），收尾后 git status 干净、心跳不再被跟踪。
   */
  test('已被旧版本提交的终端心跳：untrack 移出索引，一次成功', async () => {
    const heartbeat = '.pipeline-terminal-activity.json'
    const oldArchived = join(h.cwd, 'openspec', 'changes', 'archive', '2026-01-01-old')
    await mkdir(oldArchived, { recursive: true })
    await writeFile(join(oldArchived, heartbeat), '{"pid":1}\n', 'utf8')
    await writeFile(join(h.cwd, 'openspec', 'changes', CHANGE, heartbeat), '{"pid":2}\n', 'utf8')
    expect(git(['init', '-q']).status).toBe(0)
    expect(git(['add', '-A']).status).toBe(0)
    expect(git(['commit', '-q', '-m', 'legacy heartbeat committed']).status).toBe(0)
    await writeFile(join(h.cwd, 'openspec', '.gitignore'), '.pipeline-terminal-activity.*\n', 'utf8')

    const commit = await commitOf()
    expect([...commit.untrack].sort()).toEqual([
      `openspec/changes/${CHANGE}/${heartbeat}`,
      `openspec/changes/archive/2026-01-01-old/${heartbeat}`,
    ].sort())
    expect(commit.paths).toContain('openspec/.gitignore')
    await moveToArchive()
    commitAsInstructed(commit)
    expect(git(['ls-files', '--', `*${heartbeat}`]).output).toBe('')
    // 心跳文件本身还在磁盘上，只是不再被跟踪（也不显示为未跟踪：已被忽略）。
    expect(existsSync(join(oldArchived, heartbeat))).toBe(true)
  })

  test('不是 git 仓：不发提交（commit: null），不给一条必然失败的命令', async () => {
    const status = await statusOf()
    expect(status.step?.next[0]).toMatchObject({ action: 'finish-change', commit: null })
  })
})

/**
 * 真机验收 F7：design-system 任务归档只提交了 openspec/changes/archive 与几个 .gitignore，`DESIGN.md`（10 章）和
 * `design/`（模型、方向文档、预览页，约 2350 行）留在工作区，随后的前端任务 `tenon test code-size` 把它们算成
 * 候选改动（4354 行）。设计体系任务的收尾提交要带上它们；别的工作流不动项目根的 DESIGN.md。
 */
describe('finish-change 的提交：design-system 任务带上 DESIGN.md 与 design/', () => {
  const DS = 'shop-design'

  async function archivedDesignSystem(): Promise<Commit> {
    expect(await h.run(['init', DS, '--workflow', 'design-system', '--track', 'free', '--preset', 'full']), h.err.join('\n')).toBe(0)
    await h.seedPhase(DS, 'review')
    await h.seedArtifact(DS, 'archived', 'true')
    await h.seedArtifact(DS, 'archived_at', '2026-09-20T00:00:00Z')
    expect(await h.run(['status', DS, '--json']), h.err.join('\n')).toBe(0)
    const action = (JSON.parse(h.out.join('\n')) as StatusJson).step?.next[0]
    expect(action?.action).toBe('finish-change')
    expect(action?.commit).toBeTruthy()
    return action!.commit!
  }

  test('DESIGN.md 与 design/ 在 paths 里；照动作提交后它们已入库、工作区干净', async () => {
    await writeFile(join(h.cwd, 'DESIGN.md'), '---\nschema: tenon-design/v1\n---\n# 1. Philosophy\n', 'utf8')
    await mkdir(join(h.cwd, 'design'), { recursive: true })
    await writeFile(join(h.cwd, 'design', 'design-model.yaml'), 'schema: tenon-design-model/v1\n', 'utf8')
    await writeFile(join(h.cwd, 'design', 'preview.html'), '<html></html>\n', 'utf8')
    expect(git(['init', '-q']).status).toBe(0)
    const commit = await archivedDesignSystem()
    expect(commit.paths).toEqual(expect.arrayContaining(['DESIGN.md', 'design', 'openspec/changes/archive']))
    const root = join(h.cwd, 'openspec', 'changes')
    await mkdir(join(root, 'archive'), { recursive: true })
    await rename(join(root, DS), join(root, 'archive', `2026-09-20-${DS}`))
    const add = git(['add', '-A', '--', ...commit.paths])
    expect(add.status, add.output).toBe(0)
    const done = git(['commit', '-q', '-m', commit.message])
    expect(done.status, done.output).toBe(0)
    // 夹具项目自带一套就绪的设计体系（design/ 下还有别的文件）：这里只看本测试写下的三个，以及整体已干净。
    expect(git(['ls-files', '--', 'DESIGN.md', 'design']).output.trim().split('\n'))
      .toEqual(expect.arrayContaining(['DESIGN.md', 'design/design-model.yaml', 'design/preview.html']))
    expect(git(['status', '--porcelain', '--', 'DESIGN.md', 'design']).output).toBe('')
  })

  test('被忽略或不存在的设计文件不进 paths（git add 会整条失败）；default 工作流的收尾不带它们', async () => {
    await rm(join(h.cwd, 'design'), { recursive: true, force: true })
    await writeFile(join(h.cwd, 'DESIGN.md'), '# ignored\n', 'utf8')
    await writeFile(join(h.cwd, '.gitignore'), 'DESIGN.md\n', 'utf8')
    expect(git(['init', '-q']).status).toBe(0)
    const commit = await archivedDesignSystem()
    expect(commit.paths).not.toContain('DESIGN.md')
    expect(commit.paths).not.toContain('design')

    const plain = await statusOf()
    expect(plain.step?.next[0]?.commit?.paths).not.toContain('DESIGN.md')
  })
})
