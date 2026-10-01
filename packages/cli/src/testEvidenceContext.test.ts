import { describe, expect, it } from 'vitest'
import { mockState, makeDeps } from './test-support.js'
import { tryChangedFiles } from './test-system/plan-context.js'
import { changedFilesFor, testEvidenceContextFor } from './testEvidenceContext.js'

describe('testEvidenceContextFor —— 改动文件提供者', () => {
  it('身份缺失 → undefined（记录按用户存放，读不到就失败关闭）', () => {
    const deps = makeDeps({ state: mockState() })
    expect(testEvidenceContextFor({ ...deps, user: () => ({ missing: true }) }, 'demo')).toBeUndefined()
  })

  it('注入了 changedFiles 就用注入的；提供者抛错原样抛给判定（判定据此阻塞，不吞成空列表）', async () => {
    const deps = makeDeps({ state: mockState() })
    const seen: string[] = []
    const context = testEvidenceContextFor({ ...deps, changedFiles: async (name) => { seen.push(name); return ['src/a.test.ts'] } }, 'demo')
    expect(await context?.changedFiles?.()).toEqual(['src/a.test.ts'])
    expect(seen).toEqual(['demo'])
    const failing = changedFilesFor({ ...deps, changedFiles: async () => { throw new Error('不是 git 仓库') } }, 'demo')
    await expect(failing()).rejects.toThrow('不是 git 仓库')
  })

  it('缺省用 kernel 的 changedFilesForState：项目目录不是 git 仓库时抛 ChangedFilesUnavailableError', async () => {
    const deps = makeDeps({ state: mockState({ base_branch: 'main', created_at: '2026-01-01T00:00:00Z' }) })
    await expect(changedFilesFor({ ...deps, cwd: '/nonexistent-tenon-cwd' }, 'demo')()).rejects.toThrow(/git/)
  })
})

describe('改动文件的截断标记', () => {
  const truncated = { files: ['src/a.test.ts'], untrackedTruncated: { found: 25_000, limit: 20_000 } }

  it('测试策略拿到带标记的结果；只要列表的调用方拿到纯文件列表', async () => {
    const deps = { ...makeDeps({ state: mockState() }), changedFiles: async () => truncated }
    expect(await testEvidenceContextFor(deps, 'demo')?.changedFiles?.()).toEqual(truncated)
    expect(await changedFilesFor(deps, 'demo')()).toEqual(['src/a.test.ts'])
  })

  it('tenon test plan / sync 的输入读取把标记带出来；纯列表没有标记；失败带原因', async () => {
    const base = makeDeps({ state: mockState() })
    expect(await tryChangedFiles({ ...base, changedFiles: async () => truncated }, 'demo')).toEqual({
      ok: true, files: ['src/a.test.ts'], untrackedTruncated: { found: 25_000, limit: 20_000 },
    })
    expect(await tryChangedFiles({ ...base, changedFiles: async () => ['x.ts'] }, 'demo')).toEqual({ ok: true, files: ['x.ts'] })
    expect(await tryChangedFiles({ ...base, changedFiles: async () => { throw new Error('git 超时') } }, 'demo')).toEqual({ ok: false, reason: 'git 超时' })
  })
})
