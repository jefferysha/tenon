/**
 * EffectiveSkillResolver 单测（G2 P5）——default（manifest mandatory+recommended，稳定拼接去重，
 * a|b 拆 alternatives、per-track/_all 回退、畸形 token fail-loud）与 custom（step.skills 稳定去重、
 * 不隐式拆 `|`）两种解析能力。
 */
import { describe, expect, it } from 'vitest'
import { createEffectiveSkillResolver, type EffectiveSkillSlot } from './effective-skill-resolver.js'
import type { SkillTable } from '../flow/manifest.js'
import type { StepIR } from './ir.js'
import type { TrackRegistry } from '../tracks/types.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { legacyDefaultWorkflow } from './test-support.js'

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

function registry(track: string, profile: string): TrackRegistry {
  const def = {
    id: track,
    label: track,
    builtin: false,
    workflow: { default: 'default', allowed: '*' as const },
    policyProfile: {
      reviewSeed: 'pending' as const,
      automationEligible: true,
      coverageProfile: 'none' as const,
      routing: { enabled: false as const },
      skills: { matrix: true, profile },
    },
  }
  return { ordered: [def], byId: new Map([[track, def]]), revision: 'test', source: 'project-file' }
}

describe('T-R6 resolveDefault —— track registry profile 接线', () => {
  it('以 track.policyProfile.skills.profile 查表，不再假设 profile 等于 track id', () => {
    const manifest = {
      mandatorySkills: table({ explore: { 'mobile-profile': ['mobile-build'], mobile: ['wrong-track-key'] } }),
      recommendedSkills: table({ explore: { 'mobile-profile': ['mobile-review'] } }),
    }
    const r = createEffectiveSkillResolver({ registry: registry('mobile', 'mobile-profile'), manifest })
    expect(flat(r.resolveDefault('explore', 'mobile'))).toEqual(['mobile-build', 'mobile-review'])
  })

  it('profile 专属行缺失时回退 _all；两层都缺失时 []', () => {
    const r = createEffectiveSkillResolver({
      registry: registry('mobile', 'mobile-profile'),
      manifest: {
        mandatorySkills: table({ open: { _all: ['shared-open'] } }),
        recommendedSkills: table({}),
      },
    })
    expect(flat(r.resolveDefault('open', 'mobile'))).toEqual(['shared-open'])
    expect(r.resolveDefault('verify', 'mobile')).toEqual([])
  })

  it('未知 track fail-loud，不把无效引用偷降级成 _all', () => {
    const r = createEffectiveSkillResolver({
      registry: registry('mobile', 'mobile-profile'),
      manifest: { mandatorySkills: table({ open: { _all: ['shared-open'] } }), recommendedSkills: table({}) },
    })
    expect(() => r.resolveDefault('open', 'ghost')).toThrow(/track.*ghost|ghost.*track/i)
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
