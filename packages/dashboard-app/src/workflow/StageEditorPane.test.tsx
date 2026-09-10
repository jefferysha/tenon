import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WbEffectiveIo, WbSkillEntry, WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { producerSkills, StageEditorPane } from './StageEditorPane'

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
    def: DEF, effectiveIo: IO, canWrite: true, lintBlocked: false, dirty: false, saving: false, saveStatus: { kind: 'idle' },
    wfName: 'default', branch: 'pm', branches: [{ id: 'pm', label: '产品' }],
    labelOf: (id: string) => labels.get(id) ?? id,
    mandatory: { registry: REGISTRY },
    renameStep: vi.fn(), removeStage: vi.fn(), setGate: vi.fn(), setSkillWaves: vi.fn(), save: vi.fn(), discardDraft: vi.fn(), reloadDefinition: vi.fn(),
    ...overrides,
    ...(step.id === 'spec' ? {} : {}),
  } as unknown as WorkflowEditor
}

function renderPane(step: WbStepDef, overrides: Partial<WorkflowEditor> = {}): WorkflowEditor {
  const editor = fakeEditor(step, overrides)
  render(<I18nProvider><StageEditorPane editor={editor} step={step} /></I18nProvider>)
  return editor
}

describe('StageEditorPane · 面包屑 sheet', () => {
  it('头部 = 工作流 / 轨道 / 阶段；标题输入直接改名；技能按波次成卡片并带 description', async () => {
    const user = userEvent.setup()
    const editor = renderPane(EXPLORE)
    const crumbs = screen.getByTestId('wb-crumbs')
    expect(crumbs).toHaveTextContent('default')
    expect(crumbs).toHaveTextContent('产品')
    expect(screen.getByTestId('wb-lane-name-explore')).toHaveTextContent('调研')
    expect(screen.getByTestId('wb-lane-name-input-explore')).toHaveValue('调研')
    await user.type(screen.getByTestId('wb-lane-name-input-explore'), '!')
    expect(editor.renameStep).toHaveBeenCalledWith('explore', '调研!')
    expect(screen.getByTestId('skill-wave-0')).toHaveAttribute('data-parallel', 'false')
    expect(screen.getByTestId('skill-wave-1')).toHaveAttribute('data-parallel', 'true')
    expect(screen.getByTestId('skill-card-desc-brainstorming')).toHaveTextContent('把想法聊成设计')
    expect(within(screen.getByTestId('skill-card-tenon-explore')).getByTestId('skill-source-local-plugin')).toBeInTheDocument()
    expect(screen.queryByTestId('skill-card-desc-grill-with-docs')).toBeNull()
  })

  it('输出摘要卡 → 本列切成输出 sheet（面包屑追加「输出」），行只读：产出技能芯片 + 读取阶段；点阶段 crumb 返回', async () => {
    const user = userEvent.setup()
    renderPane(EXPLORE)
    expect(screen.getByTestId('wb-outputs-count')).toHaveTextContent('2')
    await user.click(screen.getByTestId('wb-open-outputs'))
    expect(screen.getByTestId('wb-sheet-title')).toHaveTextContent('输出')
    expect(screen.getByTestId('wb-crumb-sheet')).toHaveTextContent('输出')
    expect(screen.queryByTestId('output-picker')).toBeNull()
    expect(screen.queryByTestId('output-add')).toBeNull()
    const doc = screen.getByTestId('slot-document-superpower-design')
    expect(within(doc).getByTestId('slot-lock-superpower-design')).toBeInTheDocument()
    expect(within(doc).getByTestId('slot-skills-superpower-design')).toHaveTextContent('brainstorming')
    expect(within(doc).getByTestId('slot-skills-superpower-design')).not.toHaveTextContent('superpowers:brainstorming')
    expect(within(doc).getByTestId('slot-stages-superpower-design')).toHaveTextContent('规格')
    const field = screen.getByTestId('slot-field-design_doc')
    expect(within(field).getByTestId('slot-skills-design_doc')).toHaveTextContent('tenon-explore')
    expect(field).toHaveAttribute('title', 'tracks.pm.steps[explore].outputs[design_doc]')
    await user.click(screen.getByTestId('wb-lane-name-explore'))
    expect(screen.queryByTestId('wb-sheet-title')).toBeNull()
    expect(screen.getByTestId('wb-lane-name-input-explore')).toBeInTheDocument()
  })

  it('输入 sheet：来源 = 产出阶段与其技能；无勾选框', async () => {
    const user = userEvent.setup()
    renderPane(SPEC)
    await user.click(screen.getByTestId('wb-open-inputs'))
    const doc = screen.getByTestId('slot-document-superpower-design')
    expect(within(doc).getByTestId('slot-stages-superpower-design')).toHaveTextContent('调研')
    expect(within(doc).getByTestId('slot-skills-superpower-design')).toHaveTextContent('brainstorming')
    expect(screen.queryByTestId('input-check-field-design_doc')).toBeNull()
    expect(screen.getByTestId('slot-field-design_doc')).toHaveAttribute('title', 'tracks.pm.steps[spec].inputs[design_doc]')
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
  it('候选与阶段技能按裸名匹配；无命中时给去前缀去重的候选', () => {
    expect(producerSkills(['brainstorming', 'superpowers:brainstorming'], ['tenon-explore', 'brainstorming'])).toEqual(['brainstorming'])
    expect(producerSkills(['openspec-propose', 'opsx:propose'], ['tenon-open'])).toEqual(['openspec-propose', 'propose'])
    expect(producerSkills(['tenon:tenon-verify'], ['tenon-verify'])).toEqual(['tenon-verify'])
  })
})
