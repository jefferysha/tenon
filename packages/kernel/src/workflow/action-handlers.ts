/**
 * IR action handler 注册表（G2 P1）——default 轨（DefaultEventPolicy，G2 P3 起）与 custom 轨共用的
 * 状态副作用实现。语义源包括老仓 skills/pipeline/scripts/state-transition.sh cmd_transition case 块
 * 的四个事件专属 mutation 体（build-complete / verify-pass / verify-fail / archived），以及
 * Tenon 全局 pre-Verify 收敛状态的显式 reset。裁决钉死的
 * 形状差：老仓就地改 state.fields，本层回 patch（不原地 mutate），落盘合并由调用方做。
 * 单测 action-handlers.test.ts 逐分支手写期望值（对齐老仓 case 块，不 import 任何旧函数当 oracle）。
 *
 * 注册表是 exhaustive mapped type 静态闭集（同 guard-handlers.ts；属性 readonly + 对象
 * Object.freeze，无运行时注册/替换面）：刻意不提供任意 set-field action——防 custom
 * workflow 获得改 phase/workflow 等系统字段的通用脚本能力。
 */
import type { ActionConfig, ActionInput, ActionOutcome } from './ir.js'
import { BuildRevisionCaptureError, expectedBuildRevisionKind, safeRevisionHash } from './build-revision.js'

function fieldString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

export type ActionHandler<C extends ActionConfig> = (
  config: C,
  input: ActionInput,
) => ActionOutcome | Promise<ActionOutcome>

export type ActionHandlerRegistry = {
  readonly [K in ActionConfig['type']]: ActionHandler<Extract<ActionConfig, { type: K }>>
}

export const ACTION_HANDLERS: ActionHandlerRegistry = Object.freeze({
  /** build-complete 的不可变验证靶：
   *  · 所有 isolation 都必须由可信 capture capability 生成 canonical build:v1 token。
   *  · branch 绑定物理 Git identity 与 object ID；worktree / in-place 绑定内容寻址的 workspace baseline
   *    （worktree 的身份里带该 worktree，换检出复核得 worktree-mismatch）。类别由 expectedBuildRevisionKind 判定。
   *    能力缺失、返回非法 token 或求值异常一律 fail-closed，绝不写一个无法复验的假 SHA。
   */
  'freeze-build-sha': async (_config, input) => {
    const isolation = fieldString(input.fields.isolation)
    if (isolation !== 'branch' && isolation !== 'worktree' && isolation !== 'in-place') {
      throw new BuildRevisionCaptureError('isolation-mismatch', safeRevisionHash(input.fields))
    }
    if (!input.captureBuildRevision) {
      throw new BuildRevisionCaptureError('capability-unavailable', safeRevisionHash(input.fields))
    }
    try {
      // The capture capability already returns the canonical token.  Do not trim here: accepting
      // surrounding whitespace would make a non-canonical value appear valid at the action seam,
      // while the Verify assessor (and token parser) correctly rejects it.
      const token = await input.captureBuildRevision(isolation)
      const expectedKind = expectedBuildRevisionKind(isolation)
      if (!new RegExp(`^build:v1:${expectedKind}:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$`).test(token)) {
        throw new BuildRevisionCaptureError('malformed', safeRevisionHash(input.fields))
      }
      return { patch: { build_sha: token }, signals: [] }
    } catch (error) {
      if (error instanceof BuildRevisionCaptureError) throw error
      throw new BuildRevisionCaptureError('evaluation-error', safeRevisionHash(input.fields))
    }
  },

  /** 进入任一新的实现 visit 时，旧候选的 Build 收敛审查不得继承。 */
  'reset-pre-verify-review': () => ({
    patch: { pre_verify_review_result: 'pending' },
    signals: [],
  }),

  /** 老仓 state-transition.sh verify-pass 事件体：verify_result=pass + verified_at=clock()。 */
  'mark-verification-passed': (_config, input) => ({
    patch: { verify_result: 'pass', verified_at: input.clock() },
    signals: [],
  }),

  /** 老仓 state-transition.sh verify-fail 事件体：连带把 build_sha 打回字面 'null'
   *  ——barrier 复位，回退重 build 后必须重新冻结。 */
  'mark-verification-failed': () => ({
    patch: { verify_result: 'fail', build_sha: 'null' },
    signals: [],
  }),

  /** 老仓 state-transition.sh archived 事件体：archived=true + archived_at=clock()。 */
  'archive-run': (_config, input) => ({
    patch: { archived: 'true', archived_at: input.clock() },
    signals: [],
  }),
})

/** 注册表按 type 收窄的派发点（收窄安全性同 guard-handlers.ts dispatchGuard 的说明）。
 *  只读冻结的 ACTION_HANDLERS，无注入位。 */
function dispatchAction<C extends ActionConfig>(config: C, input: ActionInput): ActionOutcome | Promise<ActionOutcome> {
  const handler = ACTION_HANDLERS[config.type] as ActionHandler<C>
  return handler(config, input)
}

/**
 * 按声明顺序逐项执行 action 并合并 patch：
 *   · 每个 action 收到的 fields = 原 fields 覆盖上累计 patch 的只读视图——后一个 action
 *     看得到前一个的结果；
 *   · patch 逐项合并，同键后者胜（顺序即语义，调用方声明序负责；单测以真实 handler 的
 *     patch 冲突观测合并序——freeze-build-sha × mark-verification-failed 对 build_sha）；
 *   · signals 按执行顺序串接；input.fields 全程不被改动。
 * 公开签名只有 (actions, input)：派发恒走模块级冻结的 ACTION_HANDLERS，无 registry 注入位。
 */
export async function applyActions(
  actions: readonly ActionConfig[],
  input: ActionInput,
): Promise<ActionOutcome> {
  let patch: ActionOutcome['patch'] = {}
  const signals: ActionOutcome['signals'][number][] = []
  for (const action of actions) {
    const view: ActionInput = { ...input, fields: { ...input.fields, ...patch } }
    const outcome = await dispatchAction(action, view)
    patch = { ...patch, ...outcome.patch }
    signals.push(...outcome.signals)
  }
  return { patch, signals }
}
