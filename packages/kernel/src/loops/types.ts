/**
 * loop 治理子系统类型面（BACKLOG #35 / GOAL B18 / D16 —— loop-engineering 内建）。
 *
 * 老仓真相源（严格移植，行号锚定 workflow-plugin/skills/pipeline/scripts/）：
 *   · registry 数据模式 ← loops.schema.json（version/loops[]/budget/kill_criteria/human_gates …）。
 *   · 裁决信封 ← loops_enforce.py::adjudicate 384-397（id/verdict/reasons/metrics）。
 *
 * 分级放权 L1→L3（老仓无此面；对标 cobusgreyling/loop-engineering "Phased Rollout" × 老仓 human_gates）：
 * `autonomy_level` 字段 + verdict 信封的 enforcement/report_only。
 * 缺省 L1 = report-only（观察不动手）；L2 assisted（人工门）；L3 unattended（无监管自动 merge，
 * 同时受 allowlist 白名单与 denylist 黑名单约束；L3 merge 前由 automation lifecycle 强制校验，
 * merge permit 还会复核 prepare 时冻结的 policy epoch，避免运行中收紧策略后沿用旧白名单。
 *
 * ★当前限制（读裁决信封的人须知）：级别与 verdict 都不驱动任何自动 gate/halt。adjudicate 的
 * kill/warn 只汇进报告（enforce.ts::buildReport → CLI `loops report`），没有消费方据此停 loop；
 * enforcement/report_only 是给消费方判读的标注，不是执行动作。相关子系统各自在同目录，且同为
 * 「算了就报」而非闸门：token 预算熔断 budget.ts（computeBudgetStatus 出 breaker，tripped 只影响
 * 升降档裁决与展示，不阻断运行）、漂移/就绪审计 drift.ts、升降档毕业制 graduation.ts
 * （applyLevelChange 改的是 autonomy_level 本身，不是运行闸门）。
 */

export type LoopKind = 'orchestrator' | 'executor'
export type LoopStatus = 'active' | 'paused' | 'retired'
export type LoopRisk = 'low' | 'medium' | 'high'

/** 分级放权级别（loop-engineering 核心思想；缺省 L1）。 */
export type AutonomyLevel = 'L1' | 'L2' | 'L3'

/**
 * v5 T20：已知 agent runner 清单（编排页 runner 下拉的双选项数据面；automation 分派口径见
 * automation/runner.ts::buildAfkRunCommand。LoopEntry.runner 仍是自由字符串以便旧表可读，但
 * 所有新写入/执行边界必须调用本文件的闭集 guard；历史未知值只能诊断，不能隐式执行。
 */
export const LOOP_RUNNERS = ['claude-code', 'codex'] as const
export type LoopRunner = (typeof LOOP_RUNNERS)[number]

export function isLoopRunner(value: unknown): value is LoopRunner {
  return typeof value === 'string' && (LOOP_RUNNERS as readonly string[]).includes(value)
}

export function assertLoopRunner(value: unknown): LoopRunner {
  if (!isLoopRunner(value)) {
    throw new Error(`runner 非法「${String(value)}」：仅允许 ${LOOP_RUNNERS.join(' / ')}，拒绝隐式降级执行`)
  }
  return value
}

/** 预算声明（老 loops.schema.json budget 76-93）。
 * #36 追加可选 token 级预算（向后兼容，旧登记表无需改）：
 *   · max_tokens_per_day —— token 预算/circuit breaker 硬阈值（累计今日花费达/超即熔断）。
 *   · tokens_per_run     —— 成本估算 pattern 覆盖（每轮 token 足迹；缺省按 risk 预设）。
 * 追踪/熔断/估算纯逻辑在 loops/budget.ts；本处仅声明字段类型。 */
export interface LoopBudget {
  max_runs_per_day: number
  max_in_flight: number
  on_exceed: string
  /** #36：token 预算硬阈值（circuit breaker）；缺省 = 无 token 预算（仅追踪花费）。 */
  max_tokens_per_day?: number
  /** #36：每轮 token 足迹（成本估算 pattern 覆盖）；缺省按 risk 预设。 */
  tokens_per_run?: number
}

/** 登记表单条 loop（老 loops.schema.json loops.items 14-100 + 分级放权的 autonomy_level）。 */
export interface LoopEntry {
  id: string
  name: string
  kind: LoopKind
  goal: string
  cadence: string
  risk: LoopRisk
  runner: string
  change_prefix: string | null
  phases: string[]
  human_gates: string[]
  /** @deprecated H9: legacy imported run-log path only; runtime iteration state comes from ledger facts. */
  state?: string
  design_doc: string
  status: LoopStatus
  budget: LoopBudget
  kill_criteria: string[]
  /** 分级放权级别（缺省填 L1；loadRegistry 派生时补默认）。 */
  autonomy_level: AutonomyLevel
  /** v5 决议 #12：路径 glob 白名单（L3 unattended 自动合并的许可范围）。schema 载入 + server
   * 只读透出；运行时由 automation/lifecycle/denylist.ts + lifecycle.ts 在 merge 前强制消费。缺省 []。 */
  allowlist: string[]
  /** v5 决议 #12：路径 glob 黑名单（存储侧；运行时校验见 automation/lifecycle/denylist.ts，
   * 该模块以鸭子类型只读 change_prefix + denylist——本字段名即其消费契约，勿改名）。缺省 []。 */
  denylist: string[]
  /** H11 starter 来源；旧登记表可缺席，template catalog 的引用存在性不属于 registry 类型层。 */
  template_id?: string
  /** H11 starter schema 版本；当前持久化格式只接受字面量 1。 */
  template_version?: 1
  /** H11 编译后绑定的 workflow token；旧登记表可缺席。 */
  workflow_id?: string
  /**
   * H10 §1：skill bundle 引用（YAML 字段 `skill_bundle_id`，snake_case，与 change_prefix/human_gates
   * 等其余字段同一命名口径；执行域消费方若需要 camelCase `skillBundleId`，由消费方自行映射，本类型
   * 不做转写）。值域词法上是 `_all` 或工作流分支 id 形状的 profile id（词法规则见
   * registry.ts::SKILL_BUNDLE_ID_RE，复用既有正则不另造）；是否是 manifest 里真实声明过的 profile
   * 属存在性语义校验，留给消费本字段的后续任务，本类型与 loadRegistry 均不做、也做不到（这里拿不到
   * manifest 上下文）。
   *
   * `loadRegistry` 派生后：旧登记表缺这一行、或显式写 `null`，一律归一化为 `null`——语义是
   * **unwired**（未接线），不是"空 bundle"，也不是"沿用某个默认 bundle"；任何 real-run 都据此拒绝。
   *
   * 类型标为可选：兼容仓内其余尚未读取本字段的既有 LoopEntry 构造点（避免本次改动波及清单外文件的
   * 类型检查）。`loadRegistry` 产出的对象本字段恒为 `null` 或合法字符串，不会是 `undefined`——
   * `undefined` 只出现在尚未接线本字段的手写测试夹具里，语义上与显式 `null` 同视为 unwired。
   */
  skill_bundle_id?: string | null
}

export interface LoopRegistry {
  version: 1
  loops: LoopEntry[]
}

/** 裁决三值（老 ok/warn/kill，kill > warn > ok 取最严；对齐老仓 --json）。 */
export type Verdict = 'ok' | 'warn' | 'kill'

/** 分级放权级别 → 执行模式（随裁决信封回显的标注；不驱动自动动作，见顶注★当前限制）。 */
export type Enforcement = 'report-only' | 'assisted' | 'unattended'

/** 单条触发规则（老 adjudicate reasons 元素：{rule, detail}）。 */
export interface VerdictReason {
  rule: string
  detail: string
}

/** 裁决度量（老 adjudicate metrics 388-396）。 */
export interface VerdictMetrics {
  runs_today: number
  fail_streak: number
  dry_rounds: number
  in_flight: number
  minutes_since_last_run: number | null
  latest_row_ok: boolean
  misaccounted: number
}

/** 单个 loop 的裁决信封（老 adjudicate 返回 384-397 + 分级放权的 autonomy_level/enforcement/report_only）。 */
export interface LoopVerdict {
  id: string
  verdict: Verdict
  autonomy_level: AutonomyLevel
  /** 由 autonomy_level 派生：L1→report-only / L2→assisted / L3→unattended。 */
  enforcement: Enforcement
  /** = autonomy_level === 'L1'：标注「即便 kill 判据命中也只报告不自动停」，供消费方判读（见顶注）。 */
  report_only: boolean
  reasons: VerdictReason[]
  metrics: VerdictMetrics
}

/**
 * 运行事实（adjudicate 的纯输入）：progress.md 解析 + 在途计数 + barrier audit 的汇总。
 * 老 adjudicate 直接吃散参数（parsed/in_flight/misaccounted）；本仓聚成一个只读结构便于测试与注入。
 */
export interface RunFacts {
  runsToday: number
  failStreak: number
  dryRounds: number
  lastRunAt: Date | null
  latestRowOk: boolean
  inFlight: number
  misaccounted: readonly string[]
}
