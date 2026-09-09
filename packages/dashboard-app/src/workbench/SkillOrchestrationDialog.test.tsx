import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WbSkillEntry } from '../api/client'
import { I18nProvider } from '../i18n'
import type { BoardLane } from './boardLane'
import { SkillOrchestrationDialog } from './SkillOrchestrationDialog'

const LANE: BoardLane = {
  id: 'build',
  name: '实现',
  gate: null,
  skills: ['research', 'implement', 'verify'],
  skillDeps: { research: [], implement: ['research'], verify: ['implement'] },
  outputs: ['build_sha'],
  nonemptyGuard: true,
  linkEvent: 'done',
  count: 0,
  running: false,
}

const REGISTRY: WbSkillEntry[] = [
  { name: 'research', installed: true, source: 'builtin' },
  { name: 'implement', installed: true, source: 'builtin' },
  { name: 'verify', installed: true, source: 'builtin' },
  { name: 'browser-qa', installed: true, source: 'local-plugin', description: 'Inspect the real browser flow.' },
  { name: 'code-review', installed: true, source: 'user', description: 'Review changes against standards and the requested spec.' },
  { name: 'code-tour', installed: true, source: 'user', description: 'Create a guided code walkthrough.' },
]

function renderDialog(component: JSX.Element): void {
  render(<I18nProvider>{component}</I18nProvider>)
}

afterEach(() => {
  window.localStorage.removeItem('tenon-dashboard-lang')
})

describe('SkillOrchestrationDialog', () => {
  it('English locale covers the complete Skill orchestration dialog', () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    renderDialog(<SkillOrchestrationDialog lane={LANE} registry={REGISTRY} onClose={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} onMove={vi.fn()} onDependencyChange={vi.fn()} />)

    const dialog = screen.getByTestId('wb-skill-orchestration')
    expect(dialog).toHaveTextContent('Skill library')
    expect(dialog).toHaveTextContent('Execution plan')
    expect(dialog).toHaveTextContent('Execution order')
    expect(dialog).not.toHaveTextContent('技能库')
    expect(dialog).not.toHaveTextContent('执行计划')
    expect(dialog).not.toHaveTextContent('调用顺序')
    expect(screen.getByTestId('wb-skill-library-browser-qa')).toHaveTextContent('Inspect the real browser flow.')
  })

  it('左右排版展示技能库与有序执行计划，技能库不再显示加号按钮', () => {
    const onAdd = vi.fn()
    renderDialog(
      <SkillOrchestrationDialog
        lane={LANE}
        registry={REGISTRY}
        onClose={vi.fn()}
        onAdd={onAdd}
        onRemove={vi.fn()}
        onMove={vi.fn()}
        onDependencyChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: '技能库' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '实现 · 执行计划' })).toBeInTheDocument()
    expect(screen.getAllByText(/串行/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/并行/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '添加 browser-qa' })).toBeNull()
    const reviewCard = screen.getByTestId('wb-skill-library-code-review')
    expect(reviewCard).toHaveTextContent('code-review')
    expect(reviewCard).toHaveTextContent('按项目规范和需求目标检查当前代码变更。')
    expect(reviewCard).not.toHaveTextContent('为当前阶段提供一项可复用的专业执行能力')
    fireEvent.keyDown(screen.getByTestId('wb-skill-library-browser-qa'), { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledWith('build', 'browser-qa')
  })

  it('技能搜索与依赖配置声明稳定表单身份并关闭搜索自动填充', () => {
    renderDialog(<SkillOrchestrationDialog lane={LANE} registry={REGISTRY} onClose={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} onMove={vi.fn()} onDependencyChange={vi.fn()} />)

    const search = screen.getByRole('textbox', { name: '搜索技能' })
    expect(search).toHaveAttribute('name', 'skill-search')
    expect(search).toHaveAttribute('autocomplete', 'off')
    fireEvent.click(screen.getByRole('button', { name: 'implement 自定义依赖' }))
    expect(screen.getByRole('checkbox', { name: /research/ })).toHaveAttribute('name', 'skill-dependency-build-implement-research')
  })

  it('可把技能切为并行或接续上一项，变更映射到 depends_on', () => {
    const onDependencyChange = vi.fn()
    renderDialog(
      <SkillOrchestrationDialog
        lane={LANE}
        registry={REGISTRY}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onMove={vi.fn()}
        onDependencyChange={onDependencyChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'verify 与其他技能并行' }))
    expect(onDependencyChange).toHaveBeenCalledWith('build', 'verify', null, 'implement')
  })

  it('技能库可拖入计划，计划卡可拖动重排', () => {
    const onAdd = vi.fn()
    const onMove = vi.fn()
    renderDialog(
      <SkillOrchestrationDialog lane={LANE} registry={REGISTRY} onClose={vi.fn()} onAdd={onAdd} onRemove={vi.fn()} onMove={onMove} onDependencyChange={vi.fn()} />,
    )

    fireEvent.dragStart(screen.getByTestId('wb-skill-library-browser-qa'))
    fireEvent.drop(screen.getByTestId('wb-skill-plan-dropzone'))
    expect(onAdd).toHaveBeenCalledWith('build', 'browser-qa')

    fireEvent.dragStart(screen.getByTestId('wb-skill-plan-verify'))
    fireEvent.drop(screen.getByTestId('wb-skill-plan-research'), { clientY: 0 })
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ skillId: 'verify', refSkillId: 'research', after: false }))
  })

  it('计划卡提供键盘可聚焦的前后移动入口', () => {
    const onMove = vi.fn()
    renderDialog(<SkillOrchestrationDialog lane={LANE} registry={REGISTRY} onClose={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} onMove={onMove} onDependencyChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '将 Skill implement 向前移动' }))
    expect(onMove).toHaveBeenCalledWith({
      skillId: 'implement', fromStage: 'build', toStage: 'build', refSkillId: 'research', after: false,
    })
  })

  it('用批次拓扑直观区分并行与串行，而不是只显示开关', () => {
    renderDialog(<SkillOrchestrationDialog lane={LANE} registry={REGISTRY} onClose={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} onMove={vi.fn()} onDependencyChange={vi.fn()} />)

    const topology = screen.getByTestId('wb-skill-topology')
    expect(topology).toHaveTextContent('3 个批次')
    expect(topology).toHaveTextContent('第 1 批')
    expect(screen.getByLabelText('Skill 串并行执行拓扑')).toBeInTheDocument()
  })

  it('拖动经过计划卡时展示明确落点预览', () => {
    renderDialog(<SkillOrchestrationDialog lane={LANE} registry={REGISTRY} onClose={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} onMove={vi.fn()} onDependencyChange={vi.fn()} />)

    fireEvent.dragStart(screen.getByTestId('wb-skill-library-code-tour'))
    fireEvent.dragOver(screen.getByTestId('wb-skill-plan-implement'), { clientY: 0 })
    expect(screen.getByTestId('wb-skill-drop-preview')).toHaveTextContent('放到 implement 前面')
  })
})
