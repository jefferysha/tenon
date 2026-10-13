// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseWorkflow, validateWorkflowForStorage } from '@tenon/kernel'
import { describe, expect, it } from 'vitest'
import type { WbStepDef, WbTransition, WbWorkflowDef } from '../api/governanceTypes'
import { branchesOf, cloneWorkflowDef, selectBranchDef } from '../workbench/workbenchDefinition'
import { lintWorkflow, type LintIssue } from './lint'

/** 转移类问题按老形状比对（severity 单独有用例）。 */
function withoutSeverity(issues: readonly LintIssue[]): Array<Record<string, unknown>> {
  return issues.map(({ severity: _severity, ...issue }) => ({ ...issue }))
}

function stage(id: string, transitions: WbTransition[] = []): WbStepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions }
}

function transitionIssues(def: WbWorkflowDef): Array<Record<string, unknown>> {
  return withoutSeverity(lintWorkflow(def).filter((issue) => issue.kind.startsWith('transition-')))
}

function notNextOrBack(def: WbWorkflowDef): Array<Record<string, unknown>> {
  return transitionIssues(def).filter((issue) => issue.kind === 'transition-not-next-or-back')
}

describe('lint · 转移只能去下一阶段或退回', () => {
  it('正向边去下一阶段 + 退回更早阶段：不报', () => {
    const def: WbWorkflowDef = {
      name: 'mine',
      steps: [
        stage('a', [{ event: 'a-complete', to: 'b' }]),
        stage('b', [{ event: 'b-complete', to: 'c' }, { event: 'b-back', to: 'a' }]),
        stage('c', [{ event: 'c-fail', to: 'b', actions: [{ type: 'mark-verification-failed' }] }, { event: 'c-reset', to: 'a' }]),
      ],
    }
    expect(transitionIssues(def)).toEqual([])
  })

  it('E2E 里保存出的形状：旧退回边在排序后变成第二条去下一阶段的边 → 报第二条', () => {
    const corrupted: WbWorkflowDef = {
      name: 'mine',
      steps: [
        stage('stage-1', [{ event: 'stage-1-complete', to: 'verify' }]),
        stage('verify', [{ event: 'verify-back', to: 'build' }, { event: 'verify-complete', to: 'build' }]),
        stage('build'),
      ],
    }
    expect(notNextOrBack(corrupted)).toEqual([
      { kind: 'transition-not-next-or-back', stepId: 'verify', event: 'verify-complete', to: 'build' },
    ])
  })

  it('往后跳、指向自己、指向不存在的阶段都报；第一个阶段也查', () => {
    const def: WbWorkflowDef = {
      name: 'mine',
      steps: [
        stage('a', [{ event: 'a-complete', to: 'b' }, { event: 'a-skip', to: 'c' }]),
        stage('b', [{ event: 'b-complete', to: 'c' }, { event: 'b-loop', to: 'b' }]),
        stage('c', [{ event: 'c-gone', to: 'removed' }]),
      ],
    }
    expect(notNextOrBack(def)).toEqual([
      { kind: 'transition-not-next-or-back', stepId: 'a', event: 'a-skip', to: 'c' },
      { kind: 'transition-not-next-or-back', stepId: 'b', event: 'b-loop', to: 'b' },
      { kind: 'transition-not-next-or-back', stepId: 'c', event: 'c-gone', to: 'removed' },
    ])
  })

  it('显式写出的 archived 自环是完成边，不报；其它自环照报', () => {
    const def: WbWorkflowDef = {
      name: 'mine',
      steps: [
        stage('a', [{ event: 'a-complete', to: 'b' }]),
        stage('b', [{ event: 'archived', to: 'b', actions: [{ type: 'archive-run' }] }, { event: 'b-loop', to: 'b' }]),
      ],
    }
    expect(notNextOrBack(def)).toEqual([{ kind: 'transition-not-next-or-back', stepId: 'b', event: 'b-loop', to: 'b' }])
  })

  it('末阶段不能有正向边：它没有下一阶段', () => {
    const def: WbWorkflowDef = { name: 'mine', steps: [stage('a', [{ event: 'a-complete', to: 'b' }]), stage('b', [{ event: 'b-complete', to: 'a' }])] }
    expect(notNextOrBack(def)).toEqual([])
    const tail: WbWorkflowDef = { name: 'mine', steps: [stage('a'), stage('b', [{ event: 'b-complete', to: 'b' }])] }
    expect(notNextOrBack(tail)).toEqual([{ kind: 'transition-not-next-or-back', stepId: 'b', event: 'b-complete', to: 'b' }])
  })
})

describe('lint · 严重度', () => {
  it('转移问题是错误（挡保存）', () => {
    const issues = lintWorkflow({ name: 'mine', openspec: true, steps: [stage('a', [{ event: '', to: 'b' }]), stage('b')] })
    expect(issues.find((issue) => issue.kind === 'transition-empty-event')?.severity).toBe('error')
  })

  // 不再手写每步的输入输出：没有输出的阶段、没有输入的阶段都不是问题，也不会有文档契约的检查。
  it('没有输出的阶段不报：不论是否开启 OpenSpec、是否内建', () => {
    const steps = [stage('a', [{ event: 'a-complete', to: 'b' }]), stage('b')]
    for (const def of [
      { name: 'mine', openspec: true, steps },
      { name: 'mine', steps },
      { name: 'mine', openspec: false, steps },
      { name: 'design-system', openspec: true, source: 'builtin' as const, steps },
    ] satisfies WbWorkflowDef[]) {
      expect(lintWorkflow(def)).toEqual([])
    }
  })

  it('问题的种类只剩转移、测试与 agent；没有输入输出或文档类的种类', () => {
    const issues = lintWorkflow({
      name: 'mine',
      openspec: true,
      steps: [{
        ...stage('a', [{ event: '', to: 'b' }]),
        tests: [{ id: 't', direction: 'unit', command: ' ', outputs: [{ path: 'dist/out.xml' }] }],
        agents: { executors: [{ agent: 'ghost' }], reviewers: [] },
      }, stage('b')],
    }, [])
    expect(issues.map((issue) => issue.kind).sort()).toEqual(['agent-missing', 'test-command-empty', 'test-output-location', 'transition-empty-event'])
  })
})

describe('lint · 内建 default 不误报', () => {
  const yaml = readFileSync(fileURLToPath(new URL('../../../../templates/workflows/default.yaml', import.meta.url)), 'utf8')
  const parsed = parseWorkflow(yaml)
  const toSteps = (steps: typeof parsed.steps): WbStepDef[] => steps.map((step) => ({
    id: step.id,
    label: step.id,
    gate: null,
    skills: [],
    inputs: [],
    outputs: [],
    guards: [],
    transitions: step.transitions.map((transition) => ({ event: transition.event, to: transition.to })),
  }))
  const builtin: WbWorkflowDef = {
    name: 'default',
    steps: toSteps(parsed.steps),
    ...(parsed.tracks === undefined ? {} : { tracks: Object.fromEntries(Object.entries(parsed.tracks).map(([id, branch]) => [id, { steps: toSteps(branch.steps) }])) }),
  }

  it('每条轨道（含 verify-fail / requirements-changed 回流）按原名与复制后都没有转移问题', () => {
    const branches = branchesOf(builtin)
    expect(branches.length).toBeGreaterThan(1)
    const events = branches.flatMap((branch) => selectBranchDef(builtin, branch.id).steps.flatMap((step) => step.transitions.map((transition) => transition.event)))
    expect(events).toContain('verify-fail')
    expect(events).toContain('requirements-changed')
    const copied = cloneWorkflowDef(builtin, 'default-copy')
    for (const branch of branches) {
      expect(transitionIssues(selectBranchDef(builtin, branch.id))).toEqual([])
      expect(transitionIssues(selectBranchDef(copied, branch.id))).toEqual([])
    }
  })

  // 快照：内建 default 的每条轨道在编辑器里都是零问题。曾经每个阶段都亮琥珀点——把编排器 `tenon` 与
  // 运行时由 phase manifest 叠加的技能当成「缺技能」报了出来，kernel 对这两类都不判。
  it('每条轨道 lint 零问题（agent 库未拉到与已拉到两种情况）', () => {
    const full = JSON.parse(JSON.stringify(parsed)) as WbWorkflowDef
    const agents = full.tracks === undefined ? [] : Object.values(full.tracks).flatMap((branch) => branch.steps.flatMap((step) => [
      ...(step.agents?.executors ?? []).map((ref) => ref.agent),
      ...(step.agents?.reviewers ?? []).map((ref) => ref.agent),
    ]))
    const byBranch = Object.fromEntries(branchesOf(full).map((branch) => {
      const view = selectBranchDef(full, branch.id)
      return [branch.id, [...lintWorkflow(view, null), ...lintWorkflow(view, agents)]]
    }))
    // lite 是 `spec: none` 的五步分支（带 scope-expanded 放弃边）：不受 OpenSpec 治理，也不需要 default 七阶段的转移去向。
    expect(byBranch).toEqual({ lite: [], pm: [], frontend: [], backend: [] })
  })

  it('scope-expanded 放弃边（去往终态 escalated）不是「非下一步 / 回退」的转移；别的跳转仍报错', () => {
    const view = selectBranchDef(builtin, 'lite')
    expect(view.steps.flatMap((step) => step.transitions.filter((transition) => transition.event === 'scope-expanded').map((transition) => transition.to)))
      .toEqual(['escalated', 'escalated', 'escalated'])
    expect(transitionIssues(view)).toEqual([])
    const skipping: WbWorkflowDef = {
      name: 'mine',
      steps: [stage('a', [{ event: 'jump', to: 'c' }]), stage('b'), stage('c')],
    }
    expect(transitionIssues(skipping).map((issue) => issue.kind)).toEqual(['transition-not-next-or-back'])
  })

  it('复制 default：每条分支都过 kernel 的自定义工作流校验，必须产出守卫原样带着', () => {
    const full = JSON.parse(JSON.stringify(parsed)) as WbWorkflowDef
    const copied = cloneWorkflowDef(full, 'default-copy')
    expect(copied.openspec).toBe(true)
    expect(validateWorkflowForStorage('default-copy', copied as never)).toEqual([])
    const required = (steps: WbStepDef[] | undefined): string[] => (steps ?? []).flatMap((step) => step.guards.flatMap((guard) => guard.type === 'required-output' ? [guard.path] : []))
    expect(required(copied.tracks?.backend?.steps)).toContain('docs/superpowers/specs/*.md')
    expect(required(copied.tracks?.backend?.steps)).toEqual(required(full.tracks?.backend?.steps))
  })
})

describe('lint · 步骤 agent 必须在库里', () => {
  const def: WbWorkflowDef = {
    name: 'mine',
    steps: [{
      ...stage('a', [{ event: 'a-complete', to: 'b' }]),
      agents: { executors: [{ agent: 'builder' }], reviewers: [{ agent: 'ghost', required: true, block_at: 'high' }] },
    }, stage('b')],
  }
  const agentIssues = (agents: readonly string[] | null): LintIssue[] =>
    lintWorkflow(def, agents).filter((issue) => issue.kind === 'agent-missing')

  it('库里没有的 agent 是 error；库还没拉到就不判', () => {
    expect(agentIssues(['builder'])).toEqual([{ kind: 'agent-missing', stepId: 'a', agent: 'ghost', severity: 'error' }])
    expect(agentIssues(['builder', 'ghost'])).toEqual([])
    expect(agentIssues(null)).toEqual([])
  })
})
