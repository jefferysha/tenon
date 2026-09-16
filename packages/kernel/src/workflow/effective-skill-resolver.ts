/**
 * EffectiveSkillResolver（G2 P5）——artifact register 校验「谁产出了这条 artifact」的领域接缝。
 *
 * 三种解析投影一一对应运行时消费者的不同授权面：
 *   · resolveRequired(capability, stepId) —— phase-first 硬要求 + matrix-enabled mandatory overlay；
 *   · resolveAvailable(capability, stepId) —— phase-first 自动可用集 + matrix-enabled mandatory/recommended overlay；
 *   · resolveExplicitProfile(capability, stepId, profile) —— phase-first + named profile 的
 *     mandatory/recommended allowlist，供 artifact/AFK 等显式选择；显式 profile 不会反向成为 Hook/transition
 *     的自动要求。所有投影按 token 稳定去重并拆成具体 alternatives。
 *   · resolveDefault(stepId, track) / resolveDefaultProfile(stepId, profile) —— 保留给旧 producer
 *     装配面的 manifest-only compatibility seam；新 runtime consumers 不应借此丢弃 frozen phase slots。
 *   · resolveCustom(step, track) —— custom 轨（producerPolicy: effective-step-skills）：产出者值域
 *     = 本 step 声明的 skill 集（step.skills[].id），稳定去重、**每个 id 是具体 skill、不把 `|`
 *     隐式当 alternative**（custom SkillRef.id 语义是实际 id，`a|b` 备选只存在于 manifest 契约；
 *     且 validateWorkflow 的 SKILL_IDENT_RE 本就不许 id 含 `|`）。
 *
 * slot 保留 alternative 关系（不扁平成 string[]/Set）：调用方（artifact register）据此判定
 * `--producer` 是否精确命中「某个有效 skill 槽的某个具体 alternative」，而不能把整个 `a|b` token
 * 当合法 producer（那是从未被实际调用的伪 id）。
 *
 * T-R6 生产装配使用 createEffectiveSkillResolver({ registry, manifest })：default artifact/AFK 分支先从
 * track.policyProfile.skills.profile 得 profile，再把 frozen phase capability 与 profile allowlist 一起解析。
 * registry 可传快照或 fresh-load 函数，CLI 采用后者，保证同进程 CRUD 后不复用旧 registry。
 */
import { skillsFor, skillTokenAlternatives, type SkillTable } from '../flow/manifest.js'
import type { TrackRegistry } from '../tracks/types.js'
import type { Phase } from '../types.js'
import type { EffectiveWorkflowPlan } from './effective-plan.js'
import type { StepIR } from './ir.js'

/** 一个「有效 skill 槽」：token 是原始 manifest/step 记法，alternatives 是其具体可选 skill id
 *  （default 的 `a|b` 拆分产物 / custom 的单元素 [id]）；`--producer` 须精确等于某 alternative。 */
export interface EffectiveSkillSlot {
  readonly token: string
  readonly alternatives: readonly string[]
}

export interface EffectiveSkillResolver {
  /**
   * Resolve the mandatory exit requirements declared by an EffectiveWorkflowPlan.  Runtime
   * consumers use this one entrypoint for every execution model; source dispatch is contained
   * inside the resolver and is driven exclusively by the frozen capability.
   */
  resolveRequired?(
    capability: EffectiveWorkflowPlan['capabilities']['skills'],
    stepId: string,
  ): readonly EffectiveSkillSlot[]
  /** Resolve every declared producer/orchestration slot (mandatory plus recommended overlays). */
  resolveAvailable?(
    capability: EffectiveWorkflowPlan['capabilities']['skills'],
    stepId: string,
  ): readonly EffectiveSkillSlot[]
  /** Resolve a named explicit profile for artifact producers and AFK bundles.
   * Workflow-owned phase slots are always first; custom workflows remain step-declared. */
  resolveExplicitProfile?(
    capability: EffectiveWorkflowPlan['capabilities']['skills'],
    stepId: string,
    profile: string,
  ): readonly EffectiveSkillSlot[]
  /** default 轨当前 step 的硬阻断 skill 槽；不含 recommended。 */
  resolveDefaultMandatory(stepId: string, track: string): readonly EffectiveSkillSlot[]
  /** default 轨 step/track 的有效 skill 槽（manifest mandatory＋recommended，稳定去重＋a|b 拆分）。 */
  resolveDefault(stepId: string, track: string): readonly EffectiveSkillSlot[]
  /** 已解析 profile 的入口（H10 skill bundle）；缺省仅供兼容手写 resolver，由适配层回退 resolveDefault。 */
  resolveDefaultProfile?(stepId: string, profile: string): readonly EffectiveSkillSlot[]
  /** custom 轨 step/track 的有效 skill 槽（step.skills[].id，稳定去重，不拆 `|`）。 */
  resolveCustom(step: StepIR, track: string): readonly EffectiveSkillSlot[]
}

/** 兼容装配面：调用方已持有 profile 时可直接注入 manifest。 */
export interface EffectiveSkillResolverManifest {
  readonly mandatorySkills: SkillTable
  readonly recommendedSkills: SkillTable
}

/** T-R6 装配面：effective registry 决定 track 使用哪个 manifest skill profile。 */
export interface EffectiveSkillResolverOptions {
  /** CLI 传 fresh loader；短生命周期/不可变上下文也可传快照。 */
  readonly registry: TrackRegistry | (() => TrackRegistry)
  readonly manifest: EffectiveSkillResolverManifest
}

/**
 * Compatibility bridge for injected resolvers created before EffectiveWorkflowPlan existed.
 * Capability dispatch remains centralized here; transition/check adapters never reconstruct it.
 */
export function resolveRequiredSkillSlots(
  resolver: EffectiveSkillResolver | undefined,
  capability: EffectiveWorkflowPlan['capabilities']['skills'],
  stepId: string,
): readonly EffectiveSkillSlot[] {
  if (resolver?.resolveRequired !== undefined) return resolver.resolveRequired(capability, stepId)
  const phase = capability.steps.find((candidate) => candidate.stepId === stepId)?.requiredSkillIds ?? []
  if (capability.source === 'manifest-overlay') {
    // 宿主没接 resolver（如 dashboard server 的 transition）= 不启用矛阵叠加，只按 phase 槽——与旧行为一致。
    const overlay = !capability.trackOverlay.matrix || resolver === undefined
      ? []
      : resolver.resolveDefaultMandatory(stepId, capability.trackOverlay.profile)
    return dedupeStableSlots([
      ...phase.map((id) => ({ token: id, alternatives: [id] })),
      ...overlay,
    ])
  }
  return dedupeStableSlots(phase.map((id) => ({ token: id, alternatives: [id] })))
}

export function resolveAvailableSkillSlots(
  resolver: EffectiveSkillResolver,
  capability: EffectiveWorkflowPlan['capabilities']['skills'],
  stepId: string,
): readonly EffectiveSkillSlot[] {
  if (resolver.resolveAvailable !== undefined) return resolver.resolveAvailable(capability, stepId)
  const phase = capability.steps.find((candidate) => candidate.stepId === stepId)?.requiredSkillIds ?? []
  if (capability.source === 'manifest-overlay') {
    const overlay = !capability.trackOverlay.matrix
      ? []
      : resolver.resolveDefaultProfile?.(stepId, capability.trackOverlay.profile)
          ?? resolver.resolveDefault(stepId, capability.trackOverlay.profile)
    return dedupeStableSlots([
      ...phase.map((id) => ({ token: id, alternatives: [id] })),
      ...overlay,
    ])
  }
  return dedupeStableSlots(phase.map((id) => ({ token: id, alternatives: [id] })))
}

/** Resolve an explicitly named profile without dropping the frozen Workflow phase capability. */
export function resolveExplicitProfileSkillSlots(
  resolver: EffectiveSkillResolver | undefined,
  capability: EffectiveWorkflowPlan['capabilities']['skills'],
  stepId: string,
  profile: string,
): readonly EffectiveSkillSlot[] {
  if (resolver?.resolveExplicitProfile !== undefined) {
    return resolver.resolveExplicitProfile(capability, stepId, profile)
  }
  const phase = capability.steps.find((candidate) => candidate.stepId === stepId)?.requiredSkillIds ?? []
  const profileSlots = capability.source !== 'manifest-overlay' || resolver === undefined
    ? []
    : resolver.resolveDefaultProfile?.(stepId, profile) ?? resolver.resolveDefault(stepId, profile)
  return dedupeStableSlots([
    ...phase.map((id) => ({ token: id, alternatives: [id] })),
    ...profileSlots,
  ])
}

/** 稳定去重（保留首次出现顺序）。 */
function dedupeStable(tokens: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function dedupeStableSlots(slots: readonly EffectiveSkillSlot[]): EffectiveSkillSlot[] {
  const seen = new Set<string>()
  const out: EffectiveSkillSlot[] = []
  for (const slot of slots) {
    if (seen.has(slot.token)) continue
    seen.add(slot.token)
    out.push(slot)
  }
  return out
}

export function createEffectiveSkillResolver(options: EffectiveSkillResolverOptions): EffectiveSkillResolver
/** 兼容 P5 外部调用；仓内生产装配使用 registry-aware 形态。 */
export function createEffectiveSkillResolver(manifest: EffectiveSkillResolverManifest): EffectiveSkillResolver
export function createEffectiveSkillResolver(
  input: EffectiveSkillResolverOptions | EffectiveSkillResolverManifest,
): EffectiveSkillResolver {
  const registry = 'registry' in input ? input.registry : undefined
  const manifest = 'manifest' in input ? input.manifest : input
  const resolveProfile = (stepId: string, profile: string): readonly EffectiveSkillSlot[] => {
    const mandatory = skillsFor(manifest.mandatorySkills, stepId as Phase, profile)
    const recommended = skillsFor(manifest.recommendedSkills, stepId as Phase, profile)
    return dedupeStable([...mandatory, ...recommended]).map((token) => ({
      token,
      alternatives: skillTokenAlternatives(token),
    }))
  }
  const resolveRecommended = (stepId: string, profile: string): readonly EffectiveSkillSlot[] =>
    dedupeStable(skillsFor(manifest.recommendedSkills, stepId as Phase, profile)).map((token) => ({
      token,
      alternatives: skillTokenAlternatives(token),
    }))
  const resolveMandatory = (stepId: string, profile: string): readonly EffectiveSkillSlot[] =>
    dedupeStable(skillsFor(manifest.mandatorySkills, stepId as Phase, profile)).map((token) => ({
      token,
      alternatives: skillTokenAlternatives(token),
    }))
  const phaseSlots = (
    capability: EffectiveWorkflowPlan['capabilities']['skills'],
    stepId: string,
  ): readonly EffectiveSkillSlot[] => {
    const step = capability.steps.find((candidate) => candidate.stepId === stepId)
    return dedupeStableSlots((step?.requiredSkillIds ?? []).map((id) => ({
      token: id,
      alternatives: [id],
    })))
  }
  return {
    resolveRequired(capability, stepId) {
      if (capability.source === 'manifest-overlay') {
        const overlay = !capability.trackOverlay.matrix
          ? []
          : resolveMandatory(stepId, capability.trackOverlay.profile)
        return dedupeStableSlots([...phaseSlots(capability, stepId), ...overlay])
      }
      return phaseSlots(capability, stepId)
    },
    resolveAvailable(capability, stepId) {
      if (capability.source === 'manifest-overlay') {
        // 矩阵内嵌时 mandatory 来自定义；recommended 仍是机器级 manifest 的建议表（只 WARN，不阻断）。
        const overlay = !capability.trackOverlay.matrix
          ? []
          : resolveProfile(stepId, capability.trackOverlay.profile)
        return dedupeStableSlots([...phaseSlots(capability, stepId), ...overlay])
      }
      return phaseSlots(capability, stepId)
    },
    resolveExplicitProfile(capability, stepId, profile) {
      if (capability.source !== 'manifest-overlay') return phaseSlots(capability, stepId)
      const overlay = resolveProfile(stepId, profile)
      return dedupeStableSlots([...phaseSlots(capability, stepId), ...overlay])
    },
    resolveDefaultMandatory(stepId, track) {
      const currentRegistry = typeof registry === 'function' ? registry() : registry
      const profile = currentRegistry === undefined ? track : currentRegistry.byId.get(track)?.policyProfile.skills.profile
      if (profile === undefined) throw new Error(`unknown track '${track}' in effective skill resolver`)
      return dedupeStable(skillsFor(manifest.mandatorySkills, stepId as Phase, profile)).map((token) => ({
        token,
        alternatives: skillTokenAlternatives(token),
      }))
    },
    resolveDefault(stepId, track) {
      const currentRegistry = typeof registry === 'function' ? registry() : registry
      const profile = currentRegistry === undefined ? track : currentRegistry.byId.get(track)?.policyProfile.skills.profile
      if (profile === undefined) throw new Error(`unknown track '${track}' in effective skill resolver`)
      return resolveProfile(stepId, profile)
    },
    // Legacy profile-only seam retained for callers that explicitly need the manifest
    // allowlist. New artifact/AFK consumers use resolveExplicitProfile so phase slots
    // cannot be dropped when matrix=false.
    resolveDefaultProfile: resolveProfile,
    // track 目前不参与 custom 解析（step.skills 固定）——保留在签名里供 T-R6 track-条件 custom skill 接线。
    resolveCustom(step, _track) {
      // custom id 是具体 skill：token===id、alternatives=[id]，**不**按 `|` 拆分（不扩大未声明 DSL）。
      return dedupeStable(step.skills.map((s) => s.id)).map((id) => ({ token: id, alternatives: [id] }))
    },
  }
}
