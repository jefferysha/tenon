/**
 * DefaultEventPolicy（G2 P3，2026-07-17）——default 轨每个转换事件的**前置 guard + 状态副作用
 * action** 的静态穷尽声明，取代 flow/transition-table.ts 曾各持一份的两个 legacy switch
 * （checkTransitionPreconditions 的 guard switch + applyTransitionEffects 的 action switch）。
 *
 * 分叉裁决（GOAL.md G2 保守分叉）：default 轨的**边选择与 phase/status 推进继续由
 * TRANSITION_EVENTS + FlowEngine 承担**（本文件不碰转换结构）；只有「走这条边前要过哪些 guard」
 * 与「走这条边后改哪些字段」这两项 event 专属政策，从手写 switch 迁到 P1 已有的 typed
 * guard/action handler（guard-handlers.ts / action-handlers.ts）——与 custom 轨共用同一套
 * 判定/副作用引擎，default 轨不再另立一套硬编码分支。
 *
 * 穷尽性：DEFAULT_EVENT_POLICY 的键是 Record<EventName, …>，与 TRANSITION_EVENTS 同键空间——
 * 新增 default 事件时 TypeScript 强制补 policy（guards/actions 至少写空数组），杜绝「加了边却漏
 * 声明前置/副作用」。**不读取、不编译 templates/workflows/default.yaml**——那是 P4 的 artifact
 * declaration 真相源，P3 的转换政策仍在代码里声明（保守分叉：default.yaml 不升为转换图真相源）。
 *
 * 分层（G2 设计钉死）：typed guard handler 只回结构化 GuardDecision（零文案）；default 轨对
 * 外可观测的**逐字 ERROR 文案**由本文件的 renderPreconditionViolation 渲染——文案层与判定层
 * 分离，判定走 typed handler、文案留 renderer（对齐老仓 state-transition.sh cmd_transition
 * 的 case 块 red() 逐字输出，供 golden-oracle 双跑逐字对齐）。
 *
 * import 纪律：本文件只在运行期 import workflow/{guard-handlers,predicates}（具体文件路径，非
 * barrel）——两者的运行期依赖链最终只落到零 import 的 predicates.js 与 flow/guard.js，无环
 * （transition-application.ts 经 ../flow/default-event-policy.js 具体路径消费本文件，同 predicates
 * 的既有反环约定）。
 */
import type { FieldName, PipelineState } from '../types.js'
import type { EventName, TransitionContext } from './transition-table.js'
import type { ActionConfig, CompiledGuardConfig, GuardInput } from '../workflow/ir.js'
import { evaluateGuards, type EvaluateGuardsOptions, type GuardEvaluation } from '../workflow/guard-handlers.js'
import { safeRevisionHash } from '../workflow/build-revision.js'
import type { BuildRevisionBlocker } from '../workflow/build-revision.js'
import { NON_PM, NON_PM_OR_FREE } from '../workflow/predicates.js'

/** 一个 default 事件的转换政策：前置 guard（首错优先评估）+ 走边后的状态副作用 action。 */
export interface DefaultEventPolicy {
  readonly guards: readonly CompiledGuardConfig[]
  readonly actions: readonly ActionConfig[]
  /** Phase-exit task completeness applies to completion edges, never to controlled rollback edges. */
  readonly enforceTaskExit: boolean
}

/**
 * default 轨事件 → 政策的穷尽映射（对齐老仓 state-transition.sh cmd_transition case 块）：
 *   · guards：老 checkTransitionPreconditions 各 event 分支的 typed 等价（首错优先序逐条对齐）。
 *     file-exists 单枚即覆盖老仓「字段非空且文件存在」合取（handler 对 unset 直接 failed、
 *     fileExists 未注入则 skipped=放行——与老仓 `isUnset(v) || !fileExists(v)` 且 fileExists
 *     缺省视为存在同判）。when:NON_PM 承载原流程的 PM 豁免：PM 仍须完成 OpenSpec/Superpower
 *     文档账本中的 plan 文档，但不要求 legacy state 的 `plan` artifact 字段。
 *   · actions：转换副作用的 typed 等价；除冻结/验证/归档外，Tenon 全局 pre-Verify 收敛状态也
 *     通过显式 reset action 管理，不能藏在 phase switch 或调用方约定里。
 */
export const DEFAULT_EVENT_POLICY = {
  'open-complete': { guards: [], actions: [], enforceTaskExit: true },
  'explore-complete': {
    // 老仓 L120-126：design_doc 非空且文件存在。
    guards: [{ type: 'file-exists', path: { kind: 'field', field: 'design_doc' } }],
    actions: [],
    enforceTaskExit: true,
  },
  'spec-complete': {
    // 老仓 L127-138：仅非 PM 轨要求 legacy `plan` artifact；PM 的文档链由 OpenSpec ledger
    // 单独强制，不能用一个新增 state 字段要求破坏原有 default transition 兼容性。
    guards: [{ type: 'file-exists', path: { kind: 'field', field: 'plan' }, when: NON_PM }],
    actions: [{ type: 'reset-pre-verify-review' }],
    enforceTaskExit: true,
  },
  'requirements-changed': {
    guards: [], actions: [{ type: 'reset-pre-verify-review' }], enforceTaskExit: false,
  },
  'build-complete': {
    // 首错优先：build_mode 必设 → isolation 必设 → isolation ∈ {branch,worktree,in-place}
    // → full+direct 锁 direct_override → pre-Verify 全量收敛通过。in-place 明确表示受限 agent
    // 仅能在当前工作目录写文件，不得把它伪装成已创建的 Git branch/worktree。
    guards: [
      { type: 'field-nonempty', field: 'build_mode' },
      { type: 'field-nonempty', field: 'isolation' },
      { type: 'field-in', field: 'isolation', values: ['branch', 'worktree', 'in-place'] },
      { type: 'full-direct-override' },
      { type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' },
    ],
    // Build revision capture capability writes the canonical build:v1 token; capability failure is closed.
    actions: [{ type: 'freeze-build-sha' }],
    enforceTaskExit: true,
  },
  'verify-pass': {
    // 首错优先：verification_report 非空且文件存在 → branch_status=handled → trustworthy
    // build revision barrier。手填的双 review 字段已删除，这道检查由步骤评审者承担。
    guards: [
      { type: 'file-exists', path: { kind: 'field', field: 'verification_report' } },
      { type: 'field-equals', field: 'branch_status', value: 'handled' },
      { type: 'build-head-unchanged', field: 'build_sha' },
    ],
    // 老仓 L201-204：verify_result=pass + verified_at=now。
    actions: [{ type: 'mark-verification-passed' }],
    enforceTaskExit: true,
  },
  'verify-fail': {
    guards: [],
    // 老仓 L207-210：verify_result=fail + build_sha=null（barrier 复位；phase_status 在 flow）。
    actions: [{ type: 'mark-verification-failed' }, { type: 'reset-pre-verify-review' }],
    enforceTaskExit: false,
  },
  'ship-complete': {
    guards: [{ type: 'spec-migration-applied' }], actions: [], enforceTaskExit: true,
  },
  archived: {
    guards: [],
    // 老仓 L213-217：archived=true + archived_at=now（phase_status=done 在 flow）。
    actions: [{ type: 'archive-run' }],
    enforceTaskExit: true,
  },
} as const satisfies Record<EventName, DefaultEventPolicy>

/** 值级 fstr：列表按逗号连接、缺省空串——老仓 cmd_get / 老 transition-table fstr 读值口径。 */
function fstr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(',') : (v ?? '')
}

/** 字段值 → 字符串（对齐老仓 cmd_get / 老 transition-table fstr）。 */
function fieldStr(state: PipelineState, k: FieldName): string {
  return fstr(state.fields[k])
}

/**
 * default 轨 guard 求值前，把参与判定的 state 字段值**逐字段按老仓 fstr 归一成 string**（列表→
 * 逗号连接、缺省/undefined→空串），使 default 轨 scalar guard 对数组/undefined 边界输入**逐字等价**
 * 老 checkTransitionPreconditions switch 的读值口径——老 switch 每个字段读值都过 fstr，数组被
 * join(',') 后再判定（如 build_mode=['direct'] → 'direct' → 放行；isolation=['branch','worktree']
 * → 'branch,worktree' → 枚举拒；design_doc=['a','b'] → 'a,b' 当路径判存在）。P1/P2 的 typed guard
 * scalarValue 对数组直接 fail-loud throw（列表进 scalar guard = 绕过编译器），本归一在把字段交给
 * typed guard **之前**先折成标量，令 default 轨恢复老 switch 的放行/join 行为。
 *
 * 落点纪律（G2 P3 阻断 1 修复）：
 *   · 归一**只作用于 guard 求值输入**——本函数产出一份全 string 的字段**副本**交 evaluateGuards，
 *     绝不回写 state.fields。transition 推进后的 typed action（freeze/verify/archive，applyActions）
 *     仍读真实 state.fields（含原始数组），故 action patch 不受本归一污染（B 已判 action 逐字一致，
 *     此处不动 action 求值面）。
 *   · **只 default 轨放宽**：custom 轨（planCustomTransition→evaluateGuards 直吃原始 state.fields）
 *     不经本归一，scalar guard 遇数组继续 fail-loud throw（guard-handlers.scalarValue 抛错）——
 *     列表字段进 scalar guard 在 custom 轨仍是须暴露的越界；default 轨的 guard 字段全来自受控
 *     FIELD_ORDER 的非列表字段（LIST_FIELDS 不进任何 default guard），join 归一是老 switch 既有的、
 *     对外可观测的历史等价行为，非新语义。
 */
export function normalizeDefaultGuardFields(fields: PipelineState['fields']): Record<FieldName, string> {
  const out: Partial<Record<FieldName, string>> = {}
  for (const k of Object.keys(fields) as FieldName[]) {
    out[k] = fstr(fields[k])
  }
  return out as Record<FieldName, string>
}

/**
 * 把 typed guard 的结构化 failed 判定渲染成老仓 cmd_transition 逐字 ERROR 文案（stderr 面）。
 * 按 (event, guard.type[, guard.field]) 分派——文案是 event 专属、非机械可从结构推导，故渲染层
 * 就是一层 event 感知的翻译（判定逻辑已在 typed handler，此处只拼串）。barrier 是唯一双行文案。
 * failure.decision.kind 恒 'failed'（调用方只对 failed 评估调本函数）。
 */
export function renderPreconditionViolation(
  event: EventName,
  failure: GuardEvaluation,
  track: string,
): string[] {
  const { guard, decision } = failure
  if (decision.kind === 'failed' && decision.blocker !== undefined) {
    return [
      `ERROR: ${event} revision trust blocked (code=${decision.blocker.code} reason=${decision.blocker.reason})`,
      `  修复：${decision.blocker.remediation}`,
    ]
  }
  const actual = (decision.kind === 'failed' ? decision.actual : undefined) ?? ''
  switch (event) {
    case 'explore-complete':
      return [`ERROR: explore-complete 要求 design_doc 字段非空且文件存在 (当前=${actual})`]
    case 'spec-complete':
      return [`ERROR: ${track} track spec-complete 要求 plan 字段非空且文件存在 (当前=${actual})`]
    case 'build-complete':
      if (guard.type === 'field-nonempty') {
        return guard.field === 'build_mode'
          ? ['ERROR: build_mode 必须设置']
          : ['ERROR: isolation 必须设置']
      }
      if (guard.type === 'field-in') return [`ERROR: 非法值 '${actual}'，允许: branch worktree in-place`]
      if (guard.type === 'full-direct-override') {
        return ['ERROR: full workflow 使用 build_mode=direct 必须显式设 direct_override=true']
      }
      if (guard.type === 'field-equals' && guard.field === 'pre_verify_review_result') {
        return [`ERROR: build-complete 要求 pre_verify_review_result=pass (当前=${actual})`]
      }
      break
    case 'verify-pass':
      if (guard.type === 'file-exists') {
        return [`ERROR: verify-pass 要求 verification_report 字段非空且文件存在 (当前=${actual})`]
      }
      if (guard.type === 'field-equals') {
        return [`ERROR: verify-pass 要求 branch_status=handled (当前=${actual})`]
      }
      if (guard.type === 'build-head-unchanged') {
        const bsha = (decision.kind === 'failed' ? decision.expected?.[0] : undefined) ?? ''
        if (bsha.startsWith('workspace:sha256:')) {
          return [
            `ERROR: verify-pass 要求当前工作区内容等于 build 冻结基线（build_sha=${bsha} 当前=${actual}）`,
            '  修复：工作区在 build 后发生变化；重跑 build-complete 冻结新基线后再验证',
          ]
        }
        return [
          `ERROR: verify-pass 要求 HEAD==build_sha（build 后产物被改未复验）build_sha=${bsha} HEAD=${actual}`,
          '  修复：要么把改动并入复验（重跑 build→verify），要么 verify-fail 回退后重新 build-complete 冻结新 SHA',
        ]
      }
      break
    case 'ship-complete':
      if (guard.type === 'spec-migration-applied') {
        return [`ERROR: ship-complete 要求主规格迁移机器证据有效（当前=${actual}）`]
      }
      break
    default:
      break
  }
  // guards 非空的 event（explore/spec/build/verify-pass）必被上面覆盖；到这里 = 政策表与渲染器
  // 漂移（新增了 guard 却漏渲染），fail-loud 而非静默产出错文案。
  throw new Error(`renderPreconditionViolation: 未覆盖的 (event=${event}, guardType=${guard.type})`)
}

/**
 * default 轨事件前置校验（老 checkTransitionPreconditions 的 drop-in 替身，签名/语义逐字保留）：
 * 按 policy.guards 首错优先评估 typed guard，命中 failed → 渲染成老仓逐字 ERROR 行数组；全通过
 * （或仅有可选文件面 skipped/不适用）→ null；revision guard 缺能力永不 skipped，而是 typed
 * blocker。在锁内、任何 mutation 之前由 planner 调用。
 */
export async function checkDefaultEventPreconditions(
  event: EventName,
  state: PipelineState,
  ctx?: TransitionContext,
): Promise<string[] | null> {
  const result = await evaluateDefaultEventPreconditions(event, state, ctx)
  return result === null ? null : [...result.lines]
}

export interface DefaultPreconditionResult {
  readonly lines: readonly string[]
  readonly blockers?: readonly BuildRevisionBlocker[]
}

export async function evaluateDefaultEventPreconditions(
  event: EventName,
  state: PipelineState,
  ctx?: TransitionContext,
  options?: EvaluateGuardsOptions,
): Promise<DefaultPreconditionResult | null> {
  const policy = DEFAULT_EVENT_POLICY[event]
  if (policy.guards.length === 0) return null
  const track = fieldStr(state, 'track')
  // 阻断 1 修复：交 typed guard 前先按老仓 fstr 归一字段值（数组→join、缺省→''），令 default 轨
  // scalar guard 对数组/undefined 边界输入逐字等价老 switch（副本入参，不污染 state / action 求值）。
  const input: GuardInput = {
    fields: normalizeDefaultGuardFields(state.fields),
    stateHash: safeRevisionHash(state.fields),
    rawBuildSha: state.fields.build_sha,
    track,
    fileExists: ctx?.fileExists,
    gitHeadSha: ctx?.gitHeadSha,
    workspaceFingerprint: ctx?.workspaceFingerprint,
    specMigrationStatus: ctx?.specMigrationStatus,
    assessBuildRevision: ctx?.assessBuildRevision,
    currentStep: fieldStr(state, 'phase'),
  }
  const evaluations = await evaluateGuards(policy.guards, input, options)
  const failed = evaluations.find((e) => e.decision.kind === 'failed')
  if (!failed) return null
  const blockers = evaluations.flatMap((evaluation) =>
    evaluation.decision.kind === 'failed' && evaluation.decision.blocker !== undefined
      ? [evaluation.decision.blocker]
      : [])
  return {
    lines: renderPreconditionViolation(event, failed, track),
    ...(blockers.length === 0 ? {} : { blockers }),
  }
}
