// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseWorkflow } from '@tenon/kernel'
import { describe, expect, it } from 'vitest'
import type { WbStepDef, WbTransition, WbWorkflowDef } from '../api/governanceTypes'
import { branchesOf, copyWorkflowDef, selectBranchDef } from '../workbench/workbenchDefinition'
import { draftEffectiveIo, lintWorkflow, type LintIssue } from './lint'

function stage(id: string, transitions: WbTransition[] = []): WbStepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions }
}

function transitionIssues(def: WbWorkflowDef): LintIssue[] {
  return lintWorkflow(def, draftEffectiveIo(def, undefined)).filter((issue) => issue.kind.startsWith('transition-'))
}

function notNextOrBack(def: WbWorkflowDef): LintIssue[] {
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
    const copied = copyWorkflowDef(builtin, 'default-copy')
    for (const branch of branches) {
      expect(transitionIssues(selectBranchDef(builtin, branch.id))).toEqual([])
      expect(transitionIssues(selectBranchDef(copied, branch.id))).toEqual([])
    }
  })
})
