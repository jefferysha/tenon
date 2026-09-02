import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import {
  WorkflowCanvas,
  type CanvasArchivedChange,
  type CanvasChange,
  type CanvasGroup,
  type CanvasStep,
} from './WorkflowCanvas'

/**
 * WorkflowCanvas（画布 v3 · 单项目地铁站台）—— 纯展示组件的结构测试（断言 data/aria/testid，
 * 不断言视觉类名；例外：名称禁截断是拍板硬条款，钉名称节点不落 truncate；sched 图标改 lucide
 * 后钉 svg.lucide-* 类做「是正规图标非 unicode」的证据）：
 *   · 空相位=过路小站（data-kind="stop"，不出大卡）；带归档相位小站「N 项已归档」可点开只读名单；
 *   · 有在制的相位=站台卡（data-kind="card"：序号/相位名/门徽章/件数）；
 *   · change 小卡（data-state/data-sbx/data-dim/data-on/data-pulse/lucide sched 图标/点击回调/长名完整）；
 *   · 单项目语境：小卡无项目缩写 chip、组头无「N 个项目」尾缀。
 * 与 ProgressView 的数据接线（FlatRow → CanvasGroup 投影）由 ProgressView.test 钉住。
 */

function chg(over: Partial<CanvasChange> & { key: string; name: string; phase: string }): CanvasChange {
  return {
    state: 'agent', tone: 'gray', running: false, executionSource: 'none', sandbox: false,
    dimmed: false, selected: false, statusLabel: '等待处理', ...over,
  }
}

function arch(over: Partial<CanvasArchivedChange> & { key: string; name: string }): CanvasArchivedChange {
  return { tone: 'gray', state: 'archived', ...over }
}

function step(id: string, over: Partial<CanvasStep> = {}): CanvasStep {
  const state = id === 'draft' ? 'done' : id === 'review' ? 'current' : 'pending'
  return { id, label: id, gate: null, archived: 0, archivedChanges: [], state, ...over }
}

/** 缺省组：proj-a 的 flow-x（3 相位，draft running·sandbox / review gatejudge，ship 空站）。 */
function makeGroup(over: Partial<CanvasGroup> = {}): CanvasGroup {
  return {
    key: '/tmp/proj-a::flow-x',
    projName: 'proj-a',
    workflow: 'flow-x',
    linearProgress: true,
    steps: [step('draft', { label: '起草' }), step('review', { label: '复核', gate: 'review' }), step('ship', { label: '发布' })],
    changes: [
      chg({ key: 'a1@/tmp/proj-a', name: 'a1', phase: 'draft', state: 'running', tone: 'blue', running: true, sandbox: true }),
      chg({ key: 'a2@/tmp/proj-a', name: 'a2', phase: 'review', state: 'gatejudge', tone: 'red', dimmed: true }),
    ],
    ...over,
  }
}

function renderCanvas(groups: CanvasGroup[], onOpen = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <I18nProvider>
      <WorkflowCanvas groups={groups} onOpen={onOpen} />
    </I18nProvider>,
  )
  return onOpen
}

function renderCanvasInEnglish(groups: CanvasGroup[]): void {
  localStorage.setItem('tenon-dashboard-lang', 'en')
  render(
    <I18nProvider>
      <WorkflowCanvas groups={groups} onOpen={vi.fn()} />
    </I18nProvider>,
  )
}

afterEach(() => localStorage.removeItem('tenon-dashboard-lang'))

describe('WorkflowCanvas 组与站点（单项目）', () => {
  it('空 groups → 不渲染画布容器', () => {
    renderCanvas([])
    expect(screen.queryByTestId('prg-canvas')).toBeNull()
  })

  it('全部组都没有在制 change → 画布容器整个不渲染', () => {
    renderCanvas([makeGroup({ changes: [] })])
    expect(screen.queryByTestId('prg-canvas')).toBeNull()
  })

  it('空组与有在制组混合：空组跳过不渲染，有在制的组照常', () => {
    renderCanvas([
      makeGroup(),
      makeGroup({ key: '/tmp/proj-a::flow-y', workflow: 'flow-y', changes: [] }),
    ])
    expect(screen.getByTestId('prg-cv-group-proj-a-flow-x')).toBeInTheDocument()
    expect(screen.queryByTestId('prg-cv-group-proj-a-flow-y')).toBeNull()
  })

  it('组头只保留工作流身份，项目标识保留在可访问属性中', () => {
    renderCanvas([makeGroup()])
    const group = screen.getByTestId('prg-cv-group-proj-a-flow-x')
    expect(group.textContent).toContain('flow-x')
    expect(group.textContent).not.toContain('3 步骤 · 流程中 2')
    const projectName = screen.getByTestId('prg-cv-project-proj-a-flow-x')
    expect(projectName).toHaveAttribute('data-project', 'proj-a')
    expect(projectName).toHaveAccessibleName('proj-a flow-x')
  })

  it('聚合多个项目时才把项目名加入紧凑组头，避免不同项目无法区分', () => {
    renderCanvas([
      makeGroup(),
      makeGroup({ key: '/tmp/proj-b::flow-x', projName: 'proj-b' }),
    ])
    expect(screen.getByTestId('prg-cv-project-proj-a-flow-x')).toHaveTextContent('proj-a · flow-x')
    expect(screen.getByTestId('prg-cv-project-proj-b-flow-x')).toHaveTextContent('proj-b · flow-x')
  })

  it('移动布局保持紧凑组头，阶段轨只在自身视口横向滚动', () => {
    renderCanvas([makeGroup()])
    const group = screen.getByTestId('prg-cv-group-proj-a-flow-x')
    expect(group).toHaveAttribute('data-responsive', 'summary-track-cards')
    expect(group.className).toContain('mobile:min-h-0')
    const projectName = screen.getByTestId('prg-cv-project-proj-a-flow-x')
    expect(projectName.className).not.toContain('mobile:basis-full')
    const viewport = screen.getByTestId('prg-cv-scroll-proj-a-flow-x')
    expect(viewport).toHaveAttribute('data-canvas-scroll')
    expect(viewport.className).toContain('overflow-x-auto')
    expect(viewport).toHaveAttribute('tabindex', '0')
    expect(viewport).toHaveAccessibleName('横向滚动查看后续阶段')
  })

  it('阶段轨保留可访问横向滚动，不再显示额外滚动提示', async () => {
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return this.hasAttribute('data-canvas-scroll') ? 1_000 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() { return this.hasAttribute('data-canvas-scroll') ? 1_624 : 0 },
    })
    try {
      const steps = ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive']
        .map((id) => step(id, { label: id }))
      renderCanvas([makeGroup({
        steps,
        changes: [chg({ key: 'active@/tmp/proj-a', name: 'active', phase: 'build' })],
      })])

      fireEvent(window, new Event('resize'))
      expect(screen.queryByTestId('prg-cv-scroll-hint-proj-a-flow-x')).toBeNull()
    } finally {
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      if (originalScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
    }
  })

  it('有在制步骤保留阶段、件数和 gate 语义，但按终稿统一使用 done/current/pending 圆形时间线节点', () => {
    renderCanvas([makeGroup()])
    const review = screen.getByTestId('prg-cv-node-proj-a-flow-x-review')
    expect(review).toHaveAttribute('data-kind', 'card')
    expect(review.textContent).toContain('02')
    expect(review.textContent).toContain('复核')
    expect(review.textContent).not.toContain('review 门')
    const stage = screen.getByTestId('prg-cv-stage-proj-a-flow-x-review')
    expect(stage).toHaveAttribute('data-stage-state', 'current')
    expect(stage).toHaveAttribute('title', 'review 门')
    expect(stage).toHaveAttribute('aria-label', 'review 门')
    expect(within(review).queryByTitle('1 项流程中')).toBeNull()
    expect(screen.queryByTestId('prg-cv-gate-proj-a-flow-x-draft')).toBeNull()
  })

  it('空步骤=过路小站（data-kind="stop"）：仍显示阶段名与 gate 的可访问语义，不出大卡占位「—」', () => {
    renderCanvas([
      makeGroup({
        steps: [step('draft', { label: '起草' }), step('review', { label: '复核', gate: 'review' }), step('ship', { label: '发布' })],
        changes: [chg({ key: 'a1@/tmp/proj-a', name: 'a1', phase: 'draft' })],
      }),
    ])
    const review = screen.getByTestId('prg-cv-node-proj-a-flow-x-review')
    expect(review).toHaveAttribute('data-kind', 'stop')
    expect(review.textContent).toContain('复核')
    expect(review.textContent).not.toContain('review 门')
    expect(screen.getByTestId('prg-cv-stage-proj-a-flow-x-review')).toHaveAttribute('aria-label', 'review 门')
    expect(review.textContent).not.toContain('—')
    expect(screen.getByTestId('prg-cv-node-proj-a-flow-x-draft')).toHaveAttribute('data-kind', 'card')
  })

  it('含 running change 的站台卡 data-run（呼吸环/流动段 CSS 门控）；静止站台与小站不落', () => {
    renderCanvas([makeGroup()])
    expect(screen.getByTestId('prg-cv-node-proj-a-flow-x-draft')).toHaveAttribute('data-run', 'true')
    expect(screen.getByTestId('prg-cv-node-proj-a-flow-x-review').getAttribute('data-run')).toBeNull()
    expect(screen.getByTestId('prg-cv-node-proj-a-flow-x-ship').getAttribute('data-run')).toBeNull()
  })

  it('首次呈现长阶段轨时把 current phase 定位到横向可视区', () => {
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const originalOffsetLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return this.getAttribute('data-testid')?.startsWith('prg-cv-scroll-') ? 1_000 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get() { return this.getAttribute('data-stage-state') === 'current' ? 1_300 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return this.getAttribute('data-stage-state') === 'current' ? 260 : 0 },
    })
    try {
      const steps = ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive']
        .map((id, index) => step(id, {
          label: id,
          state: index < 4 ? 'done' : index === 4 ? 'current' : 'pending',
        }))
      renderCanvas([makeGroup({
        steps,
        changes: [chg({
          key: 'current@/tmp/proj-a',
          name: 'current',
          phase: 'verify',
          state: 'running',
          running: true,
        })],
      })])

      expect(scrollTo).toHaveBeenCalledWith({ left: 930, behavior: 'auto' })
    } finally {
      if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      if (originalOffsetLeft) Object.defineProperty(HTMLElement.prototype, 'offsetLeft', originalOffsetLeft)
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetLeft')
      if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
    }
  })

  it('一个 workflow 的 phase 变化只重定位自己的 viewport，不抢走其他 workflow 的用户滚动', () => {
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const originalOffsetLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return this.hasAttribute('data-canvas-scroll') ? 600 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get() { return this.getAttribute('data-stage-state') === 'current' ? 900 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return this.getAttribute('data-stage-state') === 'current' ? 200 : 0 },
    })
    const groupA = makeGroup()
    const groupB = makeGroup({
      key: '/tmp/proj-b::flow-y',
      projName: 'proj-b',
      workflow: 'flow-y',
      changes: [chg({ key: 'b1@/tmp/proj-b', name: 'b1', phase: 'review' })],
    })
    try {
      const view = render(
        <I18nProvider>
          <WorkflowCanvas groups={[groupA, groupB]} onOpen={vi.fn()} />
        </I18nProvider>,
      )
      expect(scrollTo).toHaveBeenCalledTimes(2)
      scrollTo.mockClear()

      const advancedB = {
        ...groupB,
        steps: groupB.steps.map((candidate) => ({
          ...candidate,
          state: candidate.id === 'ship' ? 'current' as const : 'done' as const,
        })),
        changes: [chg({ key: 'b1@/tmp/proj-b', name: 'b1', phase: 'ship' })],
      }
      view.rerender(
        <I18nProvider>
          <WorkflowCanvas groups={[groupA, advancedB]} onOpen={vi.fn()} />
        </I18nProvider>,
      )

      expect(scrollTo).toHaveBeenCalledTimes(1)
      expect(scrollTo.mock.instances[0]).toBe(screen.getByTestId('prg-cv-scroll-proj-b-flow-y'))
    } finally {
      if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      if (originalOffsetLeft) Object.defineProperty(HTMLElement.prototype, 'offsetLeft', originalOffsetLeft)
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetLeft')
      if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
    }
  })
})

// ── 归档不失联：带归档的相位小站把「N 项已归档」做成可点开的只读折叠——点开在站台线下方
//    平铺该相位归档 change 只读名单；再点收起。──
describe('WorkflowCanvas 归档相位小站（归档不失联，只读折叠）', () => {
  function withArchive(): CanvasGroup {
    return makeGroup({
      steps: [
        step('draft', { label: '起草' }),
        step('review', { label: '复核', gate: 'review' }),
        step('ship', {
          label: '发布',
          archived: 2,
          archivedChanges: [arch({ key: 'z1@/tmp/proj-a', name: 'z1' }), arch({ key: 'z2@/tmp/proj-a', name: 'z2', tone: 'red', state: 'failed' })],
        }),
      ],
      changes: [chg({ key: 'a1@/tmp/proj-a', name: 'a1', phase: 'draft' })],
    })
  }

  it('归档相位小站带「N 项已归档」toggle（默认收起，aria-expanded=false）；名单初始不在 DOM', () => {
    renderCanvas([withArchive()])
    const ship = screen.getByTestId('prg-cv-node-proj-a-flow-x-ship')
    expect(ship).toHaveAttribute('data-kind', 'stop')
    const toggle = screen.getByTestId('prg-cv-arch-toggle-proj-a-flow-x-ship')
    expect(toggle.textContent).toContain('2 项已归档')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('prg-cv-arch-panel-proj-a-flow-x-ship')).toBeNull()
    expect(screen.queryByTestId('prg-cv-arch-chg-z1')).toBeNull()
  })

  it('点开 → 只读平铺归档名单（完整 mono 名、状态点、无点击回调按钮）；再点收起', () => {
    renderCanvas([withArchive()])
    const toggle = screen.getByTestId('prg-cv-arch-toggle-proj-a-flow-x-ship')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const panel = screen.getByTestId('prg-cv-arch-panel-proj-a-flow-x-ship')
    expect(within(panel).getByTestId('prg-cv-arch-chg-z1').textContent).toContain('z1')
    expect(within(panel).getByTestId('prg-cv-arch-chg-z2').textContent).toContain('z2')
    // 只读：归档条目不是按钮（不开抽屉）
    expect(within(panel).queryAllByRole('button')).toHaveLength(0)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('prg-cv-arch-panel-proj-a-flow-x-ship')).toBeNull()
  })
})

describe('WorkflowCanvas change 小卡', () => {
  it('任务卡只保留中文状态、名称和打开入口；时间线给出 done/current 状态', () => {
    renderCanvas([
      makeGroup({
        changes: [
          chg({ key: 'a1@/tmp/proj-a', name: 'a1', phase: 'draft', state: 'queued', tone: 'blue', sandbox: true, statusLabel: '排队' }),
          chg({ key: 'a2@/tmp/proj-a', name: 'a2', phase: 'review', state: 'gatejudge', tone: 'amb', statusLabel: '等你判断' }),
        ],
      }),
    ])
    expect(screen.getByTestId('prg-cv-track-proj-a-flow-x')).toHaveStyle({ minWidth: '696px' })
    expect(screen.getByTestId('prg-cv-group-proj-a-flow-x')).toContainElement(
      screen.getByTestId('prg-cv-scroll-proj-a-flow-x'),
    )
    expect(screen.getByTestId('prg-cv-stage-proj-a-flow-x-draft')).toHaveAttribute('data-stage-state', 'done')
    expect(screen.getByTestId('prg-cv-stage-proj-a-flow-x-review')).toHaveAttribute('data-stage-state', 'current')
    const card = screen.getByTestId('prg-cv-chg-a1')
    expect(card).toHaveTextContent('等待中')
    expect(card).not.toHaveTextContent('QUEUED')
    expect(card).not.toHaveTextContent('阶段')
    expect(card).not.toHaveTextContent('01 · 起草')
    expect(card).not.toHaveTextContent('工作流')
    expect(card).not.toHaveTextContent('flow-x')
    expect(card).toHaveTextContent('打开')
  })

  it('英文模式只翻译画布状态和操作，不展示技术元信息', () => {
    renderCanvasInEnglish([
      makeGroup({
        changes: [
          chg({
            key: 'a1@/tmp/proj-a',
            name: 'a1',
            phase: 'draft',
            state: 'running',
            tone: 'blue',
            running: true,
            executionSource: 'terminal',
            statusLabel: 'Running Build',
          }),
        ],
      }),
    ])
    const group = screen.getByTestId('prg-cv-group-proj-a-flow-x')
    expect(group).toHaveTextContent('flow-x')
    expect(group).not.toHaveTextContent('Project · proj-a')
    expect(group).not.toHaveTextContent('Process')
    const card = screen.getByTestId('prg-cv-chg-a1')
    expect(card).toHaveTextContent('Running')
    expect(card).not.toHaveTextContent('Stage')
    expect(card).not.toHaveTextContent('Workflow')
    expect(card).not.toHaveTextContent('Terminal running')
    expect(card).toHaveTextContent('Open')
    expect(group.textContent).not.toMatch(/[项目流程运行中阶段工作流终端打开项]/)
  })

  it('小卡：dim 上下文同时淡出、禁用并从无障碍树隐藏，且点击不会打开抽屉', () => {
    const onOpen = renderCanvas([
      makeGroup({
        changes: [
          chg({ key: 'a1@/tmp/proj-a', name: 'a1', phase: 'draft', state: 'running', tone: 'blue', running: true, sandbox: true }),
          chg({ key: 'a2@/tmp/proj-a', name: 'a2', phase: 'review', state: 'gatejudge', tone: 'red', dimmed: true, selected: true }),
        ],
      }),
    ])
    const run = screen.getByTestId('prg-cv-chg-a1')
    expect(run).toHaveAttribute('data-state', 'running')
    expect(run).toHaveAttribute('data-sbx', 'true')
    expect(run.querySelector('[data-pulse="true"]')).not.toBeNull()
    expect(run.getAttribute('data-dim')).toBeNull()
    // 单项目语境：小卡不带项目缩写
    expect(run.textContent).not.toContain('proj-a')
    const judge = screen.getByTestId('prg-cv-chg-a2')
    expect(judge).toHaveAttribute('data-state', 'gatejudge')
    expect(judge).toHaveAttribute('data-dim', 'true')
    expect(judge).toBeDisabled()
    expect(judge).toHaveAttribute('aria-hidden', 'true')
    expect(judge).toHaveAttribute('data-on', 'true')
    expect(judge.getAttribute('data-sbx')).toBeNull()
    expect(judge.querySelector('[data-pulse="true"]')).toBeNull()
    fireEvent.click(judge)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(run)
    expect(onOpen).toHaveBeenCalledWith('a1@/tmp/proj-a', run)
  })

  it('卡片不再展示调度来源图标，来源仍保留在 data-sbx 上供逻辑使用', () => {
    renderCanvas([
      makeGroup({
        changes: [
          chg({ key: 'a1@/tmp/proj-a', name: 'a1', phase: 'draft', state: 'running', tone: 'blue', running: true, sandbox: true }),
          chg({ key: 'a2@/tmp/proj-a', name: 'a2', phase: 'review', state: 'gatejudge', tone: 'red', sandbox: false }),
        ],
      }),
    ])
    const sbx = screen.getByTestId('prg-cv-chg-a1')
    expect(sbx.querySelector('svg.lucide-coffee')).toBeNull()
    expect(sbx.textContent).not.toMatch(/AFK|终端/)
    const term = screen.getByTestId('prg-cv-chg-a2')
    expect(term.querySelector('svg.lucide-terminal')).toBeNull()
    expect(term.textContent).not.toMatch(/AFK|终端/)
  })

  it('卡片不再展示 AFK/终端角标，避免把执行实现暴露给普通用户', () => {
    renderCanvas([
      makeGroup({
        changes: [
          chg({ key: 'a1@/tmp/proj-a', name: 'a1', phase: 'draft', state: 'running', tone: 'blue', running: true, sandbox: true }),
          chg({ key: 'a2@/tmp/proj-a', name: 'a2', phase: 'review', state: 'gatejudge', tone: 'red', sandbox: false }),
        ],
      }),
    ])
    const sbx = screen.getByTestId('prg-cv-chg-a1')
    expect(within(sbx).queryByLabelText('AFK 沙箱')).toBeNull()
    expect(sbx.querySelector('svg.lucide-coffee')).toBeNull()
    expect(sbx.textContent).not.toContain('AFK')
    const term = screen.getByTestId('prg-cv-chg-a2')
    expect(within(term).queryByLabelText('AFK 沙箱')).toBeNull()
    expect(within(term).queryByLabelText('终端')).toBeNull()
    expect(term.querySelector('svg.lucide-terminal')).toBeNull()
  })

  // 反馈②硬条款：change 名称完整渲染，禁 ellipsis（break-all 折行）。textContent 钉全名，
  // 名称节点不落 truncate（此处例外地断言类名——截断禁令本身就是视觉契约）。
  it('长 change 名完整渲染：全名在 DOM、名称节点无 truncate', () => {
    const longName = 'refactor-legacy-payment-gateway-reconciliation-pipeline-and-webhooks-v2'
    renderCanvas([
      makeGroup({
        changes: [chg({ key: `${longName}@/tmp/proj-a`, name: longName, phase: 'draft' })],
      }),
    ])
    const card = screen.getByTestId(`prg-cv-chg-${longName}`)
    const nameEl = within(card).getByText(longName)
    expect(nameEl.textContent).toBe(longName)
    expect(nameEl.className).not.toContain('truncate')
  })

  it('小卡点击 → onOpen(key, 触发元素)（宿主 openDrawer 的焦点归还契约）', () => {
    const onOpen = renderCanvas([makeGroup()])
    const chip = screen.getByTestId('prg-cv-chg-a1')
    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('a1@/tmp/proj-a', chip)
  })
})
