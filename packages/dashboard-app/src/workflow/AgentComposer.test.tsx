import { render, screen, waitFor } from '@testing-library/react'
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
  it('文案按角色：空画布与搜索都按角色（拖入评审者 / 搜索评审者），提示用「智能体」，控件标签是中文', () => {
    renderComposer('reviewers', vi.fn())
    expect(screen.getByTestId('skill-flow-empty')).toHaveTextContent('拖入评审者')
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('aria-label', '评审者')
    expect(screen.getByTestId('agent-palette-search')).toHaveAttribute('placeholder', '搜索评审者')
    expect(screen.getByTestId('agent-composer-detail')).toHaveTextContent('选一个智能体')
    const labels = JSON.parse(screen.getByTestId('react-flow').getAttribute('data-aria-labels') ?? '{}') as Record<string, string>
    expect(labels['controls.zoomIn.ariaLabel']).toBe('放大')
  })

  it('执行者画布为空时写「拖入执行者」，搜索框写「搜索执行者」', () => {
    renderComposer('executors', vi.fn())
    expect(screen.getByTestId('skill-flow-empty')).toHaveTextContent('拖入执行者')
    expect(screen.getByTestId('agent-palette-search')).toHaveAttribute('placeholder', '搜索执行者')
  })

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

  it('× 叫「关闭」；打开即聚焦搜索框；没改动时「完成」不可点，改了才可点', async () => {
    const user = userEvent.setup()
    renderComposer('executors', vi.fn())
    expect(screen.getByTestId('agent-composer-close')).toHaveAccessibleName('关闭')
    await waitFor(() => expect(screen.getByTestId('agent-palette-search')).toHaveFocus())
    expect(screen.getByTestId('agent-composer-save')).toHaveTextContent('完成')
    expect(screen.getByTestId('agent-composer-save')).toBeDisabled()
    await user.click(screen.getByTestId('palette-agent-add-builder'))
    expect(screen.getByTestId('agent-composer-save')).toBeEnabled()
  })

  // 用户要求：先看再决定。点行只在右栏显示（不加入），行尾「+」才加入。
  it('点行只选中查看、不加入；行尾「+」（40px）才加入画布', async () => {
    const user = userEvent.setup()
    renderComposer('reviewers', vi.fn(), [{ agent: 'security', required: true, block_at: 'high' }])
    const row = screen.getByTestId('palette-agent-open-builder')
    expect(row.className).toContain('min-h-10')
    await user.click(row)
    expect(screen.queryByTestId('flow-node-builder')).toBeNull()
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-nodes', '1')
    expect(screen.getByTestId('palette-agent-open-builder')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('agent-composer-save')).toBeDisabled()
    const add = screen.getByTestId('palette-agent-add-builder')
    expect(add).toHaveAccessibleName('加入 builder')
    expect(add.className).toContain('size-10')
    await user.click(add)
    expect(screen.getByTestId('flow-node-builder')).toBeInTheDocument()
    expect(screen.getByTestId('palette-agent-add-builder')).toBeDisabled()
  })

  it('评审者设置：字段名是「级别」与「阻断阈值」', () => {
    renderComposer('reviewers', vi.fn(), [{ agent: 'security', required: true, block_at: 'high' }])
    expect(screen.getByRole('radiogroup', { name: '级别' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-composer-detail')).toHaveTextContent('阻断阈值')
    expect(screen.getByTestId('agent-composer-detail')).not.toHaveTextContent('必需必需')
  })
})
