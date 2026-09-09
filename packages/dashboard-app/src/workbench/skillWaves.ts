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

/** 第 i 个技能是否与前一个技能并行 = 不依赖前一个技能（同一波）。首个技能恒为串行起点。 */
export function isParallelWithPrevious(skills: readonly { id: string; depends_on?: string[] }[], index: number): boolean {
  if (index <= 0) return false
  const previous = skills[index - 1]
  const current = skills[index]
  if (!previous || !current) return false
  return !(current.depends_on ?? []).includes(previous.id)
}
