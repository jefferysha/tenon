/**
 * 工作台「已结束」：`openspec/changes/archive/` 下的任务按结束时间倒序列出，卡片标任务结果（完结 / 已升级 / 已终止），
 * 「全部」里排在进行中之后；点开才按归档目录名只读读取详情（`?archived=1`），不拉任务编排与记录。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { FIXTURE_USER, planBrief, verifyReport } from '../api/testSystemFixtures'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import type { EndedTask } from '../types'
import { WorkspaceView } from './WorkspaceView'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const ROOT = '/repo'
const PROJECTS = [{ root: ROOT, name: 'repo', count: 2, ok: true }]

function ended(name: string, endedAt: string, over: Partial<EndedTask> = {}): EndedTask {
  return { name, workflow: 'default', track: 'lite', result: 'finished', endedAt, archivedDir: `openspec/changes/archive/2026-10-11-${name}`, ...over }
}

const ENDED = [
  ended('old', '2026-10-09T00:00:00Z'),
  ended('retired', '2026-10-11T09:00:00Z', { result: 'terminated' }),
  ended('bumped', '2026-10-10T00:00:00Z', { result: 'escalated' }),
  ended('legacy', '2026-10-08T00:00:00Z', { result: 'unknown' }),
]

function renderEnded(over: Parameters<typeof makeProject>[2] = { ended: ENDED }, extra: Partial<Parameters<typeof WorkspaceView>[0]> = {}) {
  const snapshot = makeSnapshot([makeProject(ROOT, [makeChange('demo', 'build'), makeChange('other', 'spec')], over)])
  return render(
    <I18nProvider><TooltipProvider>
      <WorkspaceView
        snapshot={snapshot}
        currentRoot={ROOT}
        rulesByKey={new Map()}
        projects={PROJECTS}
        onSelectProject={() => undefined}
        selectedChange={null}
        onSelectedChange={() => undefined}
        {...extra}
      />
    </TooltipProvider></I18nProvider>,
  )
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => handler(String(input)))
}

const NOT_FOUND = (): Response => new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

function listedNames(): string[] {
  return within(screen.getByTestId('task-list-items')).getAllByRole('button')
    .map((card) => card.getAttribute('data-testid') ?? '')
    .filter((id) => id.startsWith('task-card-') && !id.startsWith('task-card-menu-'))
}

describe('已结束 category', () => {
  it('lists the ended tasks newest first, each with its result mark', () => {
    stubFetch(NOT_FOUND)
    renderEnded()
    expect(screen.getByTestId('task-status-ended')).toHaveTextContent('已结束4')
    fireEvent.click(screen.getByTestId('task-status-ended'))
    expect(listedNames()).toEqual([
      'task-card-2026-10-11-retired', 'task-card-2026-10-11-bumped', 'task-card-2026-10-11-old', 'task-card-2026-10-11-legacy',
    ])
    expect(screen.getByTestId('task-summary-2026-10-11-retired')).toHaveTextContent('已终止')
    expect(screen.getByTestId('task-summary-2026-10-11-bumped')).toHaveTextContent('已升级')
    expect(screen.getByTestId('task-summary-2026-10-11-old')).toHaveTextContent('完结')
    // 旧归档没有结果字段：按「完结」显示。
    expect(screen.getByTestId('task-summary-2026-10-11-legacy')).toHaveTextContent('完结')
    const card = screen.getByTestId('task-card-2026-10-11-retired')
    expect(card).toHaveAttribute('data-status', 'ended')
    expect(within(card).getByText('retired')).toBeInTheDocument()
    expect(screen.getByTestId('task-meta-2026-10-11-retired')).toHaveTextContent(/^default\/lite$/u)
  })

  it('has no 终止 / 删除 menu on an ended card; the 已归档 toggle is gone', () => {
    stubFetch(NOT_FOUND)
    renderEnded()
    fireEvent.click(screen.getByTestId('task-status-ended'))
    expect(screen.queryByTestId('task-card-menu-2026-10-11-retired')).toBeNull()
    expect(screen.queryByTestId('task-view-archived')).toBeNull()
  })

  it('全部 puts the ended tasks after the running ones', () => {
    stubFetch(NOT_FOUND)
    renderEnded()
    expect(listedNames().map((id) => id.replace('task-card-', ''))).toEqual(['demo', 'other', '2026-10-11-retired', '2026-10-11-bumped', '2026-10-11-old', '2026-10-11-legacy'])
    fireEvent.click(screen.getByTestId('task-status-running'))
    expect(listedNames()).toEqual(['task-card-demo', 'task-card-other'])
  })

  it('says 显示 N / 共 M once, in one nowrap line, only when the snapshot truncated the list', () => {
    stubFetch(NOT_FOUND)
    const view = renderEnded({ ended: ENDED, endedTotal: 1203 })
    fireEvent.click(screen.getByTestId('task-status-ended'))
    const count = screen.getByTestId('task-ended-count')
    expect(count).toHaveTextContent('显示 4 / 共 1203')
    expect(count.className).toContain('whitespace-nowrap')
    expect(screen.getAllByText(/共 1203/u)).toHaveLength(1)
    view.unmount()
    renderEnded()
    fireEvent.click(screen.getByTestId('task-status-ended'))
    expect(screen.queryByTestId('task-ended-count')).toBeNull()
  })

  it('an empty ended list shows the filtered empty state, not an invented archive message', () => {
    stubFetch(NOT_FOUND)
    renderEnded({})
    fireEvent.click(screen.getByTestId('task-status-ended'))
    expect(screen.getByTestId('task-list-empty-filtered')).toHaveTextContent('没有匹配的任务')
  })

  it('search matches the ended task name and its flow', async () => {
    stubFetch(NOT_FOUND)
    renderEnded()
    await userEvent.type(screen.getByTestId('task-list-search'), 'retired')
    expect(listedNames()).toEqual(['task-card-2026-10-11-retired'])
  })

  it('English labels the marks Finished / Escalated / Terminated', () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    try {
      stubFetch(NOT_FOUND)
      renderEnded()
      fireEvent.click(screen.getByTestId('task-status-ended'))
      expect(screen.getByTestId('task-summary-2026-10-11-retired')).toHaveTextContent('Terminated')
      expect(screen.getByTestId('task-summary-2026-10-11-bumped')).toHaveTextContent('Escalated')
      expect(screen.getByTestId('task-summary-2026-10-11-old')).toHaveTextContent('Finished')
    } finally {
      localStorage.removeItem('tenon-dashboard-lang')
    }
  })
})

describe('opening an ended task', () => {
  const DETAIL = (name: string): string => JSON.stringify({ ...makeChange(name, 'build', { track: 'lite', fields: { task_result: 'terminated' } }) })
  const entry = (kind: string, id: string, wave: number, extra: Record<string, unknown> = {}) => ({ kind, id, label: id, wave, dependsOn: [], required: true, source: 'declared', status: 'done', ...extra })
  /** `GET /api/change/:dir/orchestration?archived=1`：冻结计划的编排 + 运行状态 + 冻结 IO。 */
  const ORCHESTRATION = (name: string): string => JSON.stringify({
    change: name,
    workflow: 'default',
    track: 'lite',
    current: 'build',
    stages: [{ id: 'build', label: 'build', gate: 'review', entries: [entry('skill', 'tenon-build', 0), entry('test', 'unit', 1), entry('reviewer', 'security', 2)] }],
    returns: [],
    flows: [],
    io: {
      build: {
        inputs: [{ kind: 'field', id: 'plan', type: 'file_path', producer: null, consumers: [] }],
        outputs: [{ kind: 'field', id: 'build_sha', type: 'string', producer: null, consumers: [] }],
      },
    },
  })
  const HISTORY = JSON.stringify({
    entries: [
      { ts: '2026-10-09T01:00:00Z', kind: 'init', actor: { id: 'ann@x.io', name: 'Ann', trust: 'declared' } },
      { ts: '2026-10-09T02:00:00Z', kind: 'transition', from: 'open', to: 'build', actor: { id: 'ann@x.io', name: 'Ann', trust: 'declared' } },
    ],
  })
  /** 按归档目录名答三个只读接口，别的一律 404。 */
  function archiveHandler(dir: string): (url: string) => Response {
    return (url) => {
      if (url.startsWith(`/api/change/${dir}/snapshot`)) return new Response(DETAIL(dir), { status: 200 })
      if (url.startsWith(`/api/change/${dir}/orchestration`)) return new Response(ORCHESTRATION(dir), { status: 200 })
      if (url.startsWith(`/api/change/${dir}/history`)) return new Response(HISTORY, { status: 200 })
      return NOT_FOUND()
    }
  }

  it('reads the archive directory read-only and shows the task name and its result', async () => {
    const fetchMock = stubFetch(archiveHandler('2026-10-11-retired'))
    renderEnded()
    fireEvent.click(screen.getByTestId('task-status-ended'))
    await waitFor(() => expect(screen.getByTestId('task-detail-title')).toHaveTextContent('retired'))
    expect(screen.getByTestId('task-detail-title').textContent).toBe('retired')
    expect(screen.getByTestId('task-detail-badge')).toHaveTextContent('已终止')
    // 只读：详情、编排、记录三个读接口都按归档目录名、带 archived=1。
    await screen.findByTestId('task-records')
    const archiveCalls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('2026-10-11-retired') || url.includes('archived'))
    expect(archiveCalls.sort()).toEqual([
      '/api/change/2026-10-11-retired/history?root=%2Frepo&archived=1',
      '/api/change/2026-10-11-retired/orchestration?root=%2Frepo&archived=1',
      '/api/change/2026-10-11-retired/snapshot?root=%2Frepo&archived=1',
    ])
    // 没有下一步、没有评审台、⋯ 里只有复制链接。
    expect(screen.queryByTestId('task-next')).toBeNull()
    await userEvent.click(screen.getByTestId('task-detail-menu'))
    const menu = await screen.findByTestId('task-detail-menu-menu')
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.getAttribute('data-testid'))).toEqual(['task-detail-menu-copy-link'])
  })

  it('shows the same panels as a live task: 阶段 · 总览, the stage canvas, 输入 / 输出, 记录', async () => {
    stubFetch(archiveHandler('2026-10-11-retired'))
    renderEnded()
    fireEvent.click(screen.getByTestId('task-status-ended'))
    const canvas = await screen.findByTestId('orchestration-stage')
    expect(within(canvas).getByTestId('orch-node-skill-tenon-build')).toHaveAttribute('data-status', 'done')
    // 输入 / 输出来自冻结计划的 IO。
    expect(screen.getByTestId('task-io-tab-inputs')).toHaveTextContent('1')
    expect(within(screen.getByTestId('task-io-tab-outputs')).getByText('0/1')).toBeInTheDocument()
    // 记录：创建与阶段转换，带操作人。
    const records = await screen.findByTestId('task-records')
    expect([...records.querySelectorAll('li')].map((item) => item.getAttribute('data-kind'))).toEqual(['init', 'transition'])
    expect([...records.querySelectorAll('[data-testid="task-record-actor"]')].map((item) => item.textContent)).toEqual(['Ann', 'Ann'])
    // 总览页同一张工作流画布。
    await userEvent.click(screen.getByTestId('task-view-tab-overview'))
    expect(screen.getByTestId('orchestration-overview')).toBeInTheDocument()
  })

  it('offers no write control and no test entry: the tests tab is hidden and test nodes do not open', async () => {
    const fetchMock = stubFetch(archiveHandler('2026-10-11-retired'))
    renderEnded()
    fireEvent.click(screen.getByTestId('task-status-ended'))
    const canvas = await screen.findByTestId('orchestration-stage')
    expect(screen.queryByTestId('task-io-tab-tests')).toBeNull()
    expect(within(canvas).getByTestId('orch-open-test-unit')).toBeDisabled()
    expect(within(canvas).getByTestId('orch-open-skill-tenon-build')).toBeDisabled()
    // 评审者 / 执行者的运行结论是只读证据，仍可打开。
    expect(within(canvas).getByTestId('orch-open-reviewer-security')).toBeEnabled()
    // 没有评审台、下一步、终止 / 转换入口。
    for (const id of ['task-next', 'review-console', 'task-action-terminate', 'task-action-finish']) expect(screen.queryByTestId(id), id).toBeNull()
    expect(within(screen.getByTestId('task-detail-pane')).queryByRole('button', { name: /终止|确认|评审通过|转换|编辑/u })).toBeNull()
    // 它只发了三个只读读取；没有任何写请求，也没有测试记录的请求。
    const own = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/change/2026-10-11-retired/'))
    expect(own.map(([url]) => String(url).split('?')[0]).sort()).toEqual([
      '/api/change/2026-10-11-retired/history',
      '/api/change/2026-10-11-retired/orchestration',
      '/api/change/2026-10-11-retired/snapshot',
    ])
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === undefined || init.method === 'GET')).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/tests'))).toBe(false)
  })

  it('reads the report of a reviewer at its archived location', async () => {
    const dir = '2026-10-11-retired'
    const reviewed = JSON.stringify({
      ...makeChange(dir, 'build', { track: 'lite', fields: { task_result: 'terminated' } }),
      agentRuns: [{ stepId: 'build', agents: [{ agent: 'security', role: 'reviewer', required: true, dependsOn: [], readsTests: [], state: 'done', result: 'pass', findings: 0, blocking: 0, runId: 'r1', reportPath: `openspec/changes/archive/${dir}/.pipeline-agent-reports/r1.md`, actor: null, finishedAt: null }] }],
    })
    const fetchMock = stubFetch((url) => {
      if (url.startsWith(`/api/change/${dir}/snapshot`)) return new Response(reviewed, { status: 200 })
      if (url.startsWith('/api/documents/read')) return new Response(JSON.stringify({ ok: true, path: 'r1.md', text: '# 结论\n\n通过', bytes: 9 }), { status: 200 })
      return archiveHandler(dir)(url)
    })
    renderEnded()
    fireEvent.click(screen.getByTestId('task-status-ended'))
    await userEvent.click(await screen.findByTestId('orch-open-reviewer-security'))
    await screen.findByTestId('agent-run-report')
    const read = fetchMock.mock.calls.map(([url]) => String(url)).find((url) => url.startsWith('/api/documents/read'))
    expect(new URL(read ?? '', 'http://localhost').searchParams.get('path')).toBe(`openspec/changes/archive/${dir}/.pipeline-agent-reports/r1.md`)
    // 已结束的任务不给启动命令。
    expect(screen.queryByTestId('agent-run-command-row')).toBeNull()
  })

  it('shows a loading line, then an error with a retry that reads again', async () => {
    let attempts = 0
    stubFetch((url) => {
      if (!url.startsWith('/api/change/2026-10-11-retired/snapshot')) return NOT_FOUND()
      attempts += 1
      return attempts === 1
        ? new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500 })
        : new Response(DETAIL('2026-10-11-retired'), { status: 200 })
    })
    renderEnded()
    fireEvent.click(screen.getByTestId('task-status-ended'))
    expect(await screen.findByTestId('task-detail-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('task-detail-title')).toHaveTextContent('retired')
    await userEvent.click(screen.getByTestId('task-detail-retry'))
    await waitFor(() => expect(screen.getByTestId('task-detail-badge')).toHaveTextContent('已终止'))
    expect(attempts).toBe(2)
  })

  it('hides the tests tab even when the snapshot carries a policy verdict: test records are kept under the live task name', async () => {
    const withVerdict = JSON.stringify({
      ...makeChange('2026-10-11-retired', 'verify', { track: 'lite', fields: { task_result: 'terminated' } }),
      testPolicy: [verifyReport()],
      testPlan: planBrief(),
      testUser: FIXTURE_USER,
    })
    stubFetch((url) => (url.startsWith('/api/change/2026-10-11-retired/snapshot')
      ? new Response(withVerdict, { status: 200 })
      : NOT_FOUND()))
    renderEnded()
    fireEvent.click(screen.getByTestId('task-status-ended'))
    await waitFor(() => expect(screen.getByTestId('task-detail-badge')).toBeInTheDocument())
    expect(screen.queryByTestId('task-io-tab-tests')).toBeNull()
  })

  it('selects by the archive directory name in the URL ref, never by the task name of a live task', async () => {
    const onSelectedChange = vi.fn()
    stubFetch((url) => (url.startsWith('/api/change/2026-10-11-retired/snapshot')
      ? new Response(DETAIL('2026-10-11-retired'), { status: 200 })
      : NOT_FOUND()))
    const view = renderEnded({ ended: [...ENDED, ended('demo', '2026-10-11T10:00:00Z', { result: 'terminated' })] }, { onSelectedChange })
    fireEvent.click(screen.getByTestId('task-status-ended'))
    await userEvent.click(screen.getByTestId('task-card-2026-10-11-retired'))
    expect(onSelectedChange).toHaveBeenLastCalledWith('2026-10-11-retired')
    // 终止后重建的同名任务：活跃行与已结束行同时存在，互不顶替。
    fireEvent.click(screen.getByTestId('task-status-all'))
    expect(screen.getByTestId('task-card-demo')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-2026-10-11-demo')).toBeInTheDocument()
    view.unmount()
    renderEnded({ ended: ENDED }, { selectedChange: '2026-10-11-retired' })
    await waitFor(() => expect(screen.getByTestId('task-detail-title')).toHaveTextContent('retired'))
  })
})
