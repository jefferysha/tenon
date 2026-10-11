/**
 * H10 skill bundle 的唯一只读 wiring evaluator。
 *
 * 只做 profile/workflow step 的静态解析与当前安装面定位，不物化 CAS、不写 registry/ledger。
 * alternative 仅在明确 SkillContentNotFoundError 时继续；内容损坏、来源歧义和访问错误均立即
 * fail-closed，保持与 runtime preparation 的错误边界一致。
 */
import {
  compileEffectiveWorkflowPlan,
  resolveSkillBundle,
  type EffectiveSkillResolver,
  type EffectiveWorkflowPlan,
  type LoopEntry,
  type StepIR,
} from '@tenon/kernel'
import type { SkillContentLocator } from './content-locator.js'

/** 绑定到 default 工作流的 loop 没有轨道：技能取 default 的 backend 分支（AFK 修复轨道）。 */
export const LOOP_DEFAULT_TRACK = 'backend'

/** default 工作流在 loop 轨道（backend 分支）下冻结的技能能力。 */
export function defaultLoopSkillCapability(): EffectiveWorkflowPlan['capabilities']['skills'] {
  return compileEffectiveWorkflowPlan('default', undefined, { track: LOOP_DEFAULT_TRACK }).capabilities.skills
}

export type SkillBundleWiringStatus = 'unwired' | 'invalid' | 'ready'

export interface SkillBundleWiringResult {
  readonly status: SkillBundleWiringStatus
  readonly bundleId: string | null
  readonly reason: string | null
}

export interface SkillBundleWiringDeps {
  readonly isSkillProfileKnown?: (profileId: string) => boolean
  readonly resolver: EffectiveSkillResolver
  readonly locator: SkillContentLocator
}

/** host 已解析的 workflow 坐标；profileId 仍由 loop 的 durable skill_bundle_id 唯一提供。 */
export type SkillBundleWiringResolutionInput =
  | {
      readonly kind: 'default'
      readonly stepId: string
      readonly capability: EffectiveWorkflowPlan['capabilities']['skills']
    }
  | { readonly kind: 'custom'; readonly step: StepIR }

type SlotLocateOutcome = { readonly ok: true } | { readonly ok: false; readonly detail: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function locateSlot(
  locator: SkillContentLocator,
  alternatives: readonly string[],
): Promise<SlotLocateOutcome> {
  const notFoundDetails: string[] = []
  for (const alternative of alternatives) {
    try {
      await locator.locate(alternative)
      return { ok: true }
    } catch (error) {
      const tag = (error as { _tag?: string } | null | undefined)?._tag
      if (tag === 'SkillContentNotFoundError') {
        notFoundDetails.push(errorMessage(error))
        continue
      }
      return {
        ok: false,
        detail: `候选「${alternative}」定位失败（非 not-found，立即判定失败，不再尝试其余候选）：${errorMessage(error)}`,
      }
    }
  }
  return {
    ok: false,
    detail: `在当前安装面均无法定位（候选：${alternatives.join('|')}）：${notFoundDetails.join('; ')}`,
  }
}

export async function evaluateSkillBundleWiring(
  loop: LoopEntry,
  deps: SkillBundleWiringDeps,
  resolutionInputs?: readonly SkillBundleWiringResolutionInput[],
): Promise<SkillBundleWiringResult> {
  const bundleId = loop.skill_bundle_id ?? null
  if (bundleId === null) {
    return {
      status: 'unwired',
      bundleId: null,
      reason: 'skill_bundle_id 未接线（字段缺失/null），任何 real-run 都会被 fail-closed 拒绝',
    }
  }
  if (bundleId !== '_all') {
    if (deps.isSkillProfileKnown === undefined || !deps.isSkillProfileKnown(bundleId)) {
      return {
        status: 'invalid',
        bundleId,
        reason: `profile "${bundleId}" 不在当前合法 skill profile 键空间（或存在性校验器尚未装配）`,
      }
    }
  }
  const workflowId = loop.workflow_id ?? 'default'
  if (resolutionInputs === undefined && workflowId !== 'default') {
    return {
      status: 'invalid',
      bundleId,
      reason: `custom workflow "${workflowId}" 缺少 host 已编译 StepIR 解析计划，拒绝偷用同名 default phase`,
    }
  }
  const effectiveInputs = resolutionInputs ?? (() => {
    const capability = defaultLoopSkillCapability()
    return loop.phases.map((stepId) => ({ kind: 'default' as const, stepId, capability }))
  })()
  const expectedKind = workflowId === 'default' ? 'default' : 'custom'
  const mismatchedKind = effectiveInputs.find((input) => input.kind !== expectedKind)
  if (mismatchedKind !== undefined) {
    return {
      status: 'invalid',
      bundleId,
      reason: `workflow "${workflowId}" 只允许 ${expectedKind} skill 解析计划，收到 ${mismatchedKind.kind}`,
    }
  }
  if (effectiveInputs.length !== loop.phases.length) {
    return {
      status: 'invalid',
      bundleId,
      reason: `workflow skill 解析计划长度 ${effectiveInputs.length} 与 loop phases ${loop.phases.length} 不一致`,
    }
  }
  for (let index = 0; index < loop.phases.length; index++) {
    const phase = loop.phases[index]!
    const resolutionInput = effectiveInputs[index]!
    const resolvedStepId = resolutionInput.kind === 'default'
      ? resolutionInput.stepId
      : resolutionInput.step.id
    if (resolvedStepId !== phase) {
      return {
        status: 'invalid',
        bundleId,
        reason: `workflow skill 解析计划第 ${index + 1} 项 step "${resolvedStepId}" 与 loop phase "${phase}" 不一致`,
      }
    }
    let slots
    try {
      slots = resolveSkillBundle(
        deps.resolver,
        resolutionInput.kind === 'default'
          ? {
              kind: 'default', stepId: resolutionInput.stepId, profileId: bundleId,
              capability: resolutionInput.capability,
            }
          : { kind: 'custom', step: resolutionInput.step, profileId: bundleId },
      ).slots
    } catch (error) {
      return {
        status: 'invalid',
        bundleId,
        reason: `phase "${phase}" 静态解析失败：${errorMessage(error)}`,
      }
    }
    for (const slot of slots) {
      const outcome = await locateSlot(deps.locator, slot.alternatives)
      if (!outcome.ok) {
        return {
          status: 'invalid',
          bundleId,
          reason: `phase "${phase}" 的 skill 槽「${slot.token}」${outcome.detail}`,
        }
      }
    }
  }
  return { status: 'ready', bundleId, reason: null }
}
