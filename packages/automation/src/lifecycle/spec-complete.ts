/**
 * spec-complete 的 AFK 后置编排。
 *
 * TransitionApplication 负责把 workflow state 原子提交；本模块只在该提交成功之后接管
 * `spec -> build` 这一条明确边。它不启动 runner、不创建容器、更不绕过 L1/L2/L3：仅在
 * 任务所选分支的 `automation.enqueue_after_spec`、automation 配置及当前 state 三者同时允许时，
 * 把 automation 从 off 原子置为 queued。
 *
 * 这刻意不复用 `automationEligible` 作为触发条件。该字段（分支的 `automation.eligible`）是
 * “手动 enqueue 是否允许”的 capability，多个普通轨道都可能为 true；自动接管必须由更窄的
 * `enqueue_after_spec` 显式授权。分支没写 `automation` 时两个位都是 false（失败关闭）。
 */
import { join } from 'node:path'
import type { AutomationPolicyBits, StateStore } from '@tenon/kernel'
import type { AutomationJsonFs } from '../config/automationJson.js'
import { shouldAutoEnqueueOnSpecComplete } from '../queue/gate.js'
import type { AutomationConfig } from '../types.js'
import { resolveAutomationConfig } from '../sdk/sdk.js'

const scalar = (value: string | string[] | undefined): string => typeof value === 'string' ? value : ''

export interface SpecCompleteAutoEnqueueDeps {
  readonly repoRoot: string
  readonly store: StateStore
  readonly clock: () => string
  /** 任务所记轨道 → 该分支 `automation` 折成的策略位；可异步（宿主要读任务自己的冻结快照）。只在确认是 spec→build 之后才被调用。 */
  readonly resolveTrackPolicy: (trackId: string) => AutomationPolicyBits | Promise<AutomationPolicyBits>
  readonly config?: Partial<AutomationConfig>
  readonly configFs?: AutomationJsonFs
}

export interface SpecCompleteTransition {
  readonly changeName: string
  readonly event: string
  readonly from: string
  readonly to: string
}

/** 可审计的后置编排结果；调用层可据此显示成功，但不把“未适用”伪装成失败。 */
export type SpecCompleteAutoEnqueueOutcome =
  | { readonly kind: 'queued' }
  | { readonly kind: 'already-queued' }
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'phase-changed' }
  | { readonly kind: 'track-disabled' }
  | { readonly kind: 'not-opted-in' }
  | { readonly kind: 'automation-not-off'; readonly automation: string }

/**
 * 在 state 已成功提交后调用。再次在 change lock 内验证 current phase，避免“transition 已提交、
 * 随后别的入口已推进到下一阶段”时给过期运行挂队；因此这个后置动作不会制造跨阶段队列。
 */
export async function enqueueAfterSpecComplete(
  deps: SpecCompleteAutoEnqueueDeps,
  transition: SpecCompleteTransition,
): Promise<SpecCompleteAutoEnqueueOutcome> {
  if (transition.event !== 'spec-complete' || transition.from !== 'spec' || transition.to !== 'build') {
    return { kind: 'not-applicable' }
  }

  const config = resolveAutomationConfig(deps)
  const changeDir = join(deps.repoRoot, 'openspec', 'changes', transition.changeName)
  return deps.store.withLock(changeDir, async () => {
    const state = await deps.store.read(changeDir)
    if (scalar(state.fields.phase) !== 'build') return { kind: 'phase-changed' }

    const policy = await deps.resolveTrackPolicy(scalar(state.fields.track))
    if (policy.autoEnqueueOnSpecComplete !== true) return { kind: 'track-disabled' }

    const automation = scalar(state.fields.automation)
    if (automation === 'queued') return { kind: 'already-queued' }
    if (automation !== 'off') return { kind: 'automation-not-off', automation }

    if (!shouldAutoEnqueueOnSpecComplete({
      enabled: config.enabled,
      autoEnqueueOnSpecComplete: policy.autoEnqueueOnSpecComplete === true,
      automation,
      defaultOptIn: config.defaultOptIn,
    })) return { kind: 'not-opted-in' }

    state.fields.automation = 'queued'
    state.fields.automation_queued_at = deps.clock()
    await deps.store.writeUnderLock(changeDir, state, { kind: 'automation' })
    return { kind: 'queued' }
  })
}
