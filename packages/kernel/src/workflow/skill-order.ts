/**
 * 步骤技能的执行顺序——技能门（internal-skill-gate）、`tenon status` 的 step.skills 投影与 Dashboard 画布
 * 共用的唯一实现。
 *
 * 规则只有一条：声明了 `depends_on` 的技能按声明的前置排（`depends_on: []` = 无前置，与前面的技能并行）；
 * 没声明的技能保持声明顺序串行——它的前置是声明顺序中排在它前面的全部技能。波次由前置推出（dag-waves），
 * 同一波并行、波与波串行。0.1.x 的 runner 一律按声明顺序串行，它就是「全部未声明」的特例。
 */
import { dependencyWaves, directDependencies } from './dag-waves.js'

/** 波次的唯一算法；Dashboard 画布经这个子路径使用同一份，不再自己算。 */
export { dependencyWaves } from './dag-waves.js'

/** Pipeline 自有技能在宿主里以 `tenon:<id>` 出现；workflow 数据用裸 id。 */
export function bareSkillId(id: string): string {
  return id.startsWith('tenon:') ? id.slice('tenon:'.length) : id
}

export interface SkillOrderDeclaration {
  readonly id: string
  readonly dependsOn: readonly string[]
  /** false = 定义里没写 depends_on（按声明顺序串行）；缺省时按 dependsOn 非空推断（兼容旧计划对象）。 */
  readonly dependsOnDeclared?: boolean
}

export interface SkillOrderSlot {
  readonly token: string
  readonly alternatives: readonly string[]
}

export interface OrderedSkillSlot extends SkillOrderSlot {
  /** 前置槽位的 token：声明的 depends_on，或未声明时声明顺序中排在它前面的全部槽位。 */
  readonly dependsOn: readonly string[]
  readonly wave: number
  /** depends_on 是否来自声明（false = 按声明顺序串行推出）。 */
  readonly declared: boolean
}

function slotMatches(slot: SkillOrderSlot, id: string): boolean {
  const bare = bareSkillId(id)
  return bareSkillId(slot.token) === bare || slot.alternatives.some((alternative) => bareSkillId(alternative) === bare)
}

/** from 是否（沿已知前置）到达 target。 */
function reaches(edges: ReadonlyMap<number, readonly number[]>, from: number, target: number): boolean {
  const seen = new Set<number>()
  const stack = [from]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || seen.has(current)) continue
    if (current === target) return true
    seen.add(current)
    stack.push(...(edges.get(current) ?? []))
  }
  return false
}

/**
 * 给有序槽位排出前置与波次。`declared` 是步骤里声明的技能（capability.declared 或 step.skills）；
 * 不在声明里的槽位（manifest 叠加）按声明顺序串行。未声明的槽位不把「经声明前置已依赖它」的前面槽位算作
 * 前置，所以声明的前向依赖与声明顺序串行混在一起也不会成环。
 */
export function orderSkillSlots(
  slots: readonly SkillOrderSlot[],
  declared: readonly SkillOrderDeclaration[],
): readonly OrderedSkillSlot[] {
  const edges = new Map<number, number[]>()
  const explicit = new Set<number>()
  slots.forEach((slot, index) => {
    const declaration = declared.find((candidate) => slotMatches(slot, candidate.id))
    if (declaration === undefined) return
    const isDeclared = declaration.dependsOnDeclared ?? declaration.dependsOn.length > 0
    if (!isDeclared) return
    explicit.add(index)
    const dependencies = declaration.dependsOn
      .map((dependency) => slots.findIndex((candidate) => slotMatches(candidate, dependency)))
      .filter((dependency) => dependency >= 0 && dependency !== index)
    edges.set(index, [...new Set(dependencies)])
  })
  slots.forEach((_slot, index) => {
    if (explicit.has(index)) return
    const before = slots.slice(0, index).map((_candidate, earlier) => earlier)
    edges.set(index, before.filter((earlier) => !reaches(edges, earlier, index)))
  })
  const waves = dependencyWaves(slots.map((slot, index) => ({
    id: String(index),
    dependsOn: (edges.get(index) ?? []).map(String),
  })))
  return slots.map((slot, index) => ({
    token: slot.token,
    alternatives: slot.alternatives,
    dependsOn: (edges.get(index) ?? []).map((dependency) => slots[dependency]?.token ?? '').filter((token) => token !== ''),
    wave: waves.get(String(index)) ?? 0,
    declared: explicit.has(index),
  }))
}

/** 技能的执行态：done 完成；invoked 已调用但本步绑定的文档还没登记；ready 前置已齐；waiting 等前置。 */
export type SkillSlotStatus = 'done' | 'invoked' | 'ready' | 'waiting'

export function skillSlotStatuses(
  ordered: readonly OrderedSkillSlot[],
  progress: readonly { readonly done: boolean; readonly invoked: boolean }[],
): readonly SkillSlotStatus[] {
  const done = new Map(ordered.map((slot, index) => [slot.token, progress[index]?.done === true]))
  return ordered.map((slot, index) => {
    const own = progress[index]
    if (own?.done === true) return 'done'
    if (slot.dependsOn.some((dependency) => done.get(dependency) !== true)) return 'waiting'
    return own?.invoked === true ? 'invoked' : 'ready'
  })
}

/** 还没完成的前置槽位（token）；空 = 已解锁。`completed` 判一个槽位的任一备选是否已完成。 */
export function missingSkillDependencies(
  ordered: readonly OrderedSkillSlot[],
  index: number,
  completed: (slot: OrderedSkillSlot) => boolean,
): readonly string[] {
  const slot = ordered[index]
  if (slot === undefined) return []
  return slot.dependsOn.filter((token) => {
    const dependency = ordered.find((candidate) => candidate.token === token)
    return dependency !== undefined && !completed(dependency)
  })
}

export interface SkillRefLike {
  readonly id: string
  readonly depends_on?: readonly string[]
}

export interface EffectiveSkillDependency {
  readonly id: string
  /** 直接前置（传递约简后；语义与完整前置相同）。 */
  readonly dependsOn: readonly string[]
  readonly wave: number
}

/** 技能引用 → 每个技能实际的直接前置与波次（未声明 = 前面全部，约简后通常就是前一波）。 */
export function effectiveSkillDependencies(refs: readonly SkillRefLike[]): readonly EffectiveSkillDependency[] {
  const ordered = orderSkillSlots(
    refs.map((ref) => ({ token: ref.id, alternatives: [ref.id] })),
    refs.map((ref) => ({ id: ref.id, dependsOn: ref.depends_on ?? [], dependsOnDeclared: ref.depends_on !== undefined })),
  )
  const direct = directDependencies(ordered.map((slot) => ({ id: slot.token, dependsOn: slot.dependsOn })))
  return ordered.map((slot) => ({ id: slot.token, dependsOn: direct.get(slot.token) ?? [], wave: slot.wave }))
}

/**
 * 显式前置 → 最小声明：与「未声明 = 前面全部」等价的省掉 depends_on，不等价的照写（包括 `[]`）。
 * 输入须按执行顺序排好（前置在前）；画布回写与编辑器追加都走这里，YAML 只在需要时出现 depends_on。
 */
export function minimalSkillDependencies(
  refs: readonly { readonly id: string; readonly dependsOn: readonly string[] }[],
): readonly { readonly id: string; readonly depends_on?: readonly string[] }[] {
  const byId = new Map(refs.map((ref) => [ref.id, ref]))
  const closure = (ids: readonly string[]): ReadonlySet<string> => {
    const out = new Set<string>()
    const stack = [...ids]
    while (stack.length > 0) {
      const id = stack.pop()
      if (id === undefined || out.has(id) || !byId.has(id)) continue
      out.add(id)
      stack.push(...(byId.get(id)?.dependsOn ?? []))
    }
    return out
  }
  return refs.map((ref, index) => {
    const before = refs.slice(0, index).map((candidate) => candidate.id)
    const reach = closure(ref.dependsOn.filter((dependency) => dependency !== ref.id))
    const implied = reach.size === before.length && before.every((id) => reach.has(id))
    return implied ? { id: ref.id } : { id: ref.id, depends_on: [...new Set(ref.dependsOn)] }
  })
}
