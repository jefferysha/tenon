import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ensureUserLocalDir, serializeTaskArchive, type PipelineState } from '@tenon/kernel'
import { cmdList, cmdListFinished, cmdStatus } from './status.js'
import { makeDeps, mockState, spy } from '../test-support.js'

const ARCHIVE_ENTRY = {
  archivedAt: '2026-09-15T12:00:00.000Z',
  phase: 'build',
  actor: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const },
}
const repos: string[] = []

/** Real temporary checkout whose per-user archive store hides `names` from the acting user. */
async function repoWithArchived(...names: string[]): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'tenon-status-archived-'))
  repos.push(repo)
  for (const name of names) await mkdir(join(repo, 'openspec', 'changes', name), { recursive: true })
  const paths = await ensureUserLocalDir(repo, 'tester-at-tenon.test')
  await writeFile(paths.archived, serializeTaskArchive({
    version: 1,
    changes: Object.fromEntries(names.map((name) => [name, ARCHIVE_ENTRY])),
  }), 'utf8')
  return repo
}

/**
 * D14：OpenSpec 归档把 `openspec/changes/<name>` 移成 `openspec/changes/archive/<日期>-<name>`
 * （skills/openspec-archive-change 第 5 步）。真目录 + 真 `.pipeline.yaml`，因为定位逻辑要在
 * 文件系统上找那份被移走的状态。
 */
async function repoWithFinished(dated: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'tenon-status-finished-'))
  repos.push(repo)
  const dir = join(repo, 'openspec', 'changes', 'archive', dated)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.pipeline.yaml'), 'phase: archive\n', 'utf8')
  return repo
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })))
})

const stateA = mockState({
  track: 'backend',
  phase: 'build',
  phase_status: 'in_progress',
  verify_result: 'pending',
  assignee: 'Jeff Sha <jeff@x.io>',
  updated_at: '2026-07-06T00:00:00Z',
})
const stateB = mockState({
  track: 'pm',
  phase: 'explore',
  phase_status: 'pending',
  assignee: 'null',
  updated_at: '2026-07-05T00:00:00Z',
})
const stateArchived = mockState({
  track: 'chat',
  phase: 'archive',
  phase_status: 'done',
  archived: 'true',
  updated_at: '2026-07-01T00:00:00Z',
})

describe('status --json —— schema 稳定（CONTRACT §3）', () => {
  test('全量：active_changes 数组，键序固定，排除 archived，按名排序', async () => {
    const deps = makeDeps({ states: { 'demo-b': stateB, 'demo-a': stateA, 'old-x': stateArchived } })
    const code = await cmdStatus(deps, undefined, { json: true })
    expect(code).toBe(0)
    expect(deps.outLines).toHaveLength(1)
    expect(JSON.parse(deps.outLines[0]!)).toEqual({
      active_changes: [
        {
          name: 'demo-a',
          track: 'backend',
          phase: 'build',
          phase_status: 'in_progress',
          verify_result: 'pending',
          updated_at: '2026-07-06T00:00:00Z',
        },
        {
          name: 'demo-b',
          track: 'pm',
          phase: 'explore',
          phase_status: 'pending',
          verify_result: '',
          updated_at: '2026-07-05T00:00:00Z',
        },
      ],
    })
  })

  test('键序逐字稳定（schema 锚）', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA } })
    await cmdStatus(deps, undefined, { json: true })
    expect(deps.outLines[0]).toBe(
      '{"active_changes":[{"name":"demo-a","track":"backend","phase":"build",'
      + '"phase_status":"in_progress","verify_result":"pending","updated_at":"2026-07-06T00:00:00Z"}]}',
    )
  })

  test('指定 name：已完结的不算活跃，落在 finished_changes（与列表形态同一口径）', async () => {
    const deps = makeDeps({ states: { 'old-x': stateArchived } })
    const code = await cmdStatus(deps, 'old-x', { json: true })
    expect(code).toBe(0)
    const parsed = JSON.parse(deps.outLines[0]!) as {
      active_changes: Array<{ name: string }>
      finished_changes: Array<{ name: string }>
    }
    expect(parsed.active_changes).toEqual([])
    expect(parsed.finished_changes.map((row) => row.name)).toEqual(['old-x'])
  })

  test('空项目：active_changes 为空数组，exit 0', async () => {
    const deps = makeDeps({ changes: [] })
    const code = await cmdStatus(deps, undefined, { json: true })
    expect(code).toBe(0)
    expect(deps.outLines).toEqual(['{"active_changes":[]}'])
  })
})

describe('status —— 人读渲染（对齐宽度）', () => {
  test('单 change 摘要：对齐 key-value 块', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA } })
    const code = await cmdStatus(deps, 'demo-a', {})
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([
      'change   demo-a',
      'track    backend',
      'phase    build (in_progress)',
      'verify   pending',
      'updated  2026-07-06T00:00:00Z',
    ])
  })

  test('全量：紧凑表（列宽对齐、空值显示 -、无尾空格）', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA, 'demo-b': stateB } })
    const code = await cmdStatus(deps, undefined, {})
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([
      'NAME    TRACK    PHASE    STATUS       VERIFY   UPDATED',
      'demo-a  backend  build    in_progress  pending  2026-07-06T00:00:00Z',
      'demo-b  pm       explore  pending      -        2026-07-05T00:00:00Z',
    ])
    for (const line of deps.outLines) expect(line).toBe(line.trimEnd())
  })

  test('无活跃 change：提示一行，exit 0', async () => {
    const deps = makeDeps({ changes: [] })
    const code = await cmdStatus(deps, undefined, {})
    expect(code).toBe(0)
    expect(deps.outLines).toEqual(['无活跃 change'])
  })

  test('某 change 读取失败：跳过 + stderr WARN，其余照常，exit 0', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA }, changes: ['demo-a', 'broken'] })
    const code = await cmdStatus(deps, undefined, {})
    expect(code).toBe(0)
    expect(deps.outLines.some((l) => l.startsWith('demo-a'))).toBe(true)
    expect(deps.errLines.join('\n')).toContain('broken')
  })

  test('指定 name 不存在：exit 1', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA } })
    const code = await cmdStatus(deps, 'ghost', {})
    expect(code).toBe(1)
  })

  /**
   * D7（acceptance run）：`tenon status no-such-change` 打的是
   * `ERROR: ENOENT: no such file or directory, open '….../.pipeline.yaml'`——既点名了内部存储
   * 文件，又不告诉读者发生了什么。`tenon get` 早已把同一条缝翻译成产品层的一句话。
   */
  test('指定 name 不存在：产品层文案，不漏内部存储路径', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA } })
    deps.store.read = spy(async (dir: string) => {
      const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${dir}/.pipeline.yaml'`)
      error.code = 'ENOENT'
      throw error
    })
    expect(await cmdStatus(deps, 'ghost', {})).toBe(1)
    expect(deps.errLines).toEqual(['ERROR: change 不存在: ghost'])
  })
})

describe('list —— 活跃 change 表；--json schema 稳定', () => {
  test('人读：紧凑表 NAME/TRACK/PHASE/STATUS/OWNER（负责人名字，无负责人为 -）', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA, 'demo-b': stateB } })
    const code = await cmdList(deps, {})
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([
      'NAME    TRACK    PHASE    STATUS       OWNER',
      'demo-a  backend  build    in_progress  Jeff Sha',
      'demo-b  pm       explore  pending      -',
    ])
  })

  test('--json：{"changes":[...]} 键序稳定，排除 archived', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA, 'old-x': stateArchived } })
    const code = await cmdList(deps, { json: true })
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([
      '{"changes":[{"name":"demo-a","track":"backend","phase":"build",'
      + '"phase_status":"in_progress","owner":{"id":"jeff@x.io","name":"Jeff Sha"}}]}',
    ])
  })

  test('空：人读提示一行 / json 空数组，exit 0', async () => {
    const human = makeDeps({ changes: [] })
    expect(await cmdList(human, {})).toBe(0)
    expect(human.outLines).toEqual(['无活跃 change'])

    const json = makeDeps({ changes: [] })
    expect(await cmdList(json, { json: true })).toBe(0)
    expect(json.outLines).toEqual(['{"changes":[]}'])
  })

  test('listChanges 收到 <cwd>/openspec/changes', async () => {
    const deps = makeDeps({ changes: [] })
    await cmdList(deps, {})
    expect(deps.listChanges.calls[0]?.[0]).toBe('/repo/openspec/changes')
  })

  test('读取失败的 change 跳过 + WARN，exit 0', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA }, changes: ['demo-a', 'broken'] })
    deps.store.read = spy(async (dir: string): Promise<PipelineState> => {
      if (dir.endsWith('demo-a')) return stateA
      throw new Error('ENOENT')
    })
    const code = await cmdList(deps, {})
    expect(code).toBe(0)
    expect(deps.errLines.join('\n')).toContain('broken')
  })
})

describe('已归档（当前用户）在列表中隐藏', () => {
  test('status / list 跳过当前用户已归档的 change，键序不变', async () => {
    const cwd = await repoWithArchived('demo-a')
    const status = makeDeps({ states: { 'demo-a': stateA, 'demo-b': stateB }, cwd })
    expect(await cmdStatus(status, undefined, { json: true })).toBe(0)
    expect(status.outLines[0]).toBe(
      '{"active_changes":[{"name":"demo-b","track":"pm","phase":"explore","phase_status":"pending","verify_result":"","updated_at":"2026-07-05T00:00:00Z"}]}',
    )
    const list = makeDeps({ states: { 'demo-a': stateA, 'demo-b': stateB }, cwd })
    expect(await cmdList(list, { json: true })).toBe(0)
    expect(list.outLines[0]).toBe(
      '{"changes":[{"name":"demo-b","track":"pm","phase":"explore","phase_status":"pending","owner":null}]}',
    )
  })

  test('另一个用户的归档不影响本用户；读不到的归档记录 fail-open', async () => {
    const cwd = await repoWithArchived('demo-a')
    const other = makeDeps({
      states: { 'demo-a': stateA },
      cwd,
      user: () => ({ id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }),
    })
    expect(await cmdList(other, { json: true })).toBe(0)
    expect(other.outLines[0]).toContain('demo-a')

    const missing = makeDeps({ states: { 'demo-a': stateA }, cwd, user: () => ({ missing: true }) })
    expect(await cmdList(missing, { json: true })).toBe(0)
    expect(missing.outLines[0]).toContain('demo-a')
  })
})

/**
 * D14：完结的任务被 OpenSpec 移进 archive/ 之后，status 与 get 只剩一句 ENOENT，两张列表也都
 * 看不到它——做完的工作从此不可查。做完 ≠ 消失：只读面要能一路读到归档目录里那份状态。
 */
describe('完结（已移入 openspec/changes/archive/）的 change 仍可查', () => {
  const finishedState = mockState({
    track: 'backend',
    phase: 'archive',
    phase_status: 'done',
    archived: 'true',
    archived_at: '2026-09-22T03:00:00Z',
    assignee: 'Tester <tester@tenon.test>',
    updated_at: '2026-09-22T03:00:00Z',
  })

  test('status <name>：从归档目录读到状态，不再 ENOENT', async () => {
    const cwd = await repoWithFinished('2026-09-22-fin-demo')
    const deps = makeDeps({ states: { '2026-09-22-fin-demo': finishedState }, changes: [], cwd })
    expect(await cmdStatus(deps, 'fin-demo', {})).toBe(0)
    expect(deps.outLines).toEqual([
      'change       fin-demo',
      'track        backend',
      'phase        archive (done)',
      'verify       -',
      'updated      2026-09-22T03:00:00Z',
      'archived     true',
      'archived_at  2026-09-22T03:00:00Z',
    ])
  })

  test('status <name> --json：给出状态，step 的 next 是 stop finished——完结的任务没有下一步', async () => {
    const cwd = await repoWithFinished('2026-09-22-fin-demo')
    const deps = makeDeps({ states: { '2026-09-22-fin-demo': finishedState }, changes: [], cwd })
    expect(await cmdStatus(deps, 'fin-demo', { json: true })).toBe(0)
    const parsed = JSON.parse(deps.outLines[0]!) as Record<string, unknown>
    expect(parsed.active_changes).toEqual([])
    expect(parsed.finished_changes).toEqual([{
      name: 'fin-demo',
      track: 'backend',
      phase: 'archive',
      phase_status: 'done',
      verify_result: '',
      updated_at: '2026-09-22T03:00:00Z',
      archived_at: expect.any(String),
    }])
    // 真机（第三轮）：从前省略 step，照 `.step.next` 读的循环当场 KeyError；现在 step 结构照旧。
    expect(parsed.step).toMatchObject({
      schema: 'tenon-step-v1',
      change: 'fin-demo',
      archived: true,
      exits: [],
      next: [{ action: 'stop', code: 'finished' }],
    })
  })

  test('list --finished 列出它；活跃表仍然不列', async () => {
    const cwd = await repoWithFinished('2026-09-22-fin-demo')
    const finished = makeDeps({ states: { '2026-09-22-fin-demo': finishedState }, changes: [], cwd })
    expect(await cmdListFinished(finished, { json: true })).toBe(0)
    expect(JSON.parse(finished.outLines[0]!)).toEqual({
      finished: [{
        name: 'fin-demo',
        track: 'backend',
        phase: 'archive',
        phase_status: 'done',
        archived: 'true',
        archived_at: '2026-09-22T03:00:00Z',
        owner: { id: 'tester@tenon.test', name: 'Tester' },
      }],
    })
    const active = makeDeps({ states: { '2026-09-22-fin-demo': finishedState }, changes: [], cwd })
    expect(await cmdList(active, { json: true })).toBe(0)
    expect(active.outLines[0]).toBe('{"changes":[]}')
  })

  test('没有归档目录时 list --finished 说清楚是空的', async () => {
    const deps = makeDeps({ changes: [] })
    expect(await cmdListFinished(deps, {})).toBe(0)
    expect(deps.outLines).toEqual(['无已完结 change'])
  })

  /**
   * 真机实测的 P0（acceptance run）：`tenon transition <c> archived` 之后、`openspec archive`
   * 之前，change 目录还在 `openspec/changes/` 下而 `archived` 已是 true。活跃表按 archived=true
   * 把它滤掉，完结表只读归档目录，做完的任务在两张表里同时消失——正是 collectFinished 的注释
   * 说「不该存在」的那个状态。完结的判定是 `archived=true`，目录在哪只决定它还能不能继续改。
   */
  test('list --finished 也列出还没被 openspec archive 搬走的完结 change', async () => {
    const finished = makeDeps({ states: { 'fin-demo': finishedState }, changes: ['fin-demo'] })
    expect(await cmdListFinished(finished, { json: true })).toBe(0)
    expect(JSON.parse(finished.outLines[0]!)).toEqual({
      finished: [{
        name: 'fin-demo',
        track: 'backend',
        phase: 'archive',
        phase_status: 'done',
        archived: 'true',
        archived_at: '2026-09-22T03:00:00Z',
        owner: { id: 'tester@tenon.test', name: 'Tester' },
      }],
    })
    const active = makeDeps({ states: { 'fin-demo': finishedState }, changes: ['fin-demo'] })
    expect(await cmdList(active, { json: true })).toBe(0)
    expect(active.outLines[0]).toBe('{"changes":[]}')
  })

  test('同一个 change 两边都在时只列一次，读归档目录那份', async () => {
    const cwd = await repoWithFinished('2026-09-22-fin-demo')
    const deps = makeDeps({
      states: { 'fin-demo': finishedState, '2026-09-22-fin-demo': finishedState },
      changes: ['fin-demo'],
      cwd,
    })
    expect(await cmdListFinished(deps, { json: true })).toBe(0)
    const parsed = JSON.parse(deps.outLines[0]!) as { finished: readonly { name: string }[] }
    expect(parsed.finished.map((row) => row.name)).toEqual(['fin-demo'])
  })

  test('活跃 change 没有 archived=true 时不进完结表', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA }, changes: ['demo-a'] })
    expect(await cmdListFinished(deps, { json: true })).toBe(0)
    expect(deps.outLines[0]).toBe('{"finished":[]}')
  })

  test('status <name>：目录还没搬走也照样报 archived / archived_at', async () => {
    const deps = makeDeps({ states: { 'fin-demo': finishedState }, changes: ['fin-demo'] })
    expect(await cmdStatus(deps, 'fin-demo', {})).toBe(0)
    expect(deps.outLines.slice(-2)).toEqual([
      'archived     true',
      'archived_at  2026-09-22T03:00:00Z',
    ])
  })

  test('活跃目录还在时不去归档目录找（同名不串）', async () => {
    const cwd = await repoWithFinished('2026-09-22-demo-a')
    const deps = makeDeps({ states: { 'demo-a': stateA, '2026-09-22-demo-a': finishedState }, cwd })
    expect(await cmdStatus(deps, 'demo-a', {})).toBe(0)
    expect(deps.outLines).toEqual([
      'change   demo-a',
      'track    backend',
      'phase    build (in_progress)',
      'verify   pending',
      'updated  2026-07-06T00:00:00Z',
    ])
  })
})
