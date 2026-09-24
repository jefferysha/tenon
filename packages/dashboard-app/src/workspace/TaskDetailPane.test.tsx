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
import { invalidateWorkflowDefinition } from './useWorkflowDefinition'

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

describe('TaskDetailPane header and records', () => {
  it('标题右侧 ⋯ 菜单承载动作；没有底部动作条，也没有重复阶段名的 eyebrow', async () => {
    stubFetch()
    const archive = vi.fn()
    renderPane({ row: ownerRow(ann), menu: [{ id: 'archive', label: '归档', icon: null, danger: false, onSelect: archive }] })
    // 负责人只用头像 + 悬浮名字，副行不再写名字。
    expect(screen.getByTestId('task-detail-owner')).toHaveAttribute('title', 'Ann')
    expect(screen.getByTestId('task-detail-meta')).not.toHaveTextContent('Ann')
    expect(screen.getByTestId('task-detail-pane').querySelector('footer')).toBeNull()
    await userEvent.click(screen.getByTestId('task-detail-menu'))
    await userEvent.click(await screen.findByTestId('task-detail-menu-archive'))
    expect(archive).toHaveBeenCalledTimes(1)
  })

  it('状态行只写状态一词，不再带阶段名；定义里没有 label 时回退 id', () => {
    stubFetch()
    const row = { ...ownerRow(null), summary: { kind: 'ready' as const, to: 'verify' } }
    renderPane({ row })
    expect(screen.getByTestId('task-detail-badge')).toHaveTextContent(/^可进入verify$/u)
    // 可前进由智能体推进，不是「需要你」。
    expect(screen.getByTestId('task-detail-badge')).toHaveAttribute('data-tone', 'running')
  })

  // 状态只读快照：工作流定义加载前后，状态行、阶段轨与记录的名字都一样（名称只显示一个：冻结计划的 label，没有就是 id）。
  it('定义加载前后状态行不变', async () => {
    const def = {
      name: 'default',
      steps: ['build', 'verify'].map((id, index) => ({
        id, label: id === 'verify' ? '验证' : '实现', gate: null, skills: [], inputs: [], outputs: [], guards: [],
        transitions: index === 0 ? [{ event: 'build-complete', to: 'verify' }] : [],
      })),
    }
    const history = { entries: [{ ts: '2026-09-16T01:00:00Z', kind: 'transition', from: 'build', to: 'verify', actor: { id: 'ann@x.io', name: 'Ann', trust: 'declared' } }] }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/workflows/default?root=%2Frepo') return new Response(JSON.stringify(def), { status: 200 })
      if (url.startsWith('/api/change/x/history')) return new Response(JSON.stringify(history), { status: 200 })
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })
    })
    const base = ownerRow(null)
    const ids = { build: 'build', verify: 'verify' }
    const rules = { ...base.change.workflowRules, steps: ['build', 'verify'], labelByStep: ids }
    const row: TaskRow = {
      ...base,
      rules,
      stages: [{ id: 'build', label: 'build', status: 'current' }, { id: 'verify', label: 'verify', status: 'todo' }],
      summary: { kind: 'ready', to: 'verify' },
    }
    try {
      renderPane({ row })
      const before = screen.getByTestId('task-detail-badge').textContent
      expect(before).toBe('可进入verify')
      await waitFor(() => expect(fetchSpy.mock.calls.some((call) => String(call[0]).startsWith('/api/workflows/'))).toBe(true))
      expect(await screen.findByText('build → verify')).toBeInTheDocument()
      expect(screen.getByTestId('task-detail-badge').textContent).toBe(before)
    } finally {
      invalidateWorkflowDefinition()
    }
  })

  it('没有菜单项时不渲染 ⋯', () => {
    stubFetch()
    renderPane({ row: ownerRow(ann) })
    expect(screen.queryByTestId('task-detail-menu')).toBeNull()
  })

  it('聚合语境不请求记录', () => {
    stubFetch()
    renderPane({ row: ownerRow(ann), fetchDefinition: false })
    expect(screen.queryByTestId('task-records')).toBeNull()
  })

  it('记录 lists operator records with their actor names and skips host evidence rows', async () => {
    stubFetch()
    renderPane({ row: ownerRow(bob) })
    const records = await screen.findByTestId('task-records')
    expect([...records.querySelectorAll('li')].map((item) => item.getAttribute('data-kind'))).toEqual(['init', 'set'])
    expect([...records.querySelectorAll('[data-testid="task-record-actor"]')].map((item) => item.textContent)).toEqual(['Ann', 'Bob'])
    expect(records).toHaveTextContent('负责人 Bob')
  })
})

describe('TaskDetailPane · URL step', () => {
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('从 URL 的 step 打开所选阶段；切回当前阶段时从 URL 去掉', async () => {
    window.history.replaceState(null, '', '/?view=progress&change=demo&step=spec')
    renderSnapshotPane(change())
    expect(screen.getByTestId('stage-rail-spec')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByTestId('stage-rail-build'))
    expect(new URLSearchParams(window.location.search).get('step')).toBeNull()
    await userEvent.click(screen.getByTestId('stage-rail-verify'))
    expect(new URLSearchParams(window.location.search).get('step')).toBe('verify')
  })

  it('URL 的 step 属于别的任务时忽略', () => {
    window.history.replaceState(null, '', '/?view=progress&change=other&step=spec')
    renderSnapshotPane(change())
    expect(screen.getByTestId('stage-rail-build')).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('TaskDetailPane · 技能状态', () => {
  const RUNS = [{ stepId: 'build', skills: [{ id: 'tenon-build', status: 'idle' as const, wave: 0 }] }]

  it('已完结的任务，没有运行记录的技能不写「未运行」', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
    const row = { ...snapshotRow(change({ skillRuns: RUNS })), summary: { kind: 'completed' as const } }
    render(<I18nProvider><TaskDetailPane row={row} fetchDefinition={false} /></I18nProvider>)
    expect(screen.getByTestId('flow-node-tenon-build')).not.toHaveTextContent('未运行')
  })

  it('阶段仍在进行时照常写「未运行」（与智能体、测试同一用词）', () => {
    renderSnapshotPane(change({ skillRuns: RUNS }))
    expect(screen.getByTestId('flow-node-tenon-build')).toHaveTextContent('未运行')
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

describe('TaskDetailPane · agent 段', () => {
  const RUNS = [{
    stepId: 'build',
    agents: [
      {
        agent: 'builder', role: 'executor' as const, required: true, dependsOn: [], readsTests: [],
        state: 'done' as const, result: 'done' as const, findings: 0, blocking: 0,
        runId: 'r1', reportPath: 'openspec/changes/demo/.pipeline-agent-reports/r1.md',
        actor: { id: 'ann@x.io', name: 'Ann' }, finishedAt: '2026-09-20T01:00:00Z',
      },
      {
        agent: 'security', role: 'reviewer' as const, required: true, blockAt: 'high' as const,
        dependsOn: [], readsTests: ['unit'], state: 'done' as const, result: 'fail' as const,
        findings: 2, blocking: 1, runId: 'r2', reportPath: 'openspec/changes/demo/.pipeline-agent-reports/r2.md',
        actor: { id: 'ann@x.io', name: 'Ann' }, finishedAt: '2026-09-20T02:00:00Z',
      },
    ],
  }]

  it('画布按身份与结论标注；评审者接在执行者之后', () => {
    renderSnapshotPane(change({ agentRuns: RUNS }))
    const section = screen.getByTestId('stage-agents')
    expect(section).toHaveTextContent('2')
    expect(within(section).getByTestId('skill-flow')).toHaveAttribute('data-edges', '1')
    expect(screen.getByTestId('flow-caption-security')).toHaveTextContent('评审者')
    expect(screen.getByTestId('flow-node-security')).toHaveTextContent('不通过 · 问题 2')
    expect(screen.getByTestId('flow-node-builder')).toHaveTextContent('完成')
    // 高度由只读画布按内容算（canvasHeight），不再写死 h-56 把多行波次压扁。
    const canvas = within(section).getByTestId('skill-flow')
    expect(canvas.className.split(/\s+/u)).not.toContain('h-56')
    expect(canvas.style.height).not.toBe('')
  })

  it('没有 agent 的步骤整段不渲染；点节点开抽屉，抽屉读它的报告', async () => {
    const bare = renderSnapshotPane(change())
    expect(screen.queryByTestId('stage-agents')).toBeNull()
    cleanup()
    bare.mockReset()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, path: 'r2.md', text: '# 结论\n\n不通过', bytes: 12 }),
      { status: 200 },
    )))
    render(<I18nProvider><TaskDetailPane row={snapshotRow(change({ agentRuns: RUNS }))} fetchDefinition={false} /></I18nProvider>)
    await userEvent.click(screen.getByTestId('flow-open-security'))
    expect(screen.getByTestId('agent-run-facts')).toHaveTextContent('评审者 · 不通过 · 问题 2 · Ann')
    await waitFor(() => expect(screen.getByTestId('agent-run-report')).toHaveTextContent('不通过'))
  })
})

describe('TaskDetailPane · 下一步', () => {
  const blocked = (): ChangeSnapshot => change({
    workflowExecution: {
      readinessByTransition: {
        build: {
          'build-complete': {
            ready: false,
            blockers: [
              { kind: 'step-exit', source: 'skill', code: 'skill-incomplete', message: '尚未完成声明的 skill：tdd' },
              { kind: 'step-exit', source: 'tasks', code: 'tasks-incomplete', message: 'tasks.md 仍有 2 项未勾', items: ['a', 'b'] },
            ],
          },
        },
      },
    },
  })

  it('状态行下列出前进出口的阻断（每条一行、截断带 title）+ 可复制的 tenon status 命令', () => {
    renderSnapshotPane(blocked())
    const next = screen.getByTestId('task-next')
    const lines = within(next).getAllByTestId('task-next-blocker')
    expect(lines.map((line) => line.textContent)).toEqual(['尚未完成声明的 skill：tdd', 'tasks.md 仍有 2 项未勾'])
    for (const line of lines) {
      expect(line.className).toContain('truncate')
      expect(line.className).toContain('whitespace-nowrap')
      expect(line).toHaveAttribute('title', line.textContent ?? '')
    }
    expect(screen.getByTestId('task-next-command-text')).toHaveTextContent('cd /repo && tenon status demo')
  })

  it('「复制接管命令」复制 tenon session activate 并提示', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
    const onToast = vi.fn()
    render(<I18nProvider><TaskDetailPane row={snapshotRow(blocked())} fetchDefinition={false} onToast={onToast} /></I18nProvider>)
    await userEvent.click(screen.getByTestId('task-next-takeover'))
    expect(writeText).toHaveBeenCalledWith('cd /repo && tenon session activate demo')
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('接管命令已复制'))
  })

  it('已完结不显示下一步', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
    const row = { ...snapshotRow(change()), summary: { kind: 'completed' as const } }
    render(<I18nProvider><TaskDetailPane row={row} fetchDefinition={false} /></I18nProvider>)
    expect(screen.queryByTestId('task-next')).toBeNull()
  })
})
