import type { WbSkillRef } from '../api/governanceTypes'

/**
 * 技能执行波次：按 depends_on 拓扑深度分组——同一波并行、波与波之间串行。
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

/** 步骤的技能引用 → 波（列）。 */
export function wavesOf(skills: readonly WbSkillRef[]): string[][] {
  return skillExecutionWaves(
    skills.map((skill) => skill.id),
    Object.fromEntries(skills.map((skill) => [skill.id, skill.depends_on ?? []])),
  )
}

/**
 * 波（列）→ 技能引用：第 k 列的每个技能依赖第 k-1 列的全部技能，第 0 列无依赖。
 * 列模型是「同列并行、邻列串行」的唯一真相；其它字段从 `existing` 原样带回。
 */
export function wavesToSkills(waves: readonly (readonly string[])[], existing: readonly WbSkillRef[]): WbSkillRef[] {
  const byId = new Map(existing.map((skill) => [skill.id, skill]))
  const out: WbSkillRef[] = []
  waves.forEach((wave, column) => {
    const previous = column > 0 ? [...(waves[column - 1] ?? [])] : []
    for (const id of wave) {
      const { depends_on: _dropped, ...rest } = byId.get(id) ?? { id }
      out.push(previous.length > 0 ? { ...rest, id, depends_on: previous } : { ...rest, id })
    }
  })
  return out
}

/** 第 i 个技能是否与前一个技能并行 = 不依赖前一个技能（同一波）。首个技能恒为串行起点。 */
export function isParallelWithPrevious(skills: readonly { id: string; depends_on?: string[] }[], index: number): boolean {
  if (index <= 0) return false
  const previous = skills[index - 1]
  const current = skills[index]
  if (!previous || !current) return false
  return !(current.depends_on ?? []).includes(previous.id)
}

/** 把技能放进第 column 列（-1 = 新的首列，waves.length = 新的末列）；从原位置移除；空列被清掉。 */
export function placeSkillInWave(waves: readonly (readonly string[])[], skillId: string, column: number, position: number | null = null): string[][] {
  const stripped = waves.map((wave) => wave.filter((id) => id !== skillId))
  const target = Math.max(-1, Math.min(column, stripped.length))
  if (target === -1) stripped.unshift([])
  else if (target === stripped.length) stripped.push([])
  const index = target === -1 ? 0 : target
  const wave = stripped[index] ?? []
  const at = position === null || position > wave.length ? wave.length : Math.max(0, position)
  wave.splice(at, 0, skillId)
  stripped[index] = wave
  return stripped.filter((wave) => wave.length > 0)
}

/** 在第 column 列之前插入一个只含该技能的新列（列间隙拖放 = 新的串行一步）。 */
export function insertWaveBefore(waves: readonly (readonly string[])[], skillId: string, column: number): string[][] {
  const stripped = waves.map((wave) => wave.filter((id) => id !== skillId)).filter((wave) => wave.length > 0)
  const at = Math.max(0, Math.min(column, stripped.length))
  stripped.splice(at, 0, [skillId])
  return stripped
}
