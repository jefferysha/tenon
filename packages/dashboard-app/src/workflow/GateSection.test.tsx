/**
 * 门禁段下只读列出该步的离开条件：每条一行，没有编辑控件；文案来自 i18n `workflow.leave_conditions.*`。
 * 条件取自本阶段的 guards 与通向后面阶段的转换的 guards（退回边不算），按所选轨道过滤带 `when` 的条件。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WbGuardConfig, WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { GateSection } from './GateSection'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

function step(id: string, label: string, over: Partial<WbStepDef> = {}): WbStepDef {
  return { id, label, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...over }
}

const BUILD_GUARDS: WbGuardConfig[] = [
  { type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' },
  { type: 'tasks-through-step' },
  { type: 'not-afk-queued' },
  { type: 'dependencies-ended' },
]

const DEF: WbWorkflowDef = {
  name: 'default',
  steps: [
    step('spec', '规格', { transitions: [{ event: 'spec-complete', to: 'build' }] }),
    step('build', '实现', {
      transitions: [
        { event: 'build-complete', to: 'verify', guards: BUILD_GUARDS, actions: [{ type: 'freeze-build-sha' }] },
        { event: 'requirements-changed', to: 'spec', guards: [{ type: 'field-nonempty', field: 'never_shown_for_back_edge' }] },
      ],
    }),
    step('verify', '验证', { gate: 'review', transitions: [] }),
  ],
}

function editorFor(def: WbWorkflowDef, branch: string, canWrite = true): WorkflowEditor {
  const labels = new Map(def.steps.map((candidate) => [candidate.id, candidate.label]))
  return {
    def, canWrite, lint: [], branch, branches: [{ id: branch, label: branch }],
    labelOf: (id: string) => labels.get(id) ?? id,
    setGate: vi.fn(), setStageBack: vi.fn(), setTestLevel: vi.fn(),
  } as unknown as WorkflowEditor
}

function renderGate(stepId: string, def: WbWorkflowDef = DEF, branch = 'backend', canWrite = true): WorkflowEditor {
  const editor = editorFor(def, branch, canWrite)
  const target = def.steps.find((candidate) => candidate.id === stepId) as WbStepDef
  render(<I18nProvider><TooltipProvider><GateSection editor={editor} step={target} /></TooltipProvider></I18nProvider>)
  return editor
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})
afterEach(() => cleanup())

function rows(): string[] {
  return within(screen.getByTestId('stage-leave-conditions')).getAllByRole('listitem').map((item) => item.textContent ?? '')
}

describe('GateSection · 离开条件', () => {
  it('后端实现步：实现前评审通过 · 本阶段任务已勾选 · 未在 AFK 队列中 · 依赖任务已结束，每条一行，退回边的条件不列', () => {
    renderGate('build')
    expect(rows()).toEqual(['实现前评审通过', '本阶段任务已勾选', '未在 AFK 队列中', '依赖任务已结束'])
    const list = screen.getByTestId('stage-leave-conditions')
    expect(list.tagName).toBe('UL')
    for (const item of within(list).getAllByRole('listitem')) expect(item.className).toContain('whitespace-nowrap')
  })

  it('放弃边（scope-expanded，转入已升级）的条件不算离开条件：任务要被放弃了，与 CLI 的 check 同口径', () => {
    const def: WbWorkflowDef = {
      name: 'default',
      steps: [
        step('build', '实现', {
          transitions: [
            { event: 'build-complete', to: 'verify', guards: [{ type: 'tasks-through-step' }] },
            { event: 'scope-expanded', to: 'escalated', guards: [{ type: 'field-nonempty', field: 'escalation_reason' }, { type: 'nonempty-output' }] },
          ],
        }),
        step('verify', '验证', { gate: 'review' }),
        step('escalated', '已升级'),
      ],
    }
    renderGate('build', def)
    expect(rows()).toEqual(['本阶段任务已勾选'])
  })

  it('只读：条件行里没有输入框、按钮、开关，也不随 canWrite 出现编辑入口', () => {
    renderGate('build', DEF, 'backend', true)
    const list = screen.getByTestId('stage-leave-conditions')
    expect(list.querySelector('input, button, select, textarea, [role="switch"], [role="checkbox"]')).toBeNull()
    cleanup()
    renderGate('build', DEF, 'backend', false)
    expect(screen.getByTestId('stage-leave-conditions').querySelector('input, button, select, textarea')).toBeNull()
  })

  it('没有任何离开条件的阶段不画这一块', () => {
    renderGate('spec')
    expect(screen.queryByTestId('stage-leave-conditions')).toBeNull()
    cleanup()
    renderGate('verify')
    expect(screen.queryByTestId('stage-leave-conditions')).toBeNull()
  })

  it('覆盖已有的 guard 类型，每种一句话；相同的话只列一次', () => {
    const guards: WbGuardConfig[] = [
      { type: 'tasks-at-least', n: 3 },
      { type: 'nonempty-output' },
      { type: 'field-nonempty', field: 'design_doc' },
      { type: 'file-exists', path: { kind: 'field', field: 'plan' } },
      { type: 'field-equals', field: 'verify_result', value: 'pass' },
      { type: 'field-in', field: 'pr_kind', values: ['a', 'b'] },
      { type: 'build-head-unchanged', field: 'build_sha' },
      { type: 'spec-migration-applied' },
      { type: 'full-direct-override' },
      { type: 'tasks-through-step' },
      { type: 'required-output', path: 'docs/superpowers/specs/*.md' },
    ]
    const def: WbWorkflowDef = { name: 'x', steps: [step('only', '唯一', { guards: [...guards, { type: 'tasks-through-step' }] })] }
    renderGate('only', def, '')
    expect(rows()).toEqual([
      '任务不少于 3 条', '输出已填写', 'design_doc 已填写', 'plan 文件存在', 'verify_result 为 pass', 'pr_kind 属于 a, b',
      '构建后代码未变', '规格已迁移', '已设置 direct_override', '本阶段任务已勾选', '必须产出 docs/superpowers/specs/*.md',
    ])
  })

  it('自动门禁的警示只看有没有离开条件：default 的实现步（有条件）不出；一条条件都没有的自动阶段出，评审门不出', () => {
    renderGate('build')
    expect(screen.queryByTestId('stage-gate-auto-warning')).toBeNull()
    cleanup()
    renderGate('spec')
    expect(screen.getByTestId('stage-gate-auto-warning')).toHaveAttribute('aria-label', '没有离开条件')
    cleanup()
    renderGate('verify')
    expect(screen.queryByTestId('stage-gate-auto-warning')).toBeNull()
    cleanup()
    localStorage.setItem('tenon-dashboard-lang', 'en')
    try {
      renderGate('spec')
      expect(screen.getByTestId('stage-gate-auto-warning')).toHaveAttribute('aria-label', 'No leave conditions')
    } finally {
      localStorage.removeItem('tenon-dashboard-lang')
    }
  })

  it('必须产出：一条一行，不换行，完整文案进 title；路径里的 {change} 原样显示', () => {
    const def: WbWorkflowDef = {
      name: 'x',
      steps: [
        step('open', '立项', {
          guards: [{ type: 'required-output', path: 'openspec/changes/{change}/proposal.md' }],
          transitions: [{ event: 'open-complete', to: 'explore' }],
        }),
        step('explore', '调研'),
      ],
    }
    renderGate('open', def, 'backend')
    const item = within(screen.getByTestId('stage-leave-conditions')).getByRole('listitem')
    expect(item).toHaveTextContent('必须产出 openspec/changes/{change}/proposal.md')
    expect(item.className).toContain('whitespace-nowrap')
    expect(item.innerHTML).not.toContain('flex-wrap')
    expect(within(item).getByTitle('必须产出 openspec/changes/{change}/proposal.md').className).toContain('truncate')
  })

  it('必须产出可挂在通向后面阶段的转换上；带 when 的只在命中的轨道出现；退回边上的不算', () => {
    const def: WbWorkflowDef = {
      name: 'x',
      steps: [
        step('spec', '规格', {
          transitions: [
            { event: 'spec-complete', to: 'build', guards: [{ type: 'required-output', path: 'docs/plans/*.md', when: { kind: 'track-in', values: ['backend'] } }] },
            { event: 'spec-back', to: 'explore', guards: [{ type: 'required-output', path: 'never-shown-for-back-edge.md' }] },
          ],
        }),
        step('build', '实现'),
      ],
    }
    def.steps.unshift(step('explore', '调研'))
    renderGate('spec', def, 'backend')
    expect(rows()).toEqual(['必须产出 docs/plans/*.md'])
    cleanup()
    renderGate('spec', def, 'pm')
    expect(screen.queryByTestId('stage-leave-conditions')).toBeNull()
  })

  it('带 when 的条件只在所选轨道命中时列出', () => {
    const guarded: WbGuardConfig[] = [
      { type: 'file-exists', path: { kind: 'field', field: 'plan' }, when: { kind: 'track-not-in', values: ['pm'] } },
      { type: 'file-exists', path: { kind: 'field', field: 'prd_path' }, when: { kind: 'track-in', values: ['pm'] } },
    ]
    const def: WbWorkflowDef = { name: 'x', steps: [step('spec', '规格', { guards: guarded })] }
    renderGate('spec', def, 'backend')
    expect(rows()).toEqual(['plan 文件存在'])
    cleanup()
    renderGate('spec', def, 'pm')
    expect(rows()).toEqual(['prd_path 文件存在'])
  })

  it('English wording', () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    try {
      renderGate('build')
      expect(rows()).toEqual(['Pre-verify review passed', 'Tasks through this stage checked', 'Not queued in AFK', 'Dependencies ended'])
      cleanup()
      renderGate('open', {
        name: 'x',
        steps: [step('open', 'Open', { guards: [{ type: 'required-output', path: 'docs/specs/*.md' }] })],
      }, '')
      expect(rows()).toEqual(['Required output docs/specs/*.md'])
    } finally {
      localStorage.removeItem('tenon-dashboard-lang')
    }
  })

  it('门禁段原有的内容还在：分段控件与退回目标', () => {
    renderGate('build')
    expect(screen.getByTestId('stage-gate')).toBeInTheDocument()
    expect(screen.getByTestId('stage-back')).toBeInTheDocument()
  })
})
