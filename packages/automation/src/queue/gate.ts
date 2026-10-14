/**
 * 门联动 + 两层开关 opt-in 判定（BACKLOG #29b 诚实门 + 双执行守卫）。
 *
 * 老仓真相源：
 *   - hooks/pipeline-gate.sh:16-25 —— TENON_AFK=1 沙箱放行三门（confirm/review/interaction）。
 *     只放行"停下问用户"的交互门；build_sha barrier 的 HEAD==build_sha 校验在另一层，不触及。
 *   - pipeline-guard.sh:147-162 —— build 相位 automation=queued 双执行守卫（HARD STOP 主线 build，
 *     防主线 agent 与调度器对同一 change 双执行）；TENON_AUTOMATION_RUNNER=1 旁路。
 *   - automation-config.sh:19-94 —— 两层开关 fail-safe OFF；opt-in 判定：policy 不允许则永不、
 *     否则已 queued=显式意图，再否则取 default_opt_in。
 *
 * 全纯函数（无 fs / 无 env 副作用；env 由调用面读入后传值），可穷举单测。
 */

/** 沙箱镜像内注入的放行 env（runChange 侧 env={TENON_AFK:"1"}）。 */
export const TENON_AFK_ENV = 'TENON_AFK'
/** 调度器执行路径的旁路 env（认领后翻 scheduled 前的防御逃生口）。 */
export const AUTOMATION_RUNNER_ENV = 'TENON_AUTOMATION_RUNNER'

/**
 * 是否放行沙箱内三门。严格 `=== '1'`：host 端该变量恒未设（或非 1），三门行为逐字不变
 * （人在环不被削弱）。老仓 pipeline-gate.sh:23 `[ "${TENON_AFK:-}" = "1" ]`。
 */
export function afkGateBypasses(env: Record<string, string | undefined>): boolean {
  return env[TENON_AFK_ENV] === '1'
}

/**
 * build 相位双执行守卫：phase=build && automation=queued && 非 runner → 拦下主线 build。
 * 老仓 pipeline-guard.sh:154-161。runner 旁路（isRunner）= 认领瞬间的防御逃生口。
 */
export function buildQueuedGuardBlocks(input: { phase: string; automation: string; isRunner: boolean }): boolean {
  return input.phase === 'build' && input.automation === 'queued' && !input.isRunner
}

/**
 * per-change opt-in 判定（老仓 automation-config.sh:77-94 ac_opted_in；资格位取自任务所选分支的 `automation`）：
 *   policy 不允许自动化 → false；已预置 automation=queued = 显式挂起意图 → true；否则取 default_opt_in。
 */
export function optedIn(input: {
  automationEligible: boolean
  automation: string
  defaultOptIn: boolean
}): boolean {
  if (!input.automationEligible) return false
  if (input.automation === 'queued') return true
  return input.defaultOptIn
}

/**
 * spec-complete 挂队注入点判定（老仓 state-transition.sh:231-236 + automation-config.sh）：
 * 两层开关都 ON（enabled && opted-in）才挂队。enabled=false（fail-safe）时该 change 字段被忽略。
 */
export function shouldEnqueueOnSpecComplete(input: {
  enabled: boolean
  automationEligible: boolean
  automation: string
  defaultOptIn: boolean
}): boolean {
  if (!input.enabled) return false
  return optedIn(input)
}

/**
 * 自动 spec-complete 入队的独立策略闸。`automationEligible` 是手动 enqueue 的 capability，
 * 不能被复用成“自动接管”的授权；auto policy 已显式开启时，仍复用同一 enabled/default-opt-in
 * 双开关语义，但不要求手动 capability 为 true。
 */
export function shouldAutoEnqueueOnSpecComplete(input: {
  enabled: boolean
  autoEnqueueOnSpecComplete: boolean
  automation: string
  defaultOptIn: boolean
}): boolean {
  if (!input.autoEnqueueOnSpecComplete) return false
  return shouldEnqueueOnSpecComplete({
    enabled: input.enabled,
    automationEligible: true,
    automation: input.automation,
    defaultOptIn: input.defaultOptIn,
  })
}
