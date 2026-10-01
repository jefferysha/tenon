/**
 * 跨厂商评审的宿主要求（纯函数）：一个评审者该在哪个宿主上跑，以及一条已登记的评审记录算不算满足要求。
 *
 * 要求来自两处，强度不同：工作流步骤写 `host: codex|claude` 是硬要求（裁决只在登记的宿主相符时有效）；
 * agent 定义里的 `host` 只是建议，只用于路由，不判失效。步骤写 `any` 盖过 agent 的建议。
 */
import type { ReviewerHost } from './types.js'

export interface ReviewerHostRequirement {
  /** 该在哪个宿主上跑；`any` = 不限。 */
  readonly host: ReviewerHost
  readonly source: 'step' | 'agent' | 'none'
  /** true = 步骤硬性要求（登记的宿主不符则裁决无效）。 */
  readonly enforced: boolean
}

export function reviewerHostRequirement(
  stepHost: ReviewerHost | undefined,
  agentHost: ReviewerHost | undefined,
): ReviewerHostRequirement {
  if (stepHost !== undefined) return { host: stepHost, source: 'step', enforced: stepHost !== 'any' }
  if (agentHost !== undefined && agentHost !== 'any') return { host: agentHost, source: 'agent', enforced: false }
  return { host: 'any', source: 'none', enforced: false }
}

/** 一条评审记录登记的宿主是否满足步骤的硬要求：没有硬要求恒成立；有则必须登记过且相符。 */
export function hostRunValid(stepHost: ReviewerHost | undefined, recorded: string | undefined): boolean {
  return stepHost === undefined || stepHost === 'any' || recorded === stepHost
}
