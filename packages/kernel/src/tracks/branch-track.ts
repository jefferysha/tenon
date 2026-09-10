import type { TrackDefinition, TrackPolicyProfile, TrackRegistry } from './types.js'

/** 只在工作流 YAML 里定义（registry 未登记）的分支 track 用的缺省策略：不评审种子跳过、不开矿阵、不路由、不 AFK 自动入队。 */
export const BRANCH_TRACK_DEFAULT_POLICY: TrackPolicyProfile = {
  reviewSeed: 'pending',
  automationEligible: true,
  coverageProfile: 'none',
  routing: { enabled: false },
  skills: { matrix: false, profile: '_all' },
}

export interface BranchTrackWorkflow {
  readonly name: string
  readonly tracks?: Readonly<Record<string, { readonly label?: string }>>
}

/**
 * change 的 track 定义解析（registry 优先）：
 *   1. registry 已登记 → 原定义（策略、允许的工作流等全部沿用）；
 *   2. 未登记但所选工作流有同名分支 → 合成一条缺省策略的定义（label 取分支 label，只允许绑定该工作流）；
 *   3. 两者皆无 → undefined，由调用方报「未知 track」。
 * 这样用户在工作流 YAML 里写一条新分支即可直接 `tenon init --track <id>`，不必先去 tracks.yaml 登记。
 */
export function resolveTrackForBranch(
  registry: TrackRegistry,
  id: string,
  workflow: BranchTrackWorkflow | null | undefined,
): TrackDefinition | undefined {
  const registered = registry.byId.get(id)
  if (registered !== undefined) return registered
  const branch = workflow?.tracks?.[id]
  if (branch === undefined) return undefined
  return {
    id,
    label: branch.label ?? id,
    builtin: false,
    workflow: { default: workflow!.name, allowed: [workflow!.name] },
    policyProfile: BRANCH_TRACK_DEFAULT_POLICY,
  }
}
