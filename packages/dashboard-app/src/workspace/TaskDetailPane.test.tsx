import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeChange } from '../testkit'
import type { ChangeSnapshot, UserRefView } from '../types'
import { StageIoPanel } from './StageIoPanel'
import type { IoRow } from './stageIo'
import { TaskDetailPane, type TaskDetailPaneProps } from './TaskDetailPane'
import { stagesOf, summaryOf, type TaskRow } from './taskModel'

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

/** 任务端点 `GET /api/change/:c/orchestration` 的响应：冻结计划的编排 + 运行状态 + 冻结 IO。 */
function orchestrationBody(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const entry = (kind: string, id: string, wave: number, status: string, extra: Record<string, unknown> = {}) => ({ kind, id, label: id, wave, dependsOn: [], required: true, source: 'declared', status, ...extra })
  return {
    change: name,
    workflow: 'mine',
    track: null,
    current: 'build',
    stages: [
      { id: 'spec', label: 'spec', gate: null, entries: [entry('skill', 'writing-plans', 0, 'done')] },
      {
        id: 'build', label: 'build', gate: 'review', entries: [
          entry('executor', 'builder', 0, 'done'),
          entry('skill', 'tenon-build', 1, 'running'),
          entry('test', 'unit', 2, 'failed'),
          entry('reviewer', 'security', 3, 'waiting'),
        ],
      },
      { id: 'verify', label: 'verify', gate: 'review', entries: [entry('skill', 'browser-qa', 0, 'waiting')] },
    ],
    returns: [{ from: 'verify', to: 'build', event: 'verify-fail' }],
    flows: [{ slot: 'field', id: 'build_sha', from: 'build', producers: [], to: ['verify'] }],
    io: {
      spec: { inputs: [], outputs: [] },
      build: {
        inputs: [{ kind: 'field', id: 'plan', type: 'file_path', producer: 'spec', consumers: [] }],
        outputs: [{ kind: 'field', id: 'build_sha', type: 'string', producer: null, consumers: ['verify'] }],
      },
      verify: { inputs: [], outputs: [] },
    },
    ...over,
  }
}

function renderPane(props: TaskDetailPaneProps) {
  return render(<I18nProvider><TooltipProvider><TaskDetailPane {...props} /></TooltipProvider></I18nProvider>)
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

  // 状态只读快照：编排加载前后，状态行、阶段轨与记录的名字都一样（名称只显示一个：冻结计划的 label，没有就是 id）。
  it('编排加载前后状态行不变；读的是任务冻结计划（任务端点），不读当前工作流定义', async () => {
    const history = { entries: [{ ts: '2026-09-16T01:00:00Z', kind: 'transition', from: 'build', to: 'verify', actor: { id: 'ann@x.io', name: 'Ann', trust: 'declared' } }] }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/change/x/orchestration?root=%2Frepo') return new Response(JSON.stringify(orchestrationBody('x')), { status: 200 })
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
    renderPane({ row })
    const before = screen.getByTestId('task-detail-badge').textContent
    expect(before).toBe('可进入verify')
    expect(await screen.findByText('build → verify')).toBeInTheDocument()
    await screen.findByTestId('orchestration-stage')
    expect(screen.getByTestId('task-detail-badge').textContent).toBe(before)
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).startsWith('/api/workflows/'))).toBe(false)
    // 输入 / 输出槽位来自冻结计划的 IO。
    expect(screen.getByTestId('task-io-tab-inputs')).toHaveTextContent('1')
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

describe('TaskDetailPane · 编排画布与运行状态', () => {
  // 选阶段会把 step 写进 URL；每条用例从干净的地址开始。
  afterEach(() => { window.history.replaceState(null, '', '/') })

  function stubOrchestration(body = orchestrationBody('demo')) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/change/demo/orchestration?root=%2Frepo') return new Response(JSON.stringify(body), { status: 200 })
      if (url.startsWith('/api/agents/')) return new Response(JSON.stringify({ ok: true, path: 'r2.md', text: '# 结论\n\n不通过', bytes: 12 }), { status: 200 })
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })
    })
  }

  it('阶段页：所选阶段的单列画布，泳道按 执行者 → 技能 → 测试 → 评审者，节点带四态', async () => {
    stubOrchestration()
    renderPane({ row: snapshotRow(change()) })
    const canvas = await screen.findByTestId('orchestration-stage')
    const states = ['executor-builder', 'skill-tenon-build', 'test-unit', 'reviewer-security']
      .map((id) => within(canvas).getByTestId(`orch-node-${id}`))
    expect(states.map((node) => node.getAttribute('data-status'))).toEqual(['done', 'running', 'failed', 'waiting'])
    expect(states.map((node) => within(node).getByTestId('orch-status').textContent)).toEqual(['完成', '运行中', '失败', '等待'])
    expect(canvas).toHaveAttribute('data-pulse', 'loop')
  })

  it('总览页：整条工作流一张画布，当前阶段高亮；点列头回到阶段页并选中该阶段', async () => {
    stubOrchestration()
    renderPane({ row: snapshotRow(change()) })
    await screen.findByTestId('orchestration-stage')
    await userEvent.click(screen.getByTestId('task-view-tab-overview'))
    const overview = screen.getByTestId('orchestration-overview')
    expect(screen.queryByTestId('stage-rail')).toBeNull()
    expect(within(overview).getByTestId('orch-frame-build')).toHaveAttribute('data-current', 'true')
    expect(within(overview).getByTestId('orch-frame-spec')).not.toHaveAttribute('data-current')
    expect(within(within(overview).getByTestId('orch-frame-build')).getByTestId('orch-gate')).toHaveAttribute('data-gate', 'review')
    await userEvent.click(within(overview).getByTestId('orch-stage-verify'))
    expect(screen.getByTestId('stage-rail-verify')).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByTestId('orchestration-stage')).getByTestId('orch-node-skill-browser-qa')).toHaveAttribute('data-status', 'waiting')
  })

  it('读不到编排时写出错误（role=alert），其余照常', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: 'x' }), { status: 500 }))
    renderPane({ row: snapshotRow(change()) })
    expect(await screen.findByTestId('task-orchestration-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('task-detail-badge')).toBeInTheDocument()
  })

  it('点评审者节点开运行抽屉（事实来自快照的 agent 投影）；技能节点点不开', async () => {
    stubOrchestration()
    const RUNS = [{
      stepId: 'build',
      agents: [{
        agent: 'security', role: 'reviewer' as const, required: true, blockAt: 'high' as const,
        dependsOn: [], readsTests: ['unit'], state: 'done' as const, result: 'fail' as const,
        findings: 2, blocking: 1, runId: 'r2', reportPath: 'openspec/changes/demo/.pipeline-agent-reports/r2.md',
        actor: { id: 'ann@x.io', name: 'Ann' }, finishedAt: '2026-09-20T02:00:00Z',
      }],
    }]
    renderPane({ row: snapshotRow(change({ agentRuns: RUNS })) })
    await screen.findByTestId('orchestration-stage')
    expect(screen.getByTestId('orch-open-skill-tenon-build')).toBeDisabled()
    await userEvent.click(screen.getByTestId('orch-open-reviewer-security'))
    expect(screen.getByTestId('agent-run-facts')).toHaveTextContent('评审者 · 不通过 · 问题 2 · Ann')
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

  it('并进同名文档的值字段只出现在行 title 里，不单独成行', () => {
    render(<I18nProvider>
      <StageIoPanel
        direction="outputs"
        items={[documentRow({ slot: { kind: 'document', id: 'verification-report', role: 'produce', scope: 'change', producers: [], consumers: [], field: 'verification_report' }, status: 'recorded', path: 'docs/report.md', reason: null })]}
        activePath={null}
        definitionState="ready"
        onOpen={() => undefined}
      />
    </I18nProvider>)
    const row = screen.getByTestId('stage-output-document-verification-report')
    expect(row.getAttribute('title')).toContain('verification_report')
    expect(screen.queryByTestId('stage-output-field-verification_report')).toBeNull()
    expect(screen.getAllByRole('row')).toHaveLength(2)
    cleanup()
  })

  it('来源技能一词一概念：互为别名的候选只显示一个名字，别名放 title', () => {
    render(<I18nProvider>
      <StageIoPanel
        direction="outputs"
        items={[documentRow({ slot: { kind: 'document', id: 'tasks', role: 'produce', scope: 'change', producers: ['openspec-propose', 'opsx:propose', 'tenon:writing-plans', 'superpowers:writing-plans'], consumers: [] }, status: 'missing', path: null, value: '', producer: null, reason: null, producers: ['openspec-propose', 'opsx:propose', 'tenon:writing-plans', 'superpowers:writing-plans'] })]}
        activePath={null}
        definitionState="ready"
        onOpen={() => undefined}
      />
    </I18nProvider>)
    const cell = within(screen.getByTestId('stage-output-document-tasks')).getAllByRole('cell')[1] as HTMLElement
    expect(cell.textContent).toBe('openspec-propose, tenon:writing-plans')
    expect(cell).toHaveAttribute('title', 'openspec-propose, opsx:propose, tenon:writing-plans, superpowers:writing-plans')
    cleanup()
  })

  it('输入 / 输出是带表头的表（文件 · 来源技能 · 状态），不是卡片堆叠；点整行照旧开抽屉', async () => {
    const onOpen = vi.fn()
    render(<I18nProvider>
      <StageIoPanel
        direction="outputs"
        items={[documentRow({ status: 'recorded', reason: null }), documentRow({ slot: { kind: 'document', id: 'tasks', role: 'produce', scope: 'change', producers: ['openspec-propose'], consumers: [] }, status: 'missing', path: null, value: '', producer: null, reason: null })]}
        activePath={null}
        definitionState="ready"
        onOpen={onOpen}
      />
    </I18nProvider>)
    const table = within(screen.getByTestId('stage-outputs')).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['文件', '来源技能', '状态'])
    const row = screen.getByTestId('stage-output-document-proposal')
    expect(row).toHaveAttribute('role', 'row')
    expect(row.className).toContain('border-b')
    expect(row.className).not.toMatch(/(^|\s)rounded-md(\s|$)/u)
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['proposal', 'openspec-propose', '已登记'])
    await userEvent.click(within(row).getAllByRole('cell')[1] as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith('openspec/changes/demo/proposal.md')
    // 未产出的行没有路径：不可点。
    await userEvent.click(screen.getByTestId('stage-output-document-tasks'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    cleanup()
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

  it('状态行下列出前进出口的阻断：每条一行短标签（截断），完整 CLI 文案进 title；命令截断、复制钮常显', () => {
    renderSnapshotPane(blocked())
    const next = screen.getByTestId('task-next')
    const lines = within(next).getAllByTestId('task-next-blocker')
    expect(lines.map((line) => line.textContent)).toEqual(['技能 tdd 未运行', 'tasks.md 未勾 2 项'])
    expect(lines.map((line) => line.getAttribute('title'))).toEqual(['尚未完成声明的 skill：tdd', 'tasks.md 仍有 2 项未勾'])
    for (const line of lines) {
      expect(line.className).toContain('truncate')
      expect(line.className).toContain('whitespace-nowrap')
    }
    expect(next.className).toContain('grid-cols-[minmax(0,1fr)]')
    const command = screen.getByTestId('task-next-command-text')
    expect(command).toHaveTextContent('cd /repo && tenon status demo')
    expect(command.className).toContain('truncate')
    expect(command).toHaveAttribute('title', 'cd /repo && tenon status demo')
    expect(screen.getByTestId('task-next-command-copy').className).toContain('flex-none')
    expect(screen.getByTestId('task-next-takeover').className).toContain('flex-none')
  })

  it('阻断状态用警示琥珀，不用错误红', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
    const snapshot = blocked()
    const row = { ...snapshotRow(snapshot), summary: summaryOf(snapshot, snapshot.workflowRules) }
    expect(row.summary.kind).toBe('blocked')
    render(<I18nProvider><TaskDetailPane row={row} fetchDefinition={false} /></I18nProvider>)
    expect(screen.getByTestId('task-detail-badge')).toHaveAttribute('data-tone', 'pending')
  })

  it('「复制接管命令」复制发给 agent 的恢复提示词（不是 tenon session activate）并提示', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
    const onToast = vi.fn()
    render(<I18nProvider><TaskDetailPane row={snapshotRow(blocked())} fetchDefinition={false} onToast={onToast} /></I18nProvider>)
    await userEvent.click(screen.getByTestId('task-next-takeover'))
    expect(writeText).toHaveBeenCalledWith('/tenon 继续 demo')
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('接管命令已复制'))
  })

  it('已完结不显示下一步', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
    const row = { ...snapshotRow(change()), summary: { kind: 'completed' as const } }
    render(<I18nProvider><TaskDetailPane row={row} fetchDefinition={false} /></I18nProvider>)
    expect(screen.queryByTestId('task-next')).toBeNull()
  })
})
