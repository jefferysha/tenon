import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TestRunDrawer } from './TestRunDrawer'
import type { TestRow } from './stageTests'

const RUN = {
  runId: '20260915T101530Z-ab12cd', user: 'a-at-x.io', actor: { id: 'a@x.io', name: 'A' },
  result: 'pass' as const, exitCode: 0, durationMs: 12_300,
  finishedAt: '2026-09-15T10:15:30Z', reasons: [],
}

const ROW: TestRow = {
  id: 'unit', name: '单测', direction: 'unit', required: true, status: 'passed',
  durationMs: 12_300, finishedAt: '2026-09-15T10:15:30Z', actorName: 'A', run: RUN,
}

const RECORD = {
  test_id: 'unit',
  inputs: [{ kind: 'document', ref: 'delta-spec', present: true, digest: `sha256:${'a'.repeat(64)}` }],
  outputs: [
    { path: 'test-results/junit.xml', bytes: 12, artifact: 'outputs/test-results/junit.xml' },
    { path: 'test-results/shot.png', bytes: 34, artifact: 'outputs/test-results/shot.png' },
    { path: 'test-results/gone.xml', bytes: 0, artifact: null },
  ],
}

function stubFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.startsWith('/api/tests/runs')) {
      return new Response(JSON.stringify({ ok: true, runs: [{ ...RUN, artifacts: true }] }), { status: 200 })
    }
    if (url.startsWith('/api/tests/run')) {
      return new Response(JSON.stringify({
        ok: true,
        record: RECORD,
        artifacts: { log: true, files: ['outputs/test-results/junit.xml', 'outputs/test-results/shot.png'] },
      }), { status: 200 })
    }
    if (url.startsWith('/api/tests/artifact')) return new Response('log tail', { status: 200 })
    return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })
  })
}

afterEach(() => vi.restoreAllMocks())

describe('TestRunDrawer', () => {
  it('拉历史与记录；输出可打开、图片内联、缺失产物显示 —；日志按 tail 读', async () => {
    const fetchMock = stubFetch()
    render(<I18nProvider><TestRunDrawer root="/repo" change="demo" row={ROW} onClose={() => undefined} /></I18nProvider>)

    await waitFor(() => expect(screen.getByTestId('test-run-history-20260915T101530Z-ab12cd')).toBeTruthy())
    await waitFor(() => expect(screen.getAllByTestId('test-run-output')).toHaveLength(3))
    const outputs = screen.getAllByTestId('test-run-output')
    expect(within(outputs[0] as HTMLElement).getByTestId('test-run-open')).toHaveAttribute('download')
    expect((outputs[2] as HTMLElement).textContent).toContain('—')
    expect(screen.getByTestId('test-run-image').getAttribute('src') ?? '').toContain('path=outputs%2Ftest-results%2Fshot.png')
    expect(screen.getByTestId('test-run-input').textContent).toContain('delta-spec')

    await userEvent.click(screen.getByTestId('test-run-log-open'))
    await waitFor(() => expect(screen.getByTestId('test-run-log-text').textContent).toBe('log tail'))
    const logCall = fetchMock.mock.calls.map(([url]) => String(url)).find((url) => url.includes('output.log'))
    expect(logCall).toContain('tail=262144')
  })

  it('没有运行时不拉记录，历史为空占位', async () => {
    stubFetch()
    const row: TestRow = { id: 'bench', name: 'bench', direction: 'benchmark', required: false, status: 'missing' }
    render(<I18nProvider><TestRunDrawer root="/repo" change="demo" row={row} onClose={() => undefined} /></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('test-run-inputs').textContent).toContain('—'))
    expect(screen.getByTestId('test-run-log-open')).toBeDisabled()
  })

  it('没有选中行时不渲染', () => {
    stubFetch()
    const { container } = render(
      <I18nProvider><TestRunDrawer root="/repo" change="demo" row={null} onClose={() => undefined} /></I18nProvider>,
    )
    expect(container.textContent).toBe('')
  })
})

function within(element: HTMLElement) {
  return {
    getByTestId: (id: string): HTMLElement => {
      const found = element.querySelector(`[data-testid="${id}"]`)
      if (!(found instanceof HTMLElement)) throw new Error(`missing ${id}`)
      return found
    },
  }
}
