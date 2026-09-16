import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { makeChange } from '../testkit'
import type { ChangeSnapshot, UserRefView } from '../types'
import { StageIoPanel } from './StageIoPanel'
import type { IoRow } from './stageIo'
import { TaskDetailPane, type TaskDetailPaneProps } from './TaskDetailPane'
import { stagesOf, type TaskRow } from './taskModel'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const ann: UserRefView = { id: 'ann@x.io', name: 'Ann', slug: 'ann-at-x.io' }
const bob: UserRefView = { id: 'bob@x.io', name: 'Bob', slug: 'bob-at-x.io' }

const HISTORY = {
  entries: [
    { ts: '2026-09-16T01:00:00Z', kind: 'init', actor: { id: 'ann@x.io', name: 'Ann', trust: 'declared' } },
    { ts: '2026-09-16T02:00:00Z', kind: 'set', field: 'assignee', from: 'Ann <ann@x.io>', to: 'Bob <bob@x.io>', actor: { id: 'bob@x.io', name: 'Bob', trust: 'declared' } },
    { ts: '2026-09-16T03:00:00Z', kind: 'tool', raw: 'Skill: tenon-build' },
  ],
}

const STEPS = ['spec', 'build', 'verify']

function ownerRow(owner: UserRefView | null): TaskRow {
  const change = makeChange('x', 'build', { owner })
  return { key: 'x@/repo', root: '/repo', change, rules: undefined, workflow: 'default', archived: false, owner, stages: [], summary: { kind: 'running' } }
}

function stubFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.startsWith('/api/change/x/history')) return new Response(JSON.stringify(HISTORY), { status: 200 })
    if (url === '/api/change/x/owner' && init?.method === 'POST') {
      return new Response(JSON.stringify({ ok: true, owner: bob, changed: true }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })
  })
}

function renderPane(props: TaskDetailPaneProps) {
  return render(<I18nProvider><TaskDetailPane {...props} /></I18nProvider>)
}

function change(over: Partial<ChangeSnapshot> = {}): ChangeSnapshot {
  return {
    name: 'demo',
    path: '/repo/openspec/changes/demo',
    phase: 'build',
    phase_status: 'pending',
    track: 'backend',
    preset: 'full',
    archived: 'false',
    updated_at: '2026-09-10T00:00:00Z',
    workflowPlanFingerprint: 'f'.repeat(64),
    workflowRules: {
      executionModel: 'step-graph',
      steps: STEPS,
      transitions: { build: [{ event: 'build-complete', to: 'verify' }] },
      gateByStep: { build: 'review' },
      labelByStep: {},
      outputsByStep: { build: ['build_sha', 'plan'] },
    },
    workflowExecution: { readinessByTransition: {} },
    ...over,
    fields: { workflow: 'mine', build_sha: 'sha', plan: '', ...(over.fields ?? {}) },
  } as unknown as ChangeSnapshot
}

function snapshotRow(snapshot: ChangeSnapshot): TaskRow {
  return {
    key: `/repo ${snapshot.name}`,
    root: '/repo',
    change: snapshot,
    rules: snapshot.workflowRules,
    workflow: 'mine',
    archived: false,
    owner: null,
    stages: stagesOf(snapshot, undefined, (key: string) => key),
    summary: { kind: 'running' },
  }
}

/** 聚合语境（fetchDefinition=false）：IO 退化为快照里的输出字段，不发任何请求。 */
function renderSnapshotPane(snapshot: ChangeSnapshot): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no request expected')))
  vi.stubGlobal('fetch', fetchSpy)
  render(<I18nProvider><TaskDetailPane row={snapshotRow(snapshot)} fetchDefinition={false} /></I18nProvider>)
  return fetchSpy
}

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__TENON_DASHBOARD_TOKEN__
})

describe('TaskDetailPane owner and records', () => {
  it('another owner + token + selected project shows 接手; clicking posts the owner route and refreshes', async () => {
    const fetchMock = stubFetch()
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    const onRefresh = vi.fn()
    const onToast = vi.fn()
    renderPane({ row: ownerRow(ann), me: bob, onRefresh, onToast })
    expect(screen.getByTestId('task-detail-meta')).toHaveTextContent('Ann')
    await userEvent.click(screen.getByTestId('task-detail-take'))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    const post = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/change/x/owner' && init?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ root: '/repo' })
    expect(onToast).toHaveBeenCalledWith('已接手')
  })

  it('hides 接手 for the owner, in the aggregate view, and without a token', () => {
    stubFetch()
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    const own = renderPane({ row: ownerRow(bob), me: bob })
    expect(screen.queryByTestId('task-detail-take')).toBeNull()
    own.unmount()
    const aggregate = renderPane({ row: ownerRow(ann), me: bob, fetchDefinition: false })
    expect(screen.queryByTestId('task-detail-take')).toBeNull()
    expect(screen.queryByTestId('task-records')).toBeNull()
    aggregate.unmount()
    delete window.__TENON_DASHBOARD_TOKEN__
    renderPane({ row: ownerRow(ann), me: bob })
    expect(screen.queryByTestId('task-detail-take')).toBeNull()
  })

  it('记录 lists operator records with their actor names and skips host evidence rows', async () => {
    stubFetch()
    renderPane({ row: ownerRow(bob), me: bob })
    const records = await screen.findByTestId('task-records')
    expect([...records.querySelectorAll('li')].map((item) => item.getAttribute('data-kind'))).toEqual(['init', 'set'])
    expect([...records.querySelectorAll('[data-testid="task-record-actor"]')].map((item) => item.textContent)).toEqual(['Ann', 'Bob'])
    expect(records).toHaveTextContent('负责人 Bob')
  })
})

describe('TaskDetailPane · 门禁行与输出计数', () => {
  it('输出页签显示 已齐/总数；门禁行显示 评审 · k/n（输出 + 一条人工确认）；不再请求运行时产物', () => {
    const fetchSpy = renderSnapshotPane(change())
    expect(within(screen.getByTestId('task-io-tab-outputs')).getByText('1/2')).toBeInTheDocument()
    expect(screen.getByTestId('task-io-tab-inputs')).toHaveTextContent('0')
    expect(screen.getByTestId('task-gate-row')).toHaveTextContent('评审')
    expect(screen.getByTestId('task-gate-row')).toHaveTextContent('1/3')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.queryByTestId('runtime-artifacts')).toBeNull()
  })

  it('人工确认已批准时门禁计数 +1', () => {
    renderSnapshotPane(change({ reviewHandshake: { status: 'approved', event: 'build-complete', requestedAt: 'a', acknowledgedAt: 'b' } }))
    expect(screen.getByTestId('task-gate-row')).toHaveTextContent('2/3')
  })

  it('阶段没有任何输入输出：整块 IO 不渲染，也没有门禁行', () => {
    const snapshot = change({
      workflowRules: { ...change().workflowRules, gateByStep: {}, outputsByStep: {} },
    })
    renderSnapshotPane(snapshot)
    expect(screen.queryByTestId('stage-io')).toBeNull()
    expect(screen.queryByTestId('task-gate-row')).toBeNull()
  })
})

describe('StageIoPanel · 过期原因与缺失技能', () => {
  const documentRow = (over: Partial<IoRow>): IoRow => ({
    slot: { kind: 'document', id: 'proposal', role: 'produce', scope: 'change', producers: ['openspec-propose'], consumers: [] },
    status: 'stale',
    path: 'openspec/changes/demo/proposal.md',
    value: 'openspec/changes/demo/proposal.md',
    producer: 'openspec-propose',
    at: null,
    reason: 'changed',
    producers: ['openspec-propose'],
    ...over,
  })

  it('过期行的状态徽标带原因一词与 data-reason；缺失行显示应产出的技能', () => {
    render(<I18nProvider>
      <StageIoPanel
        direction="outputs"
        items={[documentRow({}), documentRow({ slot: { kind: 'document', id: 'tasks', role: 'produce', scope: 'change', producers: ['openspec-propose'], consumers: [] }, status: 'missing', path: null, value: '', producer: null, reason: null })]}
        activePath={null}
        definitionState="ready"
        onOpen={() => undefined}
      />
    </I18nProvider>)
    const stale = screen.getByTestId('stage-output-document-proposal')
    expect(stale).toHaveAttribute('data-status', 'stale')
    expect(within(stale).getByTitle('内容已变')).toHaveAttribute('data-reason', 'changed')
    expect(screen.getByTestId('stage-output-document-tasks')).toHaveTextContent('openspec-propose')
    cleanup()
  })
})
