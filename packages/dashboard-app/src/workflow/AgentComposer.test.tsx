import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSummary } from '../api/agentClient'
import type { WbStepTest } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { AgentComposer } from './AgentComposer'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const AGENTS: AgentSummary[] = [
  { name: 'builder', source: 'builtin', description: '实现', skills: [], tools: ['Read'], digest: 'sha256:a' },
  { name: 'security', source: 'custom', description: '安全评审', skills: [], tools: ['Read'], digest: 'sha256:b' },
]
const TESTS: WbStepTest[] = [{ id: 'unit', direction: 'unit', command: 'npm test' }]

function renderComposer(
  role: 'executors' | 'reviewers',
  onSave: (patch: unknown) => void,
  reviewers: Parameters<typeof AgentComposer>[0]['reviewers'] = [],
): void {
  render(
    <I18nProvider>
      <AgentComposer
        open
        role={role}
        stageLabel="实现"
        executors={[]}
        reviewers={reviewers}
        tests={TESTS}
        agents={AGENTS}
        onClose={() => undefined}
        onSave={onSave}
      />
    </I18nProvider>,
  )
}

describe('AgentComposer', () => {
  // 回归：StageEditorPane 每次重渲染都传 `?? []` 的新数组，草稿随之被清空，加上的评审者存不进 YAML。
  it('打开后父组件重渲染（传入新的空数组）不清空草稿，保存收到新增的评审者', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const element = (): JSX.Element => (
      <I18nProvider>
        <AgentComposer
          open
          role="reviewers"
          stageLabel="实现"
          executors={[]}
          reviewers={[]}
          tests={TESTS}
          agents={AGENTS}
          onClose={() => undefined}
          onSave={onSave}
        />
      </I18nProvider>
    )
    const view = render(element())
    await user.click(screen.getByTestId('palette-agent-add-security'))
    expect(screen.getByTestId('flow-node-security')).toBeInTheDocument()
    view.rerender(element())
    expect(screen.getByTestId('flow-node-security')).toBeInTheDocument()
    await user.click(screen.getByTestId('palette-agent-add-builder'))
    view.rerender(element())
    await user.click(screen.getByTestId('agent-composer-save'))
    expect(onSave).toHaveBeenCalledWith({
      reviewers: [
        { agent: 'security', required: true, block_at: 'high' },
        { agent: 'builder', required: true, block_at: 'high', depends_on: ['security'] },
      ],
    })
  })

  it('重新打开时按当时的 props 初始化草稿', () => {
    const props = { role: 'reviewers' as const, stageLabel: '实现', executors: [], tests: TESTS, agents: AGENTS, onClose: () => undefined, onSave: vi.fn() }
    const view = render(<I18nProvider><AgentComposer {...props} open={false} reviewers={[]} /></I18nProvider>)
    view.rerender(<I18nProvider><AgentComposer {...props} open reviewers={[{ agent: 'security', required: true, block_at: 'high' }]} /></I18nProvider>)
    expect(screen.getByTestId('flow-node-security')).toBeInTheDocument()
  })

  it('「+」把 agent 加进画布；执行者保存只写 agent 与 depends_on', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    renderComposer('executors', onSave)
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-editable', 'true')
    await user.click(screen.getByTestId('palette-agent-add-builder'))
    expect(screen.getByTestId('flow-node-builder')).toBeInTheDocument()
    expect(screen.getByTestId('palette-agent-builder')).toHaveAttribute('data-placed', 'true')
    await user.click(screen.getByTestId('agent-composer-save'))
    expect(onSave).toHaveBeenCalledWith({ executors: [{ agent: 'builder' }] })
  })

  it('评审者：新加的按 必需 / 高 落定，必需与阻断与读的测试都写进引用', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    renderComposer('reviewers', onSave)
    await user.click(screen.getByTestId('palette-agent-add-security'))
    await user.click(screen.getByTestId('palette-agent-open-security'))
    await user.click(screen.getByTestId('wb-agent-required-security-no'))
    await user.selectOptions(screen.getByTestId('wb-agent-block-security'), 'medium')
    await user.click(screen.getByTestId('wb-agent-test-security-unit'))
    await user.click(screen.getByTestId('agent-composer-save'))
    expect(onSave).toHaveBeenCalledWith({
      reviewers: [{ agent: 'security', required: false, block_at: 'medium', reads_tests: ['unit'] }],
    })
  })

  it('已有评审者的设置原样带进来，不因为重排丢失', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    renderComposer('reviewers', onSave, [{ agent: 'security', required: false, block_at: 'low' }])
    expect(screen.getByTestId('wb-agent-required-security-no')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-agent-block-security')).toHaveValue('low')
    await user.click(screen.getByTestId('palette-agent-add-builder'))
    await user.click(screen.getByTestId('agent-composer-save'))
    expect(onSave).toHaveBeenCalledWith({
      reviewers: [
        { agent: 'security', required: false, block_at: 'low' },
        { agent: 'builder', required: true, block_at: 'high', depends_on: ['security'] },
      ],
    })
  })
})
