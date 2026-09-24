/**
 * 归档 / 删除 / 取消归档 in the workspace: the card ⋯ and the detail ⋯ open the dialog, the dialog shows
 * only the reasons the server reported, and confirming echoes back exactly those codes. A blocker disables
 * the confirm button, and a 409 re-renders the fresh list the server re-checked.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import type { ArchivedChangeSnapshot } from '../types'
import { localTime } from '../model/time'
import { WorkspaceView } from './WorkspaceView'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const ROOT = '/repo'
const PROJECTS = [{ root: ROOT, name: 'repo', count: 2, ok: true }]

function archivedRow(name: string, phase: string, archivedAt: string, actor: string): ArchivedChangeSnapshot {
  return {
    ...makeChange(name, phase),
    archive: { archivedAt, phase, actor: { id: `${actor}@x.io`, name: actor, trust: 'declared' } },
  }
}

function renderWorkspace(over: Parameters<typeof makeProject>[2] = {}, extra: Partial<Parameters<typeof WorkspaceView>[0]> = {}) {
  const snapshot = makeSnapshot([makeProject(ROOT, [makeChange('demo', 'build'), makeChange('other', 'spec')], over)])
  const onRefresh = vi.fn()
  const onToast = vi.fn()
  const view = render(
    <I18nProvider><TooltipProvider>
      <WorkspaceView
        snapshot={snapshot}
        currentRoot={ROOT}
        rulesByKey={new Map()}
        projects={PROJECTS}
        onSelectProject={() => undefined}
        selectedChange={null}
        onSelectedChange={() => undefined}
        onToast={onToast}
        onRefresh={onRefresh}
        {...extra}
      />
    </TooltipProvider></I18nProvider>,
  )
  return { view, onRefresh, onToast }
}

function lifecycleResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // 状态筛选写进 URL（status=…），用例之间要清掉。
  window.history.replaceState(null, '', '/')
})

describe('card ⋯ and detail ⋯ open the dialog', () => {
  it('confirms 删除 with exactly the codes it displayed and reports the outcome', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/change/demo/lifecycle')) {
        return lifecycleResponse({
          ok: true, action: 'delete', phase: 'build', blockers: [],
          confirmations: [{ code: 'review-pending' }, { code: 'has-dependents', detail: 'other' }],
          recoverable: true,
        })
      }
      if (url.startsWith('/api/change/demo?') && init?.method === 'DELETE') {
        return lifecycleResponse({ ok: true, removed: ['openspec/changes/demo'], uncommittedDeletions: 1 })
      }
      return lifecycleResponse({ ok: false, error: 'not found' }, 404)
    })
    const { onToast, onRefresh } = renderWorkspace()
    await userEvent.click(screen.getByTestId('task-card-menu-demo'))
    await userEvent.click(screen.getByTestId('task-card-menu-demo-delete'))

    const dialog = await screen.findByTestId('task-action-dialog')
    expect(within(dialog).getByText('删除 demo')).toBeTruthy()
    expect(within(dialog).getByRole('alertdialog', { name: '删除 demo' })).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByTestId('task-action-cancel')).toHaveFocus()
    await waitFor(() => expect(screen.getByTestId('task-action-reason-review-pending')).toBeTruthy())
    expect(within(dialog).getByTestId('task-action-effect')).toHaveTextContent('从工作区删除该任务目录，不自动提交，可用 git 恢复')
    expect(screen.queryByTestId('task-action-type-name')).toBeNull()
    expect(screen.getByTestId('task-action-reason-has-dependents').textContent).toContain('other')
    const confirm = screen.getByTestId('task-action-confirm')
    expect(confirm.hasAttribute('disabled')).toBe(false)

    await userEvent.click(confirm)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已删除 demo', undefined))
    const deleteCall = fetchMock.mock.calls.find(([url, init]) => String(url).startsWith('/api/change/demo?') && (init as RequestInit | undefined)?.method === 'DELETE')
    expect(String(deleteCall?.[0])).toBe('/api/change/demo?root=%2Frepo&acknowledged=review-pending,has-dependents')
    expect(onRefresh).toHaveBeenCalled()
  })

  it('git 找不回的目录：危险色写明不可恢复，输入任务名后才能删除', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/change/demo/lifecycle')) {
        return lifecycleResponse({ ok: true, action: 'delete', phase: 'build', blockers: [], confirmations: [], recoverable: false })
      }
      if (url.startsWith('/api/change/demo?') && init?.method === 'DELETE') {
        return lifecycleResponse({ ok: true, removed: ['openspec/changes/demo'], uncommittedDeletions: null })
      }
      return lifecycleResponse({ ok: false, error: 'not found' }, 404)
    })
    const { onToast } = renderWorkspace()
    await userEvent.click(screen.getByTestId('task-card-menu-demo'))
    await userEvent.click(screen.getByTestId('task-card-menu-demo-delete'))
    const warning = await screen.findByTestId('task-action-unrecoverable')
    expect(warning).toHaveTextContent('不可恢复')
    expect(warning.className).toContain('text-red-d')
    expect(screen.queryByTestId('task-action-effect')).toBeNull()
    const confirm = screen.getByTestId('task-action-confirm')
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByTestId('task-action-type-name'), 'dem')
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByTestId('task-action-type-name'), 'o')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已删除 demo', undefined))
  })

  it('归档成功的提示带「撤销」，撤销走取消归档接口', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/change/demo/lifecycle')) {
        return lifecycleResponse({ ok: true, action: 'archive', phase: 'build', blockers: [], confirmations: [] })
      }
      if (url === '/api/change/demo/archive' && init?.method === 'POST') {
        return lifecycleResponse({ ok: true, changed: true, archived_at: '2026-09-25T00:00:00Z', phase: 'build' })
      }
      if (url === '/api/change/demo/unarchive' && init?.method === 'POST') return lifecycleResponse({ ok: true, changed: true })
      return lifecycleResponse({ ok: false, error: 'not found' }, 404)
    })
    const { onToast } = renderWorkspace()
    await userEvent.click(screen.getByTestId('task-card-menu-demo'))
    await userEvent.click(screen.getByTestId('task-card-menu-demo-archive'))
    await waitFor(() => expect(screen.getByTestId('task-action-confirm')).toBeEnabled())
    await userEvent.click(screen.getByTestId('task-action-confirm'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已归档 demo', expect.objectContaining({ label: '撤销' })))
    const action = onToast.mock.calls.find((call) => call[0] === '已归档 demo')?.[1] as { run: () => void }
    action.run()
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/change/demo/unarchive' && init?.method === 'POST')).toBe(true))
  })

  it('disables confirm for a blocker and shows its unlock reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/change/demo/lifecycle')) {
        return lifecycleResponse({ ok: true, action: 'archive', phase: 'build', blockers: [{ code: 'afk-running' }], confirmations: [] })
      }
      return lifecycleResponse({ ok: false, error: 'not found' }, 404)
    })
    renderWorkspace()
    await userEvent.click(screen.getByTestId('task-card-menu-demo'))
    await userEvent.click(screen.getByTestId('task-card-menu-demo-archive'))
    await waitFor(() => expect(screen.getByTestId('task-action-reason-afk-running').textContent).toContain('AFK 运行中'))
    expect(screen.getByTestId('task-action-effect')).toHaveTextContent('只对你隐藏，可随时取消归档')
    expect(screen.getByTestId('task-action-confirm').hasAttribute('disabled')).toBe(true)
  })

  it('re-renders the reasons the server re-checked on a 409', async () => {
    let posts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/change/demo/lifecycle')) {
        return lifecycleResponse({ ok: true, action: 'archive', phase: 'build', blockers: [], confirmations: [] })
      }
      if (url === '/api/change/demo/archive' && init?.method === 'POST') {
        posts += 1
        return lifecycleResponse({ ok: false, code: 'task-blocked', error: '任务被阻止', reasons: [{ code: 'afk-queued' }] }, 409)
      }
      return lifecycleResponse({ ok: false, error: 'not found' }, 404)
    })
    renderWorkspace()
    await userEvent.click(screen.getByTestId('task-card-menu-demo'))
    await userEvent.click(screen.getByTestId('task-card-menu-demo-archive'))
    const confirm = await screen.findByTestId('task-action-confirm')
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false))
    await userEvent.click(confirm)
    await waitFor(() => expect(screen.getByTestId('task-action-reason-afk-queued')).toBeTruthy())
    expect(screen.getByTestId('task-action-confirm').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('task-action-failure')).toBeTruthy()
    expect(posts).toBe(1)
  })

  it('detail ⋯ = card ⋯: 复制链接 · 接手 · 归档 · 分隔 · 删除; no footer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    try {
      renderWorkspace({}, { me: { id: 'bob@x.io', slug: 'bob', name: 'Bob' } })
      expect(screen.getByTestId('task-detail-pane').querySelector('footer')).toBeNull()
      await userEvent.click(screen.getByTestId('task-detail-menu'))
      const menu = await screen.findByTestId('task-detail-menu-menu')
      const ids = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.getAttribute('data-testid'))
      expect(ids).toEqual(['task-detail-menu-copy-link', 'task-detail-menu-take', 'task-detail-menu-archive', 'task-detail-menu-delete'])
      expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1)
      expect(screen.queryByTestId('task-detail-menu-unarchive')).toBeNull()
    } finally {
      delete window.__TENON_DASHBOARD_TOKEN__
    }
  })

  it('接手 from the ⋯ posts the owner route with the row root and refreshes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === '/api/change/demo/owner' && init?.method === 'POST') {
        return lifecycleResponse({ ok: true, owner: { id: 'bob@x.io', slug: 'bob', name: 'Bob' }, changed: true })
      }
      return lifecycleResponse({ ok: false, error: 'not found' }, 404)
    })
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    try {
      const { onRefresh, onToast } = renderWorkspace({}, { me: { id: 'bob@x.io', slug: 'bob', name: 'Bob' } })
      await userEvent.click(screen.getByTestId('task-card-menu-demo'))
      await userEvent.click(await screen.findByTestId('task-card-menu-demo-take'))
      // 接手先确认，确认前不改负责人。
      const dialog = await screen.findByTestId('task-action-dialog')
      expect(within(dialog).getByText('接手 demo')).toBeTruthy()
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/change/demo/owner')).toBe(false)
      await userEvent.click(screen.getByTestId('task-action-confirm'))
      await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
      const post = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/change/demo/owner' && init?.method === 'POST')
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ root: ROOT })
      expect(onToast).toHaveBeenCalledWith('已接手', undefined)
    } finally {
      delete window.__TENON_DASHBOARD_TOKEN__
    }
  })

  it('hides 接手 for the owner and without a token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    renderWorkspace({}, { me: { id: 'bob@x.io', slug: 'bob', name: 'Bob' } })
    await userEvent.click(screen.getByTestId('task-card-menu-demo'))
    await screen.findByTestId('task-card-menu-demo-menu')
    expect(screen.queryByTestId('task-card-menu-demo-take')).toBeNull()
  })
})

describe('已归档 view', () => {
  it('lists archived rows with 阶段 · 时间 · 归档人 and calls 取消归档', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === '/api/change/hidden/unarchive' && init?.method === 'POST') {
        return lifecycleResponse({ ok: true, changed: true })
      }
      return lifecycleResponse({ ok: false, error: 'not found' }, 404)
    })
    const { onToast } = renderWorkspace({ archived: [archivedRow('hidden', 'build', '2026-09-15T12:00:00.000Z', 'A')] })

    const toggle = screen.getByTestId('task-view-archived')
    // 归档是带文字的开关，不是只有图标。
    expect(toggle).toHaveTextContent('已归档1')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(toggle)

    expect(screen.getByTestId('task-card-hidden')).toBeTruthy()
    expect(screen.queryByTestId('task-card-demo')).toBeNull()
    const meta = screen.getByTestId('task-archived-meta-hidden')
    // 阶段显示工作流里的名称，不是原始 id。
    expect(meta.textContent).toContain('实现')
    expect(meta.textContent).not.toContain('build')
    // 时间按界面语言与本机时区显示，原始 ISO 只留在 title 里。
    expect(meta.textContent).toContain(localTime('2026-09-15T12:00:00.000Z', 'zh'))
    expect(meta.textContent).not.toContain('2026-09-15T12:00:00.000Z')
    expect(meta.textContent).toContain('A')
    expect(meta.className).toContain('whitespace-nowrap')
    // The archived list carries no 归档 / 删除 menu and no facets.
    expect(screen.queryByTestId('task-card-menu-hidden')).toBeNull()
    expect(screen.queryByTestId('task-facet-workflow')).toBeNull()
    expect(screen.queryByTestId('task-filters')).toBeNull()

    await userEvent.click(screen.getByTestId('task-archived-unarchive-hidden'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已取消归档 hidden'))
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/change/hidden/unarchive')).toBe(true)
  })

  it('shows the archived row with its stage label and the same status it had before archiving', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    const labelled = { ...archivedRow('hidden', 'open', '2026-09-23T14:06:48Z', 'A') }
    labelled.workflowRules = { ...labelled.workflowRules, labelByStep: { open: '立项' } }
    renderWorkspace({ archived: [labelled] })
    fireEvent.click(screen.getByTestId('task-view-archived'))
    expect(screen.getByTestId('task-archived-meta-hidden').textContent).toContain('立项')
    expect(screen.getByTestId('task-archived-meta-hidden').textContent).not.toMatch(/^open/u)
    expect(screen.getByTestId('task-summary-hidden').textContent).not.toContain('进行中')
  })

  it('says 没有已归档任务 once the last archived task is unarchived', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    const { view } = renderWorkspace({ archived: [archivedRow('hidden', 'build', '2026-09-15T12:00:00.000Z', 'A')] })
    fireEvent.click(screen.getByTestId('task-view-archived'))
    // 取消归档后刷新的快照不再带 archived：视图仍停在已归档列表。
    view.rerender(
      <I18nProvider><TooltipProvider>
        <WorkspaceView
          snapshot={makeSnapshot([makeProject(ROOT, [makeChange('demo', 'build'), makeChange('other', 'spec'), makeChange('hidden', 'build')])])}
          currentRoot={ROOT}
          rulesByKey={new Map()}
          projects={PROJECTS}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </TooltipProvider></I18nProvider>,
    )
    const empty = screen.getByTestId('task-list-empty-no-archived')
    expect(empty).toHaveTextContent('没有已归档任务')
    expect(empty.textContent).not.toContain('tenon init')
  })

  it('已完结 tasks live under 全部 and 已完成; there is no separate 含已完结 toggle', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    render(
      <I18nProvider><TooltipProvider>
        <WorkspaceView
          snapshot={makeSnapshot([makeProject(ROOT, [makeChange('done-a', 'archive', { archived: 'true' }), makeChange('done-b', 'archive', { archived: 'true' })])])}
          currentRoot={ROOT}
          rulesByKey={new Map()}
          projects={PROJECTS}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </TooltipProvider></I18nProvider>,
    )
    expect(screen.queryByTestId('task-filter-completed')).toBeNull()
    expect(screen.getByTestId('task-card-done-a')).toBeTruthy()
    expect(screen.getByTestId('task-status-done')).toHaveTextContent('2')
    fireEvent.click(screen.getByTestId('task-status-running'))
    expect(screen.getByTestId('task-list-empty-filtered')).toBeTruthy()
    fireEvent.click(screen.getByTestId('task-status-done'))
    expect(screen.getByTestId('task-card-done-b')).toBeTruthy()
  })

  it('names the empty filtered list instead of printing a dictionary key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    renderWorkspace()
    await userEvent.type(screen.getByTestId('task-list-search'), 'zzz-nothing')
    expect(screen.getByTestId('task-list-empty-filtered')).toHaveTextContent('没有匹配的任务')
  })

  it('shows 未提交删除 as plain text (not a button) only when the server reports one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    const withCount = renderWorkspace({ uncommittedDeletions: 2 })
    const chip = screen.getByTestId('task-uncommitted-deletions')
    expect(chip).toHaveAttribute('aria-label', '未提交删除 2')
    expect(chip.textContent).toContain('2')
    expect(chip.tagName).toBe('SPAN')
    expect(chip.className).toContain('whitespace-nowrap')
    withCount.view.unmount()

    renderWorkspace()
    expect(screen.queryByTestId('task-uncommitted-deletions')).toBeNull()
  })

  it('never calls a task 已完结 archived: the summary pill stays 已完结', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    const snapshot = makeSnapshot([makeProject(ROOT, [makeChange('done', 'archive', { archived: 'true' })])])
    render(
      <I18nProvider><TooltipProvider>
        <WorkspaceView
          snapshot={snapshot}
          currentRoot={ROOT}
          rulesByKey={new Map()}
          projects={PROJECTS}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </TooltipProvider></I18nProvider>,
    )
    await userEvent.click(screen.getByTestId('task-status-done'))
    expect(screen.getByTestId('task-summary-done').textContent).toBe('已完结')
    expect(screen.getByTestId('task-summary-done').textContent).not.toContain('已归档')
  })

  it('offers the same actions in the aggregate view, acting on the row root', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    const snapshot = makeSnapshot([makeProject(ROOT, [makeChange('demo', 'build')])])
    render(
      <I18nProvider><TooltipProvider>
        <WorkspaceView
          snapshot={snapshot}
          currentRoot=""
          rulesByKey={new Map()}
          projects={PROJECTS}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </TooltipProvider></I18nProvider>,
    )
    await userEvent.click(screen.getByTestId('task-card-menu-demo'))
    await userEvent.click(await screen.findByTestId('task-card-menu-demo-archive'))
    await screen.findByTestId('task-action-dialog')
    const lifecycle = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url).startsWith('/api/change/demo/lifecycle'))
    expect(String(lifecycle?.[0])).toContain('root=%2Frepo')
    expect(screen.getByTestId('task-detail-menu')).toBeTruthy()
  })
})
