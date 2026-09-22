/**
 * change 级写入拒绝的两条含义必须分得开：per-user 的「先收起来」，和「任务已完结」。
 * 第三条是 `openspec archive` 抢跑留下的中间态——目录已搬走而 `archived` 还是 false。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ensureUserLocalDir, serializeTaskArchive } from '@tenon/kernel'
import { changeFinishedMessage, refuseArchived, refuseFinished } from './archivedGuard.js'
import { makeDeps, mockState } from './test-support.js'

const repos: string[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })))
})

/** 真目录：定位逻辑要在文件系统上认出「活跃路径没了、归档目录里有」。 */
async function repoWithRelocated(dated: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'tenon-archived-guard-'))
  repos.push(repo)
  const dir = join(repo, 'openspec', 'changes', 'archive', dated)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.pipeline.yaml'), 'phase: archive\n', 'utf8')
  return repo
}

describe('refuseArchived —— 目录被 openspec archive 抢跑搬走', () => {
  test('还没完结：点名目录、原因与整条恢复命令，不是锁的 ENOENT', async () => {
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
    expect(err).toContain('openspec archive feat --skip-specs --yes')
    expect(err).not.toContain('ENOENT')
  })

  test('已完结：搬进归档目录是正常终态，不拦', async () => {
    const cwd = await repoWithRelocated('2026-01-02-feat')
    const deps = makeDeps({
      states: { '2026-01-02-feat': mockState({ phase: 'archive', archived: 'true' }) },
      changes: [],
      cwd,
    })
    expect(await refuseArchived(deps, 'feat')).toBe(false)
    expect(deps.errLines).toEqual([])
  })

  test('活跃目录还在就与本判定无关', async () => {
    const deps = makeDeps({ states: { feat: mockState({ archived: 'false' }) }, changes: ['feat'] })
    expect(await refuseArchived(deps, 'feat')).toBe(false)
    expect(deps.errLines).toEqual([])
  })

  test('per-user 收起表的拒绝说的是收起，不是完结', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tenon-archived-guard-hidden-'))
    repos.push(cwd)
    await mkdir(join(cwd, 'openspec', 'changes', 'feat'), { recursive: true })
    await writeFile(
      (await ensureUserLocalDir(cwd, 'tester-at-tenon.test')).archived,
      serializeTaskArchive({
        version: 1,
        changes: {
          feat: {
            archivedAt: '2026-01-02T00:00:00.000Z',
            phase: 'build',
            actor: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' },
          },
        },
      }),
      'utf8',
    )
    const deps = makeDeps({ states: { feat: mockState({ archived: 'false' }) }, changes: ['feat'], cwd })
    expect(await refuseArchived(deps, 'feat')).toBe(true)
    const err = deps.errLines.join('\n')
    expect(err).toContain('tenon task unarchive feat')
    expect(err).toContain('当前用户的收起列表')
    expect(err).not.toContain('archived=true')
    expect(changeFinishedMessage('feat')).not.toContain('tenon task unarchive')
  })
})

describe('refuseFinished —— 完结的判定只看 archived', () => {
  test('archived=true 拒写，文案与收起表不同', () => {
    const deps = makeDeps({ state: mockState({ archived: 'true' }) })
    expect(refuseFinished(deps, 'feat', mockState({ archived: 'true' }).fields)).toBe(true)
    expect(deps.errLines.join('\n')).toContain(changeFinishedMessage('feat'))
    expect(deps.errLines.join('\n')).not.toContain('tenon task unarchive')
  })

  test('其余取值一律放行', () => {
    const deps = makeDeps({ state: mockState({}) })
    for (const archived of ['false', '', 'null']) {
      expect(refuseFinished(deps, 'feat', mockState({ archived }).fields)).toBe(false)
    }
    expect(deps.errLines).toEqual([])
  })
})
