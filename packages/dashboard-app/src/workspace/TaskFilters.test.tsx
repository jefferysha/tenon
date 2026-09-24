/**
 * 工作台中列：单行筛选栏（状态分段 + 「筛选」菜单收负责人 / 工作流 / 轨道 / 阶段；已归档是标题旁的文字开关）、
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

function review(name: string, over: Partial<ChangeSnapshot> = {}): ChangeSnapshot {
  return { ...makeChange(name, 'build', over), reviewHandshake: { status: 'pending', event: 'build-complete', requestedAt: 'now' } }
}

const CHANGES = [
  makeChange('a', 'build', { track: 'chat', owner: ann }),
  makeChange('b', 'verify', { track: 'chat' }),
  review('c', { track: 'web' }),
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
  it('单行：状态分段 + 「筛选」按钮在同一行，不换行、不横向滚动；已归档是标题旁的文字开关', () => {
    renderView()
    const bar = screen.getByTestId('task-filters')
    expect(bar.className.split(/\s+/u)).toContain('flex-nowrap')
    expect(bar.className.split(/\s+/u)).not.toContain('flex-wrap')
    expect(bar.className.split(/\s+/u)).not.toContain('overflow-x-auto')
    expect(bar).toContainElement(screen.getByTestId('task-status'))
    expect(bar).toContainElement(screen.getByTestId('task-filter-menu'))
    const head = screen.getByTestId('task-list-action')
    expect(head).toContainElement(screen.getByTestId('task-view-archived'))
    expect(head).toContainElement(screen.getByTestId('task-uncommitted-deletions'))
    expect(screen.getByTestId('task-view-archived')).toHaveTextContent('已归档0')
    expect(screen.getByTestId('task-status')).toHaveAttribute('role', 'radiogroup')
    // 不再有「更多」把状态拆成两处。
    expect(screen.queryByTestId('task-filters-more')).toBeNull()
  })

  it('状态分段：全部 / 需要你 / 进行中 / 已完成；需要你只算评审待确认', () => {
    renderView()
    const chips = within(screen.getByTestId('task-status')).getAllByRole('radio')
    expect(chips.map((chip) => chip.textContent)).toEqual(['全部4', '需要你1', '进行中2', '已完成1'])
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

  it('「筛选」菜单：负责人「我的」紧跟「全部」；选中后按钮显示生效条件数；只有一个取值的维度不列', async () => {
    const user = userEvent.setup()
    renderView()
    expect(screen.queryByTestId('task-filter-active')).toBeNull()
    await user.click(screen.getByTestId('task-filter-menu'))
    const menu = await screen.findByTestId('task-filter-menu-content')
    expect(within(menu).getByTestId('task-facet-owner-all')).toBeInTheDocument()
    const owners = within(menu).getAllByRole('menuitemradio').map((item) => item.getAttribute('data-testid')).filter((id) => id?.startsWith('task-facet-owner-'))
    expect(owners).toEqual(['task-facet-owner-all', 'task-facet-owner-me', 'task-facet-owner-ann'])
    // 只有一个工作流：该维度不列。
    expect(within(menu).queryByTestId('task-facet-workflow-all')).toBeNull()
    await user.click(screen.getByTestId('task-facet-owner-ann'))
    expect(screen.getByTestId('task-filter-active')).toHaveTextContent('1')
    expect(screen.queryByTestId('task-card-b')).toBeNull()
  })

  it('「筛选」按钮键盘可达：Enter 打开菜单', async () => {
    const user = userEvent.setup()
    renderView()
    screen.getByTestId('task-filter-menu').focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('task-facet-track-web')).toBeInTheDocument()
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

  it('评审待确认 = 需要你，用琥珀色；可前进由智能体推进，算进行中', () => {
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

  it('默认选中第一项；列表为空时右列收起', () => {
    const first = renderView()
    expect(screen.getByTestId('task-detail-pane')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-view')).toHaveAttribute('data-detail-collapsed', 'false')
    first.unmount()
    renderView({}, [])
    expect(screen.queryByTestId('task-detail-pane')).toBeNull()
    expect(screen.getByTestId('workspace-view')).toHaveAttribute('data-detail-collapsed', 'true')
  })

  it('空态两步引导：智能体对话的提示词 + 不截断的完整命令（含 --preset）', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    render(
      <I18nProvider>
        <WorkspaceView
          snapshot={makeSnapshot([makeProject(ROOT, [])])}
          currentRoot={ROOT}
          rulesByKey={new Map()}
          projects={[{ root: ROOT, name: 'repo', count: 0, ok: true }]}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </I18nProvider>,
    )
    expect(screen.getByTestId('task-list-empty-prompt-text').textContent).toMatch(/^\/tenon /u)
    const command = screen.getByTestId('task-list-empty-command-text')
    expect(command).toHaveTextContent('tenon init my-change --workflow default --track chat --preset full')
    expect(command.className).toContain('whitespace-nowrap')
    expect(command.className).not.toContain('truncate')
  })
})
