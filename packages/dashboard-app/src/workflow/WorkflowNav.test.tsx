import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { backEdgePath, STEP_PITCH, WorkflowNav } from './WorkflowNav'

function step(id: string, label: string, gate: WbStepDef['gate'], to: string[]): WbStepDef {
  return { id, label, gate, skills: [{ id: `tenon-${id}` }], inputs: [], outputs: [{ field: 'x', type: 'string' }], guards: [], transitions: to.map((target) => ({ event: `${id}-${target}`, to: target })) }
}
const DEF: WbWorkflowDef = { name: 'default', steps: [step('open', '立项', null, ['explore']), step('explore', '调研', 'review', ['spec']), step('spec', '规格', 'review', ['build']), step('build', '实现', null, ['verify', 'spec'])] }

function renderNav(overrides: Partial<Parameters<typeof WorkflowNav>[0]> = {}) {
  const fns = { onSwitch: vi.fn(), onSwitchBranch: vi.fn(), onCreate: vi.fn(), onExport: vi.fn(), onDelete: vi.fn(), onNewTrack: vi.fn(), onDeleteTrack: vi.fn(), onSelect: vi.fn(), onAddStage: vi.fn(), onReorder: vi.fn() }
  render(
    <I18nProvider>
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
        {...fns}
        {...overrides}
      />
    </I18nProvider>,
  )
  return fns
}

describe('WorkflowNav', () => {
  it('工作流名点开列表切换；副行显示来源与轨道数', async () => {
    const user = userEvent.setup()
    const { onSwitch } = renderNav()
    expect(screen.getByTestId('wb-wf-switch')).toHaveTextContent('default')
    expect(screen.getByTestId('wb-wf-meta')).toHaveTextContent('内建 · 2 轨道')
    await user.click(screen.getByTestId('wb-wf-switch'))
    expect(screen.getByTestId('wb-wf-item-default')).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByTestId('wb-wf-item-release'))
    expect(onSwitch).toHaveBeenCalledWith('release')
    expect(screen.queryByTestId('wb-wf-list')).toBeNull()
  })

  it('⋯ 菜单：新建 / 导出 / 恢复内建（内建时禁用）/ 删除当前轨道', async () => {
    const user = userEvent.setup()
    const { onCreate, onDeleteTrack } = renderNav()
    await user.click(screen.getByTestId('wb-wf-menu'))
    expect(screen.getByTestId('wb-wf-menu-restore')).toBeDisabled()
    expect(screen.getByTestId('wb-wf-menu-delete-track')).toHaveTextContent('产品')
    await user.click(screen.getByTestId('wb-wf-menu-new'))
    expect(onCreate).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('wb-wf-menu'))
    await user.click(screen.getByTestId('wb-wf-menu-delete-track'))
    expect(onDeleteTrack).toHaveBeenCalledWith('pm')
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
})
