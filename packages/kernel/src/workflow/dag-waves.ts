/**
 * 依赖图的波次：wave(x) = 0 无前置，否则 1 + 前置的最大 wave。同一波并行、波与波串行。
 *
 * 技能、执行者、评审者的排波都走这一个函数，编号口径因此只有一处。前置里指向图外的名字不计；
 * 环（校验期本会拒绝）按回边为 0 处理，保证任何输入都能得到有限的编号。
 */
export interface DependencyRef {
  readonly id: string
  readonly dependsOn: readonly string[]
}

export function dependencyWaves(refs: readonly DependencyRef[]): ReadonlyMap<string, number> {
  const byId = new Map(refs.map((ref) => [ref.id, ref]))
  const waves = new Map<string, number>()
  const visit = (id: string, trail: ReadonlySet<string>): number => {
    const cached = waves.get(id)
    if (cached !== undefined) return cached
    const ref = byId.get(id)
    if (ref === undefined || trail.has(id)) return -1
    const next = new Set([...trail, id])
    const wave = ref.dependsOn.reduce((max, dependency) => Math.max(max, visit(dependency, next) + 1), 0)
    waves.set(id, wave)
    return wave
  }
  for (const ref of refs) visit(ref.id, new Set())
  return waves
}

/**
 * 传递约简：去掉能经由其它前置到达的前置（A→B→C 里 C 只留 B）。画图用——语义不变，边不重复。
 */
export function directDependencies(refs: readonly DependencyRef[]): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(refs.map((ref) => [ref.id, ref]))
  const ancestors = new Map<string, ReadonlySet<string>>()
  const ancestorsOf = (id: string, trail: ReadonlySet<string>): ReadonlySet<string> => {
    const cached = ancestors.get(id)
    if (cached !== undefined) return cached
    const out = new Set<string>()
    if (trail.has(id)) return out
    const next = new Set([...trail, id])
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue
      out.add(dependency)
      for (const ancestor of ancestorsOf(dependency, next)) out.add(ancestor)
    }
    ancestors.set(id, out)
    return out
  }
  const direct = new Map<string, readonly string[]>()
  for (const ref of refs) {
    const known = [...new Set(ref.dependsOn)].filter((dependency) => byId.has(dependency) && dependency !== ref.id)
    direct.set(ref.id, known.filter((dependency) =>
      !known.some((other) => other !== dependency && ancestorsOf(other, new Set([ref.id])).has(dependency))))
  }
  return direct
}
