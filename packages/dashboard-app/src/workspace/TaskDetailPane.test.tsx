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

describe('TaskDetailPane 详情头', () => {
  it('头像在标题行、⋯ 之前；状态词只在头部这一处（「阻塞」不在下一步里重复）', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
    const snapshot = change({
      workflowExecution: {
        readinessByTransition: { build: { 'build-complete': { ready: false, blockers: [{ kind: 'step-exit', source: 'skill', code: 'skill-incomplete', message: '尚未完成声明的 skill：tdd', subject: 'tdd', state: 'not-run' }] } } },
      },
    } as unknown as Partial<ChangeSnapshot>)
    const row: TaskRow = { ...snapshotRow(snapshot), owner: ann, summary: summaryOf(snapshot, snapshot.workflowRules) }
    render(<I18nProvider><TaskDetailPane row={row} fetchDefinition={false} menu={[{ id: 'archive', label: '归档', icon: null, danger: false, onSelect: () => undefined }]} /></I18nProvider>)
    const title = screen.getByTestId('task-detail-title')
    const owner = screen.getByTestId('task-detail-owner')
    const menu = screen.getByTestId('task-detail-menu')
    expect(title.parentElement).toContainElement(owner)
    expect(title.parentElement).toContainElement(menu)
    expect(owner.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(title.compareDocumentPosition(owner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 副行不再放头像，只有 workflow/track 与状态。
    expect(screen.getByTestId('task-detail-meta').parentElement).not.toContainElement(owner)
    expect(screen.getByTestId('task-detail-meta').parentElement).toContainElement(screen.getByTestId('task-detail-badge'))
    expect(screen.getByTestId('task-detail-badge')).toHaveTextContent('阻塞 1')
    const pane = screen.getByTestId('task-detail-pane')
    expect(pane.textContent?.match(/阻塞/gu) ?? []).toHaveLength(1)
  })
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
    // 页签引用的面板真的在 DOM 里，并由当前页签命名（aria-controls 不悬空）。
    for (const tabId of ['task-view-tab-stage', 'task-io-tab-inputs']) {
      const tab = screen.getByTestId(tabId)
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '')
      expect(panel, tabId).not.toBeNull()
      expect(panel).toHaveAttribute('role', 'tabpanel')
      const selected = tab.closest('[role="tablist"]')?.querySelector('[aria-selected="true"]')
      expect(panel?.getAttribute('aria-labelledby')).toBe(selected?.id)
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
    // 有条目在运行：运行流（只走未完成的线）。
    expect(canvas).toHaveAttribute('data-signal', 'running')
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

  it('评审待确认：阶段页与总览的 Signal 都停在评审门前（still，线尽头琥珀短横，门图标围琥珀环）；不在被拦阶段时阶段页照常流', async () => {
    stubOrchestration()
    const pending = { status: 'pending' as const, event: 'build-complete', requestedAt: 'a' }
    const held = snapshotRow(change({ reviewHandshake: pending }))
    renderPane({ row: { ...held, summary: { kind: 'review' } } })
    const stage = await screen.findByTestId('orchestration-stage')
    expect(stage).toHaveAttribute('data-signal', 'still')
    expect(within(stage).getByTestId('react-flow').getAttribute('data-edge-holds')).toContain('end')
    await userEvent.click(screen.getByTestId('task-view-tab-overview'))
    const overview = screen.getByTestId('orchestration-overview')
    expect(overview).toHaveAttribute('data-signal', 'still')
    expect(within(within(overview).getByTestId('orch-frame-build')).getByTestId('orch-gate')).toHaveAttribute('data-holding', 'true')
    expect(within(overview).getByTestId('react-flow').getAttribute('data-edge-holds')).toBe('s:build->s:verify')
    // 选中另一个阶段看：那一阶段没被拦。
    await userEvent.click(within(overview).getByTestId('orch-stage-verify'))
    expect(within(screen.getByTestId('orchestration-stage')).getByTestId('react-flow').getAttribute('data-edge-holds')).toBe('')
  })

  it('阶段轨：任务在跑时当前段上有一颗彗星；评审待确认（阻塞）时没有，也不呼吸', async () => {
    stubOrchestration()
    const view = renderPane({ row: snapshotRow(change()) })
    await screen.findByTestId('orchestration-stage')
    expect(within(screen.getByTestId('stage-rail-bar-build')).getByTestId('stage-rail-streak')).toBeInTheDocument()
    expect(screen.queryAllByTestId('stage-rail-streak')).toHaveLength(1)
    view.unmount()
    renderPane({ row: { ...snapshotRow(change({ reviewHandshake: { status: 'pending', event: 'build-complete', requestedAt: 'a' } })), summary: { kind: 'review' } } })
    await screen.findByTestId('orchestration-stage')
    expect(screen.queryByTestId('stage-rail-streak')).toBeNull()
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

  it('同一候选上重跑过的评审者：抽屉事实里写出重跑次数与翻转，原因在悬停提示里', async () => {
    stubOrchestration()
    const RUNS = [{
      stepId: 'build',
      agents: [{
        agent: 'security', role: 'reviewer' as const, required: true, blockAt: 'high' as const,
        dependsOn: [], readsTests: ['unit'], state: 'done' as const, result: 'pass' as const,
        findings: 0, blocking: 0, runId: 'r3', reportPath: 'openspec/changes/demo/.pipeline-agent-reports/r3.md',
        actor: { id: 'ann@x.io', name: 'Ann' }, finishedAt: '2026-09-20T02:00:00Z',
        reruns: 2, flipped: true, rerunReason: '第一轮提示词没带 DESIGN.md',
      }],
    }]
    renderPane({ row: snapshotRow(change({ agentRuns: RUNS })) })
    await screen.findByTestId('orchestration-stage')
    await userEvent.click(screen.getByTestId('orch-open-reviewer-security'))
    const facts = screen.getByTestId('agent-run-facts')
    expect(facts).toHaveTextContent('评审者 · 通过 · 问题 0 · 重跑 2 · 翻转 · Ann')
    expect(facts).toHaveAttribute('title', '第一轮提示词没带 DESIGN.md')
  })

  const CANDIDATE = `sha256:${'1a2b3c4d'.repeat(8)}`
  const reviewer = (over: Record<string, unknown>) => [{
    stepId: 'build',
    agents: [{
      agent: 'security', role: 'reviewer' as const, required: true, blockAt: 'high' as const,
      dependsOn: [], readsTests: [], state: 'done' as const, result: 'pass' as const,
      findings: 0, blocking: 0, runId: 'r4', reportPath: 'openspec/changes/demo/.pipeline-agent-reports/r4.md',
      actor: { id: 'ann@x.io', name: 'Ann' }, finishedAt: '2026-09-20T02:00:00Z',
      ...over,
    }],
  }]

  it('跨厂商评审：抽屉里两行定义表——宿主（登记的 · 声明）与绑定的候选（短形式，完整哈希在 title）；一行不折行', async () => {
    stubOrchestration()
    renderPane({ row: snapshotRow(change({ agentRuns: reviewer({ requiredHost: 'codex', host: 'codex', hostSource: 'declared', wrongHost: false, candidate: CANDIDATE }) })) })
    await screen.findByTestId('orchestration-stage')
    await userEvent.click(screen.getByTestId('orch-open-reviewer-security'))
    const host = screen.getByTestId('agent-run-host')
    expect(host).toHaveTextContent('宿主codex要求 · 声明')
    expect(screen.queryByTestId('agent-run-command-row'), '有效运行已在要求的宿主上：不再给命令').toBeNull()
    expect(screen.getByTestId('agent-run-host-declared')).toBeInTheDocument()
    expect(within(host).queryByTestId('agent-run-host-mismatch')).toBeNull()
    const candidate = screen.getByTestId('agent-run-candidate')
    expect(candidate).toHaveTextContent(/候选sha256:1a2b3c4d…3c4d$/)
    expect(candidate.querySelector('[title]')).toHaveAttribute('title', CANDIDATE)
    for (const cell of within(candidate).getAllByRole('cell')) expect(cell.className).toContain('truncate')
    expect(screen.getByTestId('agent-run-binding').textContent).not.toContain('。')
  })

  it('登记的宿主不符：红点 + 「宿主不符」，要求的宿主在 title；仍显示登记的宿主与候选', async () => {
    stubOrchestration()
    renderPane({ row: snapshotRow(change({ agentRuns: reviewer({ state: 'stale', result: null, requiredHost: 'codex', host: 'claude', hostSource: 'detected', wrongHost: true, candidate: CANDIDATE }) })) })
    await screen.findByTestId('orchestration-stage')
    await userEvent.click(screen.getByTestId('orch-open-reviewer-security'))
    const mismatch = screen.getByTestId('agent-run-host-mismatch')
    expect(mismatch).toHaveAttribute('data-tone', 'blocked')
    expect(mismatch).toHaveTextContent('宿主不符')
    expect(mismatch).toHaveAttribute('title', 'codex')
    expect(screen.getByTestId('agent-run-host')).toHaveTextContent('claude')
    expect(screen.getByTestId('agent-run-candidate')).toBeInTheDocument()
  })

  it('要求宿主的评审者：当前或之后的步骤给 `tenon agent prompt` 命令，已过去的步骤、已归档的任务不给', async () => {
    const reviewerEntry = (id: string) => ({ kind: 'reviewer', id, label: id, wave: 0, dependsOn: [], required: true, source: 'declared', status: 'waiting' })
    const stages = [
      { id: 'spec', label: 'spec', gate: null, entries: [reviewerEntry('past-reviewer')] },
      { id: 'build', label: 'build', gate: 'review', entries: [reviewerEntry('now-reviewer')] },
      { id: 'verify', label: 'verify', gate: 'review', entries: [reviewerEntry('later-reviewer')] },
    ]
    const agent = (name: string) => ({
      agent: name, role: 'reviewer' as const, required: true, blockAt: 'high' as const, dependsOn: [], readsTests: [],
      state: 'idle' as const, result: null, findings: 0, blocking: 0, runId: null, reportPath: null, actor: null, finishedAt: null,
      requiredHost: 'codex' as const, host: null, hostSource: null, wrongHost: false, candidate: null,
    })
    const agentRuns = [
      { stepId: 'spec', agents: [agent('past-reviewer')] },
      { stepId: 'build', agents: [agent('now-reviewer')] },
      { stepId: 'verify', agents: [agent('later-reviewer')] },
    ]
    stubOrchestration(orchestrationBody('demo', { stages }))
    renderPane({ row: snapshotRow(change({ agentRuns })) })
    await screen.findByTestId('orchestration-stage')
    // 当前步骤。
    await userEvent.click(screen.getByTestId('orch-open-reviewer-now-reviewer'))
    expect(screen.getByTestId('agent-run-command-text').textContent).toBe('cd /repo && tenon agent prompt demo now-reviewer')
    await userEvent.keyboard('{Escape}')
    // 之后的步骤：同样给（轮到它时运行）。
    await userEvent.click(screen.getByTestId('stage-rail-verify'))
    await userEvent.click(await screen.findByTestId('orch-open-reviewer-later-reviewer'))
    expect(screen.getByTestId('agent-run-command-text').textContent).toBe('cd /repo && tenon agent prompt demo later-reviewer')
    expect(screen.getByTestId('agent-run-host-required')).toHaveTextContent('codex要求')
    await userEvent.keyboard('{Escape}')
    // 已过去的步骤：只展示宿主要求，不给命令。
    await userEvent.click(screen.getByTestId('stage-rail-spec'))
    await userEvent.click(await screen.findByTestId('orch-open-reviewer-past-reviewer'))
    expect(screen.getByTestId('agent-run-host-required')).toHaveTextContent('codex要求')
    expect(screen.queryByTestId('agent-run-command-row')).toBeNull()
  })

  it('要求了宿主但还没登记：宿主一格是破折号；没有宿主也没有候选的旧快照：整块不出现', async () => {
    stubOrchestration()
    const view = renderPane({ row: snapshotRow(change({ agentRuns: reviewer({ state: 'running', result: null, requiredHost: 'codex', host: null, candidate: null }) })) })
    await screen.findByTestId('orchestration-stage')
    await userEvent.click(screen.getByTestId('orch-open-reviewer-security'))
    expect(screen.getByTestId('agent-run-host')).toHaveTextContent('宿主— · codex要求')
    expect(screen.getByTestId('agent-run-command-text').textContent).toBe('cd /repo && tenon agent prompt demo security')
    expect(screen.queryByTestId('agent-run-candidate')).toBeNull()
    view.unmount()
    stubOrchestration()
    renderPane({ row: snapshotRow(change({ agentRuns: reviewer({}) })) })
    await screen.findByTestId('orchestration-stage')
    await userEvent.click(screen.getByTestId('orch-open-reviewer-security'))
    expect(screen.queryByTestId('agent-run-binding')).toBeNull()
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
              { kind: 'step-exit', source: 'skill', code: 'skill-incomplete', message: '尚未完成声明的 skill：tdd', subject: 'tdd', state: 'not-run' },
              { kind: 'step-exit', source: 'tasks', code: 'tasks-incomplete', message: 'tasks.md 仍有 2 项未勾', items: ['a', 'b'], count: 2 },
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

  it('下一步：标题旁不放计数；每条阻断是 40px 行 + 2px 琥珀左条', () => {
    renderSnapshotPane(blocked())
    const next = screen.getByTestId('task-next')
    expect(within(next).getByRole('heading', { name: '下一步' }).textContent).toBe('下一步')
    for (const line of within(next).getAllByTestId('task-next-blocker')) {
      const classes = line.className.split(/\s+/u)
      expect(classes).toEqual(expect.arrayContaining(['h-10', 'border-l-2', 'border-amber-d']))
    }
  })

  it('下一步：同类阻断合并成一行「缺少文档 proposal · openspec-design · tasks」，完整文案逐条进 title', () => {
    const doc = (name: string) => ({ kind: 'step-exit', source: 'document', code: 'document-evidence', message: `缺少 document '${name}'；执行 tenon document record <change> ${name} <path> --producer <skill>`, subject: name, state: 'missing' })
    renderSnapshotPane(change({
      workflowExecution: {
        readinessByTransition: {
          build: {
            'build-complete': {
              ready: false,
              blockers: [
                doc('proposal'),
                { kind: 'step-exit', source: 'tasks', code: 'tasks-incomplete', message: 'tasks.md 仍有 1 项未勾', items: ['a'], count: 1 },
                doc('openspec-design'),
                doc('tasks'),
              ],
            },
          },
        },
      },
    } as unknown as Partial<ChangeSnapshot>))
    const lines = within(screen.getByTestId('task-next')).getAllByTestId('task-next-blocker')
    expect(lines.map((line) => line.textContent)).toEqual(['缺少文档 proposal · openspec-design · tasks', 'tasks.md 未勾 1 项'])
    expect(lines[0]?.getAttribute('title')).toContain("缺少 document 'proposal'")
    expect(lines[0]?.getAttribute('title')).toContain("缺少 document 'openspec-design'")
    expect(lines[0]?.getAttribute('title')?.split('\n')).toHaveLength(3)
    expect(lines[1]?.getAttribute('title')).toBe('tasks.md 仍有 1 项未勾')
  })

  it('下一步：命令从头部省略，保留末尾的 tenon status <change>；复制的仍是完整命令', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderSnapshotPane(blocked())
    const command = screen.getByTestId('task-next-command-text')
    expect(command).toHaveAttribute('data-truncate', 'start')
    expect(command.className.split(/\s+/u)).toEqual(expect.arrayContaining(['truncate', 'text-left', '[direction:rtl]']))
    expect(command.querySelector('bdi')).toHaveAttribute('dir', 'ltr')
    expect(command.textContent).toBe('cd /repo && tenon status demo')
    await userEvent.click(screen.getByTestId('task-next-command-copy'))
    expect(writeText).toHaveBeenCalledWith('cd /repo && tenon status demo')
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

  it('界面是英文时复制英文恢复提示词（router hook 同样认 continue）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
    localStorage.setItem('tenon-dashboard-lang', 'en')
    try {
      render(<I18nProvider><TaskDetailPane row={snapshotRow(blocked())} fetchDefinition={false} /></I18nProvider>)
      await userEvent.click(screen.getByTestId('task-next-takeover'))
      expect(writeText).toHaveBeenCalledWith('/tenon continue demo')
    } finally {
      localStorage.removeItem('tenon-dashboard-lang')
    }
  })

  it('已完结不显示下一步', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
    const row = { ...snapshotRow(change()), summary: { kind: 'completed' as const } }
    render(<I18nProvider><TaskDetailPane row={row} fetchDefinition={false} /></I18nProvider>)
    expect(screen.queryByTestId('task-next')).toBeNull()
  })
})
