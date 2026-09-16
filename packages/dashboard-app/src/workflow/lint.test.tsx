// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseWorkflow, validateWorkflowForStorage } from '@tenon/kernel'
import { describe, expect, it } from 'vitest'
import type { WbStepDef, WbTransition, WbWorkflowDef } from '../api/governanceTypes'
import { branchesOf, copyWorkflowDef, selectBranchDef } from '../workbench/workbenchDefinition'
import { draftEffectiveIo, lintWorkflow, type LintIssue } from './lint'

/** 转移类问题按老形状比对（severity 单独有用例）。 */
function withoutSeverity(issues: readonly LintIssue[]): Array<Record<string, unknown>> {
  return issues.map(({ severity: _severity, ...issue }) => ({ ...issue }))
}

function stage(id: string, transitions: WbTransition[] = []): WbStepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions }
}

function transitionIssues(def: WbWorkflowDef): Array<Record<string, unknown>> {
  return withoutSeverity(lintWorkflow(def, draftEffectiveIo(def)).filter((issue) => issue.kind.startsWith('transition-')))
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

describe('lint · 严重度与文档契约', () => {
  const skills = (...ids: string[]): WbStepDef['skills'] => ids.map((id) => ({ id }))
  const governed = (contract: WbWorkflowDef['documentContract'], name = 'mine'): WbWorkflowDef => ({
    name,
    openspec: true,
    ...(contract === undefined ? {} : { documentContract: contract }),
    steps: [
      { ...stage('shape', [{ event: 'shape-complete', to: 'build' }]), skills: skills('openspec-propose') },
      { ...stage('build'), outputs: [{ field: 'build_sha', type: 'string' }] },
    ],
  })
  const lint = (def: WbWorkflowDef): LintIssue[] => lintWorkflow(def, draftEffectiveIo(def))

  it('缺输出是警告（不挡保存）；转移问题是错误', () => {
    const issues = lint({ name: 'mine', steps: [stage('a', [{ event: '', to: 'b' }]), stage('b')] })
    expect(issues.filter((issue) => issue.kind === 'step-no-output').map((issue) => issue.severity)).toEqual(['warning', 'warning'])
    expect(issues.find((issue) => issue.kind === 'transition-empty-event')?.severity).toBe('error')
  })

  it('producer 不在阶段技能里：自定义是错误、default 是警告；read 在产出之前是错误；成对文档缺一是警告', () => {
    const contract = {
      version: 'v1' as const,
      slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
      reads: [{ step: 'shape', kinds: ['tasks'] }],
    }
    const custom = lint(governed(contract))
    expect(custom).toContainEqual({ kind: 'document-producer-missing', stepId: 'shape', document: 'proposal', skill: 'writer', severity: 'error' })
    expect(custom).toContainEqual({ kind: 'document-order', stepId: 'shape', document: 'tasks', severity: 'error' })
    expect(custom).toContainEqual({ kind: 'document-chain-gap', stepId: 'shape', document: 'proposal', missing: 'tasks', severity: 'warning' })
    expect(lint(governed(contract, 'default')).find((issue) => issue.kind === 'document-producer-missing')?.severity).toBe('warning')
    expect(lint(governed({ version: 'v1', slots: [{ kind: 'tasks', ownerStep: 'shape', role: 'update', producers: ['openspec-propose'] }], reads: [] })))
      .toContainEqual({ kind: 'document-order', stepId: 'shape', document: 'tasks', severity: 'error' })
  })

  it('草稿 IO 从契约推出 role / scope：produce 与 update 是输出，read 与 require 是输入；关掉 OpenSpec 就没有文档槽位', () => {
    const def = governed({
      version: 'v1',
      slots: [
        { kind: 'proposal', ownerStep: 'shape', producers: ['openspec-propose'] },
        { kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] },
      ],
      reads: [{ step: 'build', kinds: ['proposal'] }],
    })
    const io = draftEffectiveIo(def)
    expect(io.shape?.outputs).toEqual([
      { kind: 'document', id: 'proposal', role: 'produce', scope: 'change', producers: ['openspec-propose'], consumers: ['build'] },
    ])
    expect(io.build?.inputs).toEqual([
      { kind: 'document', id: 'proposal', role: 'read', scope: 'change', producers: ['shape'], consumers: [] },
      { kind: 'document', id: 'design-md', role: 'require', scope: 'project', producers: [], consumers: [] },
    ])
    const { openspec: _openspec, ...off } = def
    expect(draftEffectiveIo(off).shape?.outputs).toEqual([])
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

  it('复制 default：契约按阶段技能裁剪后每条分支都过 kernel 的自定义工作流校验', () => {
    const full = JSON.parse(JSON.stringify(parsed)) as WbWorkflowDef
    const copied = copyWorkflowDef(full, 'default-copy')
    expect(copied.openspec).toBe(true)
    expect(validateWorkflowForStorage('default-copy', copied as never)).toEqual([])
    // chat 轨只有驱动技能：openspec-propose 产出的 proposal 被裁掉，tenon-explore 的 adr 留下。
    const chat = copied.tracks?.chat?.documentContract?.slots.map((slot) => slot.kind) ?? []
    expect(chat).not.toContain('proposal')
    expect(chat).toContain('adr')
  })
})
