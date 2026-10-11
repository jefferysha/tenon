/**
 * @tenon/automation —— AFK Sandcastle 无人监管自动化路径（BACKLOG #29/#29b, GOAL A5/M5）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 老仓 5 个 TS 包语义盘点（严格只读源：workflow-plugin/skills/pipeline/automation/）
 * ════════════════════════════════════════════════════════════════════════════
 * 老仓把 @ai-hero/sandcastle v0.11.0 的沙箱编排移植成 5 个 npm 包 + 一层 bash 队列。
 * 本 lite 包把其**队列语义 + 生命周期状态机 + 分级放权**收编为单一 workspace 包（node
 * stdlib + @tenon/kernel），把 docker 全链执行抽象到注入面（真 docker 走 IT）。
 *
 *  1) runner/   （老仓 runner/src/*.ts）—— 沙箱运行时抽象：Docker/Podman/Apple-container/
 *     daytona/vercel provider（sandboxes/*.ts）、ContainerLifecycle/DockerLifecycle 起关容器、
 *     race.ts 三路 race（idle-timeout / completion-grace / abort）、shutdownRegistry 单监听器
 *     fan-out、boundedTail 64KiB 滚动尾部、AgentProvider（6 种 agent）、worker/ provider-op 子进程。
 *     → lite: runner/docker.ts（docker 探针 + 最小容器，注入 exec 面）+ runner/runner.ts
 *       （结构化握手解析 parseSandboxReport，老仓 runChange.ts:447-545）。全链 docker 留 #29c。
 *  2) lifecycle/（老仓 lifecycle/src/*.ts）—— SandboxLifecycle.ts merge-back 守卫（merge 非
 *     cherry-pick、失败留 temp 分支 + 恢复命令、baseHead 锚 host worktree、git 身份注入 +
 *     safe.directory + UID 对齐）、WorktreeManager 并发安全三件套（LC_ALL=C / NO_CONFIG_LOCK /
 *     随机后缀）、gitMounts .git 双挂载、syncIn/syncOut（isolated 的 bundle/am 桥）。
 *     → lite: lifecycle/lifecycle.ts（挂队→沙箱→跑 pipeline→merge-back→teardown 纯编排 +
 *       注入 worktree/sandbox/git 面）+ lifecycle/barrier.ts（build_sha 全链同源派生）。
 *  3) scheduler/（老仓 scheduler/src/*.ts）—— 调度核心：scheduler.ts（claim→running→run→
 *     settle→写回，allSettled 收口，shutdown teardown 标 in-flight failed）、semaphore.ts 手写
 *     计数信号量、classify.ts 失败分类（tag 而非字符串）、config.ts 读 config.yaml::automation、
 *     barrier.ts build_sha 派生、reconcile/abortBridge/afkObserver/kanbanDisplay 旁路上板。
 *     → lite: scheduler/{semaphore,classify,scheduler}.ts（逐字/等价移植 + L1→L3 分级合体）。
 *  4) cli/    （老仓 cli/src/*.ts）—— sandcastle 自身 CLI（init/run/交互式镜像选择），非 pipeline
 *     队列面。→ lite: 未收编——本包不含 CLI 层，只出 sdk 编排面；pipeline 侧的队列命令面在
 *     packages/cli 的 `tenon afk`（program.ts::afk <sub>，commands/afk.ts：enqueue/scan/
 *     status/run/cancel），由它调本包的 sdk。
 *  5) sdk/    （老仓 sdk/src/*.ts）—— createSandbox/createWorktree/run 编排 + output/
 *     extractStructuredOutput（取最后 tag + fence 剥离 + 重试）+ prompt/PromptPreprocessor
 *     （SHELL_BLOCK_MARKER 注入防护）。→ lite: sdk/sdk.ts（对外 API：enqueue/scanReady/runRound）。
 *
 * 队列层（老仓 skills/pipeline/scripts/*.sh，非 TS 包但是队列语义真相源）：
 *   - automation-queue.sh:1-110 —— "取下一个"扫描 + 拓扑/FIFO（→ queue/scan.ts）。
 *   - automation-config.sh:1-114 —— 两层开关与队列 opt-in 语义；本插件的轨道资格
 *     由任务所选工作流分支的 `automation` 决定（没写 = 不可进入 AFK），default 的产品 / 前端 / 后端
 *     分支都允许显式 AFK（→ queue/gate.ts）。
 *   - state-transition.sh:229-237 —— spec-complete 挂队注入点（→ sdk enqueue + queue/gate.ts）。
 *   - pipeline-guard.sh:147-162 —— build 相位 automation=queued 双执行守卫（→ queue/gate.ts）。
 *   - hooks/pipeline-gate.sh:16-25 —— TENON_AFK=1 沙箱放行三门（→ queue/gate.ts）。
 *   - state-fields.sh:110/154 —— automation 8 态枚举校验（→ queue/state-machine.ts）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 队列生命周期状态机（automation 字段，DESIGN §2；见 queue/state-machine.ts 转换表）
 * ════════════════════════════════════════════════════════════════════════════
 *   off ─(spec-complete + enabled && opted-in)─▶ queued
 *   queued ─(调度器 claim, TOCTOU-cas)─▶ scheduled ─(起容器)─▶ running
 *   running ─(build→verify→ship 全过)─▶ merged(L3 自动合并) | paused(L1/L2 report-only 停给人工)
 *   running ─(verify-fail / 瞬态, 可重试)─▶ queued(attempts++)  或  failed(预算耗尽)
 *   running ─(merge 冲突 / barrier drift / abort)─▶ conflict（保留现场, 绝不重试）
 *   merged ─▶ off（回归正常, 进 archive）；failed/conflict ─▶ queued（人工重跑, attempts 清零）
 *   queued/scheduled/running ─▶ paused（运维暂停）；paused ─▶ queued（resume）| merged（L2 放行）
 *
 * kernel 契约（只 import 不改）：@tenon/kernel 的 StateStore 读写 change 的 automation_*
 * 字段（types.ts::FIELD_ORDER 已含 7 个 automation_* 字段）；cas 提供并发闸（compare-and-set）。
 */
import type { VerificationResult } from '@tenon/kernel'

/** automation 字段的 8 个合法态（老仓 state-fields.sh:110/154 validate_enum）。 */
export const AUTOMATION_STATES = [
  'off',
  'queued',
  'scheduled',
  'running',
  'merged',
  'failed',
  'conflict',
  'paused',
] as const
export type AutomationState = (typeof AUTOMATION_STATES)[number]

/** 一次 build/verify/ship 成功对应的相位事件（老仓 scheduler/types.ts:21）。 */
export const PHASE_EVENTS = ['build-complete', 'verify-pass', 'ship-complete'] as const
export type PhaseEvent = (typeof PHASE_EVENTS)[number]

/**
 * L1→L3 分级放权（GOAL B19，与 AFK 自动化合体；上游 Phased Rollout × 老仓 human gates）：
 *   - L1 report-only（默认，安全）：挂队 + 沙箱跑 + 报告，但**不自动 merge**（成功停 paused，人工复核）。
 *   - L2 人工门：跑完停 paused 等人工在 dashboard 显式放行 → merged。
 *   - L3 unattended：无监管自动 merge（成功直接 merged），但生产 loop 路径在 merge 前同时执行
 *     allowlist（空表=零路径获准）与 denylist；任一越界都判 conflict、保留现场。策略从同一份 registry
 *     快照解析，读取失败在创建沙箱前 fail-loud，不降级为空策略。
 * 毕业制升档：change 先 L1，证明稳定后由 loop 治理（BACKLOG #35）升 L2/L3。字段先纳入。
 */
export const AUTOMATION_LEVELS = ['L1', 'L2', 'L3'] as const
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number]

/** 失败分类（老仓 scheduler/types.ts:78-86）：retry 回 queued；conflict 留现场不重试。 */
export type FailureKind = 'retry' | 'conflict'

/**
 * 结构化失败成因 tag（F-b，kernel 契约字段 automation_cause 的写入值域）——按 error `_tag`
 * 干净判定，绝不 regex message（message 会漂、会被 200 字符截断丢信号；tag 不会）：
 *   - `cancelled`   人为取消（AbortedRunError 操作员 abort / CancelledRunError dashboard 取消）
 *   - `conflict`    冲突族（SyncError / MergeToHostTimeoutError / WorktreeError /
 *                   BarrierDriftError / DenylistViolationError）
 *   - `timeout`     AgentIdleTimeoutError（agent idle 超时）
 *   - `verify-fail` 诚实结算 verify_result=fail 转失败（sentinel）
 *   - `agent-exit`  agent 非零退出（lifecycle [AGENT_EXIT] 观察器旁路写点，不经 classifyFailure）
 *   - `no-op`       空跑（零 commit / buildSha 缺失，scheduler noop 诚实结算写点）
 *   - `''`（空串）  未知/基础设施类（ExecError 等 tag 无法干净定成因）——读取端 fallback regex 兜。
 * 读取端按**开放集**消费：未识别值自动 fallback，追加新值不破。生命周期：与
 * automation_last_error **同写同清**（所有写 last_error 的落点必须同步写 cause，真值或空串），
 * 杜绝「消息换了、成因还是旧的」撕裂。
 */
export interface Classification {
  readonly kind: FailureKind
  readonly message: string
  /** 结构化成因 tag（必填；空串=未知，见上值域表）。 */
  readonly cause: string
  /** 保留的脏 worktree 路径（conflict only），供人工接管。 */
  readonly preservedPath?: string
}

/**
 * 一次沙箱运行的产物（老仓 scheduler/types.ts:49-71）。commits 空 = no-op run（noop:true，
 * 即便 verifyResult pass 也不当真 pass——诚实化 obs-13）。
 */
export interface RunOutcome {
  readonly commits: readonly Readonly<{ sha: string }>[]
  readonly verifyResult: 'pass' | 'fail'
  readonly buildSha?: string
  readonly branch?: string
  readonly phaseEvent: PhaseEvent
  /** buildSha 缺失（零 commit / 容器跑空）→ true。消费者据此判 no-op，不把空跑读成真 pass。 */
  readonly noop?: boolean
  /**
   * GOAL H · Stage C kill-switch 接缝③：运行中 loop 被停用（status!==active）时 lifecycle 在 L3
   * merge 前重查到停用 → **跳过 merge** 并置本标志。scheduler writeBackSuccess 见 killSwitched 强落
   * paused（即便 L3、即便 verify pass），reason=kill-switch——「停用则不 merge，结果强制 paused」。
   */
  readonly killSwitched?: boolean
  /**
   * H7 verifier Phase 2：lifecycle 在 merge 之前、取得权威 build_sha（本 buildSha 字段，barrier 派生
   * 非沙箱自报）后调 VerifierPort 产出的结构化核验结果。缺席 = no-op（无构建可核验，见
   * lifecycle.ts::runChangeInSandbox）。scheduler.writeBackSuccess 据 verifier/evaluateVerificationGate
   * 判定 trusted+passed+SHA 相符才允许结算 merged；absent/untrusted/inconclusive/SHA 漂移一律
   * fail-closed 落 paused（reason 见 ledger-types.ts RunRecord.reason 的 verification-* 扩）。
   * 与 verifyResult（沙箱自报二元、untrusted）并存——两者是不同信任等级的独立信号。
   */
  readonly verification?: VerificationResult
  /**
   * H7-S2 custom fail-closed：lifecycle 由 cfg.workflowKind==='custom' 判定后随本字段透传给
   * scheduler——scheduler.evaluateVerificationGate 消费点据此要求 canonical.binding.kind 必须是
   * 'workflow-transition' 才可授权（custom workflow 坐标未真正解析 → fail-closed 落 paused，
   * reason=verification-binding-unresolved）。缺席/false = 'default' workflow 语义，不加此限制
   * （行为不变，存量调用点/单测无需升级）。
   */
  readonly requireWorkflowBinding?: boolean
  /**
   * 仅真实 lifecycle 在 mergeToBase 成功返回后置 true；scheduler 还会核对进程内 lifecycle
   * provenance，普通 RunChange 自报此布尔不会被采信。terminal kill-switch 不得覆写已 landed 事实。
   */
  readonly mergeLanded?: boolean
  /** base ref 已落地，但 host 工作树同步需人工处理；仍是 merged 事实，不得重分类为 conflict。 */
  readonly hostSyncPending?: boolean
  /** base 已落地，但 merge-landed ledger fsync 失败；recovery 须用 intent+ref 对账。 */
  readonly mergeJournalPending?: boolean
}

/** 调度器配置（老仓 scheduler/config.ts 的 lite 子集 + 分级 level）。 */
export interface AutomationConfig {
  /** 全局总开关；缺省 false（fail-safe OFF，老仓 automation-config.sh:6-8）。 */
  readonly enabled: boolean
  /** 未显式预置 queued 的 change 是否默认入队（老仓 default_opt_in）。 */
  readonly defaultOptIn: boolean
  /** 并发沙箱上限（老仓 max_parallel 默认 4）。 */
  readonly maxParallel: number
  /** 单 change 失败自动重试次数（老仓 max_retries 默认 1）。 */
  readonly maxRetries: number
  /** 分级放权档位；缺省 L1 report-only（安全默认）。 */
  readonly level: AutomationLevel
}

export const DEFAULT_CONFIG: AutomationConfig = {
  enabled: false,
  defaultOptIn: false,
  maxParallel: 4,
  maxRetries: 1,
  level: 'L1',
}
