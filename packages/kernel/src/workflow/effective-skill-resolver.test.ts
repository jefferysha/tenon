/**
 * EffectiveSkillResolver 单测（G2 P5）——default（manifest mandatory+recommended，稳定拼接去重，
 * a|b 拆 alternatives、per-track/_all 回退、畸形 token fail-loud）与 custom（step.skills 稳定去重、
 * 不隐式拆 `|`）两种解析能力。
 */
import { describe, expect, it } from 'vitest'
import {
  createEffectiveSkillResolver,
  resolveAvailableSkillSlots,
  resolveExplicitProfileSkillSlots,
  resolveRequiredSkillSlots,
  type EffectiveSkillSlot,
} from './effective-skill-resolver.js'
import type { SkillTable } from '../flow/manifest.js'
import type { StepIR } from './ir.js'
import { compileEffectiveWorkflowPlan, effectiveWorkflowPlanFromIr } from './effective-plan.js'
import { defaultIr, legacyDefaultPlan } from './test-support.js'

/** 最小 SkillTable 夹具（缺相位 → skillsFor 返 []，无须补全 Record<Phase,…>）。 */
function table(rows: Record<string, Record<string, readonly string[]>>): SkillTable {
  return rows as unknown as SkillTable
}

/** 只填 id/skills 的 StepIR 夹具（resolveCustom 只读 step.skills）。 */
function step(skills: readonly { id: string }[]): StepIR {
  return { id: 's', label: '', gate: null, skills, inputs: [], outputs: [], guards: [], artifacts: [], transitions: [] }
}

const flat = (slots: readonly EffectiveSkillSlot[]) => slots.map((s) => s.token)
const alts = (slots: readonly EffectiveSkillSlot[]) => slots.flatMap((s) => s.alternatives)

/** manifest 里为 explore 配了矩阵技能：叠加分支删除后，它不得再进入任何必需 / 可用 / 显式 profile 投影。 */
const MATRIX = {
  mandatorySkills: table({ explore: { backend: ['matrix-skill'], _all: ['matrix-skill'] } }),
  recommendedSkills: table({ explore: { backend: ['matrix-recommended'] } }),
}

describe('技能投影只来自工作流声明，不叠加 manifest 矩阵', () => {
  const stepGraphSkills = () => effectiveWorkflowPlanFromIr('default', defaultIr(), { track: 'backend' }).capabilities.skills
  // 旧快照里的 default 步骤不声明技能（它们当年全靠矩阵），source 记着 manifest-overlay。
  const legacySkills = () =>
    legacyDefaultPlan({ track: 'backend', executionModel: 'phase-manifest' }).capabilities.skills
  const DECLARED = ['openspec-explore', 'brainstorming', 'grilling', 'domain-modeling', 'codebase-design']

  it('装配了矩阵的 resolver：必需 / 可用 / 显式 profile 三个投影都只给步骤自己声明的技能', () => {
    const r = createEffectiveSkillResolver(MATRIX)
    const capability = stepGraphSkills()
    expect(flat(resolveRequiredSkillSlots(r, capability, 'explore'))).toEqual(DECLARED)
    expect(flat(resolveAvailableSkillSlots(r, capability, 'explore'))).toEqual(DECLARED)
    expect(flat(resolveExplicitProfileSkillSlots(r, capability, 'explore', 'backend'))).toEqual(DECLARED)
  })

  it('旧 manifest-overlay 计划也不叠加：声明为空的步骤得到空集', () => {
    const r = createEffectiveSkillResolver(MATRIX)
    const capability = legacySkills()
    expect(capability.source).toBe('manifest-overlay')
    expect(resolveRequiredSkillSlots(r, capability, 'explore')).toEqual([])
    expect(resolveAvailableSkillSlots(r, capability, 'explore')).toEqual([])
    expect(resolveExplicitProfileSkillSlots(r, capability, 'explore', 'backend')).toEqual([])
  })

  it('宿主没有 resolver 时同样只给声明的技能；宿主实现的覆写方法优先', () => {
    expect(resolveRequiredSkillSlots(undefined, legacySkills(), 'explore')).toEqual([])
    expect(flat(resolveRequiredSkillSlots(undefined, stepGraphSkills(), 'explore'))).toEqual(DECLARED)
    expect(resolveExplicitProfileSkillSlots(undefined, legacySkills(), 'explore', 'backend')).toEqual([])
    const override = { ...createEffectiveSkillResolver(MATRIX), resolveRequired: () => [{ token: 'host', alternatives: ['host'] }] }
    expect(flat(resolveRequiredSkillSlots(override, stepGraphSkills(), 'explore'))).toEqual(['host'])
  })
})

describe('resolveDefault —— 不经轨道登记表：第二个参数就是 manifest 里的 profile 名', () => {
  it('按 profile 名查表；专属行缺失回退 _all，两层都缺失 []', () => {
    const r = createEffectiveSkillResolver({
      mandatorySkills: table({ explore: { 'mobile-profile': ['mobile-build'] }, open: { _all: ['shared-open'] } }),
      recommendedSkills: table({ explore: { 'mobile-profile': ['mobile-review'] } }),
    })
    expect(flat(r.resolveDefault('explore', 'mobile-profile'))).toEqual(['mobile-build', 'mobile-review'])
    expect(flat(r.resolveDefault('open', 'ghost'))).toEqual(['shared-open'])
    expect(r.resolveDefault('verify', 'ghost')).toEqual([])
  })
})

describe('resolveDefault —— manifest mandatory + recommended', () => {
  it('per-track 命中：mandatory 在前、recommended 在后（顺序稳定）', () => {
    const r = createEffectiveSkillResolver({
      mandatorySkills: table({ explore: { frontend: ['m1', 'm2'] } }),
      recommendedSkills: table({ explore: { frontend: ['r1'] } }),
    })
    expect(flat(r.resolveDefault('explore', 'frontend'))).toEqual(['m1', 'm2', 'r1'])
  })

  it('_all 回退：track 无专属行时命中 _all（skillsFor 三级回退）', () => {
    const r = createEffectiveSkillResolver({
      mandatorySkills: table({ open: { _all: ['propose'] } }),
      recommendedSkills: table({}),
    })
    expect(flat(r.resolveDefault('open', 'backend'))).toEqual(['propose'])
    expect(flat(r.resolveDefault('open', 'pm'))).toEqual(['propose'])
  })

  it('无表（stepId 非 phase / 该 track 无声明）→ 空槽集', () => {
    const r = createEffectiveSkillResolver({
      mandatorySkills: table({ explore: { frontend: ['m1'] } }),
      recommendedSkills: table({}),
    })
    expect(r.resolveDefault('not-a-phase', 'frontend')).toEqual([])
    expect(r.resolveDefault('explore', 'chat')).toEqual([]) // chat 无专属行、无 _all → 空
  })

  it('token 稳定去重：mandatory 与 recommended 同 token 只保留一次（mandatory 位次在前）', () => {
    const r = createEffectiveSkillResolver({
      mandatorySkills: table({ build: { frontend: ['shared', 'm-only'] } }),
      recommendedSkills: table({ build: { frontend: ['shared', 'r-only'] } }),
    })
    expect(flat(r.resolveDefault('build', 'frontend'))).toEqual(['shared', 'm-only', 'r-only'])
  })

  it('a|b 备选拆成一个 slot 的多个具体 alternatives', () => {
    const r = createEffectiveSkillResolver({
      mandatorySkills: table({ explore: { frontend: ['opsx:explore|openspec-explore', 'grill-with-docs'] } }),
      recommendedSkills: table({}),
    })
    const slots = r.resolveDefault('explore', 'frontend')
    expect(slots).toEqual([
      { token: 'opsx:explore|openspec-explore', alternatives: ['opsx:explore', 'openspec-explore'] },
      { token: 'grill-with-docs', alternatives: ['grill-with-docs'] },
    ])
    // 具体 alternative 展平序 = manifest 序（错误列许可 producer 时的稳定序）
    expect(alts(slots)).toEqual(['opsx:explore', 'openspec-explore', 'grill-with-docs'])
  })

  it('畸形 token（空 branch / 纯空白 branch / 重复 branch）→ fail-loud（不静默过滤）', () => {
    const empty = createEffectiveSkillResolver({
      mandatorySkills: table({ explore: { frontend: ['a||b'] } }),
      recommendedSkills: table({}),
    })
    expect(() => empty.resolveDefault('explore', 'frontend')).toThrow(/alternative branch/)
    // 纯空白 branch（a| |b）也拒——不能静默当合法具体 skill（codex P5 review 边际项）
    const blank = createEffectiveSkillResolver({
      mandatorySkills: table({ explore: { frontend: ['a| |b'] } }),
      recommendedSkills: table({}),
    })
    expect(() => blank.resolveDefault('explore', 'frontend')).toThrow(/alternative branch/)
    const dup = createEffectiveSkillResolver({
      mandatorySkills: table({ explore: { frontend: ['a|a'] } }),
      recommendedSkills: table({}),
    })
    expect(() => dup.resolveDefault('explore', 'frontend')).toThrow(/重复 alternative branch/)
  })
})
