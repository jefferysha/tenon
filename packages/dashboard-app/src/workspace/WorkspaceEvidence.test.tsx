/**
 * The open task's evidence (test policy, runs, documents) is not in the list snapshot: the workspace reads it from
 * `GET /api/change/:name/snapshot`, shows loading / error with a retry, and reads again when the row's `rev` moves.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { planBrief, FIXTURE_USER, verifyReport } from '../api/testSystemFixtures'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import type { ChangeSnapshot } from '../types'
import { WorkspaceView } from './WorkspaceView'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const ROOT = '/repo'
const PROJECTS = [{ root: ROOT, name: 'repo', count: 1, ok: true }]

function listRow(rev: string | undefined): ChangeSnapshot {
  return makeChange('demo', 'verify', rev === undefined ? {} : { rev })
}

function detailBody(rev: string): string {
  return JSON.stringify({ ...listRow(rev), testPolicy: [verifyReport()], testPlan: planBrief(), testUser: FIXTURE_USER })
}

function mount(rev: string | undefined) {
  const view = (snapshotRev: string | undefined): JSX.Element => (
    <I18nProvider><TooltipProvider>
      <WorkspaceView
        snapshot={makeSnapshot([makeProject(ROOT, [listRow(snapshotRev)])])}
        currentRoot={ROOT}
        rulesByKey={new Map()}
        projects={PROJECTS}
        onSelectProject={() => undefined}
        selectedChange={null}
        onSelectedChange={() => undefined}
      />
    </TooltipProvider></I18nProvider>
  )
  const rendered = render(view(rev))
  return { ...rendered, rerenderWith: (next: string | undefined) => rendered.rerender(view(next)) }
}

function detailCalls(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/change/demo/snapshot'))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('workspace · 任务证据按需读取', () => {
  it('带 rev 的列表行：先显示读取中，证据到了才出现测试页签', async () => {
    let release: (response: Response) => void = () => undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith('/api/change/demo/snapshot')) return new Promise<Response>((resolve) => { release = resolve })
      return Promise.resolve(new Response('{}', { status: 404 }))
    })
    mount('r1')
    expect(await screen.findByTestId('task-detail-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('task-io-tab-tests')).toBeNull()
    release(new Response(detailBody('r1'), { status: 200, headers: { ETag: '"one"' } }))
    expect(await screen.findByTestId('task-io-tab-tests')).toBeInTheDocument()
    expect(screen.queryByTestId('task-detail-loading')).toBeNull()
    expect(detailCalls(fetchMock)).toEqual(['/api/change/demo/snapshot?root=%2Frepo'])
  })

  it('读取失败：报错并给重试；重试成功后证据出现', async () => {
    let attempts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (!url.startsWith('/api/change/demo/snapshot')) return new Response('{}', { status: 404 })
      attempts += 1
      return attempts === 1
        ? new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500 })
        : new Response(detailBody('r-retry'), { status: 200 })
    })
    mount('r-retry')
    const alert = await screen.findByTestId('task-detail-error')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(screen.queryByTestId('task-io-tab-tests')).toBeNull()
    await userEvent.click(screen.getByTestId('task-detail-retry'))
    expect(await screen.findByTestId('task-io-tab-tests')).toBeInTheDocument()
    expect(screen.queryByTestId('task-detail-error')).toBeNull()
    expect(attempts).toBe(2)
  })

  it('列表行的 rev 变了：再读一次，证据更新前旧证据不闪掉', async () => {
    const bodies = [detailBody('r-a'), detailBody('r-b')]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (!url.startsWith('/api/change/demo/snapshot')) return new Response('{}', { status: 404 })
      return new Response(bodies.shift() ?? detailBody('r-b'), { status: 200 })
    })
    const { rerenderWith } = mount('r-a')
    expect(await screen.findByTestId('task-io-tab-tests')).toBeInTheDocument()
    rerenderWith('r-b')
    await waitFor(() => expect(detailCalls(fetchMock)).toHaveLength(2))
    expect(screen.getByTestId('task-io-tab-tests')).toBeInTheDocument()
    expect(screen.queryByTestId('task-detail-loading')).toBeNull()
  })

  it('没有 rev 的行（完整快照、旧 server）已经带着证据：不发详情请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }))
    mount(undefined)
    await screen.findByTestId('task-detail-pane')
    expect(detailCalls(fetchMock)).toEqual([])
    expect(screen.queryByTestId('task-detail-loading')).toBeNull()
    expect(screen.queryByTestId('task-detail-error')).toBeNull()
  })
})
