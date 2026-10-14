/**
 * loop admission —— 原子 preflight + reservation 生命周期 + kill-switch + 崩溃恢复（GOAL H · Stage C，
 * codex 第 3 节权威设计）。
 *
 * 判定位置（第 3 节）：**不**扩 gate.ts::optedIn（轻量 opt-in 纯函数，无 ledger/registry 锁，塞进去
 * 制造「看似已管控」的假安全）；**不**只放 CLI preflight（server/H14/SDK 都能绕过）。权威点 =
 * scheduler.handleOne 且**在 claim 之前**：semaphore.acquire → admission.reserve()（仓级锁内重读
 * registry+ledger）→ claim → activate → status recheck → running → runChange → pre-merge recheck →
 * terminal CAS → settle。
 *
 * 原子性核心（第 3 节 + C 验收「两并发 round 只一个 reserve 成功」）：reserve() 的「重读 registry+
 * ledger → 判定 → append reservation」全程在**一次 withLedgerLock 内顺序执行**（Stage A 契约：锁内
 * 可 read+append 多条，但不得锁内并发）。仓级锁串行两个并发 round，第二个必然读到第一个刚 append 的
 * reservation，不可能同时读到旧预算都通过。reservation 的 ledger 写入**严格早于** queued→scheduled
 * CAS（reserve 在 claim 之前）。
 */
import type {
  AutomationPolicySnapshot,
  EffectiveSkillResolver,
  LoopEntry,
  LoopLedgerStore,
  LoopRegistry,
  SkillBundleResolutionInput,
  WorkflowActionEvaluation,
  WorkflowActionAuthoritySnapshotV1,
  WorkflowPlanSnapshot,
} from '@tenon/kernel'
import {
  admissionDecision, budgetDayOf, buildAttemptContext, compileAutomationPolicySnapshot, compileConstraintPolicy, evaluateConstraintPolicy,
  indexMergeFactsByAttempt, LedgerDegradedError, loopMaterialUnchanged,
  normalizeOnExceed, projectLoopLedger,
  registryContentEpoch, reservedTokensFor, resolveLoopBinding, resolveSkillBundle, withRegistryGovernanceLock,
  type AdmissionBlock, type AttemptContextLedgerSnapshot, type BudgetExceedAction, type BudgetReservationRecord,
  type ChangeLoopBindingRecord, type LedgerRecord, type MergeIntentRecord, type MergeLandedRecord,
  type ReservationActivatedRecord, type RunRecord, type SkillBundleSnapshotRecord, type UsageRecord, type VerificationResult,
} from '@tenon/kernel'
import type { AutomationLevel } from '../types.js'
import type { ProviderStructuredUsage } from '../runner/runner.js'
import type { SkillContentLocator } from '../skills/content-locator.js'
import { buildCanonicalManifest, materializeSkillSnapshot, type MaterializeSkillSnapshotOptions } from '../skills/snapshot-store.js'
import type { SkillSnapshotInput, SkillSnapshotProvenance, SkillSnapshotPublishResult } from '../skills/types.js'
import {
  makeIdGen, markLoopPrepared, markNonLoopPrepared,
  type CapturedExecutionCoordinate, type ExecutionContext, type ExecutionCoordinatePort,
  type ExecutionPreparationPort, type PrepareOutcome, type PreparationFailureReason,
  type PreparedExecutionContext, type PreparedSkillSlot,
} from './execution-context.js'
import type { WorkflowActionAuthorityFacts } from './workflow-action-authority-binding.js'

export const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const isPreparedContext = (ctx: ExecutionContext): ctx is PreparedExecutionContext =>
  'preparedKind' in ctx && (ctx.preparedKind === 'loop-bundle' || ctx.preparedKind === 'non-loop')

/** activation 的 durable authority：Prepared bundle 必须逐字段对应本 reservation 唯一 snapshot 事实。 */
export const snapshotMatchesPrepared = (
  snapshot: SkillBundleSnapshotRecord,
  ctx: Extract<PreparedExecutionContext, { readonly preparedKind: 'loop-bundle' }>,
): boolean => {
  const bundle = ctx.skillBundle
  return snapshot.attempt_id === ctx.attempt_id
    && snapshot.reservation_id === ctx.reservation_id
    && snapshot.loop_id === ctx.loop_id
    && snapshot.skill_bundle_id === ctx.skill_bundle_id
    && snapshot.policy_epoch === ctx.policy_epoch
    && snapshot.workflow_run_id === (ctx.workflow_run_id ?? ctx.attempt_id)
    && snapshot.resolution_source === bundle.resolutionSource
    && snapshot.workflow === bundle.workflow
    && snapshot.step === bundle.step
    && snapshot.track === bundle.track
    && snapshot.coordinate_digest === bundle.coordinateDigest
    && snapshot.snapshot_sha256 === bundle.snapshotSha256
    && snapshot.cas_relative_path === bundle.casRelativePath
    && snapshot.slots.length === bundle.slots.length
    && snapshot.slots.every((slot, index) => {
      const prepared = bundle.slots[index]
      return prepared !== undefined
        && slot.token === prepared.token
        && slot.concrete_skill_id === prepared.concreteSkillId
        && slot.tree_sha256 === prepared.treeSha256
        && slot.alternatives.length === prepared.alternatives.length
        && slot.alternatives.every((alternative, i) => alternative === prepared.alternatives[i])
    })
}

/**
 * H10 §1/§5：loop 的 `skill_bundle_id` 是具名 profile（非 `_all`），但调用方未装配
 * `LoopAdmissionDeps.isSkillProfileKnown`——这不是「profile 不存在」（那是
 * `skill-bundle-profile-not-found` denial，需要真校验器给出 `false` 才能下这个结论），而是
 * 「校验能力尚未接线」（H10 生产装配见任务7）。两者必须区分：把「未装配」误判成「不存在」会让
 * 一个实际合法的具名 profile 在 task7 接线前被错误暂停，并在 loops.yaml 留下一条虚假的治理事实。
 * 故此处 fail-closed **throw**（不放行、不建 reservation）而非返回某个业务 denial reason——镜像
 * `RegistryReadError`/`LedgerDegradedError`等既有「基础设施/装配缺口 throw 成 round failure」的
 * 处置，绝不把配置缺口伪装成业务判定持久化。
 */
export class SkillProfileValidatorUnconfiguredError extends Error {
  readonly _tag = 'SkillProfileValidatorUnconfiguredError'
  constructor(message: string) { super(message); this.name = 'SkillProfileValidatorUnconfiguredError' }
}

/** reserve 拒绝的结构化原因（scheduler 据此决定 skip-run / pause-loop / halt-round + 记 RoundReport）。 */
export interface AdmissionDenial {
  readonly ok: false
  /** 归一后的处置动作：budget 超限用 loop.on_exceed；并发/歧义/坏行/status/binding 类一律 skip-run。 */
  readonly action: BudgetExceedAction | 'skip-run'
  /** 判别原因（binding-* / loop-inactive / registry-* / max-* / duplicate-change / ledger-degraded）。 */
  readonly reason: string
  readonly detail: string
  /** loop_id 已解析出时携带（status/额度类拒绝）；binding 失败时可能无。 */
  readonly loopId?: string
  readonly block?: AdmissionBlock
  /** Exact five-layer result when the frozen Workflow policy blocks execution before claim. */
  readonly authorization?: WorkflowActionEvaluation
}

export type ReserveResult = { readonly ok: true; readonly context: ExecutionContext } | AdmissionDenial
export type ClaimAuthorizationResult =
  | { readonly ok: true; readonly context: ExecutionContext; readonly claimed: boolean }
  | AdmissionDenial

/** reserveOnce 的内部结果：正常 ReserveResult 或「epoch 变、须整轮重试」哨兵（#4）。 */
export type ReserveOutcome = ReserveResult | { readonly retry: true }

/**
 * activate 结构化结果（Stage B 返工 #1）：ledger 锁内验证 reservation 未关闭后 append reservation-activated。
 *   · activated —— 已 append（或已存在 activated，幂等）。
 *   · already-terminal —— reservation 已被 recovery/结算关闭，或 activate 锁内发现 TTL 已严格过期并
 *     原子关闭（reserve→activate 之间的竞态/慢 preparation），不追加晚到 activation。
 * ledger I/O 故障（read/append/fsync/lock）throw typed error（调用方 fail-loud，绝不进 running）。
 */
export type ActivateResult = { readonly status: 'activated' } | { readonly status: 'already-terminal' }

/** 结算入参（scheduler 在 terminal CAS 后调 settleWon 关闭 reservation）。 */
export interface RunSettlement {
  readonly result: RunRecord['result']
  readonly reason?: RunRecord['reason']
  readonly startedAt?: string
  readonly verify?: { readonly result: 'pass' | 'fail' }
  /**
   * H7 verifier Phase 2：host/human 签发的结构化 verdict（lifecycle 经 VerifierPort 产出、scheduler
   * 经 evaluateVerificationGate 判定后原样透传）。settleWon 只持久化——不在 ledger 锁里跑 verifier、
   * 不重新判定。缺席 = 未做结构化核验的旧调用点（run 仍只落自报 verify，向后兼容）。
   */
  readonly verification?: VerificationResult
  readonly artifacts?: { readonly buildSha?: string; readonly branch?: string; readonly commitShas: readonly string[] }
  /** 有真跑但无可信 provider usage → 'reserved-estimate'（按预占保守扣账）；skip/no-op/claim-lost → 'none'（扣 0）。 */
  readonly charge: 'reserved-estimate' | 'none'
  readonly error?: { readonly cause: string; readonly message: string }
  readonly workflowRunId?: string
  /**
   * H10 §3/§8任务3：本次 run 消费的 skill bundle 快照聚合 hash（= 对应
   * `SkillBundleSnapshotRecord.snapshot_sha256`）。settleWon 据此写入终态 `RunRecord.
   * skill_bundle_snapshot_sha256`，供查询快速关联而不必回查 skill-bundle-snapshot 记录本身。
   * 只有走过 `prepareSkillBundle` 成功路径（`ctx` 是 `PreparedExecutionContext`）的 settle 才应
   * 携带；claim-lost/kill-switch 等从未 prepare 的路径缺省不传，终态该字段保持缺席（语义等价旧行）。
   */
  readonly skillBundleSnapshotSha256?: string
}

/** lifecycle 在 commit-tree 后、ref CAS 前交给 admission ledger 的完整 intent 输入。 */
export interface MergeIntentJournalInput {
  readonly context: PreparedExecutionContext
  readonly baseRef: string
  readonly baseBefore: string
  readonly branchRef: string
  readonly branchTip: string
  readonly mergedCommit: string
  readonly verification?: VerificationResult
  readonly verifyResult: 'pass' | 'fail'
  readonly buildSha?: string
  readonly branch: string
  readonly commitShas: readonly string[]
}

/** ref CAS 后的 landed receipt；同 intent 可追加更新的 host sync 状态，projection 取最新。 */
export interface MergeLandedJournalInput {
  readonly context: PreparedExecutionContext
  readonly intentRecordId: string
  readonly baseRef: string
  readonly baseBefore: string
  readonly branchTip: string
  readonly mergedCommit: string
  readonly hostSynced: boolean
  readonly hostSyncError?: string
}

export interface RecoveredMergeState {
  readonly cause: 'host-sync-pending' | 'merge-journal-pending' | 'completed'
  readonly message: string
}

export interface LoopAdmission {
  /**
   * 原子 preflight（governance 锁 + ledger 锁内重读 registry+ledger → epoch 复验 → 判定 → append reservation + fsync）。
   * `expectedLoopId` 只是 selector 已观察到的自然归属：锁内必须重新按最新 durable binding/前缀解析，
   * 仅在仍相等时放行；它绝不是能覆盖 durable binding 的显式归属指令。
   */
  reserve(change: string, opts?: {
    expectedLoopId?: string
    /** null=调用方显式覆盖 level；L1/L2/L3=selector 观察到的 loop 默认值，锁内必须仍相等。 */
    expectedAutonomyLevel?: AutomationLevel | null
  }): Promise<ReserveResult>
  /** 最终的权限事实重读，随后立刻做 queued→scheduled claim；项目层只读任务冻结计划里所选分支的 automation。 */
  claimWithFreshWorkflowAuthority?(
    ctx: ExecutionContext,
    claim: (expectedTrackId: string) => Promise<boolean>,
  ): Promise<ClaimAuthorizationResult>
  /** Versioned scheduler capability. Its absence is preflighted before reserve, never after it. */
  readonly workflowAuthorityClaim?: WorkflowAuthorityClaimCapabilityV1
  /** claim 成功后 ledger 锁内验证 reservation 未关闭且未过 expires_at → append reservation-activated。
   *  已关闭或 TTL 已过期并在锁内幂等关闭 → already-terminal（不追加晚到 activation）；ledger I/O
   *  故障 → throw（调用方 fail-loud，不进 running）。 */
  activate(ctx: ExecutionContext): Promise<ActivateResult>
  /** Codex provider JSONL 用量事实；同 attempt 同值重放幂等，冲突值 fail-closed。 */
  recordProviderUsage(ctx: ExecutionContext, usage: ProviderStructuredUsage): Promise<string>
  /** 结算：closeReservationIfOpen 幂等关闭（commit marker）；already-closed 是成功幂等结果、不双扣；I/O 故障 → throw。 */
  settleWon(ctx: ExecutionContext, settlement: RunSettlement): Promise<void>
  /** claim 输掉：幂等关闭 reservation，扣账 0（result=skipped/reason=claim-lost）。 */
  settleLost(ctx: ExecutionContext): Promise<void>
  /** commit-tree 后、ref CAS 前 fsync intent；返回 landed 关联所需 record_id。 */
  recordMergeIntent(input: MergeIntentJournalInput): Promise<string>
  /** ref CAS 后 fsync receipt；同 intent 可先记 landed、再记最终 host sync 结果。 */
  recordMergeLanded(input: MergeLandedJournalInput): Promise<void>
  /** kill-switch 重查：loop 此刻是否仍 active（claim 后 running 前 / terminal settle 前调）。仅展示/保守终态修正，不用于「检查后行动」。 */
  isActive(loopId: string): Promise<boolean>
}

export interface WorkflowAuthorityClaimCapabilityV1 {
  readonly version: 'v1'
  claim(
    ctx: ExecutionContext,
    claimState: (expectedTrackId: string) => Promise<boolean>,
  ): Promise<ClaimAuthorizationResult>
}

export interface ConfiguredLoopAdmission extends LoopAdmission {
  claimWithFreshWorkflowAuthority(
    ctx: ExecutionContext,
    claim: (expectedTrackId: string) => Promise<boolean>,
  ): Promise<ClaimAuthorizationResult>
  readonly workflowAuthorityClaim: WorkflowAuthorityClaimCapabilityV1
}

export interface LoopAdmissionDeps {
  readonly repoRoot: string
  readonly ledger: LoopLedgerStore
  /**
   * 载入 loops registry（真跑注入 `loadRegistry(root, nodeLoopIoStrict)`；测试注入 fake）。契约（Stage B 返工 #2）：
   * 文件不存在 → {data:null, errors:[]}（合法「无 registry」denial）；解析/schema 失败 → {data:null, errors:[…]}；
   * **真实 I/O 故障（EACCES/EIO/EISDIR…）→ throw**（RegistryReadError）——reserve 让其上抛成 round failure
   * （ok=false），绝不吞成「文件不存在」denial（round 假 ok=true）。isActive 则 catch 成 fail-closed。
   */
  readonly loadRegistry: (repoRoot: string) => { data: LoopRegistry | null; errors: string[] }
  readonly clock: () => string
  /** 本次 round 的分级放权档（写进 ExecutionContext.level / RunRecord.level）。 */
  readonly level: AutomationLevel
  /** 沙箱镜像（写进 ExecutionContext.image）。 */
  readonly image?: string
  /** reserve→activate 窗口（未 activate 的预占超此可在 ledger 锁外先修复 change state、再关闭扣 0）。缺省 10 分钟。 */
  readonly reservationTtlMs?: number
  /** 读某 change 当前 automation 态（recover 判 activated 预占对应 automation 是否 terminal）。 */
  readonly getAutomation: (change: string) => Promise<string>
  /** 运行存活探针（#5 orphan reconcile）：CLI 真跑注入 docker 实现（container 明确不存在 → 'dead'）、
   *  测试注入 fake、server/SDK 无实现 → 'unknown'。缺省 'unknown'（保守不擅自关闭 orphan）。 */
  readonly getExecutionLiveness?: (change: string) => Promise<ExecutionLiveness>
  /** owner CAS scheduled→queued（#5 orphan 明确 dead 时复位；#6 activation 补偿也复用）：成功返 true。
   *  缺省 no-op 返 false（无 store 写面 → 保守不恢复）。 */
  readonly resetScheduledToQueued?: (change: string) => Promise<boolean>
  /** running→failed/queued CAS（#5 orphan 明确 dead 时按 retry policy 落终态）：成功返 true。缺省 no-op 返 false。 */
  readonly failRunningToTerminal?: (change: string) => Promise<boolean>
  /** crash recovery 读取 ref 的真实值；缺席时只信 durable merge-landed，不猜 ref。 */
  readonly readGitRef?: (ref: string) => Promise<string>
  /**
   * crash recovery 的明确 commit ancestry probe：两个入参均为已解析的 commit SHA，
   * `true` 表示 ancestorCommit 已被证明为 descendantCommit 的祖先，`false` 表示不是。
   * 命令/I/O 无法得出布尔结论时必须 throw，调用方会保守保留 reservation。
   */
  readonly isCommitAncestor?: (ancestorCommit: string, descendantCommit: string) => Promise<boolean>
  /** 物理 merge 已确认后，把任何旧 automation 态原子修复为 merged；成功 resolve，失败 throw。 */
  readonly commitRecoveredMerge?: (change: string, state: RecoveredMergeState) => Promise<void>
  /** 唯一 id 生成器（缺省 makeIdGen()；测试可注入确定性序列）。 */
  readonly newId?: (prefix: string) => string
  /**
   * H10 §1/§5：skill bundle profile 存在性校验（词法已由 registry 的 `SKILL_BUNDLE_ID_RE` 保证；
   * 这里判定该具名 profile 是否真的在当前 manifest/track 声明域内）。`'_all'` 无需调用本函数——
   * 设计定稿 §1 明确其属于合法键空间，是内建的全量退路，不依赖任何具体 track 声明。
   *
   * 三态处置（不是二元 fail-closed 兜底）：
   *   · 具名 profile + 本函数返回 `false` → 真正的 `skill-bundle-profile-not-found`（admission
   *     denial，action=pause-loop——持久 wiring 错误）。
   *   · 具名 profile + 未注入本函数 → **不是** "profile 不存在"，是「校验能力尚未装配」（H10
   *     生产装配见任务7）——throw `SkillProfileValidatorUnconfiguredError`（fail-closed 拒绝放行/
   *     建 reservation，但绝不把"未装配"污染成一条虚假的 profile-not-found 治理事实，也绝不暂停
   *     loop——loop 本身的 bundle 配置可能完全合法，只是当前运行时缺一个校验器）。
   *   · `'_all'` → 恒真，不调用本函数（即便未注入也放行）。
   */
  readonly isSkillProfileKnown?: (profileId: string) => boolean
  /** Production bridge to the canonical WorkflowRun; invoked after reservation locks are released. */
  readonly bindAutomationPolicy?: (
    change: string,
    policy: AutomationPolicySnapshot,
    binding: { readonly loopId: string; readonly iterationId: string },
  ) => Promise<{
    readonly id: string; readonly automationPolicy?: AutomationPolicySnapshot
    readonly loopId?: string; readonly iterationId?: string
    readonly workflowId?: string
    readonly workflowPlanFingerprint?: string
    readonly workflowPlanSnapshot?: WorkflowPlanSnapshot
  }>
  /** Kernel-owned durable per-attempt authority binding; required before the state claim. */
  readonly bindWorkflowActionAuthority?: (
    change: string,
    snapshot: WorkflowActionAuthoritySnapshotV1,
  ) => Promise<{
    readonly id: string
    readonly workflowId?: string
    readonly workflowPlanFingerprint?: string
    readonly loopId?: string
    readonly iterationId?: string
    readonly workflowActionAuthority?: WorkflowActionAuthoritySnapshotV1
  }>
  /**
   * Fresh non-Workflow authorization facts (platform / skill / run + the track the change records).
   * The service derives the Workflow and Project layers only from the immutable WorkflowRun snapshot
   * (interaction ceiling and the selected branch's `automation`), so callers cannot replace either
   * frozen layer through this port.
   */
  readonly workflowActionAuthority?: (input: {
    readonly change: string
    readonly context: ExecutionContext
    readonly run: {
      readonly id: string
      readonly workflowId?: string
      readonly workflowPlanFingerprint?: string
      readonly workflowPlanSnapshot?: WorkflowPlanSnapshot
      readonly loopId?: string
      readonly iterationId?: string
    }
  }) => Promise<WorkflowActionAuthorityFacts>
}

/** 运行存活（#5）：'dead' 才可 reconcile 关闭 orphan；'alive'/'unknown' 一律保守保留占 in-flight。 */
export type ExecutionLiveness = 'alive' | 'dead' | 'unknown'

/** daemon 仍持有（非 terminal）的 automation 态——recover 见这两态视 activated 预占为「真在途/orphan」，不恢复。 */
export const DAEMON_OWNED = new Set(['scheduled', 'running'])
export const DEFAULT_TTL_MS = 10 * 60 * 1000
/** reserve 遇 epoch 变化的最大整轮重试次数（避免活锁；连续变化 → registry-concurrent-update denial）。 */
export const MAX_RESERVE_RETRIES = 3

/** automation terminal 态 → RunRecord.result（recover 无 usage，按 reserved-estimate 扣账，reason=recovered）。 */
export function terminalToResult(automation: string): RunRecord['result'] {
  switch (automation) {
    case 'merged': return 'merged'
    case 'paused': return 'paused'
    case 'conflict': return 'conflict'
    case 'failed': return 'failed'
    case 'queued': return 'retry-queued'
    default: return 'skipped' // off / 未知
  }
}

/** H2：只从同一 loop/change 的 durable terminal RunRecord 构造下一次 runner context。 */
export function attemptContextFor(
  records: readonly LedgerRecord[],
  loopId: string,
  change: string,
): AttemptContextLedgerSnapshot {
  const runs = records.filter(
    (record): record is RunRecord => record.kind === 'run' && record.loop_id === loopId && record.change === change,
  )
  const built = buildAttemptContext(runs.map((run) => ({
    attempt_id: run.attempt_id,
    loop_id: run.loop_id,
    change: run.change,
    result: run.result,
    recorded_at: run.finished_at,
    ...((run.error?.message ?? (run.reason === undefined || run.reason === 'completed' ? undefined : run.reason)) === undefined
      ? {}
      : { detail: run.error?.message ?? run.reason }),
  })), { tail: 3, maxChars: 6_000, stagnationThreshold: 3 })
  return {
    source_run_record_ids: runs.map((run) => run.run_record_id),
    omitted_attempt_ids: [...built.omittedAttemptIds],
    rendered: built.rendered,
    stagnation: {
      stagnant: built.stagnation.stagnant,
      ...(built.stagnation.fingerprint === undefined ? {} : { fingerprint: built.stagnation.fingerprint }),
      repeated_attempt_ids: [...built.stagnation.repeatedAttempts],
    },
  }
}
