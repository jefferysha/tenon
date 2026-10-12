/**
 * 已结束任务的写入拒绝要把三种含义分开：已终止（任务结果记录说的）、`openspec archive` 抢跑留下的中间态
 * （目录已搬走而 `archived` 还是 false），以及已完结（`archived=true`，字段写入按状态拒绝）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { changeFinishedMessage, refuseArchived, refuseFinished } from './endedTaskGuard.js'
import { makeDeps, mockState } from './test-support.js'

const repos: string[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })))
})

/** 真目录：定位逻辑要在文件系统上认出「活跃路径没了、归档目录里有」。 */
async function repoWithRelocated(dated: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'tenon-ended-guard-'))
  repos.push(repo)
  const dir = join(repo, 'openspec', 'changes', 'archive', dated)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.pipeline.yaml'), 'phase: archive\n', 'utf8')
  return repo
}

describe('refuseArchived —— 已移进 archive/ 的任务', () => {
  test('已终止：点名目录与原因，指向新建任务 + depends_on，而不是恢复命令', async () => {
    const cwd = await repoWithRelocated('2026-01-02-feat')
    const deps = makeDeps({
      states: { '2026-01-02-feat': mockState({ phase: 'build', archived: 'false', task_result: 'terminated' }) },
      changes: [],
      cwd,
    })
    expect(await refuseArchived(deps, 'feat')).toBe(true)
    const err = deps.errLines.join('\n')
    expect(err).toContain("任务 'feat' 已终止")
    expect(err).toContain('openspec/changes/archive/2026-01-02-feat')
    expect(err).toContain('depends_on feat')
    expect(err).not.toContain('tenon task unarchive')
    expect(err).not.toContain('mv openspec/changes/archive')
  })

  test('目录被 openspec archive 抢跑搬走、没有任务结果：点名目录、原因与整条恢复命令，不是锁的 ENOENT', async () => {
    const cwd = await repoWithRelocated('2026-01-02-feat')
    const deps = makeDeps({
      states: { '2026-01-02-feat': mockState({ phase: 'archive', archived: 'false' }) },
      changes: [],
      cwd,
    })
    expect(await refuseArchived(deps, 'feat')).toBe(true)
    const err = deps.errLines.join('\n')
    expect(err).toContain('openspec/changes/archive/2026-01-02-feat')
    expect(err).toContain('archived=false')
    expect(err).toContain('mv openspec/changes/archive/2026-01-02-feat openspec/changes/feat')
    expect(err).toContain('tenon transition feat archived')
    expect(err).toContain('tenon task finish feat')
    expect(err).not.toContain('openspec archive feat')
    expect(err).not.toContain('ENOENT')
  })

  test('已完结（含已升级）：搬进归档目录是正常终态，不拦', async () => {
    for (const result of ['', 'finished', 'escalated']) {
      const cwd = await repoWithRelocated('2026-01-02-feat')
      const deps = makeDeps({
        states: { '2026-01-02-feat': mockState({ phase: 'archive', archived: 'true', task_result: result }) },
        changes: [],
        cwd,
      })
      expect(await refuseArchived(deps, 'feat')).toBe(false)
      expect(deps.errLines).toEqual([])
    }
  })

  test('活跃目录还在就与本判定无关', async () => {
    const deps = makeDeps({ states: { feat: mockState({ archived: 'false' }) }, changes: ['feat'] })
    expect(await refuseArchived(deps, 'feat')).toBe(false)
    expect(deps.errLines).toEqual([])
  })

  test('活跃任务上残留的 task_result=terminated（归档被打断）不算已终止：只有目录在 archive/ 下才算', async () => {
    // archive/ 里有一个同名的旧任务，活跃目录里是新任务，状态里带着被打断的归档留下的 task_result。
    const cwd = await repoWithRelocated('2026-01-02-feat')
    const active = join(cwd, 'openspec', 'changes', 'feat')
    await mkdir(active, { recursive: true })
    await writeFile(join(active, '.pipeline.yaml'), 'phase: build\n', 'utf8')
    const leftover = mockState({ phase: 'build', archived: 'false', task_result: 'terminated' })
    const deps = makeDeps({ states: { feat: leftover, '2026-01-02-feat': leftover }, changes: ['feat'], cwd })
    expect(await refuseArchived(deps, 'feat')).toBe(false)
    expect(deps.errLines).toEqual([])
  })
})

describe('refuseFinished —— 完结的判定只看 archived', () => {
  test('archived=true 拒写', () => {
    const deps = makeDeps({ state: mockState({ archived: 'true' }) })
    expect(refuseFinished(deps, 'feat', mockState({ archived: 'true' }).fields)).toBe(true)
    expect(deps.errLines.join('\n')).toContain(changeFinishedMessage('feat'))
  })

  test('其余取值一律放行', () => {
    const deps = makeDeps({ state: mockState({}) })
    for (const archived of ['false', '', 'null']) {
      expect(refuseFinished(deps, 'feat', mockState({ archived }).fields)).toBe(false)
    }
    expect(deps.errLines).toEqual([])
  })
})
