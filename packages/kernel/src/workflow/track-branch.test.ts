import { describe, expect, it } from 'vitest'
import { builtinTrack } from '../tracks/builtins.js'
import { tmpdir } from 'node:os'
import { loadTrackRegistry } from '../tracks/registry.js'
import { resolveTrackForBranch } from '../tracks/branch-track.js'
import { compileWorkflow } from './compile.js'
import { defaultArtifactsForStep } from './default-artifacts.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import { selectTrackBranch, validateWorkflow, validateWorkflowForStorage, workflowBranches } from './validate.js'

const BRANCHED = `name: demo
steps:
  - id: change
    label: 改动
    gate: auto
    skills:
      - id: simple-task
    inputs: []
    outputs:
      - field: design_doc
        type: file_path
    guards: []
    transitions:
      - event: change-complete
        to: done
  - id: done
    label: 完成
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
tracks:
  mobile:
    label: 移动端
    steps:
      - id: design
        label: 设计
        gate: review
        skills:
          - id: frontend-design
          - id: browser-qa
            depends_on: [frontend-design]
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: design-complete
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

describe('track 分支 · 解析 / 序列化 / 选择', () => {
  it('tracks 块往返：分支 label 与独立 steps 都保留', () => {
    const def = parseWorkflow(BRANCHED)
    expect(Object.keys(def.tracks ?? {})).toEqual(['mobile'])
    expect(def.tracks?.mobile?.label).toBe('移动端')
    expect(def.tracks?.mobile?.steps.map((step) => step.id)).toEqual(['design', 'done'])
    expect(def.steps.map((step) => step.id)).toEqual(['change', 'done'])
    expect(serializeWorkflow(def)).toBe(BRANCHED)
  })

  it('workflowBranches 列出通用分支 + 每条 track；selectTrackBranch 命中用分支、未命中用通用', () => {
    const def = parseWorkflow(BRANCHED)
    expect(workflowBranches(def).map((branch) => branch.track)).toEqual(['', 'mobile'])
    expect(selectTrackBranch(def, 'mobile').steps.map((step) => step.id)).toEqual(['design', 'done'])
    expect(selectTrackBranch(def, 'backend').steps.map((step) => step.id)).toEqual(['change', 'done'])
    expect(selectTrackBranch(def, 'mobile')).not.toHaveProperty('tracks')
  })

  it('有效计划按 change 的 track 选分支：workflow 是分支 IR、definition 是完整定义；指纹属于整份定义（各分支相同）', () => {
    const def = parseWorkflow(BRANCHED)
    const mobile = compileEffectiveWorkflowPlan('demo', def, resolveTrackForBranch(loadTrackRegistry(tmpdir(), { workflowExists: () => true, skillProfiles: new Set() }), 'mobile', def))
    expect(mobile.workflow.steps.map((step) => step.id)).toEqual(['design', 'done'])
    expect(mobile.workflow).not.toHaveProperty('tracks')
    expect(mobile.capabilities.skills.steps[0]).toMatchObject({ stepId: 'design', requiredSkillIds: ['frontend-design', 'browser-qa'] })
    const backend = compileEffectiveWorkflowPlan('demo', def, builtinTrack('backend'))
    expect(backend.workflow.steps.map((step) => step.id)).toEqual(['change', 'done'])
    expect(backend.workflowFingerprint).toBe(mobile.workflowFingerprint)
    expect(Object.keys(mobile.definition?.tracks ?? {})).toEqual(['mobile'])
  })

  it('每条分支各自校验；错误带 tracks.<id> 前缀', () => {
    const def = parseWorkflow(BRANCHED.replace('            to: done\n      - id: done', '            to: nowhere\n      - id: done'))
    const errors = validateWorkflow(def)
    expect(errors.some((error) => error.startsWith('tracks.mobile: ') && error.includes('nowhere'))).toBe(true)
  })

  it('registry 未登记的分支 track 合成缺省定义；既无登记也无分支 → undefined', () => {
    const def = parseWorkflow(BRANCHED)
    const registry = loadTrackRegistry(tmpdir(), { workflowExists: () => true, skillProfiles: new Set() })
    const synthesized = resolveTrackForBranch(registry, 'mobile', def)
    expect(synthesized).toMatchObject({ id: 'mobile', label: '移动端', builtin: false, workflow: { default: 'demo', allowed: ['demo'] } })
    expect(synthesized?.policyProfile.skills).toEqual({ matrix: false, profile: '_all' })
    expect(resolveTrackForBranch(registry, 'backend', def)).toBe(registry.byId.get('backend'))
    expect(resolveTrackForBranch(registry, 'nope', def)).toBeUndefined()
  })
})

describe('门禁 · review / auto / null', () => {
  it('gate: auto 编译成每条出边上的输出齐全守卫', () => {
    const ir = compileWorkflow(parseWorkflow(BRANCHED))
    expect(ir.steps[0]!.transitions[0]!.guards).toEqual([{ type: 'field-nonempty', field: 'design_doc' }])
    expect(ir.tracks?.mobile?.steps[0]!.transitions[0]!.guards).toEqual([])
  })

  it("gate: confirm 已移除 → 解析与编译都报错并给出替代", () => {
    expect(() => parseWorkflow(BRANCHED.replace('gate: auto', 'gate: confirm'))).toThrow(/confirm.*review.*auto/u)
    expect(() => compileWorkflow({ ...parseWorkflow(BRANCHED), steps: [{ ...parseWorkflow(BRANCHED).steps[0]!, gate: 'confirm' as never }] })).toThrow(/confirm/u)
  })
})

describe('default 分支', () => {
  it('内建 default 含 pm / frontend / backend / free 四条分支且每条都过 default 骨架校验', () => {
    const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    expect(Object.keys(def.tracks ?? {})).toEqual(['pm', 'frontend', 'backend', 'free'])
    expect(validateWorkflowForStorage('default', def)).toEqual([])
  })

  it('backend 分支的 explore 技能 = 驱动 + 该轨矩阵技能；pm 分支 spec 不要求 plan artifact', () => {
    const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    const backend = compileEffectiveWorkflowPlan('default', def, builtinTrack('backend'))
    expect(backend.capabilities.skills.steps.find((step) => step.stepId === 'explore')?.requiredSkillIds).toEqual([
      'tenon-explore', 'openspec-explore', 'brainstorming', 'grill-with-docs', 'improve-codebase-architecture',
    ])
    const pm = compileEffectiveWorkflowPlan('default', def, builtinTrack('pm'))
    expect(pm.capabilities.skills.steps.find((step) => step.stepId === 'verify')?.requiredSkillIds).toContain('handoff')
    expect(backend.capabilities.skills.steps.find((step) => step.stepId === 'verify')?.requiredSkillIds).not.toContain('handoff')
    // default 运行时 artifact 走生成表：pm 分支的 spec 没有 plan artifact，其余分支有。
    expect(defaultArtifactsForStep('spec', 'pm')).toEqual([])
    expect(defaultArtifactsForStep('spec', 'backend').map((artifact) => artifact.field)).toEqual(['plan'])
  })
})
