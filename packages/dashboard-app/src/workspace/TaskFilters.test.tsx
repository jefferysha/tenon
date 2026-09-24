/**
 * 工作台中列：单行筛选栏（状态芯片 + 负责人 / 工作流 / 轨道 / 阶段下拉，放不下进「更多」）、
 * URL status、任务卡元信息、迷你流水线，以及左列与空列表时的右列。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import type { ChangeSnapshot } from '../types'
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const ROOT = '/Users/me/code/repo'
const ann = { id: 'ann@x.io', slug: 'ann', name: 'Ann' }
const me = { id: 'me@x.io', slug: 'me', name: 'me' }

function ready(name: string, over: Partial<ChangeSnapshot> = {}): ChangeSnapshot {
  const change = makeChange(name, 'build', over)
  const edge = change.workflowRules.transitions.build?.find((candidate) => change.workflowRules.steps.indexOf(candidate.to) > change.workflowRules.steps.indexOf('build'))
  return edge === undefined ? change : {
    ...change,
    workflowExecution: { ...change.workflowExecution, readinessByTransition: { build: { [edge.event]: { ready: true, blockers: [] } } } },
  }
}

const CHANGES = [
  makeChange('a', 'build', { track: 'chat', owner: ann }),
  makeChange('b', 'verify', { track: 'chat' }),
  ready('c', { track: 'web' }),
  makeChange('d', 'archive', { archived: 'true', track: 'chat' }),
]

function renderView(props: Partial<WorkspaceViewProps> = {}, changes: ChangeSnapshot[] = CHANGES) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 }))
  return render(
    <I18nProvider>
      <WorkspaceView
        snapshot={makeSnapshot([makeProject(ROOT, changes, { uncommittedDeletions: 2 })])}
        currentRoot=""
        rulesByKey={new Map()}
        projects={[{ root: ROOT, name: 'repo', count: changes.length, ok: true }, { root: '/srv/gone', name: 'gone', count: 0, ok: false }]}
        onSelectProject={() => undefined}
        selectedChange={null}
        onSelectedChange={() => undefined}
        me={me}
        {...props}
      />
    </I18nProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('工作台筛选栏', () => {
  it('单行：状态芯片 + 维度下拉在同一行，不换行、不横向滚动', () => {
    renderView()
    const bar = screen.getByTestId('task-filters')
    expect(bar.className.split(/\s+/u)).toContain('flex-nowrap')
    expect(bar.className.split(/\s+/u)).not.toContain('flex-wrap')
    expect(bar.className.split(/\s+/u)).not.toContain('overflow-x-auto')
    for (const id of ['task-status', 'task-facet-owner', 'task-facet-track', 'task-view-archived', 'task-uncommitted-deletions']) {
      expect(bar, id).toContainElement(screen.getByTestId(id))
    }
    // 只有一个工作流：该维度隐藏。
    expect(screen.queryByTestId('task-facet-workflow')).toBeNull()
    expect(screen.queryByTestId('task-filter-completed')).toBeNull()
    expect(screen.getByTestId('task-status')).toHaveAttribute('role', 'radiogroup')
  })

  it('状态芯片与原型一致：全部 / 需要你 / 进行中 / 待复核 / 已完成，计数由 summary 映射', () => {
    renderView()
    const chips = within(screen.getByTestId('task-status')).getAllByRole('radio')
    expect(chips.map((chip) => chip.textContent)).toEqual(['全部4', '需要你1', '进行中2', '待复核0', '已完成1'])
    fireEvent.click(screen.getByTestId('task-status-needs-you'))
    expect(screen.getByTestId('task-card-c')).toBeInTheDocument()
    expect(screen.queryByTestId('task-card-a')).toBeNull()
    expect(new URLSearchParams(window.location.search).get('status')).toBe('needs-you')
    fireEvent.click(screen.getByTestId('task-status-all'))
    expect(new URLSearchParams(window.location.search).get('status')).toBeNull()
  })

  it('URL 的 status=needs-you（顶部徽标跳转）作为初始筛选；非法值回到全部', () => {
    window.history.replaceState(null, '', '/?view=progress&status=needs-you')
    const first = renderView()
    expect(screen.getByTestId('task-status-needs-you')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByTestId('task-card-a')).toBeNull()
    first.unmount()
    window.history.replaceState(null, '', '/?view=progress&status=bogus')
    renderView()
    expect(screen.getByTestId('task-status-all')).toHaveAttribute('aria-checked', 'true')
  })

  it('负责人下拉：「我的」紧跟「全部」，选中后触发器显示当前值', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(screen.getByTestId('task-facet-owner'))
    const items = await screen.findAllByRole('menuitemradio')
    expect(items.map((item) => item.getAttribute('data-testid'))).toEqual(['task-facet-owner-all', 'task-facet-owner-me', 'task-facet-owner-ann'])
    await user.click(screen.getByTestId('task-facet-owner-ann'))
    expect(screen.getByTestId('task-facet-owner')).toHaveTextContent('负责人Ann1')
    expect(screen.queryByTestId('task-card-b')).toBeNull()
  })

  it('下拉触发器键盘可达：Enter 打开菜单', async () => {
    const user = userEvent.setup()
    renderView()
    screen.getByTestId('task-facet-track').focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('task-facet-track-web')).toBeInTheDocument()
  })

  it('中列放不下时维度收进「更多 N」，芯片整颗保留或整颗收起', () => {
    const widths: Record<string, number> = { container: 304, trailing: 80, more: 64 }
    renderView({
      measureWidth: (element) => {
        const key = element.dataset.measure ?? ''
        return widths[key] ?? (key.startsWith('item:status:') ? 44 : key.startsWith('item:') ? 90 : 0)
      },
    })
    // 304 - 80 - 4 = 220：5 颗芯片 = 5×44 + 4×4 = 236 放不下；留「更多」64 后能放 3 颗。
    expect(within(screen.getByTestId('task-status')).getAllByRole('radio')).toHaveLength(3)
    expect(screen.queryByTestId('task-facet-owner')).toBeNull()
    expect(screen.getByTestId('task-filters-more')).toHaveTextContent('更多4')
  })
})

describe('任务卡', () => {
  it('元信息只留项目（聚合视图）与 工作流/轨道；负责人是头像 + title', () => {
    renderView()
    expect(screen.getByTestId('task-meta-a')).toHaveTextContent(/^repo · default\/chat$/u)
    const avatar = screen.getByTestId('task-owner-a')
    expect(avatar).toHaveAttribute('title', 'Ann')
    expect(avatar).toHaveTextContent('A')
    expect(screen.queryByTestId('task-owner-b')).toBeNull()
  })

  it('可进入下一阶段 = 需要你，用琥珀色而不是成功绿', () => {
    renderView()
    expect(screen.getByTestId('task-card-c')).toHaveAttribute('data-status', 'needs-you')
    expect(screen.getByTestId('task-summary-c')).toHaveAttribute('data-tone', 'pending')
  })

  it('迷你流水线：当前段是浅底 + 40% 内填；单阶段工作流不画分段条', () => {
    renderView()
    const pipeline = screen.getByTestId('task-pipeline-a')
    const current = pipeline.querySelector('[data-status="current"]')
    expect(current?.className).toContain('bg-seg-now-t')
    expect(screen.getByTestId('task-pipeline-a-now').className).toContain('w-2/5')
    cleanup()
    const single = makeChange('solo', 'only')
    renderView({}, [{ ...single, workflowRules: { ...single.workflowRules, steps: ['only'], transitions: {} } }])
    expect(screen.queryByTestId('task-pipeline-solo')).toBeNull()
  })
})

describe('左列与右列', () => {
  it('「所有项目」在最前；没有设置链接；路径用 shortPath；不可读只说一次；≤900px 整列隐藏', () => {
    renderView()
    const rail = screen.getByTestId('project-rail')
    expect(rail.querySelector('button[data-testid^="project-rail-"]:not([data-testid$="-toggle"])')).toBe(screen.getByTestId('project-rail-all'))
    expect(screen.queryByTestId('project-rail-settings')).toBeNull()
    const repo = screen.getByTestId('project-rail-item-repo')
    expect(repo).toHaveTextContent('~/code/repo')
    expect(screen.getByTestId('project-rail-item-repo-meta')).toHaveAttribute('title', ROOT)
    expect(screen.getByTestId('project-rail-item-gone').textContent?.match(/不可读/gu)).toHaveLength(1)
    expect(screen.getByTestId('project-rail-wrap').className.split(/\s+/u)).toContain('max-[900px]:hidden')
  })

  it('列表为空时右列不写「选一个任务」', () => {
    renderView({}, [])
    expect(screen.queryByTestId('task-detail-pane')).toBeNull()
    expect(screen.getByTestId('task-detail-none')).toBeEmptyDOMElement()
  })
})
