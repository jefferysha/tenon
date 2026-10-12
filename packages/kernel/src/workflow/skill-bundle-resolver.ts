/**
 * SkillBundleResolver（G2 适配层，H10 任务 2）——H10「skill_bundle_id → 有效 skill 快照」链路里，
 * 把「workflow kind + step + profile ID」翻译成对现有 EffectiveSkillResolver 的一次具体调用，并把
 * 触发的分支（resolution source）与产出的 EffectiveSkillSlot 集一并交给调用方——H10 任务 5 的
 * prepareSkillBundle、任务 4 的 snapshot manifest 都要记录 resolution source（参见 H10 设计定稿 §3
 * 快照 manifest 字段清单）。
 *
 * 本层零新语义、零值域校验：
 *   · default 分支把 frozen capability、stepId 与已解析的 profileId 交给
 *     resolveExplicitProfileSkillSlots——结果是计划冻结的步骤技能（工作流 YAML 声明），不叠加 manifest
 *     矩阵。default bundle 没有 frozen capability 时立即 fail-closed。
 *   · custom 分支原样转发 resolver.resolveCustom(step, profileId)——step.skills 仍是唯一真相，
 *     本层不叠加 manifest profile（即便同名 default phase 在 manifest 有声明）。
 *   · 两分支的返回值（含 alternatives 声明序）原样透出，不做重排/过滤/物化选择——挑选具体
 *     concrete skill 是 H10 任务 4（内容定位）/ 任务 5（admission 编排）的职责，本层只做静态解析
 *     形状转换。
 *   · profileId 原样透传，不做词法/语义校验——profile 合法性是 H10 registry/governance 层职责。
 */
import {
  resolveExplicitProfileSkillSlots,
  type EffectiveSkillResolver,
  type EffectiveSkillSlot,
} from './effective-skill-resolver.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { StepIR } from './ir.js'

/** 解析来源 = 触发的 resolver 分支；快照 manifest 据此记录 slots 出自 default 还是 custom。 */
export type SkillBundleResolutionSource = 'default' | 'custom'

/** default 轨输入：stepId 是 default.yaml 的 phase id，capability 必须来自冻结 coordinate。 */
export interface SkillBundleDefaultInput {
  readonly kind: 'default'
  readonly stepId: string
  readonly profileId: string
  /** Frozen capability captured by the execution coordinate. */
  readonly capability: EffectiveWorkflowPlan['capabilities']['skills']
}

/** custom 轨输入：完整 StepIR（resolveCustom 只读其 .skills，其余字段透传、无副作用）。 */
export interface SkillBundleCustomInput {
  readonly kind: 'custom'
  readonly step: StepIR
  readonly profileId: string
}

/** workflow kind 判别其一：default 走 stepId、custom 走完整 StepIR。 */
export type SkillBundleResolutionInput = SkillBundleDefaultInput | SkillBundleCustomInput

/** 单次解析的产出：来源标签 + 现有 EffectiveSkillSlot 集（alternatives 按声明序原样保留）。 */
export interface SkillBundleResolution {
  readonly source: SkillBundleResolutionSource
  readonly slots: readonly EffectiveSkillSlot[]
}

/**
 * 按 workflow kind 分派到现有 EffectiveSkillResolver 的对应解析路径。default 委托
 * frozen explicit-profile projection，custom 委托 resolver.resolveCustom；两分支都只做参数透传与来源标注，
 * 不改写、不过滤、不重排 resolver 的返回值。
 */
export function resolveSkillBundle(
  resolver: EffectiveSkillResolver,
  input: SkillBundleResolutionInput,
): SkillBundleResolution {
  if (input.kind === 'default') {
    if (input.capability === undefined) {
      throw new Error('default skill bundle requires frozen workflow capability')
    }
    const slots = resolveExplicitProfileSkillSlots(resolver, input.capability, input.stepId, input.profileId)
    return { source: 'default', slots }
  }
  return { source: 'custom', slots: resolver.resolveCustom(input.step, input.profileId) }
}
