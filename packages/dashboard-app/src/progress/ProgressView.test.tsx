import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import gsap from 'gsap'
import { I18nProvider, useT } from '../i18n'
import { AFK_LOG_POLL_INTERVAL_MS } from './useAfkLog'
import {
  DEFAULT_RULES,
  rulesFromDef,
  rulesKey,
  workflowRulesFromSnapshot,
  type StepOutputRules,
  type WorkflowRules,
} from '../model/workflowModel'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import type { Snapshot, WorkflowExecutionSnapshot, WorkflowRulesSnapshot } from '../types'
import { ProgressView } from './ProgressView'

const ROOT_A = '/tmp/proj-a'

/**
 * v10c 单项目进度页测试：App 保证 currentRoot 恒非空（本文件恒传 ROOT_A）。画布即操作面——
 * change 挂在相位站台卡里，点开=右滑抽屉（TaskDetail + 全部动作）；下方按项目分组的重复在制
 * 列表整段退役（负向断言钉死不回归）；归档挂在相位小站的只读折叠里。fixture=单项目 proj-a
 * 六条在制（default 五 + release-train 一）+ 一条 archived：
 *   gate 全绿（gate-demo·verify 可以放行）/ 自定义门纯人判（changelog-cn·release-train 等你判断）/
 *   失败（hotfix-login ×3）/ 执行中（afk-demo）/ 等产出（triage-demo 缺 plan）/ 排队（board-demo），
 *   外加 old-demo（archive 相位已归档）。
 */
const RELEASE_TRAIN_RULES = rulesFromDef({
  name: 'release-train',
  steps: [
    {
      id: 'draft', label: '起草', gate: null, skills: [], inputs: [],
      outputs: [{ field: 'draft_doc', type: 'file_path' }], guards: [],
      transitions: [{ event: 'submitted', to: 'review' }],
    },
    {
      id: 'review', label: '人工复核', gate: 'review', skills: [], inputs: [],
      outputs: [], guards: [],
      transitions: [{ event: 'approved', to: 'ship' }],
    },
    { id: 'ship', label: '发布', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ],
})

// 评审 P1-1 探针：自定义 workflow 的 review 相位挂 2 条前进边（ship-now→ship / fast-track→done）
// + 1 条回退边（send-back→triage）——「2+ 条同向出边一条不落」的抽屉动作条量规。
const MULTI_EDGE_RULES = rulesFromDef({
  name: 'multi-edge',
  steps: [
    {
      id: 'triage', label: '分诊', gate: null, skills: [], inputs: [], outputs: [], guards: [],
      transitions: [{ event: 'triaged', to: 'review' }],
    },
    {
      id: 'review', label: '复核', gate: 'review', skills: [], inputs: [], outputs: [], guards: [],
      transitions: [
        { event: 'ship-now', to: 'ship' },
        { event: 'fast-track', to: 'done' },
        { event: 'send-back', to: 'triage' },
      ],
    },
    { id: 'ship', label: '发布', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'shipped', to: 'done' }] },
    { id: 'done', label: '完成', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ],
})

const REVIEW_CHAIN_RULES = rulesFromDef({
  name: 'review-chain',
  steps: [
    {
      id: 'explore', label: '调研', gate: 'review', skills: [], inputs: [], outputs: [], guards: [],
      transitions: [{ event: 'explore-complete', to: 'spec' }],
    },
    {
      id: 'spec', label: '规格', gate: 'review', skills: [], inputs: [], outputs: [], guards: [],
      transitions: [{ event: 'spec-complete', to: 'build' }],
    },
    { id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ],
})

function readyWorkflowExecution(rules: WorkflowRulesSnapshot): WorkflowExecutionSnapshot {
  return {
    readinessByTransition: Object.fromEntries(rules.steps.map((step) => [
      step,
      Object.fromEntries((rules.transitions[step] ?? []).map(({ event }) => [
        event,
        { ready: true, blockers: [] },
      ])),
    ])),
  }
}

function snapshotRules(rules: WorkflowRules & StepOutputRules): WorkflowRulesSnapshot {
  return {
    executionModel: rules.executionModel ?? 'step-graph',
    steps: [...rules.steps],
    transitions: Object.fromEntries(rules.steps.map((step) => [
      step,
      [...(rules.transitions[step] ?? [])].map(({ event, to }) => ({ event, to })),
    ])),
    gateByStep: Object.fromEntries(rules.steps.map((step) => [
      step,
      rules.gateByStep[step] ?? null,
    ])),
    labelByStep: Object.fromEntries(rules.steps.map((step) => [
      step,
      rules.labelByStep?.[step] ?? step,
    ])),
    outputsByStep: Object.fromEntries(rules.steps.map((step) => [
      step,
      [...(rules.outputsByStep?.[step] ?? [])],
    ])),
  }
}

const RELEASE_TRAIN_SNAPSHOT_RULES = snapshotRules(RELEASE_TRAIN_RULES)
const MULTI_EDGE_SNAPSHOT_RULES = snapshotRules(MULTI_EDGE_RULES)
const REVIEW_CHAIN_SNAPSHOT_RULES = snapshotRules(REVIEW_CHAIN_RULES)

function makeFixture(): Snapshot {
  return makeSnapshot([
    makeProject(ROOT_A, [
      makeChange('gate-demo', 'verify', {
        track: 'backend',
        updated_at: '2026-07-12T10:00:00Z',
        fields: { verify_result: 'pass', agent_review_result: 'pass', codex_review_result: 'pass' },
        // Readiness is an authoritative server projection; keep the gate fixture explicit.
        workflowExecution: {
          readinessByTransition: {
            verify: {
              'verify-pass': { ready: true, blockers: [] },
              'verify-fail': { ready: true, blockers: [] },
            },
          },
        },
      }),
      makeChange('triage-demo', 'spec', {
        track: 'chat',
        updated_at: '2026-07-12T09:00:00Z',
        fields: { design_doc: 'docs/design.md' },
      }),
      makeChange('afk-demo', 'build', {
        track: 'chat',
        updated_at: '2026-07-12T11:00:00Z',
        fields: { automation: 'running', automation_current_phase: 'verify' },
      }),
      makeChange('board-demo', 'open', {
        track: 'frontend',
        updated_at: '2026-07-12T08:00:00Z',
        fields: { automation: 'queued' },
      }),
      makeChange('hotfix-login', 'build', {
        track: 'backend',
        updated_at: '2026-07-11T10:00:00Z',
        fields: { automation: 'failed', automation_attempts: '3' },
      }),
      makeChange('changelog-cn', 'review', {
        track: 'chat',
        updated_at: '2026-07-13T09:30:00Z',
        fields: { workflow: 'release-train' },
        workflowRules: RELEASE_TRAIN_SNAPSHOT_RULES,
        workflowExecution: readyWorkflowExecution(RELEASE_TRAIN_SNAPSHOT_RULES),
      }),
      makeChange('old-demo', 'archive', { archived: 'true' }),
    ]),
  ])
}

function makeRules(): Map<string, WorkflowRules> {
  return new Map<string, WorkflowRules>([
    [rulesKey(ROOT_A, 'default'), DEFAULT_RULES],
    [rulesKey(ROOT_A, 'release-train'), RELEASE_TRAIN_RULES],
  ])
}

function renderView(over: Partial<Parameters<typeof ProgressView>[0]> = {}) {
  function LanguageToggle(): JSX.Element {
    const { setLang } = useT()
    return <button type="button" data-testid="progress-language-en" onClick={() => setLang('en')}>en</button>
  }
  const onToast = vi.fn()
  const onRefresh = vi.fn()
  render(
    <I18nProvider>
      <LanguageToggle />
      <ProgressView
        snapshot={makeFixture()}
        loading={false}
        error={null}
        currentRoot={ROOT_A}
        rulesByKey={makeRules()}
        onToast={onToast}
        onRefresh={onRefresh}
        {...over}
      />
    </I18nProvider>,
  )
  return { onToast, onRefresh }
}

// ── fetch 桩（沿 T11 姿势）：history（TaskDetail 挂载即拉）/afk log（RunLogPane 轮询）/动作端点
//    （缺省 200 {ok:true}；actionResponse 可按 URL 正则改写；actionGate 挂手动结算的闸门制造
//    「在途」窗口）；automation（单 root 并发上限探测）；session-links（v9-J 批量预取）。──
let fetchLog: string[] = []
let logSeq = 0
let actionResponse: { match: RegExp; status: number; body: unknown } | null = null
let actionGate: Promise<void> | null = null
let automationSettings = { max_parallel: 4, max_retries: 1, default_opt_in: false, image: '' }
let sessionLinksResponse: { status: number; body: unknown } = { status: 200, body: { links: {} } }

beforeEach(() => {
  localStorage.setItem('tenon-dashboard-lang', 'zh')
  fetchLog = []
  logSeq = 0
  actionResponse = null
  actionGate = null
  automationSettings = { max_parallel: 4, max_retries: 1, default_opt_in: false, image: '' }
  sessionLinksResponse = { status: 200, body: { links: {} } }
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    fetchLog.push(`${init?.method ?? 'GET'} ${url}${typeof init?.body === 'string' ? ` ${init.body}` : ''}`)
    if (/\/api\/change\/[^/]+\/history\?root=/.test(url)) {
      return new Response(JSON.stringify({ entries: [] }), { status: 200 })
    }
    if (/\/api\/afk\/[^/]+\/log\?root=/.test(url)) {
      logSeq += 1
      return new Response(JSON.stringify({ log: `line ${logSeq}\n` }), { status: 200 })
    }
    if (/\/api\/automation\?root=/.test(url)) {
      return new Response(JSON.stringify({ ok: true, settings: automationSettings }), { status: 200 })
    }
    if (/\/api\/workflows\?root=/.test(url)) {
      return new Response(JSON.stringify({ names: [] }), { status: 200 })
    }
    if (/\/api\/mem\/session-links\?/.test(url)) {
      return new Response(JSON.stringify(sessionLinksResponse.body), { status: sessionLinksResponse.status })
    }
    if (actionGate) await actionGate
    if (actionResponse && actionResponse.match.test(url)) {
      return new Response(JSON.stringify(actionResponse.body), { status: actionResponse.status })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch
})

/** 点画布 change 小卡开抽屉并等待紧凑详情面板挂载。 */
async function openDrawer(name: string): Promise<void> {
  fireEvent.click(screen.getByTestId(`prg-cv-chg-${name}`))
  await waitFor(() => expect(screen.getByTestId('task-detail')).toBeInTheDocument())
}

/** 可控 matchMedia 桩（驱动 gsap.matchMedia 的 reduce / no-preference 两分支）。 */
function stubMatchMedia(reduceMatches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce')
      ? reduceMatches
      : query.includes('no-preference') && !reduceMatches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('prg9-lock')
  // gsap.ticker 跨全文件用例共享单例；每条用例后强制 sleep()+wake() 一次，用此刻真实定时器重搭
  // ticker 自驱循环，兜底清除 fake-timer 窗口可能引入的卡死（详见历史注释，勿删）。
  gsap.ticker.sleep()
  gsap.ticker.wake()
})

describe('ProgressView 单项目 · 下方在制列表退役（负向钉死不回归）', () => {
  it('页面按压缩包终稿拆成实时进度页头与独立筛选栏，创建入口仍在主视觉右侧', async () => {
    renderView()
    expect(screen.getByRole('heading', { name: '进度' })).toBeInTheDocument()
    expect(screen.getByTestId('progress-view')).toHaveAttribute('data-page-frame', 'standard')
    expect(screen.getByTestId('prg-hero')).toHaveTextContent('实时同步')
    expect(screen.getByTestId('prg-hero')).toHaveTextContent('创建')
    expect(screen.getByTestId('prg-hero')).not.toHaveTextContent('创建并锁定')
    expect(screen.getByTestId('prg-filterbar')).toHaveTextContent('等你动手')
    expect(screen.getByTestId('prg-hero')).not.toContainElement(screen.getByTestId('prg-filterbar'))
    expect(screen.getByTestId('prg-workflow-select')).toBeInTheDocument()
    expect(screen.getByTestId('progress-context')).toHaveTextContent('proj-a')
    expect(screen.getByTestId('progress-context')).toHaveTextContent('流程default')
    expect(screen.getByTestId('progress-context')).toHaveTextContent('方向chat')
    expect(screen.getByTestId('progress-context')).toHaveTextContent('任务afk-demo')
    await act(async () => {})
  })

  it('七阶段 workflow 使用独立横向阅读区，任务卡同时给出名称与人话状态', async () => {
    renderView()
    const viewport = screen.getByTestId('prg-cv-scroll-proj-a-default')
    expect(viewport).toBeInTheDocument()
    expect(viewport).toHaveAttribute('tabindex', '0')
    expect(viewport).toHaveAccessibleName('横向滚动查看后续阶段')
    expect(screen.queryByTestId('prg-cv-scroll-hint-proj-a-default')).toBeNull()
    expect(screen.getByTestId('prg-cv-chg-hotfix-login')).toHaveTextContent('失败')
    expect(screen.getByTestId('prg-cv-chg-afk-demo')).toHaveTextContent('运行中')
    await act(async () => {})
  })

  it('无 prg9-stack / prg9-row / prg9g-head / prg9-name / prg9-fold 等旧列表结构', async () => {
    renderView()
    expect(screen.queryByTestId('prg9-stack')).toBeNull()
    expect(document.querySelector('[data-testid^="prg9-row-"]')).toBeNull()
    expect(document.querySelector('[data-testid^="prg9g-head-"]')).toBeNull()
    expect(document.querySelector('[data-testid^="prg9g-group-"]')).toBeNull()
    expect(document.querySelector('[data-testid^="prg9-name-"]')).toBeNull()
    expect(document.querySelector('[data-testid^="prg9-fold-"]')).toBeNull()
    expect(document.querySelector('[data-testid^="prg9-rail-"]')).toBeNull()
    expect(document.querySelector('[data-testid^="prg9-cur-"]')).toBeNull()
    expect(document.querySelector('[data-testid^="prg9-time-"]')).toBeNull()
    // change 只挂在画布里（不在别处铺一遍）
    expect(screen.getByTestId('prg-cv-chg-gate-demo')).toBeInTheDocument()
    await act(async () => {})
  })
})

describe('ProgressView 状态页签（默认全部/计数=分类总数/等待中=queued+agent/筛选联动画布淡出）', () => {
  it('默认「全部」选中；四页签计数=分类总数（全部 6 / 等你动手 3 / 运行中 1 / 等待中 2）', async () => {
    renderView()
    const all = screen.getByTestId('prg9t-tab-all')
    expect(all.getAttribute('aria-selected')).toBe('true')
    expect(all.textContent).toContain('全部')
    expect(screen.getByTestId('prg9t-n-all').textContent).toBe('6')
    expect(screen.getByTestId('prg9t-n-need').textContent).toBe('3')
    expect(screen.getByTestId('prg9t-n-run').textContent).toBe('1')
    expect(screen.getByTestId('prg9t-n-queue').textContent).toBe('2')
    await act(async () => {})
  })

  it('切「运行中」：未命中卡保留上下文但不可交互或被辅助技术读取，并公开精确摘要', async () => {
    renderView()
    fireEvent.click(screen.getByTestId('prg9t-tab-run'))
    expect(screen.getByTestId('prg9t-tab-run').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('prg-cv-chg-afk-demo').getAttribute('data-dim')).toBeNull()
    for (const name of ['gate-demo', 'hotfix-login', 'board-demo', 'changelog-cn']) {
      const card = screen.getByTestId(`prg-cv-chg-${name}`)
      expect(card).toHaveAttribute('data-dim', 'true')
      expect(card).toBeDisabled()
      expect(card).toHaveAttribute('aria-hidden', 'true')
    }
    expect(screen.getByTestId('prg-filter-status')).toHaveTextContent('匹配 1 个 · 上下文 5 个')
    expect(screen.getByTestId('prg9t-n-all').textContent).toBe('6')
    expect(screen.getByTestId('prg9t-n-need').textContent).toBe('3')
    await act(async () => {})
  })

  it('scheduled 折叠进 running 态归「运行中」页签（同源谓词）', async () => {
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [
          makeChange('sched-demo', 'build', { fields: { automation: 'scheduled' } }),
          makeChange('idle-demo', 'spec', {}),
        ]),
      ]),
    })
    expect(screen.getByTestId('prg9t-n-run').textContent).toBe('1')
    fireEvent.click(screen.getByTestId('prg9t-tab-run'))
    expect(screen.getByTestId('prg-cv-chg-sched-demo').getAttribute('data-dim')).toBeNull()
    expect(screen.getByTestId('prg-cv-chg-idle-demo')).toHaveAttribute('data-dim', 'true')
    await act(async () => {})
  })

  it('空列表不出页签条/wf pills/画布（空态指向终端）', async () => {
    renderView({ snapshot: makeSnapshot([makeProject(ROOT_A, [])]) })
    expect(screen.queryByTestId('prg9t-tabs')).toBeNull()
    expect(screen.queryByTestId('prg-wfpills')).toBeNull()
    expect(screen.queryByTestId('prg-canvas')).toBeNull()
    expect(screen.getByTestId('prg-empty')).toHaveAttribute('role', 'status')
    await act(async () => {})
  })

  it('加载、错误与空态都公开给辅助技术', () => {
    const { rerender } = render(
      <I18nProvider>
        <ProgressView snapshot={null} loading error={null} currentRoot={ROOT_A} rulesByKey={makeRules()} />
      </I18nProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('加载中')
    rerender(
      <I18nProvider>
        <ProgressView snapshot={null} loading={false} error="连接失败" currentRoot={ROOT_A} rulesByKey={makeRules()} />
      </I18nProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('连接失败')
  })
})

// ── 画布 v3（单项目地铁站台）：一 workflow 一组；有在制的相位=站台卡、空相位=过路小站；
//    change 小卡=FlatRow 同源判定；sched 图标 lucide；AFK/沙箱区分；连线纯 CSS。──
describe('ProgressView 相位画布（画布 v3 WorkflowCanvas 集成）', () => {
  it('英文下 default workflow 使用 phases.*，custom workflow 保留作者标签', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const snapshot = makeFixture()
    renderView({
      snapshot,
      rulesByKey: workflowRulesFromSnapshot(snapshot),
    })
    await act(async () => {})

    const verifyNode = screen.getByTestId('prg-cv-node-proj-a-default-verify')
    expect(verifyNode).toHaveTextContent('Verify')
    expect(verifyNode).not.toHaveTextContent('验证')
    expect(screen.getByTestId('prg-cv-node-proj-a-release-train-review')).toHaveTextContent('人工复核')

    await openDrawer('gate-demo')
    expect(screen.getByTestId('prg9-dw-pass-gate-demo')).toHaveTextContent('Approve into Ship')
    expect(screen.getByTestId('prg9-dw-reject-gate-demo')).toHaveTextContent('Build')
    fireEvent.keyDown(document, { key: 'Escape' })

    await openDrawer('afk-demo')
    expect(screen.getByTestId('prg9-dw-badge')).toHaveTextContent('Running Build')
    fireEvent.keyDown(document, { key: 'Escape' })

    await openDrawer('changelog-cn')
    expect(screen.getByTestId('prg9-dw-pass-changelog-cn')).toHaveTextContent('Approve into 发布')
  })

  it('分组（default 7 站、release-train 3 站）：相位名走 stepLabel；门徽章来自 rules；空相位收过路小站', async () => {
    renderView()
    await act(async () => {})
    expect(screen.getByTestId('prg-canvas')).toBeInTheDocument()
    const groupDefault = screen.getByTestId('prg-cv-group-proj-a-default')
    expect(groupDefault.querySelectorAll('[data-anim="prg-node"]')).toHaveLength(7)
    const groupRt = screen.getByTestId('prg-cv-group-proj-a-release-train')
    expect(groupRt.querySelectorAll('[data-anim="prg-node"]')).toHaveLength(3)
    // 相位名走 stepLabel：default 走 phases.* i18n；自定义走用户 label（不泄露 step id）
    const verifyNode = screen.getByTestId('prg-cv-node-proj-a-default-verify')
    expect(verifyNode.textContent).toContain('验证')
    expect(screen.getByTestId('prg-cv-node-proj-a-release-train-review').textContent).toContain('人工复核')
    // 门来自 rules.gateByStep（default 的 verify 是 review 门），终稿把 gate 语义挂到统一进度节点的 title/aria。
    expect(verifyNode.textContent).not.toContain('review 门')
    expect(screen.getByTestId('prg-cv-stage-proj-a-default-verify')).toHaveAttribute('aria-label', 'review 门')
    expect(screen.queryByTestId('prg-cv-gate-proj-a-default-build')).toBeNull()
    // 有在制的相位=站台卡；verify 站台挂 gate-demo 小卡
    expect(verifyNode).toHaveAttribute('data-kind', 'card')
    expect(within(verifyNode).getByTestId('prg-cv-chg-gate-demo')).toBeInTheDocument()
    expect(within(verifyNode).getByTitle('1 项流程中')).toBeInTheDocument()
    // 空相位=过路小站（大空卡与「—」占位退役）
    const shipNode = screen.getByTestId('prg-cv-node-proj-a-default-ship')
    expect(shipNode).toHaveAttribute('data-kind', 'stop')
    expect(shipNode.textContent).not.toContain('—')
  })

  it('running 站台 data-run；running 小卡状态点 data-pulse；连线纯 CSS（无 bezier svg，仅 lucide 图标 svg）', async () => {
    renderView()
    await act(async () => {})
    expect(screen.getByTestId('prg-cv-node-proj-a-default-build')).toHaveAttribute('data-run', 'true')
    expect(screen.getByTestId('prg-cv-node-proj-a-default-verify').getAttribute('data-run')).toBeNull()
    const chip = screen.getByTestId('prg-cv-chg-afk-demo')
    expect(chip).toHaveAttribute('data-state', 'running')
    expect(chip.querySelector('[data-pulse="true"]')).not.toBeNull()
    // 连线纯 CSS：画布内唯一的 svg 是 change 小卡的 lucide sched 图标（贝塞尔/rAF/ResizeObserver 退役）
    for (const svg of Array.from(screen.getByTestId('prg-canvas').querySelectorAll('svg'))) {
      expect(svg.getAttribute('class') ?? '').toContain('lucide')
    }
  })

  it('change 小卡状态点语义（data-state 同源）：gate 绿=gateok/自定义门红=gatejudge/failed/queued/agent', async () => {
    renderView()
    await act(async () => {})
    expect(screen.getByTestId('prg-cv-chg-gate-demo')).toHaveAttribute('data-state', 'gateok')
    expect(screen.getByTestId('prg-cv-chg-changelog-cn')).toHaveAttribute('data-state', 'gatejudge')
    expect(screen.getByTestId('prg-cv-chg-hotfix-login')).toHaveAttribute('data-state', 'failed')
    expect(screen.getByTestId('prg-cv-chg-board-demo')).toHaveAttribute('data-state', 'queued')
    expect(screen.getByTestId('prg-cv-chg-triage-demo')).toHaveAttribute('data-state', 'agent')
  })

  it('AFK/沙箱区分：running/queued/failed=沙箱（data-sbx + lucide-coffee）；gate/agent=终端（lucide-terminal）', async () => {
    renderView()
    await act(async () => {})
    for (const name of ['afk-demo', 'board-demo', 'hotfix-login']) {
      const chip = screen.getByTestId(`prg-cv-chg-${name}`)
      expect(chip).toHaveAttribute('data-sbx', 'true')
      expect(chip.querySelector('svg.lucide-coffee')).not.toBeNull()
      expect(chip.textContent).not.toContain('▦')
    }
    for (const name of ['gate-demo', 'triage-demo', 'changelog-cn']) {
      const chip = screen.getByTestId(`prg-cv-chg-${name}`)
      expect(chip.getAttribute('data-sbx')).toBeNull()
      expect(chip.querySelector('svg.lucide-terminal')).not.toBeNull()
      expect(chip.textContent).not.toContain('⌨')
    }
  })

  it('正常 Codex 会话的显式新鲜心跳 → 运行中页签，但仍标为终端且不给 AFK 日志/终止按钮', async () => {
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [
          makeChange('codex-live', 'build', {
            fields: { automation: 'off' },
            terminalActivity: {
              sessionId: '019f92c7-6e66-7290-9352-f9d915266f14',
              heartbeatAt: '2026-07-24T06:00:00.000Z',
              expiresAt: '2026-07-24T06:02:00.000Z',
            },
          }),
        ]),
      ]),
    })
    expect(screen.getByTestId('prg9t-n-run').textContent).toBe('1')
    fireEvent.click(screen.getByTestId('prg9t-tab-run'))
    const chip = screen.getByTestId('prg-cv-chg-codex-live')
    expect(chip).toHaveAttribute('data-state', 'running')
    expect(chip.getAttribute('data-sbx')).toBeNull()
    expect(chip.querySelector('svg.lucide-terminal')).not.toBeNull()
    expect(chip).toHaveTextContent('终端运行中')
    expect(chip).not.toHaveTextContent('自动运行中')

    await openDrawer('codex-live')
    expect(screen.getByTestId('prg9-dw-badge')).toHaveAttribute('data-tone', 'blue')
    expect(screen.queryByTestId('prg9-dw-kill-codex-live')).toBeNull()
    expect(screen.queryByTestId('prg-log-codex-live')).toBeNull()
  })

  it('change 名称完整渲染（禁 ellipsis）；单项目语境无项目缩写 chip', async () => {
    const longName = 'refactor-legacy-payment-gateway-reconciliation-pipeline-v2'
    renderView({
      snapshot: makeSnapshot([makeProject(ROOT_A, [makeChange(longName, 'build', {})])]),
    })
    await act(async () => {})
    const card = screen.getByTestId(`prg-cv-chg-${longName}`)
    const nameEl = within(card).getByText(longName)
    expect(nameEl.textContent).toBe(longName)
    expect(nameEl.className).not.toContain('truncate')
    expect(card.textContent).not.toContain('proj-a')
  })

  it('小卡点击=开抽屉（openDrawer 管线）；抽屉开着时小卡 data-on 选中', async () => {
    renderView()
    fireEvent.click(screen.getByTestId('prg-cv-chg-gate-demo'))
    await waitFor(() => expect(screen.getByTestId('task-detail')).toBeInTheDocument())
    expect(screen.getByTestId('prg9-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('prg-cv-chg-gate-demo')).toHaveAttribute('data-on', 'true')
  })
})

// ── 归档不失联：带归档的相位小站「N 项已归档」可点开只读名单（画布内自持折叠）。fixture 唯一
//    的 archived=old-demo（default·archive 相位）。──
describe('ProgressView 归档入口可达（画布相位小站只读折叠）', () => {
  it('archive 相位小站带「1 项已归档」；点开 → 只读列出 old-demo；再点收起', async () => {
    renderView()
    await act(async () => {})
    const archNode = screen.getByTestId('prg-cv-node-proj-a-default-archive')
    expect(archNode).toHaveAttribute('data-kind', 'stop')
    const toggle = screen.getByTestId('prg-cv-arch-toggle-proj-a-default-archive')
    expect(toggle.textContent).toContain('1 项已归档')
    expect(screen.queryByTestId('prg-cv-arch-chg-old-demo')).toBeNull()
    fireEvent.click(toggle)
    const panel = screen.getByTestId('prg-cv-arch-panel-proj-a-default-archive')
    expect(within(panel).getByTestId('prg-cv-arch-chg-old-demo').textContent).toContain('old-demo')
    // 只读：归档条目不是按钮（不开抽屉）
    expect(within(panel).queryAllByRole('button')).toHaveLength(0)
    fireEvent.click(toggle)
    expect(screen.queryByTestId('prg-cv-arch-panel-proj-a-default-archive')).toBeNull()
  })
})

// ── workflow 筛选下拉：工作流增多时仍保持单一紧凑控件；
//    筛选作用于画布分组；页签计数=分类总数不随 wf 筛选变。──
describe('ProgressView workflow 筛选下拉', () => {
  it('选项=全部工作流 + default + release-train；默认「全部」', async () => {
    renderView()
    await act(async () => {})
    const select = screen.getByTestId('prg-workflow-select')
    expect(select).toHaveValue('all')
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['全部工作流', 'default', 'release-train'])
    expect(screen.queryByTestId('prg-wfpills')).toBeNull()
  })

  it('选 release-train：画布只剩该组，页签徽标保持全局而状态摘要只统计当前画布', async () => {
    renderView()
    await act(async () => {})
    fireEvent.change(screen.getByTestId('prg-workflow-select'), { target: { value: 'release-train' } })
    expect(screen.getByTestId('prg-workflow-select')).toHaveValue('release-train')
    expect(screen.queryByTestId('prg-cv-group-proj-a-default')).toBeNull()
    expect(screen.getByTestId('prg-cv-group-proj-a-release-train')).toBeInTheDocument()
    expect(screen.getByTestId('prg9t-n-all').textContent).toBe('6')
    fireEvent.click(screen.getByTestId('prg9t-tab-run'))
    expect(screen.getByTestId('prg9t-n-run').textContent).toBe('1')
    expect(screen.getByTestId('prg-filter-status')).toHaveTextContent('匹配 0 个 · 上下文 1 个')
    fireEvent.change(screen.getByTestId('prg-workflow-select'), { target: { value: 'all' } })
    expect(screen.getByTestId('prg-cv-group-proj-a-default')).toBeInTheDocument()
  })
})

describe('ProgressView 判定徽章（抽屉 dw-badge；rowSemantics 同源不漂移）', () => {
  it('gate 证据齐 → 绿「可以放行」且用结构化图标表达（data-tone）', async () => {
    renderView()
    await openDrawer('gate-demo')
    const badge = screen.getByTestId('prg9-dw-badge')
    expect(badge.textContent).toContain('可以放行')
    expect(badge.textContent).not.toContain('✓')
    expect(badge.querySelector('svg')).not.toBeNull()
    expect(badge).toHaveAttribute('data-tone', 'green')
  })

  it('自定义门无自动证据 → 红「等你判断」', async () => {
    renderView()
    await openDrawer('changelog-cn')
    const badge = screen.getByTestId('prg9-dw-badge')
    expect(badge.textContent).toContain('等你判断')
    expect(badge).toHaveAttribute('data-tone', 'red')
  })

  it('失败行 → 红「失败 ×3 · 等你决定」；running=蓝「{相位}运行中」；排队=中性；等产出点名缺 plan', async () => {
    renderView()
    await openDrawer('hotfix-login')
    expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('失败 ×3 · 等你决定')
    expect(screen.getByTestId('prg9-dw-badge')).toHaveAttribute('data-tone', 'red')
    fireEvent.keyDown(document, { key: 'Escape' })
    await openDrawer('afk-demo')
    expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('实现运行中')
    expect(screen.getByTestId('prg9-dw-badge')).toHaveAttribute('data-tone', 'blue')
    fireEvent.keyDown(document, { key: 'Escape' })
    await openDrawer('board-demo')
    expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('排队')
    fireEvent.keyDown(document, { key: 'Escape' })
    await openDrawer('triage-demo')
    expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('等产出 · 缺 plan')
  })

  it('cancelled（人为终止）→ 琥珀「已取消」；画布小卡 data-state=cancelled', async () => {
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [
          makeChange('cancel-me', 'build', {
            fields: { automation: 'failed', automation_attempts: '1', automation_cause: 'cancelled' },
          }),
        ]),
      ]),
    })
    expect(screen.getByTestId('prg-cv-chg-cancel-me')).toHaveAttribute('data-state', 'cancelled')
    await openDrawer('cancel-me')
    const badge = screen.getByTestId('prg9-dw-badge')
    expect(badge.textContent).toContain('已取消')
    expect(badge).toHaveAttribute('data-tone', 'amb')
  })
})

describe('ProgressView 抽屉动作：放行/打回 = transition 管线', () => {
  it('revision blocker disables exact Verify success while retaining ready rollback and remediation details', async () => {
    const stateHash = `sha256:${'a'.repeat(64)}`
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [makeChange('revision-blocked', 'verify', {
          fields: { verification_report: 'docs/v.md', branch_status: 'handled', agent_review_result: 'pass', codex_review_result: 'pass' },
          workflowExecution: {
            readinessByTransition: {
              verify: {
                'verify-pass': {
                  ready: false,
                  blockers: [{
                    kind: 'verify-build-revision-untrusted',
                    code: 'verify-build-revision-untrusted',
                    reason: 'revision-stale',
                    remediation: 'return-to-build-and-capture-current-revision',
                    stateHash,
                  }],
                },
                'verify-fail': { ready: true, blockers: [] },
              },
            },
          },
        })]),
      ]),
    })
    await openDrawer('revision-blocked')
    const pass = screen.getByTestId('prg9-dw-pass-revision-blocked')
    expect(pass).toBeDisabled()
    expect(screen.getByTestId('prg9-dw-reject-revision-blocked')).toBeEnabled()
    const note = screen.getByTestId('prg9-note-revision-blocked')
    expect(note).toHaveTextContent('verify-build-revision-untrusted')
    expect(note).toHaveTextContent('reason=revision-stale')
    expect(note).toHaveTextContent('remediation=return-to-build-and-capture-current-revision')
    fireEvent.click(screen.getByTestId('prg9-dw-reject-revision-blocked'))
    await waitFor(() => expect(fetchLog.some((l) => l.includes('"event":"verify-fail"'))).toBe(true))
  })

  it('放行钮带目标相位（放行进入 交付）→ POST transition（verify-pass）+ 乐观推进 + toast + onRefresh', async () => {
    const { onToast, onRefresh } = renderView()
    await openDrawer('gate-demo')
    const pass = screen.getByTestId('prg9-dw-pass-gate-demo')
    expect(pass.textContent).toContain('放行进入 交付')
    fireEvent.click(pass)
    await waitFor(() => {
      expect(fetchLog.some((l) => l.startsWith('POST /api/change/gate-demo/transition') && l.includes('"event":"verify-pass"') && l.includes(ROOT_A))).toBe(true)
    })
    // 乐观更新：phase verify→ship，抽屉徽章离开「可以放行」变「等产出」
    await waitFor(() => {
      expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('等产出')
    })
    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('已提交'))
  })

  it('打回 → POST transition（verify-fail 回退边）+ 乐观回退', async () => {
    renderView()
    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('prg9-dw-reject-gate-demo'))
    await waitFor(() => {
      expect(fetchLog.some((l) => l.startsWith('POST /api/change/gate-demo/transition') && l.includes('"event":"verify-fail"'))).toBe(true)
    })
    await waitFor(() => {
      expect(screen.getByTestId('prg9-dw-badge').textContent).not.toContain('可以放行')
    })
  })

  /** multi-edge fixture：单行 multi-demo 停在 review 复核门。 */
  function renderMultiEdge(): ReturnType<typeof renderView> {
    return renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [makeChange('multi-demo', 'review', {
          fields: { workflow: 'multi-edge' },
          workflowRules: MULTI_EDGE_SNAPSHOT_RULES,
          workflowExecution: readyWorkflowExecution(MULTI_EDGE_SNAPSHOT_RULES),
          reviewHandshake: {
            status: 'pending',
            event: 'fast-track',
            requestedAt: '2026-07-30T02:00:00Z',
          },
        })]),
      ]),
      rulesByKey: new Map([[rulesKey(ROOT_A, 'multi-edge'), MULTI_EDGE_RULES]]),
    })
  }

  it('2+ 条同向出边一条不落（评审 P1-1）：首选前进边带目标相位，第 2 条以事件名可点、POST 事件正确', async () => {
    renderMultiEdge()
    await openDrawer('multi-demo')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-outputs'))
    await waitFor(() => expect(screen.getByTestId('review-handshake-status')).toBeInTheDocument())
    expect(screen.getByTestId('review-handshake-status')).toHaveTextContent('等待明确确认')
    expect(within(screen.getByTestId('review-handshake-status')).getByText('fast-track'))
      .toBeInTheDocument()
    expect(screen.getByTestId('prg9-dw-pass-multi-demo').textContent).toContain('放行进入 发布')
    const second = screen.getByTestId('prg9-dw-fw-fast-track-multi-demo')
    expect(second.textContent).toContain('fast-track')
    expect(screen.getByTestId('prg9-dw-reject-multi-demo').textContent).toContain('分诊')
    fireEvent.click(second)
    await waitFor(() => {
      expect(fetchLog.some((l) => l.startsWith('POST /api/change/multi-demo/transition') && l.includes('"event":"fast-track"'))).toBe(true)
    })
  })

  it('review→review 乐观推进立即消费旧 exact-event receipt，不把 explore 回执显示到 spec', async () => {
    actionGate = new Promise(() => {})
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [makeChange('review-chain-demo', 'explore', {
          fields: { workflow: 'review-chain' },
          workflowRules: REVIEW_CHAIN_SNAPSHOT_RULES,
          workflowExecution: readyWorkflowExecution(REVIEW_CHAIN_SNAPSHOT_RULES),
          reviewHandshake: {
            status: 'approved',
            event: 'explore-complete',
            requestedAt: '2026-07-30T02:00:00Z',
            acknowledgedAt: '2026-07-30T02:01:00Z',
          },
        })]),
      ]),
      rulesByKey: new Map([[rulesKey(ROOT_A, 'review-chain'), REVIEW_CHAIN_RULES]]),
    })
    await openDrawer('review-chain-demo')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-outputs'))
    await waitFor(() => expect(screen.getByTestId('review-handshake-status')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('prg9-dw-pass-review-chain-demo'))

    await waitFor(() => {
      expect(screen.getByTestId('review-handshake-status')).toHaveTextContent('尚未记录复核请求')
    })
    expect(screen.queryByText('explore-complete')).not.toBeInTheDocument()
  })

  it('旧 runtime 缺 handshake capability 时，review→review 乐观推进仍保持 unavailable', async () => {
    actionGate = new Promise(() => {})
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [makeChange('old-runtime-review-chain', 'explore', {
          fields: { workflow: 'review-chain' },
          workflowRules: REVIEW_CHAIN_SNAPSHOT_RULES,
          workflowExecution: readyWorkflowExecution(REVIEW_CHAIN_SNAPSHOT_RULES),
        })]),
      ]),
      rulesByKey: new Map([[rulesKey(ROOT_A, 'review-chain'), REVIEW_CHAIN_RULES]]),
    })
    await openDrawer('old-runtime-review-chain')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-outputs'))
    await waitFor(() => expect(screen.getByTestId('review-handshake-status')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('prg9-dw-pass-old-runtime-review-chain'))

    await waitFor(() => {
      expect(screen.getByTestId('review-handshake-status')).toHaveTextContent('复核状态不可用')
    })
    expect(screen.queryByText('尚未记录复核请求')).not.toBeInTheDocument()
  })

  it('transition 失败 → 失败 toast（透传 server error）+ 乐观回滚 + 不触发 onRefresh', async () => {
    actionResponse = { match: /\/transition$/, status: 400, body: { ok: false, error: 'guard 拒绝：verification_report 未产出' } }
    const { onToast, onRefresh } = renderView()
    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('prg9-dw-pass-gate-demo'))
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining('guard 拒绝'))
    })
    expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('可以放行')
    expect(onRefresh).not.toHaveBeenCalled()
  })
})

describe('ProgressView 抽屉动作：终止 = afk 端点', () => {
  it('终止（running 行）→ POST /api/afk/:name/cancel（body 带 root）+ toast', async () => {
    const { onToast, onRefresh } = renderView()
    await openDrawer('afk-demo')
    fireEvent.click(screen.getByTestId('prg9-dw-kill-afk-demo'))
    await waitFor(() => {
      expect(fetchLog.some((l) => l.startsWith('POST /api/afk/afk-demo/cancel') && l.includes(ROOT_A))).toBe(true)
    })
    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('已提交'))
  })

  it('终止钮仅 automation===running 可点：scheduled 渲染禁用态（cancel-gate 纪律）', async () => {
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [makeChange('sched-demo', 'build', { fields: { automation: 'scheduled' } })]),
      ]),
    })
    await openDrawer('sched-demo')
    expect(screen.getByTestId('prg9-dw-kill-sched-demo')).toBeDisabled()
  })

  it('automation runner 与 terminal heartbeat 同时存在时仍保留真实 AFK cancel', async () => {
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [makeChange('mixed-runner', 'build', {
          fields: { automation: 'running' },
          terminalActivity: {
            sessionId: '019f92c7-6e66-7290-9352-f9d915266f14',
            heartbeatAt: '2026-07-24T06:00:00.000Z',
            expiresAt: '2026-07-24T06:02:00.000Z',
          },
        })]),
      ]),
    })
    await openDrawer('mixed-runner')
    expect(screen.getByTestId('prg9-dw-kill-mixed-runner')).toBeEnabled()
  })

  it('排队/等产出行抽屉无放行/终止/命令钮（能力面之外不给按钮）', async () => {
    renderView()
    await openDrawer('board-demo')
    expect(screen.queryByTestId('prg9-dw-pass-board-demo')).toBeNull()
    expect(screen.queryByTestId('prg9-dw-kill-board-demo')).toBeNull()
    expect(screen.queryByTestId('prg9-dw-cmd-board-demo')).toBeNull()
  })
})

/**
 * 真机验收 G：不在进度上点重试/放弃——给可拷贝的终端命令 chip（回终端在抽屉内：作为显眼一键
 * 恢复 CTA；TaskDetail 另有完整连接现场命令卡兜底）。v9-J 批量预取命中真恢复会话则优先真命令。
 */
describe('ProgressView 失败/取消行：回终端命令 chip（抽屉内）', () => {
  function stubClipboard(): ReturnType<typeof vi.fn> {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    return writeText
  }

  it('失败行（无 worktree）抽屉 chip=「重跑命令」tenon afk enqueue，点击拷贝 + toast，不打 afk 端点；无重试/放弃钮', async () => {
    const writeText = stubClipboard()
    const { onToast } = renderView()
    await openDrawer('hotfix-login')
    expect(screen.queryByTestId('prg9-dw-retry-hotfix-login')).toBeNull()
    expect(screen.queryByTestId('prg9-dw-dismiss-hotfix-login')).toBeNull()
    const chip = screen.getByTestId('prg9-dw-cmd-hotfix-login')
    expect(chip.textContent).toContain('重跑命令')
    expect(chip.textContent).toContain('tenon afk enqueue hotfix-login')
    expect(chip.getAttribute('title')).toBe('tenon afk enqueue hotfix-login')
    fireEvent.click(chip)
    expect(writeText).toHaveBeenCalledWith('tenon afk enqueue hotfix-login')
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining('tenon afk enqueue hotfix-login'))
    })
    expect(fetchLog.some((l) => l.includes('/api/afk/hotfix-login/'))).toBe(false)
  })

  it('命令复制晚到且期间切为英文时，toast 使用当前语言', async () => {
    let releaseCopy!: () => void
    const writeText = vi.fn(() => new Promise<void>((resolve) => { releaseCopy = resolve }))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { onToast } = renderView()
    await openDrawer('hotfix-login')

    fireEvent.click(screen.getByTestId('prg9-dw-cmd-hotfix-login'))
    fireEvent.click(screen.getByTestId('progress-language-en'))
    releaseCopy()

    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Copied: tenon afk enqueue hotfix-login'))
  })

  it('失败行（有 worktree 现场）抽屉 chip=「在终端接管」，拷贝值走 shellQuote（含空格单引号安全转义）', async () => {
    const writeText = stubClipboard()
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [
          makeChange('wt-fail', 'build', {
            fields: { automation: 'failed', automation_attempts: '2', automation_worktree: '/tmp/wt/wt-fail' },
          }),
        ]),
      ]),
    })
    await openDrawer('wt-fail')
    const chip = screen.getByTestId('prg9-dw-cmd-wt-fail')
    expect(chip.textContent).toContain('在终端接管')
    expect(chip.getAttribute('title')).toBe('cd /tmp/wt/wt-fail')
    fireEvent.click(chip)
    expect(writeText).toHaveBeenCalledWith('cd /tmp/wt/wt-fail')
  })

  it('取消行（cause=cancelled）抽屉 chip=「重新跑的命令」tenon afk enqueue（worktree 现场不参与）', async () => {
    const writeText = stubClipboard()
    renderView({
      snapshot: makeSnapshot([
        makeProject(ROOT_A, [
          makeChange('cancel-me', 'build', {
            fields: {
              automation: 'failed', automation_attempts: '1', automation_cause: 'cancelled',
              automation_worktree: '/tmp/wt/cancel-me',
            },
          }),
        ]),
      ]),
    })
    await openDrawer('cancel-me')
    const chip = screen.getByTestId('prg9-dw-cmd-cancel-me')
    expect(chip.textContent).toContain('重新跑的命令')
    fireEvent.click(chip)
    expect(writeText).toHaveBeenCalledWith('tenon afk enqueue cancel-me')
  })

  it('v9-J：session-link 批量命中真恢复命令 → 抽屉 chip 显示/拷贝真命令，不是 tenon afk enqueue 兜底', async () => {
    const writeText = stubClipboard()
    const resumeCmd = 'cd /tmp/wt/hotfix-login && claude --resume abcd-1234'
    sessionLinksResponse = {
      status: 200,
      body: { links: { [`hotfix-login@${ROOT_A}`]: { found: true, platform: 'claude', sessionId: 'abcd-1234', resumeCmd } } },
    }
    renderView()
    // 预取在挂载即发（不依赖抽屉），等它落地后再开抽屉断言 chip 升级为真命令
    await waitFor(() => expect(fetchLog.some((l) => l.includes('/api/mem/session-links'))).toBe(true))
    await openDrawer('hotfix-login')
    const chip = screen.getByTestId('prg9-dw-cmd-hotfix-login')
    await waitFor(() => expect(chip.textContent).toContain(resumeCmd))
    expect(chip.textContent).toContain('恢复会话')
    expect(chip.textContent).not.toContain('tenon afk enqueue hotfix-login')
    fireEvent.click(chip)
    expect(writeText).toHaveBeenCalledWith(resumeCmd)
  })

  it('v9-J：session-link 查无（found:false）→ 抽屉 chip 落回静态命令（不回归）', async () => {
    sessionLinksResponse = {
      status: 200,
      body: { links: { [`hotfix-login@${ROOT_A}`]: { found: false, reason: 'no-session' } } },
    }
    renderView()
    await openDrawer('hotfix-login')
    const chip = screen.getByTestId('prg9-dw-cmd-hotfix-login')
    expect(chip.textContent).toContain('重跑命令')
    expect(chip.textContent).toContain('tenon afk enqueue hotfix-login')
  })

  it('v9-J：session-links 端点整体失败（非 2xx）→ fail-open，chip 仍落回静态命令（不炸视图）', async () => {
    sessionLinksResponse = { status: 500, body: { ok: false } }
    renderView()
    await openDrawer('hotfix-login')
    const chip = screen.getByTestId('prg9-dw-cmd-hotfix-login')
    expect(chip.textContent).toContain('重跑命令')
    expect(chip.textContent).toContain('tenon afk enqueue hotfix-login')
  })
})

describe('ProgressView 详情抽屉（画布卡点开右滑）', () => {
  it('点小卡开抽屉：scrim+drawer、TaskDetail、动作 dw- 前缀、滚动锁', async () => {
    renderView()
    await openDrawer('gate-demo')
    expect(screen.getByTestId('prg9-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('prg9-scrim')).toBeInTheDocument()
    expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('可以放行')
    expect(screen.getByTestId('prg9-dw-pass-gate-demo').textContent).toContain('放行进入 交付')
    expect(screen.getByTestId('prg9-dw-reject-gate-demo')).toBeInTheDocument()
    expect(screen.getByTestId('progress-sheet-tab-summary')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('detail-technical')).toBeNull()
    fireEvent.click(screen.getByTestId('progress-sheet-tab-history'))
    expect(screen.getByTestId('progress-sheet-tab-history')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    expect(document.documentElement.classList.contains('prg9-lock')).toBe(true)
  })

  it('抽屉三条退路：Esc / scrim / 关闭钮；关闭解除滚动锁', async () => {
    renderView()
    await openDrawer('gate-demo')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('prg9-drawer')).toBeNull()
    expect(document.documentElement.classList.contains('prg9-lock')).toBe(false)

    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('prg9-scrim'))
    expect(screen.queryByTestId('prg9-drawer')).toBeNull()

    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('detail-close'))
    expect(screen.queryByTestId('prg9-drawer')).toBeNull()
    expect(document.documentElement.classList.contains('prg9-lock')).toBe(false)
  })

  it('嵌套证据 composer 的 Escape 只关闭内层并把焦点归还入口', async () => {
    const snapshot = makeFixture()
    const change = snapshot.projects[0]?.changes.find((item) => item.name === 'gate-demo')
    if (!change) throw new Error('gate-demo fixture missing')
    change.documents = {
      governed: true,
      pass: true,
      blockers: [],
      items: [],
    }
    renderView({ snapshot })
    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-outputs'))
    const opener = await screen.findByTestId('evidence-compose-open')
    fireEvent.click(opener)
    expect(screen.getByTestId('evidence-compose-dialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByTestId('evidence-compose-dialog')).toBeNull()
    expect(screen.getByTestId('prg9-drawer')).toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('嵌套证据 composer 通过 body portal 覆盖抽屉外区域且关闭后保留草稿', async () => {
    const snapshot = makeFixture()
    const change = snapshot.projects[0]?.changes.find((item) => item.name === 'gate-demo')
    if (!change) throw new Error('gate-demo fixture missing')
    change.documents = {
      governed: true,
      pass: true,
      blockers: [],
      items: [],
    }
    renderView({ snapshot })
    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-outputs'))
        await waitFor(() => expect(screen.getByTestId('progress-sheet-panel')).toHaveAttribute('id', 'progress-sheet-panel'))
    fireEvent.click(screen.getByTestId('evidence-compose-open'))
    const dialog = screen.getByTestId('evidence-compose-dialog')

    expect(dialog.parentElement).toBe(document.body)

    fireEvent.click(screen.getByTestId('evidence-add-entry'))
    fireEvent.change(screen.getByTestId('evidence-title-1'), {
      target: { value: 'DRAFT_MUST_SURVIVE' },
    })
    fireEvent.click(dialog)

    expect(screen.queryByTestId('evidence-compose-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('prg9-drawer')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('evidence-compose-open'))
    expect(screen.getByTestId('evidence-title-1')).toHaveValue('DRAFT_MUST_SURVIVE')
  })

  it.each([
    ['build', false],
    ['verify', true],
  ] as const)('证据 composer phase gate：%s 阶段可见=%s', async (phase, visible) => {
    const snapshot = makeFixture()
    const change = snapshot.projects[0]?.changes.find((item) => item.name === 'gate-demo')
    if (!change) throw new Error('gate-demo fixture missing')
    change.phase = phase
    change.documents = {
      governed: true,
      pass: true,
      blockers: [],
      items: [],
    }

    renderView({ snapshot })
    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-outputs'))

    if (visible) {
      expect(await screen.findByTestId('evidence-compose-open')).toBeVisible()
    } else {
      expect(screen.queryByTestId('evidence-compose-open')).not.toBeInTheDocument()
    }
  })

  it('非文档治理 workflow 的真实 Verify 阶段仍显示证据 composer', async () => {
    const snapshot = makeFixture()
    const change = snapshot.projects[0]?.changes.find((item) => item.name === 'gate-demo')
    if (!change) throw new Error('gate-demo fixture missing')
    change.phase = 'verify'
    change.documents = {
      governed: false,
      blockers: [],
      items: [],
    }

    renderView({ snapshot })
    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-outputs'))

    expect(await screen.findByTestId('evidence-compose-open')).toBeVisible()
    expect(screen.queryByTestId('dt-documents')).not.toBeInTheDocument()
  })

  it('嵌套证据 composer 的正向 Tab 从末元素回绕到内层首元素', async () => {
    const snapshot = makeFixture()
    const change = snapshot.projects[0]?.changes.find((item) => item.name === 'gate-demo')
    if (!change) throw new Error('gate-demo fixture missing')
    change.documents = {
      governed: true,
      pass: true,
      blockers: [],
      items: [],
    }
    renderView({ snapshot })
    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-outputs'))
    fireEvent.click(await screen.findByTestId('evidence-compose-open'))
    const dialog = screen.getByTestId('evidence-compose-dialog')
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    expect(first).toBeDefined()
    expect(last).toBeDefined()
    last!.focus()

    fireEvent.keyDown(document, { key: 'Tab' })

    expect(document.activeElement).toBe(first)
    expect(screen.getByTestId('detail-close')).not.toHaveFocus()
  })

  it('running 行抽屉：TaskDetail 之下挂日志区，2.5s 轮询；抽屉关闭即停（组件卸载）', async () => {
    vi.useFakeTimers()
    renderView()
    fireEvent.click(screen.getByTestId('prg-cv-chg-afk-demo'))
    await act(async () => {})
    const drawer = screen.getByTestId('prg9-drawer')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-terminal'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(within(drawer).getByTestId('prg-log-afk-demo')).toBeInTheDocument()
    expect(screen.getByTestId('prg-logtext-afk-demo').textContent).toContain('line 1')
    await act(async () => {
      vi.advanceTimersByTime(AFK_LOG_POLL_INTERVAL_MS)
    })
    await act(async () => {})
    expect(screen.getByTestId('prg-logtext-afk-demo').textContent).toContain('line 2')
    fireEvent.keyDown(document, { key: 'Escape' })
    const logCalls = fetchLog.filter((l) => l.includes('/api/afk/afk-demo/log')).length
    await act(async () => {
      vi.advanceTimersByTime(AFK_LOG_POLL_INTERVAL_MS * 3)
    })
    await act(async () => {})
    expect(fetchLog.filter((l) => l.includes('/api/afk/afk-demo/log')).length).toBe(logCalls)
  })

  it('running 行抽屉日志区带「沙箱内阶段」行（automation_current_phase）', async () => {
    renderView()
    await openDrawer('afk-demo')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-terminal'))
    const note = screen.getByTestId('prg-sandbox-phase-afk-demo')
    expect(note.textContent).toContain('沙箱内阶段')
    expect(note.textContent).toContain('verify')
  })

  it('等产出抽屉点名缺什么；排队抽屉无注释句', async () => {
    renderView()
    await openDrawer('board-demo')
    expect(screen.queryByTestId('prg-log-board-demo')).toBeNull()
    expect(screen.queryByTestId('prg9-note-board-demo')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await openDrawer('triage-demo')
    const note = screen.getByTestId('prg9-note-triage-demo')
    expect(note.textContent).toContain('实施计划')
    expect(note.textContent).toContain('请在终端继续')
    expect(note.textContent).not.toContain('agent')
  })
})

/**
 * #3 抽屉焦点陷阱（无障碍）：打开即焦点移入关闭钮；Tab/Shift+Tab 在抽屉内循环；关闭（关闭钮/
 * scrim/Esc）都把焦点还给触发它的画布小卡。
 */
describe('ProgressView 抽屉焦点陷阱（#3 无障碍）', () => {
  it('打开抽屉 → 焦点移入抽屉内关闭钮（detail-close）', async () => {
    renderView()
    await openDrawer('gate-demo')
    expect(document.activeElement).toBe(screen.getByTestId('detail-close'))
  })

  it('Tab 循环：末元素 Tab → 首元素；首元素 Shift+Tab → 末元素', async () => {
    renderView()
    await openDrawer('gate-demo')
    const drawerEl = screen.getByTestId('prg9-drawer')
    const focusables = drawerEl.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    )
    expect(focusables.length).toBeGreaterThan(1)
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    expect(first).toBe(screen.getByTestId('detail-close'))
    last.focus()
    fireEvent.keyDown(drawerEl, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    first.focus()
    fireEvent.keyDown(drawerEl, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('reduce：关闭抽屉（关闭钮，同步卸载）后焦点归还触发它的画布小卡', async () => {
    stubMatchMedia(true)
    renderView()
    const trigger = screen.getByTestId('prg-cv-chg-gate-demo')
    await openDrawer('gate-demo')
    expect(document.activeElement).toBe(screen.getByTestId('detail-close'))
    fireEvent.click(screen.getByTestId('detail-close'))
    expect(screen.queryByTestId('prg9-drawer')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('reduce：Esc 关闭同样归还焦点', async () => {
    stubMatchMedia(true)
    renderView()
    const trigger = screen.getByTestId('prg-cv-chg-gate-demo')
    await openDrawer('gate-demo')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('prg9-drawer')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('reduce：路由直接选中并打开抽屉时，Esc 仍把焦点归还对应卡片', async () => {
    stubMatchMedia(true)
    function RoutedHarness(): JSX.Element {
      const [selectedChange, setSelectedChange] = useState<string | null>('gate-demo')
      return (
        <I18nProvider>
          <ProgressView
            snapshot={makeFixture()}
            loading={false}
            error={null}
            currentRoot={ROOT_A}
            rulesByKey={makeRules()}
            selectedChange={selectedChange}
            onSelectedChange={setSelectedChange}
          />
        </I18nProvider>
      )
    }
    render(<RoutedHarness />)
    const trigger = screen.getByTestId('prg-cv-chg-gate-demo')
    await waitFor(() => expect(screen.getByTestId('prg9-drawer')).toBeInTheDocument())

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByTestId('prg9-drawer')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('reduce：点击打开 A 后路由切到 B，Esc 把焦点归还 B 而不是仍连接的 A 卡片', async () => {
    stubMatchMedia(true)
    function RoutedHarness(): JSX.Element {
      const [selectedChange, setSelectedChange] = useState<string | null>(null)
      return (
        <I18nProvider>
          <button type="button" data-testid="route-to-afk" onClick={() => setSelectedChange('afk-demo')}>
            route to afk
          </button>
          <ProgressView
            snapshot={makeFixture()}
            loading={false}
            error={null}
            currentRoot={ROOT_A}
            rulesByKey={makeRules()}
            selectedChange={selectedChange}
            onSelectedChange={setSelectedChange}
          />
        </I18nProvider>
      )
    }
    render(<RoutedHarness />)
    const staleTrigger = screen.getByTestId('prg-cv-chg-gate-demo')
    const currentTrigger = screen.getByTestId('prg-cv-chg-afk-demo')
    fireEvent.click(staleTrigger)
    await waitFor(() => expect(screen.getByTestId('prg9-drawer')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('route-to-afk'))
    await waitFor(() => expect(currentTrigger).toHaveAttribute('data-on', 'true'))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByTestId('prg9-drawer')).toBeNull()
    expect(document.activeElement).toBe(currentTrigger)
  })

  it('reduce：原触发卡被同 key 新节点替换后，只在当前 ProgressView 内归还焦点', async () => {
    stubMatchMedia(true)
    renderView()
    const staleTrigger = screen.getByTestId('prg-cv-chg-gate-demo')
    await openDrawer('gate-demo')
    const currentTrigger = staleTrigger.cloneNode(true) as HTMLElement
    const outsideOwner = staleTrigger.cloneNode(true) as HTMLElement
    screen.getByTestId('progress-view').before(outsideOwner)
    staleTrigger.replaceWith(currentTrigger)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByTestId('prg9-drawer')).toBeNull()
    expect(staleTrigger.isConnected).toBe(false)
    expect(document.activeElement).toBe(currentTrigger)
    outsideOwner.remove()
  })

  // flaky 余量（#8）：GSAP 退场补间走真实挂钟，系统满载时播放变慢，waitFor 与外层 it() 超时都要
  // 放宽（详见历史注释，勿把数字改小）。
  it('no-preference：关闭抽屉（GSAP 退场补间完成后卸载）归还焦点', async () => {
    stubMatchMedia(false)
    renderView()
    const trigger = screen.getByTestId('prg-cv-chg-gate-demo')
    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('detail-close'))
    await waitFor(() => expect(screen.queryByTestId('prg9-drawer')).toBeNull(), { timeout: 40000 })
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  }, 50000)
})

describe('ProgressView GSAP 动效（gsap.matchMedia 全包；reduced-motion 守门等强度两分支）', () => {
  it('reduce：画布节点直达终态（opacity 1）；循环动效门控只落 data-*（running 节点才带）', async () => {
    stubMatchMedia(true)
    renderView()
    const nodes = screen.getByTestId('prg-canvas').querySelectorAll<HTMLElement>('[data-anim="prg-node"]')
    expect(nodes.length).toBeGreaterThan(0)
    for (const el of Array.from(nodes)) expect(el.style.opacity).toBe('1')
    expect(screen.getByTestId('prg-cv-chg-afk-demo').querySelector('[data-pulse="true"]')).not.toBeNull()
    expect(screen.getByTestId('prg-cv-chg-gate-demo').querySelector('[data-pulse="true"]')).toBeNull()
    expect(screen.getByTestId('prg-cv-node-proj-a-default-build')).toHaveAttribute('data-run', 'true')
    expect(screen.getByTestId('prg-cv-node-proj-a-default-verify').getAttribute('data-run')).toBeNull()
    // 单 root：冲掉并发上限探测请求落地（不冲会刷 act 告警）
    await act(async () => {})
  })

  // flaky 余量：与抽屉退场同族同因（真动画播放类测试的结构性弱点，非功能 bug；勿把数字改小）。
  it('no-preference：画布节点弹入后到达终态（opacity clearProps 自清或 1）', async () => {
    stubMatchMedia(false)
    renderView()
    await waitFor(() => {
      for (const el of Array.from(screen.getByTestId('prg-canvas').querySelectorAll<HTMLElement>('[data-anim="prg-node"]'))) {
        expect(el.style.opacity === '' || el.style.opacity === '1').toBe(true)
        expect(el.style.visibility === '' || el.style.visibility === 'inherit').toBe(true)
      }
    }, { timeout: 40000 })
    expect(screen.getByTestId('prg-cv-track-proj-a-default')).toHaveStyle({ minWidth: '1624px' })
  }, 50000)
})

/**
 * Bug4（单项目）：乐观 patch 按 change keyed，只清「已在 snapshot 落地」的那条，不被无关帧整清
 * → 不回弹。载具=gate 放行的 phase patch。
 */
describe('ProgressView Bug4：乐观 patch 按 change 落地清除，不被无关帧整清', () => {
  function fixtureAt(phase: string): Snapshot {
    return makeSnapshot([
      makeProject(ROOT_A, [
        makeChange('gate-demo', phase, {
          track: 'backend',
          fields: { verify_result: 'pass', agent_review_result: 'pass', codex_review_result: 'pass' },
          ...(phase === 'verify' ? {
            workflowExecution: {
              readinessByTransition: {
                verify: {
                  'verify-pass': { ready: true, blockers: [] },
                  'verify-fail': { ready: true, blockers: [] },
                },
              },
            },
          } : {}),
        }),
        makeChange('changelog-cn', 'review', { track: 'chat', fields: { workflow: 'release-train' } }),
      ]),
    ])
  }
  function viewAt(snapshot: Snapshot): JSX.Element {
    return (
      <I18nProvider>
        <ProgressView snapshot={snapshot} loading={false} error={null} currentRoot={ROOT_A} rulesByKey={makeRules()} onToast={vi.fn()} onRefresh={vi.fn()} />
      </I18nProvider>
    )
  }

  it('放行后无关帧到达 → 未落地 patch 保留（不回弹）；真落地后才清', async () => {
    const { rerender } = render(viewAt(fixtureAt('verify')))
    await openDrawer('gate-demo')
    fireEvent.click(screen.getByTestId('prg9-dw-pass-gate-demo'))
    await waitFor(() => expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('等产出'))

    // 无关帧：新 snapshot 对象，gate-demo 仍停 verify（未反映本次放行）——patch 保留不回弹
    rerender(viewAt(fixtureAt('verify')))
    expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('等产出')
    expect(screen.getByTestId('prg9-dw-badge').textContent).not.toContain('可以放行')

    // 真落地帧：真值 ship → patch 清除；随后回落 verify 的帧如实回显（证明已清）
    rerender(viewAt(fixtureAt('ship')))
    rerender(viewAt(fixtureAt('verify')))
    expect(screen.getByTestId('prg9-dw-badge').textContent).toContain('可以放行')
    // 冲掉抽屉内 TaskDetail 的 history 异步落地（不冲会刷 act 告警）
    await act(async () => {})
  })
})

describe('ProgressView 空态', () => {
  it('只读兼容模式仅保留查看与刷新，不渲染创建、transition 或 cancel 写入口', async () => {
    renderView({ readOnly: true })

    expect(screen.queryByTestId('progress-new-change')).toBeNull()
    await openDrawer('gate-demo')
    expect(screen.queryByTestId('prg9-dw-pass-gate-demo')).toBeNull()
    expect(screen.queryByTestId('prg9-dw-reject-gate-demo')).toBeNull()
    await openDrawer('afk-demo')
    expect(screen.queryByTestId('prg9-dw-kill-afk-demo')).toBeNull()
  })

  it('无在制任务 → 主入口可打开 Route Lock，同时保留 tenon init 退路', async () => {
    renderView({ snapshot: makeSnapshot([makeProject(ROOT_A, [])]) })
    expect(screen.getByTestId('prg-empty').textContent).toContain('tenon init')
    fireEvent.click(screen.getByTestId('progress-new-change'))
    expect(await screen.findByTestId('create-change-dialog')).toBeInTheDocument()
    await act(async () => {})
  })

  it('Route Lock 创建成功后刷新真 snapshot，并自动打开新 Change 详情', async () => {
    const routePreview = {
      ok: true,
      revision: 'rev-create',
      source: 'builtin-only',
      winner: {
        track: {
          id: 'frontend', label: 'Frontend', builtin: true,
          workflow: { default: 'default', allowed: '*' },
          policyProfile: {
            reviewSeed: 'pending', automationEligible: true, coverageProfile: 'frontend',
            routing: { enabled: true, pattern: 'ui', priority: 300 },
            skills: { matrix: true, profile: 'frontend' },
          },
        },
        order: 0, priority: 300, score: 1, routable: true, excluded: false,
      },
      candidates: [] as unknown[],
      suppressed_reason: null,
    }
    routePreview.candidates = [routePreview.winner]
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/workflows?')) return new Response(JSON.stringify({ names: [] }), { status: 200 })
      if (url === '/api/router/preview') return new Response(JSON.stringify(routePreview), { status: 200 })
      if (url === '/api/changes') return new Response(JSON.stringify({ ok: true, name: 'new-ui' }), { status: 200 })
      if (/\/api\/change\/new-ui\/history\?root=/.test(url)) return new Response(JSON.stringify({ entries: [] }), { status: 200 })
      if (/\/api\/automation\?root=/.test(url)) return new Response(JSON.stringify({ ok: true, settings: automationSettings }), { status: 200 })
      if (/\/api\/mem\/session-links\?/.test(url)) return new Response(JSON.stringify({ links: {} }), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    function Harness(): JSX.Element {
      const [snapshot, setSnapshot] = useState(makeSnapshot([makeProject(ROOT_A, [])]))
      const [selectedChange, setSelectedChange] = useState<string | null>(null)
      return <I18nProvider><ProgressView
        snapshot={snapshot}
        loading={false}
        error={null}
        currentRoot={ROOT_A}
        rulesByKey={makeRules()}
        selectedChange={selectedChange}
        onSelectedChange={setSelectedChange}
        onRefresh={() => setSnapshot(makeSnapshot([makeProject(ROOT_A, [makeChange('new-ui', 'open', { track: 'frontend' })])]))}
      /></I18nProvider>
    }

    render(<Harness />)
    fireEvent.click(screen.getByTestId('progress-new-change'))
    fireEvent.change(screen.getByTestId('change-name'), { target: { value: 'new-ui' } })
    fireEvent.change(screen.getByTestId('change-intent'), { target: { value: 'Build UI' } })
    expect(await screen.findByTestId('route-winner')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('change-create'))

    expect(await screen.findByTestId('prg9-drawer')).toHaveAttribute('aria-label', 'new-ui')
    fireEvent.click(screen.getByTestId('progress-sheet-tab-history'))
    await waitFor(() => expect(screen.getByTestId('dt-hist-sec')).toHaveAttribute('data-settled', 'true'))
  })
})
