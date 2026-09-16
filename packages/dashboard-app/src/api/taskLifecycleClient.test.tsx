import { describe, expect, it, vi } from 'vitest'
import {
  archiveTask, deleteTask, fetchTaskLifecycle, TaskLifecycleRefusal, unarchiveTask,
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

  it('sends the acknowledged codes and decodes the archive result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true, changed: true, archived_at: '2026-09-15T12:00:00.000Z', phase: 'build',
    }), { status: 200 }))
    const result = await archiveTask({ root: '/repo', change: 'demo', acknowledged: ['review-pending'] })
    expect(result).toEqual({ changed: true, archivedAt: '2026-09-15T12:00:00.000Z', phase: 'build' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/change/demo/archive')
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST', body: JSON.stringify({ root: '/repo', acknowledged: ['review-pending'] }),
    }))
    fetchMock.mockRestore()
  })

  it('decodes unarchive and delete, including a null 未提交删除 count', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, changed: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, removed: ['openspec/changes/demo'], uncommittedDeletions: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, removed: [], uncommittedDeletions: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, removed: [], uncommittedDeletions: -1 }), { status: 200 }))
    expect(await unarchiveTask({ root: '/repo', change: 'demo' })).toEqual({ changed: true })
    expect(await deleteTask({ root: '/repo', change: 'demo', acknowledged: ['review-pending', 'has-dependents'] }))
      .toEqual({ removed: ['openspec/changes/demo'], uncommittedDeletions: 1 })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/change/demo?root=%2Frepo&acknowledged=review-pending,has-dependents')
    expect(await deleteTask({ root: '/repo', change: 'demo', acknowledged: [] }))
      .toEqual({ removed: [], uncommittedDeletions: null })
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/change/demo?root=%2Frepo')
    await expect(deleteTask({ root: '/repo', change: 'demo', acknowledged: [] })).rejects.toThrow()
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
    const plain = await archiveTask({ root: '/repo', change: 'demo', acknowledged: [] }).catch((error: unknown) => error)
    expect(plain).not.toBeInstanceOf(TaskLifecycleRefusal)
    expect(plain).toMatchObject({ code: 'user-missing', status: 412 })
    fetchMock.mockRestore()
  })
})
