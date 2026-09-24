import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { backArrowPath, backEdgePath, STEP_PITCH, WorkflowNav } from './WorkflowNav'

function step(id: string, label: string, gate: WbStepDef['gate'], to: string[]): WbStepDef {
  return { id, label, gate, skills: [{ id: `tenon-${id}` }], inputs: [], outputs: [{ field: 'x', type: 'string' }], guards: [], transitions: to.map((target) => ({ event: `${id}-${target}`, to: target })) }
}
const DEF: WbWorkflowDef = { name: 'default', steps: [step('open', '立项', null, ['explore']), step('explore', '调研', 'review', ['spec']), step('spec', '规格', 'review', ['build']), step('build', '实现', null, ['verify', 'spec'])] }

function renderNav(overrides: Partial<Parameters<typeof WorkflowNav>[0]> = {}) {
  const fns = { onSwitch: vi.fn(), onSwitchBranch: vi.fn(), onCreate: vi.fn(), onExport: vi.fn(), onDelete: vi.fn(), onNewTrack: vi.fn(), onDeleteTrack: vi.fn(), onSelect: vi.fn(), onAddStage: vi.fn(), onReorder: vi.fn(), onToggleOpenspec: vi.fn(), onDeleteStage: vi.fn() }
  render(
    <I18nProvider><TooltipProvider>
      <WorkflowNav
        names={['default', 'release']}
        current="default"
        defaultSource="builtin"
        branches={[{ id: 'pm', label: '产品' }, { id: 'mobile', label: null }]}
        branch="pm"
        def={DEF}
        labelOf={(id) => DEF.steps.find((candidate) => candidate.id === id)?.label ?? id}
        selectedId="explore"
        lint={[]}
        loading={false}
        error={null}
        canWrite
        busy={false}
        openspec={false}
        {...fns}
        {...overrides}
      />
    </TooltipProvider></I18nProvider>,
  )
  return fns
}

describe('WorkflowNav', () => {
  it('工作流名点开菜单切换；名称只出现一次，default 只带一把锁（没有来源 / 轨道数副行）', async () => {
    const user = userEvent.setup()
    const { onSwitch } = renderNav()
    expect(screen.getByTestId('wb-wf-switch')).toHaveTextContent('default')
    expect(screen.queryByTestId('wb-wf-meta')).toBeNull()
    expect(screen.getByTestId('wb-wf-lock')).toHaveAccessibleName('内建')
    expect(screen.getByTestId('workflow-nav')).not.toHaveTextContent('全局')
    await user.click(screen.getByTestId('wb-wf-switch'))
    expect(screen.getByTestId('wb-wf-item-default')).toHaveAttribute('role', 'menuitemradio')
    expect(screen.getByTestId('wb-wf-item-default')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-wf-item-release')).not.toHaveTextContent('全局')
    await user.click(screen.getByTestId('wb-wf-item-release'))
    expect(onSwitch).toHaveBeenCalledWith('release')
    expect(screen.queryByTestId('wb-wf-list')).toBeNull()
  })

  it('切换菜单可用键盘打开，Esc 关闭', async () => {
    const user = userEvent.setup()
    renderNav()
    screen.getByTestId('wb-wf-switch').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('wb-wf-list')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('wb-wf-list')).toBeNull()
  })

  it('⋯ 菜单：新建 / 导出 / OpenSpec 设置，分隔线下是恢复内建（内建时禁用）/ 删除当前轨道', async () => {
    const user = userEvent.setup()
    const { onCreate, onDeleteTrack } = renderNav()
    await user.click(screen.getByTestId('wb-wf-menu'))
    const menu = screen.getByTestId('wb-wf-menu-menu')
    expect(within(menu).getByTestId('wb-wf-menu-openspec')).toHaveTextContent('OpenSpec 设置')
    const separator = within(menu).getByRole('separator')
    expect(separator.compareDocumentPosition(screen.getByTestId('wb-wf-menu-restore')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(separator.compareDocumentPosition(screen.getByTestId('wb-wf-menu-export')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(screen.getByTestId('wb-wf-menu-restore')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('wb-wf-menu-delete-track')).toHaveTextContent('产品')
    await user.click(screen.getByTestId('wb-wf-menu-new'))
    expect(onCreate).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('wb-wf-menu'))
    await user.click(screen.getByTestId('wb-wf-menu-delete-track'))
    expect(onDeleteTrack).toHaveBeenCalledWith('pm')
  })

  it('⋯ 菜单 OpenSpec：自定义工作流可切换且勾选态跟随，default 禁用', async () => {
    const user = userEvent.setup()
    const { onToggleOpenspec } = renderNav({ current: 'release', openspec: true })
    await user.click(screen.getByTestId('wb-wf-menu'))
    const item = screen.getByTestId('wb-wf-menu-openspec')
    expect(item).toHaveAttribute('role', 'menuitemcheckbox')
    expect(item).toHaveAttribute('aria-checked', 'true')
    await user.click(item)
    expect(onToggleOpenspec).toHaveBeenCalledOnce()
    cleanup()
    renderNav({ current: 'default', openspec: true })
    await user.click(screen.getByTestId('wb-wf-menu'))
    expect(screen.getByTestId('wb-wf-menu-openspec')).toHaveAttribute('aria-disabled', 'true')
  })

  it('恢复内建：来源 global / project 可用，builtin 禁用', async () => {
    const user = userEvent.setup()
    for (const source of ['global', 'project'] as const) {
      const { onDelete } = renderNav({ defaultSource: source })
      await user.click(screen.getAllByTestId('wb-wf-menu').at(-1)!)
      const restore = screen.getAllByTestId('wb-wf-menu-restore').at(-1)!
      expect(restore).not.toHaveAttribute('aria-disabled')
      await user.click(restore)
      expect(onDelete).toHaveBeenCalledTimes(1)
      cleanup()
    }
    renderNav({ defaultSource: 'builtin' })
    await user.click(screen.getByTestId('wb-wf-menu'))
    expect(screen.getByTestId('wb-wf-menu-restore')).toHaveAttribute('aria-disabled', 'true')
  })

  it('轨道页签 label ?? id、aria-selected；「+」新建轨道；无 tracks 时没有页签行', async () => {
    const user = userEvent.setup()
    const { onSwitchBranch, onNewTrack } = renderNav()
    expect(screen.getByTestId('wb-track-pm')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('wb-track-mobile')).toHaveTextContent('mobile')
    await user.click(screen.getByTestId('wb-track-mobile'))
    expect(onSwitchBranch).toHaveBeenCalledWith('mobile')
    await user.click(screen.getByTestId('wb-track-new'))
    expect(onNewTrack).toHaveBeenCalledTimes(1)
  })

  it('回流弧：目标端 4px 开口箭头；悬停相关阶段整条弧转 accent-b，离开复原', async () => {
    const user = userEvent.setup()
    renderNav()
    const arrow = screen.getByTestId('wb-back-arrow-build-spec')
    expect(arrow).toHaveAttribute('d', backArrowPath(2))
    expect(backArrowPath(2)).toBe(`M4 ${2 * STEP_PITCH + 16} L0 ${2 * STEP_PITCH + 20} L4 ${2 * STEP_PITCH + 24}`)
    expect(arrow).not.toHaveAttribute('stroke-dasharray')
    const arc = screen.getByTestId('wb-back-arc-build-spec')
    expect(arc).toHaveClass('stroke-border-2')
    await user.hover(screen.getByTestId('wb-pipeline-node-spec'))
    expect(arc).toHaveClass('stroke-accent-b')
    expect(arc).toHaveAttribute('data-active', 'true')
    await user.unhover(screen.getByTestId('wb-pipeline-node-spec'))
    expect(arc).toHaveClass('stroke-border-2')
    await user.hover(screen.getByTestId('wb-pipeline-node-build'))
    expect(arc).toHaveClass('stroke-accent-b')
    await user.hover(screen.getByTestId('wb-pipeline-node-explore'))
    expect(arc).toHaveClass('stroke-border-2')
  })

  it('无 tracks：不渲染页签行，菜单没有删除轨道', async () => {
    const user = userEvent.setup()
    renderNav({ branches: [{ id: '', label: null }], branch: '' })
    expect(screen.queryByTestId('wb-tracks')).toBeNull()
    await user.click(screen.getByTestId('wb-wf-menu'))
    expect(screen.queryByTestId('wb-wf-menu-delete-track')).toBeNull()
  })

  it('流程：块只有名称与门禁图标；选中 aria-current；回流虚线按序号画；添加阶段', async () => {
    const user = userEvent.setup()
    const { onSelect, onAddStage } = renderNav()
    expect(screen.getByTestId('wb-step-explore')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('wb-step-explore')).toHaveTextContent('调研')
    expect(screen.getByTestId('wb-step-explore')).not.toHaveTextContent('tenon-explore')
    expect(screen.getByTestId('wb-gate-explore').querySelector('[data-gate="review"]')).not.toBeNull()
    expect(screen.queryByTestId('wb-gate-open')).toBeNull()
    expect(screen.getByTestId('wb-back-edge-build-spec')).toHaveAttribute('d', backEdgePath(3, 2))
    expect(backEdgePath(3, 2)).toContain(`${3 * STEP_PITCH + 20}`)
    await user.click(screen.getByTestId('wb-step-spec'))
    expect(onSelect).toHaveBeenCalledWith('spec')
    await user.click(screen.getByTestId('wb-add-stage'))
    expect(onAddStage).toHaveBeenCalledTimes(1)
  })

  it('lint：块上是警示图标（错误优先于警告），聚焦阶段块时 Tooltip 说出原因', async () => {
    // Radix Tooltip 的定位层要 ResizeObserver；jsdom 没有。
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    renderNav({ lint: [
      { kind: 'step-no-output', stepId: 'spec', severity: 'warning' },
      { kind: 'transition-empty-event', stepId: 'spec', severity: 'error' },
      { kind: 'step-no-output', stepId: 'build', severity: 'warning' },
    ] })
    expect(screen.getByTestId('wb-lint-spec')).toHaveAttribute('data-severity', 'error')
    expect(screen.getByTestId('wb-lint-build')).toHaveAttribute('data-severity', 'warning')
    expect(screen.getByTestId('wb-lint-build').tagName.toLowerCase()).toBe('svg')
    expect(screen.queryByTestId('wb-lint-open')).toBeNull()
    act(() => { screen.getByTestId('wb-step-build').focus() })
    expect(await screen.findByRole('tooltip')).toHaveTextContent('缺输出')
    vi.unstubAllGlobals()
  })

  it('阶段 ⋯ 只在选中的块上；删除阶段交给页面确认；只剩一个阶段或无凭证时禁用', async () => {
    const user = userEvent.setup()
    const { onDeleteStage } = renderNav()
    expect(screen.getByTestId('wb-stage-menu-explore')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-stage-menu-spec')).toBeNull()
    await user.click(screen.getByTestId('wb-stage-menu-explore'))
    await user.click(screen.getByTestId('wb-stage-delete-explore'))
    expect(onDeleteStage).toHaveBeenCalledWith('explore')
    cleanup()
    renderNav({ def: { name: 'solo', steps: [DEF.steps[0]!] }, selectedId: 'open' })
    await user.click(screen.getByTestId('wb-stage-menu-open'))
    expect(screen.getByTestId('wb-stage-delete-open')).toHaveAttribute('aria-disabled', 'true')
  })
})
