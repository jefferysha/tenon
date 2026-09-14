import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { reviewIdempotencyKey } from '../api/decisionClient'
import { ReviewDecisionPanel } from './ReviewDecisionPanel'

const pendingItem = (revision: number) => ({ ref: { id: 'decision:1', kind: 'review', change: 'demo', anchor: 'verify:verify-pass', revision }, type: 'review', status: 'pending', anchor: { phase: 'verify', event: 'verify-pass' }, revision, evidence: ['canonical-review-receipt'], source: 'terminal', channel: 'terminal', command: 'review-acknowledge' })
const view = (revision: number, items: unknown[]) => new Response(JSON.stringify({ schemaVersion: 'pending-decision-view/v1', revision, items }), { status: 200 })
const failure = (status: number, code?: string) => new Response(JSON.stringify(code === undefined ? { ok: false, error: 'internal' } : { ok: false, error: 'rejected', code }), { status })

function renderPanel(props: { snapshotSignature?: string; onRefresh?: () => void } = {}) {
  const element = (signature?: string) => <I18nProvider><ReviewDecisionPanel root="/repo" change="demo" snapshotSignature={signature} onRefresh={props.onRefresh} /></I18nProvider>
  const utils = render(element(props.snapshotSignature))
  return { ...utils, rerenderWith: (signature: string) => utils.rerender(element(signature)) }
}

function postBodies(fetchMock: { mock: { calls: ReadonlyArray<readonly [unknown, RequestInit?]> } }): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => call[1]?.method === 'POST')
    .map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>)
}

afterEach(() => { vi.restoreAllMocks() })

describe('ReviewDecisionPanel', () => {
  it('only exposes review approve and refreshes after acknowledgement', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(view(3, [pendingItem(3)]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ref: 'decision:1', changed: true, idempotent: false, channel: 'dashboard' }), { status: 200 }))
      .mockResolvedValueOnce(view(4, []))
    const onRefresh = vi.fn()
    renderPanel({ onRefresh })
    expect(await screen.findByTestId('review-console-approve')).toBeEnabled()
    await userEvent.click(screen.getByTestId('review-console-approve'))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }))
    expect(screen.queryByRole('button', { name: /驳回|reject|decline/i })).toBeNull()
  })

  it.each([
    [409, 'review-approval-required', '缺少复核请求'],
    [409, 'revision-conflict', '状态已变化'],
    [409, 'idempotency-conflict', '重复请求冲突'],
    [500, undefined, '请求失败'],
  ])('maps HTTP %i %s to its text and keeps it after the review disappears', async (status, code, text) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(view(3, [pendingItem(3)]))
      .mockResolvedValueOnce(failure(status, code))
      .mockResolvedValue(view(4, []))
    renderPanel()
    await userEvent.click(await screen.findByTestId('review-console-approve'))
    if (status === 409) {
      const alert = await screen.findByTestId('review-console-error')
      expect(alert).toHaveTextContent(text)
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
      expect(screen.queryByTestId('review-console')).toBeNull()
      expect(screen.getByTestId('review-console-error')).toHaveTextContent(text)
    } else {
      expect(await screen.findByTestId('review-console-submit-error')).toHaveTextContent(text)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  })

  it('reuses the idempotency key when the same ref and revision is retried', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(view(3, [pendingItem(3)]))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ref: 'decision:1', changed: true, idempotent: true, channel: 'dashboard' }), { status: 200 }))
      .mockResolvedValue(view(4, []))
    renderPanel()
    await userEvent.click(await screen.findByTestId('review-console-approve'))
    expect(await screen.findByTestId('review-console-submit-error')).toHaveTextContent('网络错误')
    await userEvent.click(screen.getByTestId('review-console-approve'))
    await waitFor(() => expect(postBodies(fetchMock)).toHaveLength(2))
    const [first, second] = postBodies(fetchMock)
    expect(first?.idempotency_key).toBe(reviewIdempotencyKey('decision:1', 3))
    expect(second?.idempotency_key).toBe(first?.idempotency_key)
  })

  it('reloads pending decisions only when the change snapshot signature changes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(view(3, []))
      .mockResolvedValueOnce(view(4, [pendingItem(4)]))
    const { rerenderWith } = renderPanel({ snapshotSignature: 'a' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    rerenderWith('a')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    rerenderWith('b')
    expect(await screen.findByTestId('review-console-approve')).toBeEnabled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not import model, Skill or AFK producers', () => {
    const dir = join(process.cwd(), 'packages/dashboard-app/src')
    const allowed: Record<string, readonly string[]> = {
      'workspace/ReviewDecisionPanel.tsx': ['react', 'lucide-react', '../api/decisionClient', '../api/transport', '../i18n'],
      'api/decisionClient.ts': ['./transport'],
    }
    for (const [file, specifiers] of Object.entries(allowed)) {
      const imports = [...readFileSync(join(dir, file), 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')
      expect(imports.filter((specifier) => !specifiers.includes(specifier))).toEqual([])
    }
  })
})
