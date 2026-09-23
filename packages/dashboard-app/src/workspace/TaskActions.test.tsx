/**
 * 归档 / 删除 / 取消归档 in the workspace: the card menu and detail footer open the dialog, the dialog shows
 * only the reasons the server reported, and confirming echoes back exactly those codes. A blocker disables
 * the confirm button, and a 409 re-renders the fresh list the server re-checked.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
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
    <I18nProvider>
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
    </I18nProvider>,
  )
  return { view, onRefresh, onToast }
}

function lifecycleResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('card menu and detail footer open the dialog', () => {
  it('confirms 删除 with exactly the codes it displayed and reports the outcome', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/change/demo/lifecycle')) {
        return lifecycleResponse({
          ok: true, action: 'delete', phase: 'build', blockers: [],
          confirmations: [{ code: 'review-pending' }, { code: 'has-dependents', detail: 'other' }],
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
    expect(within(dialog).getByTestId('task-action-effect')).toHaveTextContent('从工作区删除该任务目录，不自动提交，可用 git 恢复')
    await waitFor(() => expect(screen.getByTestId('task-action-reason-review-pending')).toBeTruthy())
    expect(screen.getByTestId('task-action-reason-has-dependents').textContent).toContain('other')
    const confirm = screen.getByTestId('task-action-confirm')
    expect(confirm.hasAttribute('disabled')).toBe(false)

    await userEvent.click(confirm)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已删除 demo'))
    const deleteCall = fetchMock.mock.calls.find(([url, init]) => String(url).startsWith('/api/change/demo?') && (init as RequestInit | undefined)?.method === 'DELETE')
    expect(String(deleteCall?.[0])).toBe('/api/change/demo?root=%2Frepo&acknowledged=review-pending,has-dependents')
    expect(onRefresh).toHaveBeenCalled()
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

  it('offers 归档 and 删除 in the detail footer of a live task', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    renderWorkspace()
    expect(screen.getByTestId('task-detail-archive')).toBeTruthy()
    expect(screen.getByTestId('task-detail-delete')).toBeTruthy()
    expect(screen.queryByTestId('task-detail-unarchive')).toBeNull()
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
    expect(toggle.textContent).toContain('已归档')
    expect(toggle.textContent).toContain('1')
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
    expect(screen.queryByTestId('task-filter-completed')).toBeNull()

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
      <I18nProvider>
        <WorkspaceView
          snapshot={makeSnapshot([makeProject(ROOT, [makeChange('demo', 'build'), makeChange('other', 'spec'), makeChange('hidden', 'build')])])}
          currentRoot={ROOT}
          rulesByKey={new Map()}
          projects={PROJECTS}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </I18nProvider>,
    )
    const empty = screen.getByTestId('task-list-empty-no-archived')
    expect(empty).toHaveTextContent('没有已归档任务')
    expect(empty.textContent).not.toContain('tenon init')
  })

  it('points at the completed tasks when they are all the list has', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    render(
      <I18nProvider>
        <WorkspaceView
          snapshot={makeSnapshot([makeProject(ROOT, [makeChange('done-a', 'archive', { archived: 'true' }), makeChange('done-b', 'archive', { archived: 'true' })])])}
          currentRoot={ROOT}
          rulesByKey={new Map()}
          projects={PROJECTS}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </I18nProvider>,
    )
    const empty = screen.getByTestId('task-list-empty-completed')
    expect(empty).toHaveTextContent('没有进行中的任务 · 2 个已完结')
    expect(empty.textContent).not.toContain('tenon init')
    fireEvent.click(screen.getByTestId('task-list-empty-include-completed'))
    expect(screen.getByTestId('task-card-done-a')).toBeTruthy()
    expect(screen.getByTestId('task-filter-completed')).toHaveAttribute('aria-pressed', 'true')
  })

  it('names the empty filtered list instead of printing a dictionary key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    renderWorkspace()
    await userEvent.type(screen.getByTestId('task-list-search'), 'zzz-nothing')
    expect(screen.getByTestId('task-list-empty-filtered')).toHaveTextContent('没有匹配的任务')
  })

  it('shows the 未提交删除 chip only when the server reports one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    const withCount = renderWorkspace({ uncommittedDeletions: 2 })
    const chip = screen.getByTestId('task-uncommitted-deletions')
    expect(chip.textContent).toContain('未提交删除')
    expect(chip.textContent).toContain('2')
    expect(chip.className).toContain('whitespace-nowrap')
    withCount.view.unmount()

    renderWorkspace()
    expect(screen.queryByTestId('task-uncommitted-deletions')).toBeNull()
  })

  it('never calls a task 已完结 archived: the summary pill stays 已完结', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    const snapshot = makeSnapshot([makeProject(ROOT, [makeChange('done', 'archive', { archived: 'true' })])])
    render(
      <I18nProvider>
        <WorkspaceView
          snapshot={snapshot}
          currentRoot={ROOT}
          rulesByKey={new Map()}
          projects={PROJECTS}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </I18nProvider>,
    )
    await userEvent.click(screen.getByTestId('task-filter-completed'))
    expect(screen.getByTestId('task-summary-done').textContent).toBe('已完结')
    expect(screen.getByTestId('task-summary-done').textContent).not.toContain('已归档')
  })

  it('offers no action in the aggregate view, which issues only /api/snapshot', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(lifecycleResponse({ ok: false, error: 'not found' }, 404))
    const snapshot = makeSnapshot([makeProject(ROOT, [makeChange('demo', 'build')])])
    render(
      <I18nProvider>
        <WorkspaceView
          snapshot={snapshot}
          currentRoot=""
          rulesByKey={new Map()}
          projects={PROJECTS}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </I18nProvider>,
    )
    expect(screen.queryByTestId('task-card-menu-demo')).toBeNull()
    expect(screen.queryByTestId('task-detail-archive')).toBeNull()
    expect(screen.queryByTestId('task-detail-delete')).toBeNull()
  })
})
