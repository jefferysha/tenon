import { effectiveSkillDependencies, minimalSkillDependencies } from '@tenon/kernel/workflow/skill-order'
import type { WbSkillRef } from '../api/governanceTypes'

/**
 * 图的执行波次：按 depends_on 拓扑深度分组——同一波并行、波与波之间串行，未写依赖的节点在第 0 波。
 * 这是画布（SkillFlow）的图口径，节点的依赖都已显式给出；技能在阶段里「没写 depends_on = 按声明顺序
 * 串行」的规则由 kernel skill-order 负责，进画布之前先用 explicitSkillRefs 展开。
 * 只认同阶段内的依赖；环依赖按深度 0 处理（kernel 校验期会拒绝环，这里不重复报错）。
 */
export function skillExecutionWaves(
  skills: readonly string[],
  depsBySkill: Readonly<Record<string, string[]>>,
): string[][] {
  const skillSet = new Set(skills)
  const memo = new Map<string, number>()

  function depthOf(skillId: string, trail: ReadonlySet<string>): number {
    const cached = memo.get(skillId)
    if (cached !== undefined) return cached
    if (trail.has(skillId)) return 0
    const nextTrail = new Set(trail).add(skillId)
    const dependencies = (depsBySkill[skillId] ?? []).filter((dependency) => skillSet.has(dependency))
    const depth = dependencies.length === 0
      ? 0
      : Math.max(...dependencies.map((dependency) => depthOf(dependency, nextTrail))) + 1
    memo.set(skillId, depth)
    return depth
  }

  const waves: string[][] = []
  for (const skillId of skills) {
    const depth = depthOf(skillId, new Set())
    const wave = waves[depth] ?? []
    wave.push(skillId)
    waves[depth] = wave
  }
  return waves.filter((wave) => wave.length > 0)
}

/** 显式依赖图 → 波（列）。 */
export function wavesOf(skills: readonly WbSkillRef[]): string[][] {
  return skillExecutionWaves(
    skills.map((skill) => skill.id),
    Object.fromEntries(skills.map((skill) => [skill.id, skill.depends_on ?? []])),
  )
}

/**
 * 阶段技能 → 画布用的显式依赖：每个技能都写上它实际的直接前置（没写 depends_on 的 = 前面全部，约简后；
 * 没有前置的写 `[]`），所以这份结果再按技能口径解读也不变。
 */
export function explicitSkillRefs(skills: readonly WbSkillRef[]): WbSkillRef[] {
  const effective = new Map(effectiveSkillDependencies(skills).map((item) => [item.id, item.dependsOn]))
  return skills.map((skill) => ({ ...skill, depends_on: [...(effective.get(skill.id) ?? [])] }))
}

/**
 * 画布回写 → 阶段技能：按执行顺序排好的显式依赖压成最小声明——与「前面全部」等价的不写 depends_on，
 * 与前面并行的写 `depends_on: []`（或上一波），其余字段原样带回。
 */
export function minimalSkillRefs(skills: readonly WbSkillRef[]): WbSkillRef[] {
  const minimal = minimalSkillDependencies(skills.map((skill) => ({ id: skill.id, dependsOn: skill.depends_on ?? [] })))
  return skills.map((skill, index) => {
    const { depends_on: _explicit, ...rest } = skill
    const declared = minimal[index]?.depends_on
    return declared === undefined ? rest : { ...rest, depends_on: [...declared] }
  })
}

/** 两份阶段技能是否排出同一个顺序（画布比较用；`[]` 与未写的差别在这里算数）。 */
export function skillOrderSignature(skills: readonly WbSkillRef[]): string {
  return effectiveSkillDependencies(skills).map((item) => `${item.id}<${[...item.dependsOn].sort().join(',')}`).join('|')
}

/** 追加技能：不写 depends_on，按声明顺序接在前面全部之后。 */
export function appendSkill(skills: readonly WbSkillRef[], id: string): WbSkillRef[] {
  return skills.some((skill) => skill.id === id) ? [...skills] : [...skills, { id }]
}

/** 移除技能：别的技能对它的依赖一并摘掉；只依赖它的那个改回按声明顺序接在前面之后。 */
export function removeSkill(skills: readonly WbSkillRef[], id: string): WbSkillRef[] {
  return skills.filter((skill) => skill.id !== id).map((skill) => {
    if (skill.depends_on?.includes(id) !== true) return skill
    const { depends_on: dependsOn, ...rest } = skill
    const kept = dependsOn.filter((dependency) => dependency !== id)
    return kept.length === 0 ? rest : { ...rest, depends_on: kept }
  })
}
