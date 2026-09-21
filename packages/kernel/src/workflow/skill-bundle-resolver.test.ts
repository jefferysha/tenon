/**
 * skill-bundle-resolver 单测（H10 任务 2）——G2 适配层：把「workflow kind + step + profile ID」
 * 翻译成对现有 EffectiveSkillResolver 的一次具体调用。default 委托 resolveDefault、custom 委托
 * resolveCustom；profileId 原样透传（不做值域校验，值域校验是 H10 任务 1 registry/governance 的
 * 职责）；resolution source 如实标注调用了哪条分支；a|b alternative 按声明序原样输出，不做物化
 * 选择/过滤（物化选择是 H10 任务 4/5 的事）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createEffectiveSkillResolver,
  type EffectiveSkillResolver,
  type EffectiveSkillSlot,
} from './effective-skill-resolver.js'
import { resolveSkillBundle } from './skill-bundle-resolver.js'
import type { SkillTable } from '../flow/manifest.js'
import type { StepIR } from './ir.js'
import type { TrackRegistry } from '../tracks/types.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { legacyDefaultWorkflow } from './test-support.js'

/** 最小 SkillTable 夹具（对齐 effective-skill-resolver.test.ts 同款写法）。 */
function table(rows: Record<string, Record<string, readonly string[]>>): SkillTable {
  return rows as unknown as SkillTable
}

/** 只填 id/skills 的 StepIR 夹具（resolveCustom 只读 step.skills）。 */
function step(skills: readonly { id: string }[]): StepIR {
  return { id: 's', label: '', gate: null, skills, inputs: [], outputs: [], guards: [], artifacts: [], transitions: [] }
}

describe('resolveSkillBundle —— default 分支委托 frozen explicit profile', () => {
  const capability = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow()).capabilities.skills

  it('原样转发 capability/stepId/profileId 给 resolveExplicitProfile，source 标 default，不触碰 legacy profile API/custom', () => {
    const slots: EffectiveSkillSlot[] = [{ token: 'm1', alternatives: ['m1'] }]
    const resolveDefault = vi.fn().mockReturnValue(slots)
    const resolveExplicitProfile = vi.fn().mockReturnValue(slots)
    const resolveCustom = vi.fn()
    const resolver: EffectiveSkillResolver = { resolveDefault, resolveExplicitProfile, resolveCustom }

    const result = resolveSkillBundle(resolver, {
      kind: 'default', stepId: 'explore', profileId: 'frontend', capability,
    })

    expect(resolveExplicitProfile).toHaveBeenCalledWith(capability, 'explore', 'frontend')
    expect(resolveDefault).not.toHaveBeenCalled()
    expect(resolveCustom).not.toHaveBeenCalled()
    expect(result).toEqual({ source: 'default', slots })
  })

  it('端到端（真 resolver）：manifest mandatory+recommended 三级回退、a|b alternative 声明序原样保留', () => {
    const resolver = createEffectiveSkillResolver({
      mandatorySkills: table({ explore: { frontend: ['opsx:explore|openspec-explore', 'grill-with-docs'] } }),
      recommendedSkills: table({}),
    })

    const result = resolveSkillBundle(resolver, {
      kind: 'default', stepId: 'explore', profileId: 'frontend', capability,
    })

    expect(result).toEqual({
      source: 'default',
      slots: [
        { token: 'opsx:explore|openspec-explore', alternatives: ['opsx:explore', 'openspec-explore'] },
        { token: 'grill-with-docs', alternatives: ['grill-with-docs'] },
      ],
    })
  })

  it('端到端（真 resolver）：_all 回退命中 与 无表 → 合法空槽集，都原样透出（不算未接线）', () => {
    const resolver = createEffectiveSkillResolver({
      mandatorySkills: table({ open: { _all: ['propose'] } }),
      recommendedSkills: table({}),
    })

    expect(resolveSkillBundle(resolver, {
      kind: 'default', stepId: 'open', profileId: 'backend', capability,
    })).toEqual({
      source: 'default',
      slots: [
        { token: 'propose', alternatives: ['propose'] },
      ],
    })
    expect(resolveSkillBundle(resolver, {
      kind: 'default', stepId: 'not-a-phase', profileId: 'frontend', capability,
    })).toEqual({
      source: 'default',
      slots: [],
    })
  })

  it('T-R6/H10 组合：registry-aware resolver 仍按显式 profileId 解析 skill bundle，_all 不被当成 track id', () => {
    const registry = {
      ordered: [],
      byId: new Map(),
      revision: 'test',
      source: 'builtin-only',
    } as TrackRegistry
    const resolver = createEffectiveSkillResolver({
      registry,
      manifest: {
        mandatorySkills: table({ open: { _all: ['propose'] } }),
        recommendedSkills: table({}),
      },
    })

    expect(resolveSkillBundle(resolver, {
      kind: 'default', stepId: 'open', profileId: '_all', capability,
    })).toEqual({
      source: 'default',
      slots: [
        { token: 'propose', alternatives: ['propose'] },
      ],
    })
  })

  it('issue #43：携带冻结 capability 时显式 profile 以 phase slot 开头', () => {
    const resolver = createEffectiveSkillResolver({
      mandatorySkills: table({ build: { free: ['writing-plans'] } }),
      recommendedSkills: table({ build: { free: ['hallmark'] } }),
    })
    const plan = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow())
    const result = resolveSkillBundle(resolver, {
      kind: 'default', stepId: 'build', profileId: 'free', capability: plan.capabilities.skills,
    })
    expect(result.slots.map((slot) => slot.token)).toEqual(['writing-plans', 'hallmark'])
  })

  it('issue #43：default bundle 缺 frozen capability 时 fail-closed，不回退到 profile-only resolver', () => {
    const resolver = createEffectiveSkillResolver({
      mandatorySkills: table({ build: { free: ['writing-plans'] } }),
      recommendedSkills: table({}),
    })
    expect(() => resolveSkillBundle(resolver, {
      kind: 'default', stepId: 'build', profileId: 'free', capability: undefined as never,
    })).toThrow('default skill bundle requires frozen workflow capability')
  })
})

describe('resolveSkillBundle —— custom 分支委托 resolveCustom', () => {
  it('原样转发 step/profileId 给 resolveCustom，source 标 custom，slots 等于 resolver 产出、不触碰 resolveDefault', () => {
    const slots: EffectiveSkillSlot[] = [{ token: 'skill-a', alternatives: ['skill-a'] }]
    const resolveDefault = vi.fn()
    const resolveCustom = vi.fn().mockReturnValue(slots)
    const resolver: EffectiveSkillResolver = { resolveDefault, resolveCustom }
    const stepIR = step([{ id: 'skill-a' }])

    const result = resolveSkillBundle(resolver, { kind: 'custom', step: stepIR, profileId: 'frontend' })

    expect(resolveCustom).toHaveBeenCalledWith(stepIR, 'frontend')
    expect(resolveDefault).not.toHaveBeenCalled()
    expect(result).toEqual({ source: 'custom', slots })
  })

  it('端到端（真 resolver）：只读 step.skills，同名 phase 在 manifest 有声明也不叠加（step.skills 唯一真相）', () => {
    const resolver = createEffectiveSkillResolver({
      mandatorySkills: table({ explore: { frontend: ['should-not-leak'] } }),
      recommendedSkills: table({}),
    })
    const stepIR = step([{ id: 'skill-a' }, { id: 'skill-b' }])

    const result = resolveSkillBundle(resolver, { kind: 'custom', step: stepIR, profileId: 'frontend' })

    expect(result).toEqual({
      source: 'custom',
      slots: [
        { token: 'skill-a', alternatives: ['skill-a'] },
        { token: 'skill-b', alternatives: ['skill-b'] },
      ],
    })
  })

  it('端到端（真 resolver）：custom id 的 `|` 不隐式拆 alternative（视为单个具体 id）', () => {
    const resolver = createEffectiveSkillResolver({ mandatorySkills: table({}), recommendedSkills: table({}) })

    const result = resolveSkillBundle(resolver, {
      kind: 'custom',
      step: step([{ id: 'a|b' }]),
      profileId: 'frontend',
    })

    expect(result).toEqual({ source: 'custom', slots: [{ token: 'a|b', alternatives: ['a|b'] }] })
  })

  it('端到端（真 resolver）：空 step.skills → 合法空槽集', () => {
    const resolver = createEffectiveSkillResolver({ mandatorySkills: table({}), recommendedSkills: table({}) })

    expect(resolveSkillBundle(resolver, { kind: 'custom', step: step([]), profileId: 'frontend' })).toEqual({
      source: 'custom',
      slots: [],
    })
  })
})
