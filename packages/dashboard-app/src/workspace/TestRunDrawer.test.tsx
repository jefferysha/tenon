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

  it('目录产物：列出目录里的文件、每个文件旁一个打开；目录里的截图内联', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/tests/runs')) {
        return new Response(JSON.stringify({ ok: true, runs: [{ ...RUN, artifacts: true }] }), { status: 200 })
      }
      if (url.startsWith('/api/tests/run')) {
        return new Response(JSON.stringify({
          ok: true,
          record: { ...RECORD, outputs: [{ path: 'test-results', bytes: 11, artifact: 'outputs/test-results' }] },
          artifacts: { log: false, files: ['outputs/test-results/shots/home.png', 'outputs/test-results/trace.zip'] },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })
    })
    render(<I18nProvider><TestRunDrawer root="/repo" change="demo" row={ROW} onClose={() => undefined} /></I18nProvider>)

    await waitFor(() => expect(screen.getAllByTestId('test-run-output-file')).toHaveLength(2))
    const output = screen.getByTestId('test-run-output')
    expect(output.textContent).not.toContain('—')
    const files = screen.getAllByTestId('test-run-output-file')
    expect(files.map((file) => file.textContent)).toEqual(['shots/home.png打开', 'trace.zip打开'])
    expect(within(files[1] as HTMLElement).getByTestId('test-run-open').getAttribute('href') ?? '').toContain('path=outputs%2Ftest-results%2Ftrace.zip')
    expect(screen.getByTestId('test-run-image').getAttribute('src') ?? '').toContain('path=outputs%2Ftest-results%2Fshots%2Fhome.png')
  })

  it('标题里的状态是「点 + 词」，不是药丸：无底色、无描边、圆点之外没有 rounded-full', async () => {
    stubFetch()
    render(<I18nProvider><TestRunDrawer root="/repo" change="demo" row={ROW} onClose={() => undefined} /></I18nProvider>)
    const header = await screen.findByTestId('test-run-drawer')
    const status = header.querySelector('[data-tone]')
    if (!(status instanceof HTMLElement)) throw new Error('missing status')
    expect(status).toHaveAttribute('data-tone', 'done')
    expect(status).toHaveTextContent('通过')
    const classes = status.className.split(/\s+/u)
    expect(classes).not.toContain('rounded-full')
    expect(classes).not.toContain('border')
    expect(classes.some((name) => name.startsWith('bg-') || name.startsWith('px-'))).toBe(false)
    expect(status.querySelector('i')?.className).toContain('rounded-full')
    expect(status.querySelector('i')?.className).toContain('size-1.5')
  })

  it('失败用红点 + 词；未运行用中性点 + 词', async () => {
    stubFetch()
    const { unmount } = render(<I18nProvider><TestRunDrawer root="/repo" change="demo" row={{ ...ROW, status: 'failed' }} onClose={() => undefined} /></I18nProvider>)
    expect((await screen.findByTestId('test-run-drawer')).querySelector('[data-tone]')).toHaveAttribute('data-tone', 'blocked')
    unmount()
    render(<I18nProvider><TestRunDrawer root="/repo" change="demo" row={{ ...ROW, status: 'missing' }} onClose={() => undefined} /></I18nProvider>)
    expect((await screen.findByTestId('test-run-drawer')).querySelector('[data-tone]')).toHaveAttribute('data-tone', 'neutral')
  })

  it('失败后带豁免：标题里是「已豁免 / 豁免待批准」，不再写失败', async () => {
    stubFetch()
    const { unmount } = render(<I18nProvider><TestRunDrawer root="/repo" change="demo" row={{ ...ROW, status: 'failed', waiver: 'waived' }} onClose={() => undefined} /></I18nProvider>)
    const waived = (await screen.findByTestId('test-run-drawer')).querySelector('[data-tone]')
    expect(waived).toHaveAttribute('data-tone', 'done')
    expect(waived).toHaveTextContent('已豁免')
    unmount()
    render(<I18nProvider><TestRunDrawer root="/repo" change="demo" row={{ ...ROW, status: 'failed', waiver: 'waiver-pending' }} onClose={() => undefined} /></I18nProvider>)
    const pending = (await screen.findByTestId('test-run-drawer')).querySelector('[data-tone]')
    expect(pending).toHaveAttribute('data-tone', 'pending')
    expect(pending).toHaveTextContent('豁免待批准')
  })

  it('历史行是比例字的等宽数字（时间 · 执行人 · 结果 · 耗时不是 id / 路径 / 命令 / 哈希，不用等宽字体）', async () => {
    stubFetch()
    render(<I18nProvider><TestRunDrawer root="/repo" change="demo" row={ROW} onClose={() => undefined} /></I18nProvider>)
    const entry = await screen.findByTestId('test-run-history-20260915T101530Z-ab12cd')
    expect(entry.className).toContain('tabular-nums')
    expect(entry.className).not.toContain('font-mono')
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
