import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { ReviewDecisionPanel } from './ReviewDecisionPanel'

describe('ReviewDecisionPanel', () => {
  it('only exposes review approve and refreshes after acknowledgement', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 'pending-decision-view/v1', revision: 3, items: [{ ref: { id: 'decision:1', kind: 'review', change: 'demo', anchor: 'verify:verify-pass', revision: 3 }, type: 'review', status: 'pending', anchor: { phase: 'verify', event: 'verify-pass' }, revision: 3, evidence: ['canonical-review-receipt'], source: 'user', channel: 'terminal', command: 'review-acknowledge' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ref: 'decision:1', changed: true, idempotent: false, channel: 'dashboard' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 'pending-decision-view/v1', revision: 4, items: [] }), { status: 200 }))
    const onRefresh = vi.fn()
    render(<I18nProvider><ReviewDecisionPanel root="/repo" change="demo" onRefresh={onRefresh} /></I18nProvider>)
    expect(await screen.findByTestId('review-console-approve')).toBeEnabled()
    expect(screen.getByTestId('review-console-boundary')).toHaveTextContent('驳回和退回')
    await userEvent.click(screen.getByTestId('review-console-approve'))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }))
    fetchMock.mockRestore()
  })
})
