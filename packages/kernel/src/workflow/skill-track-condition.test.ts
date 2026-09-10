import { describe, expect, it } from 'vitest'
import { builtinTrack, BUILTIN_TRACK_DEFINITIONS } from '../tracks/builtins.js'
import type { TrackDefinition } from '../tracks/types.js'
import { compileEffectiveWorkflowPlan, skillAppliesToTrack } from './effective-plan.js'
import { createEffectiveSkillResolver, resolveExplicitProfileSkillSlots, resolveRequiredSkillSlots } from './effective-skill-resolver.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import { validateWorkflowTrackReferences } from './track-reference-validation.js'
import { validateWorkflow } from './validate.js'
import type { WorkflowDef } from './types.js'

const CUSTOM = `name: cond
steps:
  - id: s1
    label: One
    gate: null
    skills:
      - id: base
      - id: fe-only
        when:
          track_in: [frontend]
      - id: not-pm
        depends_on: [base, fe-only]
        when:
          track_not_in: [pm]
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

describe('SkillRef.when · 解析 / 序列化 / 校验', () => {
  it('parse ↔ serialize 往返保留 when', () => {
    const def = parseWorkflow(CUSTOM)
    expect(def.steps[0]?.skills[1]).toEqual({ id: 'fe-only', when: { kind: 'track-in', values: ['frontend'] } })
    expect(def.steps[0]?.skills[2]?.when).toEqual({ kind: 'track-not-in', values: ['pm'] })
    const again = parseWorkflow(serializeWorkflow(def))
    expect(again.steps[0]?.skills).toEqual(def.steps[0]?.skills)
    expect(validateWorkflow(def)).toEqual([])
  })

  it('when 引用未知 track → 引用校验报错；非法 track id → validateWorkflow 报错', () => {
    const def = parseWorkflow(CUSTOM.replace('track_in: [frontend]', 'track_in: [ghost]'))
    const ordered = [...BUILTIN_TRACK_DEFINITIONS]
    const registry = { revision: 'r', source: 'builtin-only' as const, tracks: ordered, byId: new Map(ordered.map((track) => [track.id, track])) }
    expect(validateWorkflowTrackReferences(def, registry as never).join(' ')).toContain("未知 track 'ghost'")
    const bad = parseWorkflow(CUSTOM.replace('track_in: [frontend]', 'track_in: [Bad.Track]'))
    expect(validateWorkflow(bad).join(' ')).toContain('非法 track id')
  })
})

describe('SkillRef.when · 有效计划按轨道过滤', () => {
  const def: WorkflowDef = parseWorkflow(CUSTOM)

  it('frontend 拿到全部三个；pm 只有 base；backend 拿 base + not-pm 且 dependsOn 里去掉被过滑的 fe-only', () => {
    const fe = compileEffectiveWorkflowPlan('cond', def, builtinTrack('frontend')).capabilities.skills.steps[0]
    expect(fe?.requiredSkillIds).toEqual(['base', 'fe-only', 'not-pm'])
    const pm = compileEffectiveWorkflowPlan('cond', def, builtinTrack('pm')).capabilities.skills.steps[0]
    expect(pm?.requiredSkillIds).toEqual(['base'])
    const be = compileEffectiveWorkflowPlan('cond', def, builtinTrack('backend')).capabilities.skills.steps[0]
    expect(be?.requiredSkillIds).toEqual(['base', 'not-pm'])
    expect(be?.declared.find((skill) => skill.id === 'not-pm')?.dependsOn).toEqual(['base'])
  })

  it('无轨道语境不过滤；自定义轨道按其 skills.profile 继承', () => {
    const none = compileEffectiveWorkflowPlan('cond', def).capabilities.skills.steps[0]
    expect(none?.requiredSkillIds).toEqual(['base', 'fe-only', 'not-pm'])
    const custom: TrackDefinition = {
      ...builtinTrack('frontend'),
      id: 'web-app',
      label: 'Web App',
      builtin: false,
      policyProfile: { ...builtinTrack('frontend').policyProfile, skills: { matrix: true, profile: 'frontend' } },
    }
    expect(skillAppliesToTrack({ when: { kind: 'track-in', values: ['frontend'] } }, custom)).toBe(true)
    expect(skillAppliesToTrack({ when: { kind: 'track-in', values: ['frontend'] } }, { ...custom, policyProfile: { ...custom.policyProfile, skills: { matrix: false, profile: '_all' } } })).toBe(false)
  })

  it('fingerprint 不随轨道变化（when 属于定义，过滤属于运行时投影）', () => {
    const fe = compileEffectiveWorkflowPlan('cond', def, builtinTrack('frontend'))
    const pm = compileEffectiveWorkflowPlan('cond', def, builtinTrack('pm'))
    expect(fe.workflowFingerprint).toBe(pm.workflowFingerprint)
  })
})

describe('default 模板 · 技能矩阵已并入 YAML（manifest-overlay 的叠加层来自定义）', () => {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  const emptyResolver = createEffectiveSkillResolver({ mandatorySkills: {} as never, recommendedSkills: {} as never })

  it('default 仍是 manifest-overlay；phase 槽只有驱动技能，带 when 的技能进 conditional 叠加层', () => {
    const fe = compileEffectiveWorkflowPlan('default', def, builtinTrack('frontend'))
    expect(fe.skillPolicy).toBe('manifest-overlay')
    expect(fe.capabilities.skills.matrixEmbedded).toBe(true)
    const explore = fe.capabilities.skills.steps.find((step) => step.stepId === 'explore')
    expect(explore?.requiredSkillIds).toEqual(['tenon-explore'])
    expect(explore?.conditional.map((skill) => skill.id)).toEqual(['openspec-explore', 'brainstorming', 'grill-with-docs', 'improve-codebase-architecture'])
  })

  it('resolver 按轨道叠加：frontend / backend / chat 各得其所，机器级 manifest mandatory 表被忽略', () => {
    const slots = (track: 'frontend' | 'backend' | 'chat' | 'pm'): string[] => {
      const plan = compileEffectiveWorkflowPlan('default', def, builtinTrack(track))
      return resolveRequiredSkillSlots(emptyResolver, plan.capabilities.skills, 'explore').map((slot) => slot.token)
    }
    expect(slots('frontend')).toEqual(['tenon-explore', 'openspec-explore', 'brainstorming', 'grill-with-docs'])
    expect(slots('backend')).toContain('improve-codebase-architecture')
    expect(slots('pm')).toEqual(['tenon-explore', 'brainstorming', 'grill-with-docs'])
    expect(slots('chat')).toEqual(['tenon-explore'])
    const explicit = resolveExplicitProfileSkillSlots(emptyResolver, compileEffectiveWorkflowPlan('default', def, builtinTrack('chat')).capabilities.skills, 'ship', 'pm')
    expect(explicit.map((slot) => slot.token)).toEqual(['tenon-ship', 'openspec-apply-change', 'to-spec', 'to-tickets'])
  })

  it('没有 when 的老 default 定义 matrixEmbedded=false，仍按机器级 manifest 叠加（冻结快照与旧行为不变）', () => {
    const legacy: WorkflowDef = {
      ...def,
      steps: def.steps.map((step) => ({ ...step, skills: step.skills.filter((skill) => skill.when === undefined) })),
    }
    const plan = compileEffectiveWorkflowPlan('default', legacy, builtinTrack('frontend'))
    expect(plan.skillPolicy).toBe('manifest-overlay')
    expect(plan.capabilities.skills.matrixEmbedded).toBe(false)
    expect(resolveRequiredSkillSlots(emptyResolver, plan.capabilities.skills, 'explore').map((slot) => slot.token)).toEqual(['tenon-explore'])
  })
})
