/**
 * default 轨（phase-manifest）的转换规划器——从 transition-application.ts 拆出的一段纯判定。
 *
 * 编排（事务边界、commit、收尾投影）留在 transition-application.ts；这里只回答「这条边现在走不走
 * 得通、走通之后字段变成什么」，输入是 state 与已绑定的 TransitionCommand，输出是 PreparedTransition
 * 或 TransitionRejection，全程不持久化。custom 轨的同位物是 transition-application.ts 里的 planCustomTransition。
 */
import type { FlowEngine, PipelineState } from '../types.js'
import { IllegalTransitionError } from '../types.js'
import { eventEdge } from '../flow/index.js'
import type { EventName } from '../flow/index.js'
import { evaluateDefaultEventPreconditions, DEFAULT_EVENT_POLICY } from '../flow/default-event-policy.js'
import { applyActions } from './action-handlers.js'
import { BuildRevisionCaptureError, safeRevisionHash } from './build-revision.js'
import type { ActionOutcome } from './ir.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type {
  PreparedTransition, TransitionApplicationWarning, TransitionCommand, TransitionRejection,
} from './transition-application-types.js'
import { fieldStr } from './transition-field-scalar.js'

// planner 只收 flow+clock，不收完整 TransitionApplicationDeps——deps 里有 runRepository 与两个
// projection writer，收整包等于 planner 在类型上仍可间接提交/写盘（第 2 轮 review 抓到：从
// "直接持有 tx" 变成 "间接可达" 不算收窄）。
export async function planDefaultTransition(
  state: PipelineState,
  command: TransitionCommand,
  flow: FlowEngine,
  clock: () => string,
  effectivePlan: EffectiveWorkflowPlan,
): Promise<PreparedTransition | TransitionRejection> {
  const edge = eventEdge(command.event)
  if (!edge) return { kind: 'unknown-event', event: command.event }
  const current = fieldStr(state.fields.phase)
  if (current !== edge.from) {
    return { kind: 'event-source-mismatch', event: command.event, current, expected: edge.from, to: edge.to }
  }
  // eventEdge 命中 → command.event ∈ TRANSITION_EVENTS 键 = EventName（DEFAULT_EVENT_POLICY 同键
  // 空间，查表恒命中）。
  const event = command.event as EventName
  const policy = DEFAULT_EVENT_POLICY[event]

  // ① 前置 guard：typed guard handler 判定（首错优先）+ renderer 逐字 ERROR 文案——default 轨
  // 政策从老 checkTransitionPreconditions switch 迁到 DefaultEventPolicy + guard-handlers（G2 P3）。
  const preconditions = await evaluateDefaultEventPreconditions(event, state, command.context)
  if (preconditions) {
    const blocker = preconditions.blockers?.[0]
    if (blocker !== undefined) return { kind: 'revision-untrusted', blocker }
    return { kind: 'precondition-violated', lines: [...preconditions.lines] }
  }
  if (policy.enforceTaskExit) {
    const tasks = await command.context.tasksThroughPhase?.(edge.from)
    if (tasks && !tasks.pass) {
      return { kind: 'precondition-violated', lines: [tasks.failure ?? `${edge.from} 出口：tasks.md 未通过`] }
    }
    // ② 相位出口规则表（flow/guard.ts EXIT_RULES）——`tenon check` 一直在评估它，转换层此前不评估，
    // 于是同一份状态上 check 说 FAIL exit 2、transition 照样 exit 0（pm 带着 prd_path=null 走完
    // ship→archive 就是这么发生的）。只对前进边评估：回退边是修问题的路，出口条件不适用
    // （enforceTaskExit 正是「这条边是不是相位完成边」的既有声明）。
    const exit = flow.guardCheck(state, {
      ...command.context.phaseExitGuard,
      coverageProfile: effectivePlan.capabilities.track.coverageProfile,
    })
    if (!exit.pass) {
      return {
        kind: 'step-guard-failed',
        workflowName: effectivePlan.id,
        stepId: edge.from,
        failures: exit.failures,
      }
    }
  }

  // ③ FlowEngine 推进：合法边检查 + phase/phase_status/updated_at 变换（转换结构不迁——保守分叉，
  // 边选择与相位推进继续由 eventEdge + FlowEngine 承担）。
  let result: ReturnType<FlowEngine['transition']>
  try {
    result = flow.transition(state, edge.to, clock)
  } catch (e) {
    if (e instanceof IllegalTransitionError) return { kind: 'illegal-transition', from: e.from, to: e.to }
    throw e
  }

  // ④ 状态副作用：typed action handler → patch，commit 前一次合并进 nextFields——default 轨从老
  // applyTransitionEffects switch 迁到 DefaultEventPolicy.actions + applyActions（G2 P3），与
  // custom 轨（planCustomTransition）共用同一 applyActions 引擎、同一「推进后 action、commit 前
  // 合并」时序。单次 planner 路径只跑 typed action、绝不再调 legacy switch（防双执行：两条都跑
  // 会让 clock()/gitHeadSha 各调两次 = 真实行为差异）。freeze-build-sha 统一由 capture capability
  // 生成 typed token；能力缺失或异常在 commit 前转为 revision-untrusted。
  const warnings: TransitionApplicationWarning[] = []
  let nextFields = result.state.fields
  if (policy.actions.length > 0) {
    let outcome: ActionOutcome
    try {
      outcome = await applyActions(policy.actions, {
        fields: result.state.fields,
        clock,
        gitHeadSha: command.context.gitHeadSha,
        workspaceFingerprint: command.context.workspaceFingerprint,
        captureBuildRevision: command.context.captureBuildRevision,
      })
    } catch (error) {
      if (error instanceof BuildRevisionCaptureError) {
        return {
          kind: 'revision-untrusted',
          blocker: {
            ...error.blocker,
            // Capture ran against the prospective target fields, but a rejected transition never
            // commits that state. Always report the locked canonical pre-state digest.
            stateHash: safeRevisionHash(state.fields),
          },
        }
      }
      throw error
    }
    nextFields = { ...result.state.fields, ...outcome.patch }
    for (const signal of outcome.signals) warnings.push({ kind: signal.kind })
  }
  return {
    governedDocumentContract: effectivePlan.capabilities.documents.governed,
    ...(effectivePlan.capabilities.documents.policy === undefined
      ? {}
      : { documentPolicy: effectivePlan.capabilities.documents.policy }),
    requiresReviewApproval: effectivePlan.capabilities.review.steps.includes(result.from),
    from: result.from, to: result.to, nextFields, warnings,
  }
}
