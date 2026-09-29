import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import gsap from 'gsap'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { WbEffectiveIo, WbSkillEntry, WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
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

/** 画布从编辑器的定义算编排：把被测阶段放回定义里，和真实页面一致（step 就是 def.steps 里的那一项）。 */
function renderPane(step: WbStepDef, overrides: Partial<WorkflowEditor> = {}): WorkflowEditor {
  const base = overrides.def ?? DEF
  const def = { ...base, steps: base.steps.map((candidate) => candidate.id === step.id ? step : candidate) }
  const editor = fakeEditor(step, { ...overrides, def })
  render(<I18nProvider><TooltipProvider><StageEditorPane editor={editor} step={step} /></TooltipProvider></I18nProvider>)
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

  it('同一概念只显示一个名字：verification_report 并进 verification-report，字段只在 title 里', () => {
    const verify: WbStepDef = {
      id: 'verify', label: '验证', gate: 'review', skills: [], inputs: [],
      outputs: [{ field: 'verification_report', type: 'file_path' }], guards: [], transitions: [],
    }
    renderPane(verify, {
      effectiveIo: {
        ...IO,
        verify: {
          inputs: [],
          outputs: [
            { kind: 'document', id: 'verification-report', producers: ['verification-before-completion'], consumers: [], role: 'produce', scope: 'change' },
            { kind: 'field', id: 'verification_report', type: 'file_path', producer: null, consumers: [] },
          ],
        },
      },
    })
    const table = screen.getByTestId('io-outputs')
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(within(table).queryByTestId('slot-field-verification_report')).toBeNull()
    expect(within(table).getByTestId('slot-document-verification-report').getAttribute('title')).toContain('verification_report')
  })

  it('输入表三列：来源阶段 + 该阶段里产出它的技能；无输入显示空态', () => {
    const { unmount } = render(<I18nProvider><TooltipProvider><StageEditorPane editor={fakeEditor(SPEC)} step={SPEC} /></TooltipProvider></I18nProvider>)
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

  it('只读且本阶段什么都没有（也没有 OpenSpec 注入）：段内只写「无」，不渲染空画布；可编辑时四条泳道都在', () => {
    renderPane({ ...EXPLORE, skills: [] }, { effectiveIo: {}, canWrite: false, readOnly: true })
    expect(screen.getByTestId('stage-skills-empty')).toHaveTextContent('无')
    expect(within(screen.getByTestId('stage-skills')).queryByTestId('orchestration-stage')).toBeNull()
    cleanup()
    renderPane({ ...EXPLORE, skills: [] }, { effectiveIo: {} })
    const canvas = within(screen.getByTestId('stage-skills')).getByTestId('orchestration-stage')
    expect(['executor', 'skill', 'test', 'reviewer'].map((kind) => within(canvas).getByTestId(`orch-lane-${kind}`).textContent)).toEqual(['执行者0', '技能0', '测试0', '评审者0'])
  })

  it('保存条只在有改动时渲染：写「未保存 N 处」，在滚动区之外（不盖住门禁 / 退回）；没改动（含无写入凭证）整条不渲染', () => {
    renderPane(EXPLORE, { dirty: true, changeCount: 3 })
    expect(screen.getByTestId('wb-dirty')).toHaveTextContent('未保存 3 处')
    const bar = screen.getByTestId('wb-save-bar')
    for (const token of ['flex-none', 'bg-card', 'border-t']) expect(bar.className).toContain(token)
    expect(bar.className).not.toContain('sticky')
    // 门禁段在滚动区里，保存条是滚动区的兄弟节点：两者不重叠。
    expect(bar.parentElement).toBe(screen.getByTestId('stage-editor-pane'))
    expect(bar.contains(screen.getByTestId('stage-gate'))).toBe(false)
    expect(screen.getByTestId('stage-gate').closest('.overflow-y-auto')).not.toBeNull()
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

  it('无写入凭证：右栏顶部直接给错误（role=alert），排在阶段名之前；「已保存」这类非错误不显示', () => {
    renderPane(EXPLORE, { canWrite: false, saveStatus: { kind: 'ok' } })
    const alert = screen.getByTestId('wb-no-token')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent('当前地址没有编辑凭证')
    expect(alert.className).toContain('whitespace-nowrap')
    expect(alert.compareDocumentPosition(screen.getByTestId('stage-actions')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText('已保存')).toBeNull()
    cleanup()
    renderPane(EXPLORE)
    expect(screen.queryByTestId('wb-no-token')).toBeNull()
  })

  it('保存条：改动清空（保存成功 / 放弃）后卸载；保存失败时仍在并显示原因；点保存 / 放弃各自回调', async () => {
    const user = userEvent.setup()
    const editor = fakeEditor(EXPLORE, { dirty: true, changeCount: 1, saveStatus: { kind: 'error', errors: ['冲突'], conflict: true } })
    const { rerender } = render(<I18nProvider><TooltipProvider><StageEditorPane editor={editor} step={EXPLORE} /></TooltipProvider></I18nProvider>)
    expect(screen.getByTestId('wb-save-error')).toHaveTextContent('冲突')
    expect(screen.getByTestId('wb-save-conflict-reload')).toBeInTheDocument()
    await user.click(screen.getByTestId('wb-save'))
    expect(editor.save).toHaveBeenCalled()
    await user.click(screen.getByTestId('wb-discard'))
    expect(editor.discardDraft).toHaveBeenCalled()
    rerender(<I18nProvider><TooltipProvider><StageEditorPane editor={{ ...editor, dirty: false, changeCount: 0, saveStatus: { kind: 'ok' } } as WorkflowEditor} step={EXPLORE} /></TooltipProvider></I18nProvider>)
    expect(screen.queryByTestId('wb-save-bar')).toBeNull()
  })

  it('lint 挡住保存时保存条说明原因、保存禁用', () => {
    renderPane(EXPLORE, { dirty: true, changeCount: 2, lintBlocked: true })
    expect(screen.getByTestId('wb-dirty')).not.toHaveTextContent('未保存 2 处')
    expect(screen.getByTestId('wb-save')).toBeDisabled()
  })

  it('技能画布：与总览同一组件的单列形态；节点数 = 条目数；点技能打开详情抽屉；编辑按钮打开编辑器', async () => {
    const user = userEvent.setup()
    renderPane(EXPLORE)
    const canvas = within(screen.getByTestId('stage-skills')).getByTestId('orchestration-stage')
    expect(canvas).toHaveAttribute('data-nodes', '3')
    expect(canvas).toHaveAttribute('data-pulse', 'loop')
    expect(screen.getByTestId('orch-node-skill-grill-with-docs')).toHaveAttribute('data-wave', '1')
    await user.click(screen.getByTestId('wb-skills-edit'))
    expect(screen.getByTestId('skill-composer')).toBeInTheDocument()
    cleanup()
    renderPane(EXPLORE)
    await user.click(screen.getByTestId('orch-open-skill-brainstorming'))
    expect(await screen.findByTestId('skill-preview')).toBeInTheDocument()
  })

  it('右栏只有四段：输入 → 技能 → 输出 → 门禁；执行者 / 测试 / 评审者是技能画布里的泳道，退回在门禁段里', () => {
    renderPane(SPEC)
    const sections = [...screen.getByTestId('stage-editor-pane').querySelectorAll('[data-stage-sections] > section')].map((section) => section.getAttribute('data-testid'))
    expect(sections).toEqual(['stage-inputs', 'stage-skills', 'stage-outputs', 'stage-gate'])
    for (const gone of ['stage-executors', 'stage-reviewers', 'stage-tests']) expect(screen.queryByTestId(gone)).toBeNull()
    expect(screen.getByTestId('stage-gate').contains(screen.getByTestId('stage-back'))).toBe(true)
  })

  it('泳道按 runner 顺序：执行者 → 技能 → 测试 → 评审者；泳道旁的动作打开对应编辑器', async () => {
    const user = userEvent.setup()
    const step: WbStepDef = {
      ...EXPLORE,
      tests: [{ id: 'unit', direction: 'unit', command: 'npm test', label: '单测' }],
      agents: {
        executors: [{ agent: 'builder' }],
        reviewers: [{ agent: 'security', required: true, block_at: 'medium', reads_tests: ['unit'] }],
      },
    }
    renderPane(step)
    const canvas = screen.getByTestId('orchestration-stage')
    const order = ['orch-node-executor-builder', 'orch-node-skill-tenon-explore', 'orch-node-test-unit', 'orch-node-reviewer-security']
      .map((id) => within(canvas).getByTestId(id).getAttribute('data-wave'))
    expect(order).toEqual(['0', '1', '3', '4'])
    expect(canvas).toHaveAttribute('aria-label', '技能')
    await user.click(screen.getByTestId('wb-reviewers-edit'))
    expect(screen.getByTestId('agent-composer')).toBeInTheDocument()
    await user.click(screen.getByTestId('agent-composer-close'))
    await user.click(screen.getByTestId('orch-open-test-unit'))
    expect(await screen.findByTestId('test-editor-drawer')).toBeInTheDocument()
  })

  it('门禁是分段控件：fill 轨道，选中项里有白色滑块，没有内联说明图标', () => {
    renderPane(EXPLORE)
    const group = screen.getByTestId('wb-lane-gate-explore')
    expect(group).toHaveAttribute('role', 'radiogroup')
    expect(group.className).toContain('bg-fill')
    expect(screen.getByTestId('wb-lane-gate-explore-review')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-lane-gate-explore-indicator')).toHaveClass('bg-card', 'shadow-sm')
    expect(screen.getByTestId('wb-lane-gate-explore-review')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('wb-lane-gate-explore-auto')).toHaveAttribute('tabindex', '-1')
    expect(group.querySelector('.lucide-info')).toBeNull()
  })

  it('门禁键盘：方向键在评审 / 自动两项间移动并选中', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    const user = userEvent.setup()
    const editor = renderPane(EXPLORE)
    act(() => { screen.getByTestId('wb-lane-gate-explore-review').focus() })
    await user.keyboard('{ArrowRight}')
    expect(editor.setGate).toHaveBeenCalledWith('explore', 'auto')
    expect(screen.getByTestId('wb-lane-gate-explore-auto')).toHaveFocus()
  vi.unstubAllGlobals()
  })

  it('门禁两选（评审 / 自动）：aria-checked 跟随 step.gate，点选写回；说明用 Tooltip（聚焦可达），不用原生 title', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    const user = userEvent.setup()
    const editor = renderPane(EXPLORE)
    const review = screen.getByTestId('wb-lane-gate-explore-review')
    expect(review).toHaveAttribute('aria-checked', 'true')
    expect(review).not.toHaveAttribute('title')
    expect(review).toHaveAccessibleDescription('产物齐全后需人工确认')
    expect(screen.queryByTestId('wb-lane-gate-explore-none')).toBeNull()
    expect(screen.getByTestId('wb-lane-gate-explore').querySelectorAll('[role="radio"]')).toHaveLength(2)
    act(() => { screen.getByTestId('wb-lane-gate-explore-auto').focus() })
    expect(await screen.findByRole('tooltip')).toHaveTextContent('产物齐全即放行')
    vi.unstubAllGlobals()
    await user.click(screen.getByTestId('wb-lane-gate-explore-auto'))
    expect(editor.setGate).toHaveBeenCalledWith('explore', 'auto')
  })

  it('gate null 与自动同义：控件按自动选中，点「自动」不产生改动；点「评审」写回 review', async () => {
    const user = userEvent.setup()
    const editor = renderPane({ ...EXPLORE, gate: null })
    expect(screen.getByTestId('wb-lane-gate-explore-auto')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-lane-gate-explore-review')).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByTestId('wb-lane-gate-explore-auto'))
    expect(editor.setGate).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('wb-lane-gate-explore-review'))
    expect(editor.setGate).toHaveBeenCalledWith('explore', 'review')
  })
})

describe('StageEditorPane · 切换阶段的进场', () => {
  it('按阶段重挂载时各段依次上浮淡入（revealList，错开 0.03s）', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: !query.includes('prefers-reduced-motion: reduce'), media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }))
    const fromTo = vi.spyOn(gsap, 'fromTo')
    renderPane(EXPLORE)
    const call = fromTo.mock.calls.find((args) => (args[2] as gsap.TweenVars).stagger === SECTION_STAGGER)
    expect(call).toBeDefined()
    expect(call![1]).toMatchObject({ autoAlpha: 0, y: 4 })
    const sections = document.querySelectorAll('[data-stage-sections] > *')
    expect(sections.length).toBe(4)
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
    render(<I18nProvider><TooltipProvider><StageEditorPane editor={editor} step={step} /></TooltipProvider></I18nProvider>)
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

describe('StageEditorPane · OpenSpec 注入的技能', () => {
  // default 的立项：阶段自己没声明技能，文档契约要求 openspec-propose（≡ opsx:propose）产出 proposal / tasks。
  const OPEN: WbStepDef = {
    id: 'open', label: '立项', gate: null, skills: [],
    inputs: [], outputs: [], guards: [], transitions: [{ event: 'open-complete', to: 'explore' }],
  }
  const NEXT: WbStepDef = { ...EXPLORE, skills: [{ id: 'tenon-explore' }] }
  const OPEN_IO: WbEffectiveIo = {
    open: {
      inputs: [],
      outputs: [
        { kind: 'document', id: 'proposal', role: 'produce', scope: 'change', producers: ['openspec-propose', 'opsx:propose'], consumers: ['explore'] },
        { kind: 'document', id: 'tasks', role: 'produce', scope: 'change', producers: ['openspec-propose', 'opsx:propose'], consumers: [] },
      ],
    },
    explore: {
      inputs: [{ kind: 'document', id: 'proposal', role: 'read', scope: 'change', producers: ['open'], consumers: [] }],
      outputs: [{ kind: 'document', id: 'proposal', role: 'update', scope: 'change', producers: ['tenon'], consumers: [] }],
    },
  }
  const OPEN_DEF: WbWorkflowDef = { name: 'default', openspec: true, steps: [OPEN, NEXT] }

  it('阶段画布显示契约注入的技能（契约图标 + 计数），输出来源技能写出它', () => {
    renderPane(OPEN, { def: OPEN_DEF, effectiveIo: OPEN_IO })
    const skills = screen.getByTestId('stage-skills')
    expect(within(skills).queryByTestId('stage-skills-empty')).toBeNull()
    expect(within(skills).getByTestId('orchestration-stage')).toHaveAttribute('data-nodes', '1')
    const node = within(skills).getByTestId('orch-node-skill-openspec-propose')
    expect(node).toHaveAttribute('data-source', 'openspec')
    expect(within(node).getByTestId('orch-source-openspec')).toHaveAttribute('aria-label', expect.stringContaining('OpenSpec'))
    expect(skills.querySelector('h2')).toHaveTextContent('1')
    expect(screen.getByTestId('slot-skills-proposal')).toHaveTextContent('openspec-propose')
    expect(screen.getByTestId('slot-skills-tasks')).toHaveTextContent('openspec-propose')
  })

  it('下游阶段的输入：来源技能同样算上上游注入的技能；update 槽位（tenon）不注入', () => {
    renderPane(NEXT, { def: OPEN_DEF, effectiveIo: OPEN_IO })
    const inputs = screen.getByTestId('io-inputs')
    expect(within(inputs).getByTestId('slot-skills-proposal')).toHaveTextContent('openspec-propose')
    expect(within(screen.getByTestId('stage-skills')).queryByTestId('orch-node-skill-tenon')).toBeNull()
  })

  it('阶段已声明别名（opsx:propose）时不重复注入', () => {
    renderPane({ ...OPEN, skills: [{ id: 'opsx:propose' }] }, { def: OPEN_DEF, effectiveIo: OPEN_IO })
    expect(within(screen.getByTestId('stage-skills')).getByTestId('orchestration-stage')).toHaveAttribute('data-nodes', '1')
    expect(screen.queryByTestId('orch-source-openspec')).toBeNull()
  })
})

describe('StageEditorPane · 自动门禁与只读', () => {
  it('没有输出的阶段设为「自动」：门禁旁出警示图标（说明在 Tooltip）；有输出或非自动时不出', () => {
    const bare: WbStepDef = { ...SPEC, gate: 'auto', outputs: [] }
    renderPane(bare, { effectiveIo: { ...IO, spec: { inputs: [], outputs: [] } } })
    const warning = screen.getByTestId('stage-gate-auto-warning')
    expect(warning).toHaveAttribute('aria-label', '本阶段没有输出，自动门禁无从判断产物齐全')
    expect(screen.getByTestId('stage-gate').contains(warning)).toBe(true)
    cleanup()
    renderPane({ ...SPEC, gate: 'auto' })
    expect(screen.queryByTestId('stage-gate-auto-warning')).toBeNull()
    cleanup()
    renderPane({ ...bare, gate: 'review' }, { effectiveIo: { ...IO, spec: { inputs: [], outputs: [] } } })
    expect(screen.queryByTestId('stage-gate-auto-warning')).toBeNull()
  })

  it('插件内建只读（readOnly）：不报缺凭证错误，写入口照样置灰', () => {
    renderPane(EXPLORE, { canWrite: false, readOnly: true })
    expect(screen.queryByTestId('wb-no-token')).toBeNull()
    expect(screen.getByTestId('wb-lane-name-input-explore')).toBeDisabled()
    expect(screen.queryByTestId('wb-skills-edit')).toBeNull()
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

describe('StageEditorPane 测试泳道', () => {
  it('测试是技能画布里的一条泳道（技能之后、评审者之前）；点节点开抽屉，改命令经 setTests 回草稿', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, directions: [] }), { status: 200 }))
    const setTests = vi.fn()
    const step: WbStepDef = {
      ...EXPLORE,
      tests: [{ id: 'unit', direction: 'unit', command: 'npm test', label: '单测', required: true }],
    }
    renderPane(step, { setTests, def: { ...DEF, steps: [step, SPEC] } })
    const lanes = [...screen.getByTestId('orchestration-stage').querySelectorAll('[data-testid^="orch-lane-"]')].map((node) => node.getAttribute('data-testid'))
    expect(lanes).toEqual(['orch-lane-executor', 'orch-lane-skill', 'orch-lane-test', 'orch-lane-reviewer'])
    expect(screen.getByTestId('orch-node-test-unit')).toHaveTextContent('单测')

    await userEvent.click(screen.getByTestId('orch-open-test-unit'))
    // 抽屉里的改动即时进草稿，没有单独的「应用」。
    expect(screen.queryByTestId('wb-test-apply')).toBeNull()
    fireEvent.change(screen.getByTestId('wb-test-command'), { target: { value: 'npm run unit' } })
    expect(setTests).toHaveBeenLastCalledWith('explore', [
      { id: 'unit', direction: 'unit', command: 'npm run unit', label: '单测', required: true },
    ])
  })
})
