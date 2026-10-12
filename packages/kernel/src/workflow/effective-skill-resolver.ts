/**
 * EffectiveSkillResolver（G2 P5）——artifact register 校验「谁产出了这条 artifact」的领域接缝。
 *
 * 技能只看工作流 YAML：必需 / 可用 / 显式 profile 三个投影都是计划冻结下来的「步骤自己声明的技能」，
 * 稳定去重后拆成具体 alternatives。不再叠加 manifest 的「阶段 × 轨道」矩阵，也不查轨道登记表
 * （矩阵与 default.yaml 每步技能完全重复，去重后无效果）。三个入口函数是运行时消费者的统一入口；
 * 宿主可以在 resolver 上实现同名可选方法覆写。
 *   · resolveRequiredSkillSlots / resolveAvailableSkillSlots / resolveExplicitProfileSkillSlots
 *   · resolveDefault(stepId, profile) / resolveDefaultMandatory —— 直接读 manifest 技能表的兼容接缝
 *     （第二个参数就是 manifest 里的 profile 名）；新的运行时消费者不应借此丢弃计划冻结的步骤技能。
 *   · resolveCustom(step, track) —— 产出者值域 = 本 step 声明的 skill 集（step.skills[].id），稳定去重、
 *     **每个 id 是具体 skill、不把 `|` 隐式当 alternative**（custom SkillRef.id 语义是实际 id，`a|b` 备选
 *     只存在于 manifest 契约；且 validateWorkflow 的 SKILL_IDENT_RE 本就不许 id 含 `|`）。
 *
 * slot 保留 alternative 关系（不扁平成 string[]/Set）：调用方（artifact register）据此判定
 * `--producer` 是否精确命中「某个有效 skill 槽的某个具体 alternative」，而不能把整个 `a|b` token
 * 当合法 producer（那是从未被实际调用的伪 id）。
 */
import { skillsFor, skillTokenAlternatives, type SkillTable } from '../flow/manifest.js'
import type { Phase } from '../types.js'
import type { EffectiveWorkflowPlan } from './effective-plan.js'
import type { StepIR } from './ir.js'

/** 一个「有效 skill 槽」：token 是原始 manifest/step 记法，alternatives 是其具体可选 skill id
 *  （default 的 `a|b` 拆分产物 / custom 的单元素 [id]）；`--producer` 须精确等于某 alternative。 */
export interface EffectiveSkillSlot {
  readonly token: string
  readonly alternatives: readonly string[]
}

type SkillCapability = EffectiveWorkflowPlan['capabilities']['skills']

export interface EffectiveSkillResolver {
  /** 覆写必需技能的解析；缺省 = 步骤自己声明的技能。 */
  resolveRequired?(capability: SkillCapability, stepId: string): readonly EffectiveSkillSlot[]
  /** 覆写可用技能（必需加推荐）的解析；缺省 = 步骤自己声明的技能。 */
  resolveAvailable?(capability: SkillCapability, stepId: string): readonly EffectiveSkillSlot[]
  /** 覆写显式 profile（artifact 登记、AFK bundle）的解析；缺省 = 步骤自己声明的技能。 */
  resolveExplicitProfile?(capability: SkillCapability, stepId: string, profile: string): readonly EffectiveSkillSlot[]
  /** manifest 技能表里某 profile 在该 step 的硬阻断 skill 槽；不含 recommended。 */
  resolveDefaultMandatory(stepId: string, profile: string): readonly EffectiveSkillSlot[]
  /** manifest 技能表里某 profile 在该 step 的有效 skill 槽（mandatory＋recommended，稳定去重＋a|b 拆分）。 */
  resolveDefault(stepId: string, profile: string): readonly EffectiveSkillSlot[]
  /** custom 轨 step/track 的有效 skill 槽（step.skills[].id，稳定去重，不拆 `|`）。 */
  resolveCustom(step: StepIR, track: string): readonly EffectiveSkillSlot[]
}

/** 装配面：机器级 manifest 的技能表。 */
export interface EffectiveSkillResolverManifest {
  readonly mandatorySkills: SkillTable
  readonly recommendedSkills: SkillTable
}

/** 计划冻结下来的该步技能（工作流 YAML 声明），稳定去重。 */
function declaredSlots(capability: SkillCapability, stepId: string): readonly EffectiveSkillSlot[] {
  const step = capability.steps.find((candidate) => candidate.stepId === stepId)
  return dedupeStableSlots((step?.requiredSkillIds ?? []).map((id) => ({ token: id, alternatives: [id] })))
}

export function resolveRequiredSkillSlots(
  resolver: EffectiveSkillResolver | undefined,
  capability: SkillCapability,
  stepId: string,
): readonly EffectiveSkillSlot[] {
  return resolver?.resolveRequired?.(capability, stepId) ?? declaredSlots(capability, stepId)
}

export function resolveAvailableSkillSlots(
  resolver: EffectiveSkillResolver,
  capability: SkillCapability,
  stepId: string,
): readonly EffectiveSkillSlot[] {
  return resolver.resolveAvailable?.(capability, stepId) ?? declaredSlots(capability, stepId)
}

/** 显式 profile 的投影不会丢掉计划冻结的步骤技能；profile 只是宿主覆写时的选择键。 */
export function resolveExplicitProfileSkillSlots(
  resolver: EffectiveSkillResolver | undefined,
  capability: SkillCapability,
  stepId: string,
  profile: string,
): readonly EffectiveSkillSlot[] {
  return resolver?.resolveExplicitProfile?.(capability, stepId, profile) ?? declaredSlots(capability, stepId)
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

export function createEffectiveSkillResolver(manifest: EffectiveSkillResolverManifest): EffectiveSkillResolver {
  const slotsOf = (tokens: readonly string[]): readonly EffectiveSkillSlot[] =>
    dedupeStable(tokens).map((token) => ({ token, alternatives: skillTokenAlternatives(token) }))
  return {
    resolveDefaultMandatory(stepId, profile) {
      return slotsOf(skillsFor(manifest.mandatorySkills, stepId as Phase, profile))
    },
    resolveDefault(stepId, profile) {
      return slotsOf([
        ...skillsFor(manifest.mandatorySkills, stepId as Phase, profile),
        ...skillsFor(manifest.recommendedSkills, stepId as Phase, profile),
      ])
    },
    resolveCustom(step, _track) {
      // custom id 是具体 skill：token===id、alternatives=[id]，**不**按 `|` 拆分（不扩大未声明 DSL）。
      return dedupeStable(step.skills.map((s) => s.id)).map((id) => ({ token: id, alternatives: [id] }))
    },
  }
}
