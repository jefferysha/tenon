import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { WorkflowRail } from './WorkflowRail'

function renderRail(overrides: Partial<Parameters<typeof WorkflowRail>[0]> = {}) {
  const onSwitchBranch = vi.fn()
  const onSwitch = vi.fn()
  const onNewTrack = vi.fn()
  render(
    <I18nProvider>
      <WorkflowRail
        names={['default', 'branched']}
        current="default"
        defaultSource="builtin"
        stagesCountOf={() => 7}
        branches={[{ id: 'pm', label: '产品' }, { id: 'mobile', label: 'mobile' }]}
        branch="pm"
        collapsed={false}
        canWrite
        busy={false}
        onToggle={() => undefined}
        onSwitch={onSwitch}
        onSwitchBranch={onSwitchBranch}
        onCreate={() => undefined}
        onImport={() => undefined}
        onExport={() => undefined}
        onDelete={() => undefined}
        onNewTrack={onNewTrack}
        onDeleteTrack={() => undefined}
        {...overrides}
      />
    </I18nProvider>,
  )
  return { onSwitchBranch, onSwitch, onNewTrack }
}

describe('WorkflowRail · 分支树', () => {
  it('当前工作流展开为各 track；名称 = label ?? id；点分支切换；单条 pipeline 的工作流不显示分支树', async () => {
    const user = userEvent.setup()
    const { onSwitchBranch } = renderRail()
    expect(screen.getByTestId('wb-wf-branches-default')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-wf-branches-branched')).toBeNull()
    expect(screen.queryByTestId('wb-branch-base')).toBeNull()
    expect(screen.getByTestId('wb-branch-pm')).toHaveTextContent('产品')
    expect(screen.getByTestId('wb-branch-mobile')).toHaveTextContent('mobile')
    expect(screen.getByTestId('wb-branch-pm')).toHaveAttribute('aria-current', 'true')
    await user.click(screen.getByTestId('wb-branch-mobile'))
    expect(onSwitchBranch).toHaveBeenCalledWith('mobile')
    expect(screen.getByTestId('wb-wf-item-default')).toHaveTextContent('2 轨道')
  })

  it('无 tracks 的工作流：不展开分支树，也没有「删除轨道」', () => {
    renderRail({ branches: [{ id: '', label: null }], branch: '' })
    expect(screen.queryByTestId('wb-wf-branches-default')).toBeNull()
    expect(screen.queryByTestId('wb-track-delete')).toBeNull()
  })

  it('选中 track 分支时才出现「删除轨道」；新建轨道始终可用', () => {
    renderRail({ branch: 'pm' })
    expect(screen.getByTestId('wb-track-delete')).toBeInTheDocument()
    expect(screen.getByTestId('wb-track-new')).toBeEnabled()
    expect(screen.getByTestId('wb-branch-pm')).toHaveAttribute('aria-current', 'true')
  })
})
