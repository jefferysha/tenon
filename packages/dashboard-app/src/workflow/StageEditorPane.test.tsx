import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WbEffectiveIo, WbSkillEntry, WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { producerSkills, StageEditorPane } from './StageEditorPane'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const EXPLORE: WbStepDef = {
  id: 'explore', label: '调研', gate: 'review',
  skills: [{ id: 'tenon-explore' }, { id: 'brainstorming', depends_on: ['tenon-explore'] }, { id: 'grill-with-docs', depends_on: ['tenon-explore'] }],
  inputs: [], outputs: [{ field: 'design_doc', type: 'file_path' }], guards: [], transitions: [{ event: 'explore-complete', to: 'spec' }],
}
const SPEC: WbStepDef = {
  id: 'spec', label: '规格', gate: null, skills: [{ id: 'tenon-spec' }],
  inputs: [{ field: 'design_doc', type: 'file_path' }], outputs: [{ field: 'plan', type: 'file_path' }], guards: [], transitions: [],
}
const DEF: WbWorkflowDef = { name: 'default', steps: [EXPLORE, SPEC] }
const IO: WbEffectiveIo = {
  explore: {
    inputs: [],
    outputs: [
      { kind: 'document', id: 'superpower-design', producers: ['brainstorming', 'superpowers:brainstorming'], consumers: ['spec'], locked: true },
      { kind: 'field', id: 'design_doc', type: 'file_path', producer: null, consumers: ['spec'] },
    ],
  },
  spec: {
    inputs: [
      { kind: 'document', id: 'superpower-design', producers: ['explore'], consumers: [], locked: true },
      { kind: 'field', id: 'design_doc', type: 'file_path', producer: 'explore', consumers: [] },
    ],
    outputs: [{ kind: 'field', id: 'plan', type: 'file_path', producer: null, consumers: [] }],
  },
}
const REGISTRY: WbSkillEntry[] = [
  { name: 'tenon-explore', installed: true, source: 'local-plugin', description: '调研 + 深度设计', available: true },
  { name: 'brainstorming', installed: true, source: 'external-marketplace', description: '把想法聊成设计', available: true },
]

function fakeEditor(step: WbStepDef, overrides: Partial<WorkflowEditor> = {}): WorkflowEditor {
  const labels = new Map(DEF.steps.map((candidate) => [candidate.id, candidate.label]))
  return {
    def: DEF, effectiveIo: IO, canWrite: true, lint: [], lintBlocked: false, dirty: false, saving: false, saveStatus: { kind: 'idle' },
    wfName: 'default', branch: 'pm', branches: [{ id: 'pm', label: '产品' }],
    labelOf: (id: string) => labels.get(id) ?? id,
    mandatory: { registry: REGISTRY },
    renameStep: vi.fn(), removeStage: vi.fn(), setGate: vi.fn(), setSkills: vi.fn(), save: vi.fn(), discardDraft: vi.fn(), reloadDefinition: vi.fn(),
    addTransition: vi.fn(), setTransitionEvent: vi.fn(), setTransitionTo: vi.fn(), removeTransition: vi.fn(),
    ...overrides,
    ...(step.id === 'spec' ? {} : {}),
  } as unknown as WorkflowEditor
}

function renderPane(step: WbStepDef, overrides: Partial<WorkflowEditor> = {}): WorkflowEditor {
  const editor = fakeEditor(step, overrides)
  render(<I18nProvider><StageEditorPane editor={editor} step={step} /></I18nProvider>)
  return editor
}

describe('StageEditorPane · 两栏定稿', () => {
  it('面包屑 = 工作流 › 轨道；标题输入直接改名；段落顺序 输入 → 技能 → 输出 → 门禁', async () => {
    const user = userEvent.setup()
    const editor = renderPane(EXPLORE)
    expect(screen.getByTestId('wb-crumbs')).toHaveTextContent('default')
    expect(screen.getByTestId('wb-crumbs')).toHaveTextContent('产品')
    expect(screen.getByTestId('wb-lane-name-explore')).toHaveTextContent('调研')
    expect(screen.getByTestId('wb-lane-name-input-explore')).toHaveValue('调研')
    await user.type(screen.getByTestId('wb-lane-name-input-explore'), '!')
    expect(editor.renameStep).toHaveBeenCalledWith('explore', '调研!')
    const order = ['stage-inputs', 'stage-skills', 'stage-outputs', 'stage-gate'].map((id) => screen.getByTestId(id))
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('输出表三列与输入对齐：文件 · 来源阶段（= 本阶段）· 来源技能；文档来源 = 契约候选 ∩ 阶段技能，字段 = 阶段全部技能', () => {
    renderPane(EXPLORE)
    const table = screen.getByTestId('io-outputs')
    expect(table).toHaveTextContent('文件')
    expect(table).toHaveTextContent('来源阶段')
    expect(table).toHaveTextContent('来源技能')
    expect(within(table).getByTestId('slot-stage-superpower-design')).toHaveTextContent('调研')
    expect(within(table).getByTestId('slot-skills-superpower-design')).toHaveTextContent('brainstorming')
    expect(within(table).getByTestId('slot-skills-superpower-design')).not.toHaveTextContent('superpowers:')
    expect(within(table).getByTestId('slot-skills-design_doc')).toHaveTextContent('tenon-explore, brainstorming, grill-with-docs')
    expect(screen.getByTestId('slot-field-design_doc')).toHaveAttribute('title', 'tracks.pm.steps[explore].outputs[design_doc]')
    expect(screen.queryByTestId('output-picker')).toBeNull()
  })

  it('输入表三列：来源阶段 + 该阶段里产出它的技能；无输入显示空态', () => {
    const { unmount } = render(<I18nProvider><StageEditorPane editor={fakeEditor(SPEC)} step={SPEC} /></I18nProvider>)
    const table = screen.getByTestId('io-inputs')
    expect(table).toHaveTextContent('来源阶段')
    expect(within(table).getByTestId('slot-stage-superpower-design')).toHaveTextContent('调研')
    expect(within(table).getByTestId('slot-skills-superpower-design')).toHaveTextContent('brainstorming')
    expect(within(table).getByTestId('slot-stage-design_doc')).toHaveTextContent('调研')
    expect(screen.queryByTestId('input-check-field-design_doc')).toBeNull()
    unmount()
    renderPane(EXPLORE)
    expect(within(screen.getByTestId('io-inputs')).getByRole('status')).toHaveTextContent('没有输入')
  })

  it('技能画布只读：节点数 = 技能数；点节点打开详情抽屉；编辑按钮打开编辑器', async () => {
    const user = userEvent.setup()
    renderPane(EXPLORE)
    expect(within(screen.getByTestId('stage-skills')).getByTestId('skill-flow')).toHaveAttribute('data-nodes', '3')
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-editable', 'false')
    expect(screen.getByTestId('wb-skills-edit')).toBeInTheDocument()
    await user.click(screen.getByTestId('wb-skills-edit'))
    expect(screen.getByTestId('skill-composer')).toBeInTheDocument()
  })

  it('门禁三选：aria-checked 跟随 step.gate，点选写回', async () => {
    const user = userEvent.setup()
    const editor = renderPane(EXPLORE)
    expect(screen.getByTestId('wb-lane-gate-explore-review')).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByTestId('wb-lane-gate-explore-auto'))
    expect(editor.setGate).toHaveBeenCalledWith('explore', 'auto')
  })
})

describe('producerSkills', () => {
  it('候选与阶段技能按裸名匹配；无命中为空，不编造不在阶段里的技能', () => {
    expect(producerSkills(['brainstorming', 'superpowers:brainstorming'], ['tenon-explore', 'brainstorming'])).toEqual(['brainstorming'])
    expect(producerSkills(['openspec-propose', 'opsx:propose'], ['tenon-open'])).toEqual([])
    expect(producerSkills(['tenon:tenon-verify'], ['tenon-verify'])).toEqual(['tenon-verify'])
  })
})

describe('StageEditorPane · 转移', () => {
  it('渲染事件与去向；去向下拉列出全部阶段（含靠前阶段，即回流）', () => {
    renderPane(EXPLORE)
    const table = screen.getByTestId('transitions-table')
    expect(table).toHaveTextContent('事件')
    expect(table).toHaveTextContent('去向')
    expect(screen.getByTestId('transition-event-0')).toHaveValue('explore-complete')
    expect(screen.getByTestId('transition-to-0')).toHaveValue('spec')
    expect(within(screen.getByTestId('transition-to-0')).getAllByRole('option').map((o) => o.textContent)).toEqual(['调研', '规格'])
  })

  it('无转移时显示空态', () => {
    renderPane(SPEC)
    expect(screen.getByTestId('transitions-empty')).toHaveTextContent('没有转移')
  })

  it('改事件名 / 改去向 / 删除 / 添加各自回调，添加缺省去向是下一阶段', async () => {
    const user = userEvent.setup()
    const editor = renderPane(EXPLORE)
    await user.type(screen.getByTestId('transition-event-0'), '!')
    expect(editor.setTransitionEvent).toHaveBeenCalledWith('explore', 0, 'explore-complete!')
    await user.selectOptions(screen.getByTestId('transition-to-0'), 'explore')
    expect(editor.setTransitionTo).toHaveBeenCalledWith('explore', 0, 'explore')
    await user.click(screen.getByTestId('transition-remove-0'))
    expect(editor.removeTransition).toHaveBeenCalledWith('explore', 0)
    await user.click(screen.getByTestId('wb-transition-add'))
    expect(editor.addTransition).toHaveBeenCalledWith('explore', 'spec')
  })

  it('无写入凭证：事件、去向、删除全部禁用，段头没有添加', () => {
    renderPane(EXPLORE, { canWrite: false })
    expect(screen.getByTestId('transition-event-0')).toBeDisabled()
    expect(screen.getByTestId('transition-to-0')).toBeDisabled()
    expect(screen.getByTestId('transition-remove-0')).toBeDisabled()
    expect(screen.queryByTestId('wb-transition-add')).toBeNull()
  })

  it('本阶段的转移 lint 显示在段内', () => {
    renderPane(EXPLORE, { lint: [{ kind: 'transition-contract-required', stepId: 'explore', to: 'spec' }] })
    expect(screen.getByTestId('stage-transitions-lint')).toHaveTextContent('受治理工作流要求本阶段可转移到「规格」')
  })
})
