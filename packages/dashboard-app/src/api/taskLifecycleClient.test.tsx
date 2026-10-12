import { describe, expect, it, vi } from 'vitest'
import {
  deleteTask, fetchTaskLifecycle, TaskLifecycleRefusal, terminateTask,
} from './taskLifecycleClient'

describe('taskLifecycleClient', () => {
  it('decodes the reasons the dialog displays', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      action: 'delete',
      phase: 'build',
      blockers: [],
      confirmations: [{ code: 'review-pending' }, { code: 'has-dependents', detail: 'b,c' }],
    }), { status: 200 }))
    const view = await fetchTaskLifecycle('/repo', 'demo', 'delete')
    expect(view).toEqual({
      action: 'delete',
      phase: 'build',
      blockers: [],
      confirmations: [{ code: 'review-pending' }, { code: 'has-dependents', detail: 'b,c' }],
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/change/demo/lifecycle?root=%2Frepo&action=delete')
    fetchMock.mockRestore()
  })

  it('rejects an unknown reason code and a malformed view', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, action: 'delete', phase: 'build', blockers: [], confirmations: [{ code: 'nope' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, action: 'nope', phase: 'build', blockers: [], confirmations: [] }), { status: 200 }))
    await expect(fetchTaskLifecycle('/repo', 'demo', 'delete')).rejects.toThrow()
    await expect(fetchTaskLifecycle('/repo', 'demo', 'delete')).rejects.toThrow()
    fetchMock.mockRestore()
  })

  it('sends the acknowledged codes and decodes the terminate result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true, result: 'terminated', archived_dir: 'openspec/changes/archive/2026-09-15-demo',
      ended_at: '2026-09-15T12:00:00.000Z', commit: 'committed',
    }), { status: 200 }))
    const result = await terminateTask({ root: '/repo', change: 'demo', acknowledged: ['review-pending'] })
    expect(result).toEqual({
      archivedDir: 'openspec/changes/archive/2026-09-15-demo', endedAt: '2026-09-15T12:00:00.000Z', commit: 'committed', warnings: [],
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/change/demo/terminate')
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST', body: JSON.stringify({ root: '/repo', acknowledged: ['review-pending'] }),
    }))
    fetchMock.mockRestore()
  })

  it('rejects a terminate response that is not a terminated result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, changed: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: 'finished', archived_dir: 'x', ended_at: 'y', commit: 'skipped' }), { status: 200 }))
    await expect(terminateTask({ root: '/repo', change: 'demo', acknowledged: [] })).rejects.toThrow()
    await expect(terminateTask({ root: '/repo', change: 'demo', acknowledged: [] })).rejects.toThrow()
    fetchMock.mockRestore()
  })

  it('decodes delete, including a null 未提交删除 count', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, removed: ['openspec/changes/demo'], uncommittedDeletions: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, removed: [], uncommittedDeletions: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, removed: [], uncommittedDeletions: -1 }), { status: 200 }))
    expect(await deleteTask({ root: '/repo', change: 'demo', acknowledged: ['review-pending', 'has-dependents'] }))
      .toEqual({ removed: ['openspec/changes/demo'], uncommittedDeletions: 1, warnings: [] })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/change/demo?root=%2Frepo&acknowledged=review-pending,has-dependents')
    expect(await deleteTask({ root: '/repo', change: 'demo', acknowledged: [] }))
      .toEqual({ removed: [], uncommittedDeletions: null, warnings: [] })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/change/demo?root=%2Frepo')
    await expect(deleteTask({ root: '/repo', change: 'demo', acknowledged: [] })).rejects.toThrow()
    fetchMock.mockRestore()
  })

  it('carries the server warnings of a terminate result through, and treats a missing key as none', async () => {
    const base = { ok: true, result: 'terminated', archived_dir: 'openspec/changes/archive/2026-09-15-demo', ended_at: '2026-09-15T12:00:00.000Z', commit: 'committed' }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: ['审计记录没写进去: EISDIR', '另一条'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(base), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: [] }), { status: 200 }))
    expect((await terminateTask({ root: '/repo', change: 'demo', acknowledged: [] })).warnings)
      .toEqual(['审计记录没写进去: EISDIR', '另一条'])
    expect((await terminateTask({ root: '/repo', change: 'demo', acknowledged: [] })).warnings).toEqual([])
    expect((await terminateTask({ root: '/repo', change: 'demo', acknowledged: [] })).warnings).toEqual([])
    fetchMock.mockRestore()
  })

  it('rejects a terminate response whose warnings are not an array of strings', async () => {
    const base = { ok: true, result: 'terminated', archived_dir: 'x', ended_at: 'y', commit: 'skipped' }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: '审计记录没写进去' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: ['ok', 1] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: null }), { status: 200 }))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(terminateTask({ root: '/repo', change: 'demo', acknowledged: [] }))
        .rejects.toMatchObject({ message: '终止响应格式无效', status: 200 })
    }
    fetchMock.mockRestore()
  })

  it('carries the server warnings of a delete result through, and treats a missing key as none', async () => {
    const base = { ok: true, removed: ['openspec/changes/demo'], uncommittedDeletions: 1 }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: ['未提交删除暂存未清理'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(base), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: [] }), { status: 200 }))
    expect((await deleteTask({ root: '/repo', change: 'demo', acknowledged: [] })).warnings).toEqual(['未提交删除暂存未清理'])
    expect((await deleteTask({ root: '/repo', change: 'demo', acknowledged: [] })).warnings).toEqual([])
    expect((await deleteTask({ root: '/repo', change: 'demo', acknowledged: [] })).warnings).toEqual([])
    fetchMock.mockRestore()
  })

  it('rejects a delete response whose warnings are not an array of strings', async () => {
    const base = { ok: true, removed: [], uncommittedDeletions: null }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: '未提交删除暂存未清理' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: [null] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, warnings: { 0: 'x' } }), { status: 200 }))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(deleteTask({ root: '/repo', change: 'demo', acknowledged: [] }))
        .rejects.toMatchObject({ message: '删除响应格式无效', status: 200 })
    }
    fetchMock.mockRestore()
  })

  it('turns a reason-carrying 409 into a refusal the dialog can re-render', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false, code: 'confirmation-required', error: '需要确认', reasons: [{ code: 'afk-queued' }],
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, code: 'user-missing', error: '未设置用户身份' }), { status: 412 }))
    await expect(deleteTask({ root: '/repo', change: 'demo', acknowledged: [] })).rejects.toMatchObject({
      name: 'TaskLifecycleRefusal', code: 'confirmation-required', reasons: [{ code: 'afk-queued' }], status: 409,
    })
    const plain = await terminateTask({ root: '/repo', change: 'demo', acknowledged: [] }).catch((error: unknown) => error)
    expect(plain).not.toBeInstanceOf(TaskLifecycleRefusal)
    expect(plain).toMatchObject({ code: 'user-missing', status: 412 })
    fetchMock.mockRestore()
  })
})
