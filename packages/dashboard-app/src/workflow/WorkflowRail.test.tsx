import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { WorkflowRail } from './WorkflowRail'

function renderRail(overrides: Partial<Parameters<typeof WorkflowRail>[0]> = {}) {
  const onSwitchBranch = vi.fn()
  const onSwitch = vi.fn()
  const onNewTrack = vi.fn()
  const onDeleteTrack = vi.fn()
  const onCreate = vi.fn()
  const onExport = vi.fn()
  const onDelete = vi.fn()
  render(
    <I18nProvider>
      <WorkflowRail
        names={['default', 'branched']}
        current="default"
        defaultSource="builtin"
        stagesCountOf={() => 7}
        branches={[{ id: 'pm', label: '产品' }, { id: 'mobile', label: null }]}
        branch="pm"
        collapsed={false}
        canWrite
        busy={false}
        onToggle={() => undefined}
        onSwitch={onSwitch}
        onSwitchBranch={onSwitchBranch}
        onCreate={onCreate}
        onExport={onExport}
        onDelete={onDelete}
        onNewTrack={onNewTrack}
        onDeleteTrack={onDeleteTrack}
        {...overrides}
      />
    </I18nProvider>,
  )
  return { onSwitchBranch, onSwitch, onNewTrack, onDeleteTrack, onCreate, onExport, onDelete }
}

describe('WorkflowRail · 行内动作与分支树', () => {
  it('标题旁「+」新建工作流；当前工作流行内「+」新建轨道；轨道行「×」删除该轨道', async () => {
    const user = userEvent.setup()
    const { onCreate, onNewTrack, onDeleteTrack } = renderRail()
    await user.click(screen.getByTestId('wb-workflow-new'))
    expect(onCreate).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('wb-track-new-default'))
    expect(onNewTrack).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('wb-track-new-branched')).toBeNull()
    await user.click(screen.getByTestId('wb-track-delete-mobile'))
    expect(onDeleteTrack).toHaveBeenCalledWith('mobile')
  })

  it('「⋯」菜单：导出 YAML；default 内建时「恢复内建」禁用，项目覆盖时可用', async () => {
    const user = userEvent.setup()
    const { onExport } = renderRail()
    await user.click(screen.getByTestId('wb-wf-menu-default'))
    await user.click(screen.getByTestId('wb-wf-menu-default-export'))
    expect(onExport).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('wb-wf-menu-default-menu')).toBeNull()
    await user.click(screen.getByTestId('wb-wf-menu-default'))
    expect(screen.getByTestId('wb-wf-menu-default-restore')).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('wb-wf-menu-default-menu')).toBeNull()
  })

  it('非 default 工作流的菜单是「删除工作流」', async () => {
    const user = userEvent.setup()
    const { onDelete } = renderRail({ current: 'branched', defaultSource: 'project' })
    await user.click(screen.getByTestId('wb-wf-menu-branched'))
    await user.click(screen.getByTestId('wb-wf-menu-branched-delete'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('分支树：名称 = label ?? id；点分支切换；单条 pipeline 的工作流没有分支树', async () => {
    const user = userEvent.setup()
    const { onSwitchBranch } = renderRail()
    expect(screen.getByTestId('wb-wf-branches-default')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-wf-branches-branched')).toBeNull()
    expect(screen.getByTestId('wb-branch-pm')).toHaveTextContent('产品')
    expect(screen.getByTestId('wb-branch-mobile')).toHaveTextContent('mobile')
    expect(screen.getByTestId('wb-branch-pm')).toHaveAttribute('aria-current', 'true')
    await user.click(screen.getByTestId('wb-branch-mobile'))
    expect(onSwitchBranch).toHaveBeenCalledWith('mobile')
    expect(screen.getByTestId('wb-wf-item-default')).toHaveTextContent('2 轨道')
  })

  it('无 tracks 的工作流：不展开分支树；没有编辑凭证时动作全部禁用', () => {
    renderRail({ branches: [{ id: '', label: null }], branch: '', canWrite: false })
    expect(screen.queryByTestId('wb-wf-branches-default')).toBeNull()
    expect(screen.getByTestId('wb-workflow-new')).toBeDisabled()
    expect(screen.getByTestId('wb-track-new-default')).toBeDisabled()
  })
})
