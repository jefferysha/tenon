import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import gsap from 'gsap'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { WbEffectiveIo, WbSkillEntry, WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { producerSkills } from './producers'
import { SECTION_STAGGER, StageEditorPane } from './StageEditorPane'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const EXPLORE: WbStepDef = {
  id: 'explore', label: '调研', gate: 'review',
  skills: [{ id: 'tenon-explore' }, { id: 'brainstorming', depends_on: ['tenon-explore'] }, { id: 'grill-with-docs', depends_on: ['tenon-explore'] }],
  inputs: [], outputs: [{ field: 'design_doc', type: 'file_path' }], guards: [], transitions: [{ event: 'explore-complete', to: 'spec' }],
}
const SPEC: WbStepDef = {
  id: 'spec', label: '规格', gate: null, skills: [{ id: 'tenon-spec' }],
  inputs: [{ field: 'design_doc', type: 'file_path' }], outputs: [{ field: 'plan', type: 'file_path' }], guards: [],
  transitions: [{ event: 'spec-back', to: 'explore', actions: [{ type: 'reset-pre-verify-review' }] }],
}
const DEF: WbWorkflowDef = { name: 'default', steps: [EXPLORE, SPEC] }
const IO: WbEffectiveIo = {
  explore: {
    inputs: [],
    outputs: [
      { kind: 'document', id: 'superpower-design', producers: ['brainstorming', 'superpowers:brainstorming'], consumers: ['spec'], role: 'produce', scope: 'change' },
      { kind: 'field', id: 'design_doc', type: 'file_path', producer: null, consumers: ['spec'] },
    ],
  },
  spec: {
    inputs: [
      { kind: 'document', id: 'superpower-design', producers: ['explore'], consumers: [], role: 'read', scope: 'change' },
      { kind: 'field', id: 'design_doc', type: 'file_path', producer: 'explore', consumers: [] },
    ],
    outputs: [{ kind: 'field', id: 'plan', type: 'file_path', producer: null, consumers: [] }],
  },
}
const AGENTS = [
  { name: 'builder', source: 'builtin' as const, description: '实现', skills: [], tools: ['Read'], digest: 'sha256:a' },
  { name: 'security', source: 'custom' as const, description: '安全评审', skills: [], tools: ['Read'], digest: 'sha256:b' },
]
const REGISTRY: WbSkillEntry[] = [
  { name: 'tenon-explore', installed: true, source: 'local-plugin', description: '调研 + 深度设计', available: true },
  { name: 'brainstorming', installed: true, source: 'external-marketplace', description: '把想法聊成设计', available: true },
]

function fakeEditor(step: WbStepDef, overrides: Partial<WorkflowEditor> = {}): WorkflowEditor {
  const labels = new Map(DEF.steps.map((candidate) => [candidate.id, candidate.label]))
  return {
    def: DEF, effectiveIo: IO, canWrite: true, lint: [], lintBlocked: false, dirty: false, changeCount: 0, saving: false, saveStatus: { kind: 'idle' },
    wfName: 'default', branch: 'pm', branches: [{ id: 'pm', label: '产品' }],
    labelOf: (id: string) => labels.get(id) ?? id,
    mandatory: { registry: REGISTRY },
    agents: AGENTS,
    setAgents: vi.fn(),
    renameStep: vi.fn(), removeStage: vi.fn(), setGate: vi.fn(), setSkills: vi.fn(), save: vi.fn(), discardDraft: vi.fn(), reloadDefinition: vi.fn(),
    setStageBack: vi.fn(),
    ...overrides,
    ...(step.id === 'spec' ? {} : {}),
  } as unknown as WorkflowEditor
}

function renderPane(step: WbStepDef, overrides: Partial<WorkflowEditor> = {}): WorkflowEditor {
  const editor = fakeEditor(step, overrides)
  render(<I18nProvider><StageEditorPane editor={editor} step={step} /></I18nProvider>)
  return editor
}

// Radix Select 在 jsdom 里要用到指针捕获与 scrollIntoView。
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})

describe('StageEditorPane · 两栏定稿', () => {
  it('没有面包屑与「n / N」：工作流名与轨道只在左栏；标题输入直接改名；段落顺序 输入 → 技能 → 输出 → 门禁', async () => {
    const user = userEvent.setup()
    const editor = renderPane(EXPLORE)
    expect(screen.queryByTestId('wb-crumbs')).toBeNull()
    expect(screen.getByTestId('stage-editor-pane')).not.toHaveTextContent('default')
    expect(screen.getByTestId('stage-editor-pane')).not.toHaveTextContent('1 / 2')
    expect(screen.queryByTestId('wb-lane-remove-explore')).toBeNull()
    expect(screen.getByTestId('wb-lane-name-explore')).toHaveTextContent('调研')
    expect(screen.getByTestId('wb-lane-name-input-explore')).toHaveValue('调研')
    await user.type(screen.getByTestId('wb-lane-name-input-explore'), '!')
    expect(editor.renameStep).toHaveBeenCalledWith('explore', '调研!')
    const order = ['stage-inputs', 'stage-skills', 'stage-outputs', 'stage-gate'].map((id) => screen.getByTestId(id))
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId('workflow-runtime-artifacts')).toBeNull()
  })

  // 用户定稿：输入 / 输出是同一张等分表（文件 · 来源阶段 · 来源技能），不显示读取阶段。
  it('输出表与输入表同列同表头：文件 · 来源阶段 · 来源技能，不列读取阶段；输出的来源阶段 = 本阶段', () => {
    renderPane(EXPLORE)
    const table = screen.getByTestId('io-outputs')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['文件', '来源阶段', '来源技能'])
    expect(within(screen.getByTestId('io-inputs')).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['文件', '来源阶段', '来源技能'])
    expect(table).not.toHaveTextContent('规格')
    expect(within(table).getByTestId('slot-stage-superpower-design')).toHaveTextContent('调研')
    expect(within(table).getByTestId('slot-stage-design_doc')).toHaveTextContent('调研')
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
    expect(within(screen.getByTestId('io-inputs')).getByRole('status')).toHaveTextContent('无')
  })

  it('没有技能：段内只写「无」，不渲染空画布', () => {
    renderPane({ ...EXPLORE, skills: [] })
    expect(screen.getByTestId('stage-skills-empty')).toHaveTextContent('无')
    expect(within(screen.getByTestId('stage-skills')).queryByTestId('skill-flow')).toBeNull()
  })

  it('保存条只在有改动时渲染：写「未保存 N 处」，贴底半透明；没改动（含无写入凭证）整条不渲染', () => {
    renderPane(EXPLORE, { dirty: true, changeCount: 3 })
    expect(screen.getByTestId('wb-dirty')).toHaveTextContent('未保存 3 处')
    const bar = screen.getByTestId('wb-save-bar')
    for (const token of ['sticky', 'bottom-0', 'bg-card/85', 'backdrop-blur-md', 'border-t']) expect(bar.className).toContain(token)
    expect(screen.getByTestId('wb-save')).toBeEnabled()
    expect(bar).not.toHaveTextContent('default')
    cleanup()
    renderPane(EXPLORE)
    expect(screen.queryByTestId('wb-save-bar')).toBeNull()
    expect(screen.queryByTestId('wb-dirty')).toBeNull()
    expect(screen.queryByTestId('wb-save')).toBeNull()
    expect(screen.getByTestId('stage-editor-pane').querySelector('footer')).toBeNull()
    cleanup()
    renderPane(EXPLORE, { canWrite: false })
    expect(screen.queryByTestId('wb-save-bar')).toBeNull()
  })

  it('保存条：改动清空（保存成功 / 放弃）后卸载；保存失败时仍在并显示原因；点保存 / 放弃各自回调', async () => {
    const user = userEvent.setup()
    const editor = fakeEditor(EXPLORE, { dirty: true, changeCount: 1, saveStatus: { kind: 'error', errors: ['冲突'], conflict: true } })
    const { rerender } = render(<I18nProvider><StageEditorPane editor={editor} step={EXPLORE} /></I18nProvider>)
    expect(screen.getByTestId('wb-save-error')).toHaveTextContent('冲突')
    expect(screen.getByTestId('wb-save-conflict-reload')).toBeInTheDocument()
    await user.click(screen.getByTestId('wb-save'))
    expect(editor.save).toHaveBeenCalled()
    await user.click(screen.getByTestId('wb-discard'))
    expect(editor.discardDraft).toHaveBeenCalled()
    rerender(<I18nProvider><StageEditorPane editor={{ ...editor, dirty: false, changeCount: 0, saveStatus: { kind: 'ok' } } as WorkflowEditor} step={EXPLORE} /></I18nProvider>)
    expect(screen.queryByTestId('wb-save-bar')).toBeNull()
  })

  it('lint 挡住保存时保存条说明原因、保存禁用', () => {
    renderPane(EXPLORE, { dirty: true, changeCount: 2, lintBlocked: true })
    expect(screen.getByTestId('wb-dirty')).not.toHaveTextContent('未保存 2 处')
    expect(screen.getByTestId('wb-save')).toBeDisabled()
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

  it('执行者在技能之后、评审者在门禁之前；没有 agent 的步骤两段都显示「无」', () => {
    renderPane(EXPLORE)
    const order = ['stage-inputs', 'stage-skills', 'stage-executors', 'stage-outputs', 'stage-reviewers', 'stage-gate']
      .map((id) => screen.getByTestId(id))
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('stage-executors-empty')).toHaveTextContent('无')
    expect(screen.getByTestId('stage-reviewers-empty')).toHaveTextContent('无')
  })

  it('评审者节点名下写出 必需 · 阻断 · 测试 n；编辑按钮打开 agent 编辑器', async () => {
    const user = userEvent.setup()
    const step: WbStepDef = {
      ...EXPLORE,
      agents: {
        executors: [{ agent: 'builder' }],
        reviewers: [{ agent: 'security', required: true, block_at: 'medium', reads_tests: ['unit'] }],
      },
    }
    renderPane(step)
    expect(within(screen.getByTestId('stage-executors')).getByTestId('skill-flow')).toHaveAttribute('data-nodes', '1')
    expect(screen.getByTestId('flow-caption-security')).toHaveTextContent('必需 · 中 · 测试 1')
    // 画布的可访问名称跟段落走，不是笼统的「技能」（H6）。
    expect(within(screen.getByTestId('stage-executors')).getByRole('group', { name: '执行者' })).toBeInTheDocument()
    expect(within(screen.getByTestId('stage-reviewers')).getByRole('group', { name: '评审者' })).toBeInTheDocument()
    await user.click(screen.getByTestId('wb-reviewers-edit'))
    expect(screen.getByTestId('agent-composer')).toBeInTheDocument()
  })

  it('门禁是分段控件：fill 轨道，选中项里有白色滑块，没有内联说明图标', () => {
    renderPane(EXPLORE)
    const group = screen.getByTestId('wb-lane-gate-explore')
    expect(group).toHaveAttribute('role', 'radiogroup')
    expect(group.className).toContain('bg-fill')
    const thumbs = group.querySelectorAll('[data-segment-thumb]')
    expect(thumbs).toHaveLength(1)
    expect(screen.getByTestId('wb-lane-gate-explore-review')).toContainElement(thumbs[0] as HTMLElement)
    expect(thumbs[0]).toHaveClass('bg-card', 'shadow-sm')
    expect(screen.getByTestId('wb-lane-gate-explore-review')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('wb-lane-gate-explore-auto')).toHaveAttribute('tabindex', '-1')
    expect(group.querySelector('.lucide-info')).toBeNull()
  })

  it('门禁键盘：方向键在三项间移动并选中', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    const user = userEvent.setup()
    const editor = renderPane(EXPLORE)
    act(() => { screen.getByTestId('wb-lane-gate-explore-review').focus() })
    await user.keyboard('{ArrowRight}')
    expect(editor.setGate).toHaveBeenCalledWith('explore', 'auto')
    expect(screen.getByTestId('wb-lane-gate-explore-auto')).toHaveFocus()
  vi.unstubAllGlobals()
  })

  it('门禁三选：aria-checked 跟随 step.gate，点选写回；说明用 Tooltip（聚焦可达），不用原生 title', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    const user = userEvent.setup()
    const editor = renderPane(EXPLORE)
    const review = screen.getByTestId('wb-lane-gate-explore-review')
    expect(review).toHaveAttribute('aria-checked', 'true')
    expect(review).not.toHaveAttribute('title')
    expect(review).toHaveAccessibleDescription('产物齐全后需人工确认')
    act(() => { screen.getByTestId('wb-lane-gate-explore-none').focus() })
    expect(await screen.findByRole('tooltip')).toHaveTextContent('不拦')
    vi.unstubAllGlobals()
    await user.click(screen.getByTestId('wb-lane-gate-explore-auto'))
    expect(editor.setGate).toHaveBeenCalledWith('explore', 'auto')
  })
})

describe('StageEditorPane · 切换阶段的进场', () => {
  it('按阶段重挂载时各段依次上浮淡入（revealList，错开 0.03s）', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: !query.includes('prefers-reduced-motion: reduce'), media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }))
    const fromTo = vi.spyOn(gsap, 'fromTo')
    renderPane(EXPLORE)
    const call = fromTo.mock.calls.find((args) => (args[2] as gsap.TweenVars).stagger === SECTION_STAGGER)
    expect(call).toBeDefined()
    expect(call![1]).toMatchObject({ opacity: 0 })
    const sections = document.querySelectorAll('[data-stage-sections] > *')
    expect(sections.length).toBeGreaterThanOrEqual(6)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})

describe('StageEditorPane · OpenSpec 文档 IO', () => {
  const GOV_OPEN: WbStepDef = {
    id: 'open', label: '立项', gate: null, skills: [{ id: 'openspec-propose' }],
    inputs: [], outputs: [], guards: [], transitions: [{ event: 'open-complete', to: 'build' }],
  }
  const GOV_BUILD: WbStepDef = {
    id: 'build', label: '实现', gate: null, skills: [{ id: 'tenon-build' }],
    inputs: [], outputs: [], guards: [], transitions: [],
  }
  const GOVERNED: WbWorkflowDef = {
    name: 'mine',
    openspec: true,
    documentContract: { version: 'v1', slots: [{ kind: 'proposal', ownerStep: 'open', producers: ['openspec-propose'] }], reads: [] },
    steps: [GOV_OPEN, GOV_BUILD],
  }
  const GOVERNED_IO: WbEffectiveIo = {
    open: { inputs: [], outputs: [{ kind: 'document', id: 'proposal', role: 'produce', scope: 'change', producers: ['openspec-propose'], consumers: [] }] },
    build: { inputs: [], outputs: [] },
  }

  function renderGoverned(step: WbStepDef, overrides: Partial<WorkflowEditor> = {}): WorkflowEditor {
    const editor = fakeEditor(step, {
      def: GOVERNED,
      effectiveIo: GOVERNED_IO,
      addDocumentOutput: vi.fn(),
      removeDocumentSlot: vi.fn(),
      setDocumentInputs: vi.fn(),
      ...overrides,
    })
    render(<I18nProvider><StageEditorPane editor={editor} step={step} /></I18nProvider>)
    return editor
  }

  it('+ 输出：只列本分支技能能产出、本阶段还没声明的文档；选中写回；文档行可移除', async () => {
    const user = userEvent.setup()
    const editor = renderGoverned(GOV_OPEN)
    await user.click(screen.getByTestId('wb-outputs-add'))
    const picker = screen.getByTestId('wb-outputs-picker')
    expect(within(picker).queryByTestId('wb-output-option-proposal')).toBeNull()
    expect(within(picker).getByTestId('wb-output-option-openspec-design')).toHaveTextContent('openspec-propose')
    await user.click(within(picker).getByTestId('wb-output-option-tasks'))
    expect(editor.addDocumentOutput).toHaveBeenCalledWith('open', 'tasks')
    await user.click(screen.getByTestId('slot-remove-proposal'))
    expect(editor.removeDocumentSlot).toHaveBeenCalledWith('open', 'proposal', 'outputs')
  })

  it('+ 输入：勾选上游已声明的输出与项目文档（无来源显示 —），勾选写回', async () => {
    const user = userEvent.setup()
    const editor = renderGoverned(GOV_BUILD)
    await user.click(screen.getByTestId('wb-inputs-edit'))
    expect(screen.getByTestId('wb-input-option-proposal')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('wb-input-option-design-md')).toHaveTextContent('—')
    await user.click(screen.getByTestId('wb-input-option-proposal'))
    expect(editor.setDocumentInputs).toHaveBeenCalledWith('build', ['proposal'])
  })

  it('文档 lint 显示在输出下方；未开启 OpenSpec 时没有 + 输入 / + 输出', () => {
    renderGoverned(GOV_OPEN, { lint: [{ kind: 'document-chain-gap', stepId: 'open', document: 'proposal', missing: 'tasks', severity: 'warning' }] })
    expect(screen.getByTestId('stage-document-lint')).toHaveTextContent('缺 tasks')
    cleanup()
    renderPane(EXPLORE)
    expect(screen.queryByTestId('wb-outputs-add')).toBeNull()
    expect(screen.queryByTestId('wb-inputs-edit')).toBeNull()
  })
})

describe('producerSkills', () => {
  it('候选与阶段技能按裸名匹配；无命中为空，不编造不在阶段里的技能', () => {
    expect(producerSkills(['brainstorming', 'superpowers:brainstorming'], ['tenon-explore', 'brainstorming'])).toEqual(['brainstorming'])
    expect(producerSkills(['openspec-propose', 'opsx:propose'], ['tenon-open'])).toEqual([])
    expect(producerSkills(['tenon:tenon-verify'], ['tenon-verify'])).toEqual(['tenon-verify'])
  })
})

describe('StageEditorPane · 退回', () => {
  it('退回下拉只列本阶段之前的阶段，加「不退回」；当前值取自指向靠前阶段的那条 transition', async () => {
    const user = userEvent.setup()
    renderPane(SPEC)
    const trigger = screen.getByTestId('wb-lane-back-spec')
    expect(trigger).toHaveAttribute('role', 'combobox')
    expect(trigger).toHaveTextContent('退回到「调研」')
    await user.click(trigger)
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['不退回', '退回到「调研」'])
  })

  it('界面上没有事件名和正向去向', () => {
    renderPane(SPEC)
    expect(screen.queryByText('事件')).toBeNull()
    expect(screen.queryByText('去向')).toBeNull()
    expect(screen.getByTestId('stage-back')).toHaveTextContent('退回')
  })

  it('第一个阶段没有可退回的目标，整段不渲染', () => {
    renderPane(EXPLORE)
    expect(screen.queryByTestId('stage-back')).toBeNull()
  })


  it('选目标与选「不退回」各自回调', async () => {
    const user = userEvent.setup()
    const editor = renderPane(SPEC)
    await user.click(screen.getByTestId('wb-lane-back-spec'))
    await user.click(screen.getByTestId('wb-lane-back-option-spec-none'))
    expect(editor.setStageBack).toHaveBeenCalledWith('spec', null)
    cleanup()
    const unlinked: WbStepDef = { ...SPEC, transitions: [] }
    const second = renderPane(unlinked, { def: { ...DEF, steps: [EXPLORE, unlinked] } })
    expect(screen.getByTestId('wb-lane-back-spec')).toHaveTextContent('不退回')
    await user.click(screen.getByTestId('wb-lane-back-spec'))
    await user.click(screen.getByTestId('wb-lane-back-option-spec-explore'))
    expect(second.setStageBack).toHaveBeenCalledWith('spec', 'explore')
  })

  it('无写入凭证时下拉禁用', () => {
    renderPane(SPEC, { canWrite: false })
    expect(screen.getByTestId('wb-lane-back-spec')).toBeDisabled()
  })

  it('本阶段的退回 lint 显示在段内', () => {
    renderPane(SPEC, { lint: [{ kind: 'transition-contract-required', stepId: 'spec', to: 'explore', severity: 'error' }] })
    expect(screen.getByTestId('stage-back-lint')).toHaveTextContent('受治理工作流要求本阶段可退回「调研」')
  })

  it('既不去下一阶段也不退回的转移：段内说出事件与目标', () => {
    renderPane(SPEC, { lint: [{ kind: 'transition-not-next-or-back', stepId: 'spec', event: 'spec-complete', to: 'spec', severity: 'error' }] })
    expect(screen.getByTestId('stage-back-lint')).toHaveTextContent('「spec-complete」→「规格」：只能是去下一阶段的唯一一条，或退回更早的阶段')
  })

  it('第一个阶段带着往后跳的边：段落只为说出问题而出现，没有下拉', () => {
    renderPane(EXPLORE, { lint: [{ kind: 'transition-not-next-or-back', stepId: 'explore', event: 'explore-skip', to: 'ship', severity: 'error' }] })
    expect(screen.getByTestId('stage-back-lint')).toHaveTextContent('「explore-skip」→「ship」')
    expect(screen.queryByTestId('wb-lane-back-explore')).toBeNull()
  })
})

describe('StageEditorPane 测试段', () => {
  it('测试段排在输出与门禁之间，行可点开抽屉，改命令经 setTests 回草稿', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, directions: [] }), { status: 200 }))
    const setTests = vi.fn()
    const step: WbStepDef = {
      ...EXPLORE,
      tests: [{ id: 'unit', direction: 'unit', command: 'npm test', label: '单测', required: true }],
    }
    renderPane(step, { setTests, def: { ...DEF, steps: [step, SPEC] } })
    const order = [...document.querySelectorAll('[data-testid]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id): id is string => id === 'stage-outputs' || id === 'stage-tests' || id === 'stage-gate')
    expect(order).toEqual(['stage-outputs', 'stage-tests', 'stage-gate'])

    await userEvent.click(screen.getByTestId('wb-test-unit'))
    await userEvent.clear(screen.getByTestId('wb-test-command'))
    await userEvent.type(screen.getByTestId('wb-test-command'), 'npm run unit')
    await userEvent.click(screen.getByTestId('wb-test-apply'))
    expect(setTests).toHaveBeenCalledWith('explore', [
      { id: 'unit', direction: 'unit', command: 'npm run unit', label: '单测', required: true },
    ])
  })
})
