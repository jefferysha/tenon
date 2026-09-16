/**
 * WorkflowRun / TransitionRecord —— W1 第二个可交付单元的持久化提交接缝（codex 范围评估
 * 2026-07-16：narrow「扩大 withLock」不足以称为「状态与 audit 原子提交」——.pipeline.yaml 与
 * .pipeline-history.jsonl 是两个文件，历史写失败时 state 已提交，进程在两次写之间崩溃仍会撕裂；
 * review marker 是项目根的短时 v2 projection、canonical approval receipt 则在 change state；不同
 * change 不共享 marker。 本增量建立稳定 run 身份 +
 * canonical TransitionRecord + 真正的状态/audit 提交点，但**明确停在唯一 TransitionApplication
 * 之前**——CLI/server 仍各自维护 default/custom 的转换规划逻辑，只是提交方式改为共同调用
 * WorkflowRunRepository.transact。
 *
 * 字段刻意从简：只收录当前有可信来源的字段，没有可信来源的（workflowVersion——workflow schema
 * 没有版本；policyId/policyVersion/iterationId/loopId——W5 才有真实绑定；goal/budget/skill
 * bundle——同理）本增量不填 null 或假字符串，等对应工作包真正接线时再加。
 */
import type {
  DocumentProfileId, FieldName, InitOptions, PipelineState, StateWriteResult,
} from '../types.js'
import type { AutomationPolicySnapshot } from '../loops/automation-policy.js'
import type { WorkflowPlanSnapshot } from './effective-plan.js'
import type { WorkflowActionAuthoritySnapshotV1 } from './action-authority-types.js'

export interface WorkflowRun {
  /** 稳定 run 身份：新 change 在 init 时生成；已存在但缺身份的老 change 在首次经
   * WorkflowRunRepository.transact 提交时于同一把锁内生成——不用 change 名/路径/时间戳冒充。 */
  readonly id: string
  /** fields.workflow 的诚实回显（空值按既有规则解析为 'default'），不是独立校验过的 schema 引用。 */
  readonly workflowId: string
  /** fields.phase（或非 default workflow 下的当前 step id）。 */
  readonly currentStep: string
  /** 只能诚实表达 archived==='true' ? 'archived' : 'active'——'completed'/'failed'/'cancelled'
   * 目前没有统一的 run 级来源（phase_status=failed 不等于整个 run 失败），本增量不引入。 */
  readonly lifecycle: 'active' | 'archived'
  readonly transitionSequence: number
  /** 最新一条已提交 TransitionRecord 的 id；尚未发生过任何 canonical transition 时为 undefined
   * （新 init 的 change 有 run 身份但还没有 transition 记录，这是合法的中间态，不是缺陷）。 */
  readonly transitionHead?: string
  readonly documentProfile?: DocumentProfileId
  readonly documentGovernanceFingerprint?: string
  readonly workflowPlanFingerprint?: string
  readonly workflowPlanSnapshot?: WorkflowPlanSnapshot
  readonly createdAt: string
  readonly updatedAt: string
  /** Governed runs carry the exact immutable policy used by admission and execution. */
  readonly automationPolicy?: AutomationPolicySnapshot
  /** H9：governed run 显式身份；legacy/non-governed run 可缺席。 */
  readonly policyId?: string
  readonly policyVersion?: string
  readonly loopId?: string
  readonly iterationId?: string
  /** Current iteration's immutable effective authorization; absent on legacy or not-yet-admitted runs. */
  readonly workflowActionAuthority?: WorkflowActionAuthoritySnapshotV1
}

/** 一次 transition 对 PipelineState.fields 造成的真实字段级改动（diff 出来的，不是猜的）。 */
export interface StateFieldEffect {
  readonly kind: 'state-field-change'
  readonly field: FieldName
  readonly from: string | readonly string[]
  readonly to: string | readonly string[]
}

export interface TransitionRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly runId: string
  /** H9 governed identity snapshot at this immutable audit commit; legacy/non-governed records omit it. */
  readonly policyId?: string
  readonly policyVersion?: string
  readonly loopId?: string
  readonly iterationId?: string
  readonly sequence: number
  /** 单向链：上一条已提交记录的 id；第一条记录没有 previous。 */
  readonly previousRecordId?: string
  readonly workflowId: string
  readonly event: string
  readonly from: string
  readonly to: string
  readonly effects: readonly StateFieldEffect[]
  /** Declared operator as a user ref `Name <id>` (`formatUserRef`). It stays a string so released readers of
   * the record chain keep validating; records committed before identity existed omit it. */
  readonly actor?: string
  readonly observedAt: string
}

/** 调用方（CLI/server 的 default 或 custom 轨）描述"这次转换发生了什么"，repository 据此
 * 生成 TransitionRecord 并原子提交——effects 由 repository 自己 diff 前后 fields，不由调用方
 * 猜测传入（避免两处各自实现一份 diff 逻辑再悄悄漂移）。 */
export interface TransitionDraft {
  readonly event: string
  readonly from: string
  readonly to: string
  readonly actor?: string
}

export interface CommitResult {
  readonly run: WorkflowRun
  readonly record: TransitionRecord
  /** canonical commit 后 YAML adapter 的 best-effort 状态；pending 不回滚已提交 revision。 */
  readonly projection: StateWriteResult['projection']
}

export interface WorkflowRunTransaction {
  readonly run: WorkflowRun
  /** transact() 锁内读到的完整 state（含 opaqueTail）——直接喂给 DefaultEventPolicy guard/action、
   * flow.transition、planStepTransition 等既有 kernel 规划函数，调用方不必重新拼装。repository 保证
   * 这是一份深拷贝，调用方原地改它不会污染 commit() 内部用于 diff 出 effects 的"改动前"快照
   * （G1 第二增量 codex review 抓到的真实风险：若 state 与内部快照共享引用，原地改字段会让
   * effects 变空或不完整）。 */
  readonly state: PipelineState
  /**
   * 提交本次转换：原子写不可达孤儿风险隔离的 TransitionRecord，随后发布绑定 record digest 的
   * 完整 revision，并以 current.json rename 同时提交新 fields 与推进的 run 元数据。一次 transaction 内只能调用一次——
   * 重复调用抛错，防止调用方在收尾逻辑里误触发第二次提交。
   *
   * 只接收 nextFields（不是完整 PipelineState）：opaqueTail 恒由 repository 复用本次 transact
   * 读到的原值、runMetadata 恒由 repository 自己推进——调用方结构上就没有机会传入这两者，
   * 不存在"要不要静默丢弃调用方输入"这个问题（第二轮 review 指出 nextState 形状会诱发这个
   * 决策，直接从类型上消灭比事后校验更彻底）。
   */
  commit(nextFields: Record<FieldName, string | string[]>, draft: TransitionDraft): Promise<CommitResult>
}

export interface WorkflowRunRepository {
  transact<T>(changeDir: string, fn: (tx: WorkflowRunTransaction) => Promise<T>): Promise<T>
  /**
   * 新 change 的唯一创建入口（W1 第二增量第五轮 codex review：必须修 #1 的最终形态）——
   * 身份随 canonical revision 0/current 的独占创建一次性写入，不是"先 init 再补一次 write"两步：
   * 两步之间有竞态窗口（期间并发的 transact() 会看到一个临时生成、永不持久化的 id），且第二步
   * 失败若被调用方吞掉，"新 change 身份已钉死"这条保证就名不副实。CLI/server 的 change 创建
   * 命令应改调这个方法，不要再分别调 store.init() 与 establishRun()。
   */
  initChange(opts: InitOptions): Promise<{ changeDir: string; run: WorkflowRun }>
  /**
   * 老 change（在 initChange 这个方法存在之前创建、缺 runMetadata）的显式升级入口：钉死稳定
   * run 身份，不等第一次 commit。幂等：change 已有 runMetadata 时原样返回，不重新生成、不
   * 重复落盘。不是一次 transition，不产生 TransitionRecord，只新增 runMetadata。新 change
   * 应该走 initChange，不需要再调这个方法。
   */
  establishRun(
    changeDir: string,
    governance?: {
      readonly openspecContract?: boolean
      readonly documentContract?: boolean
      readonly documentProfile?: DocumentProfileId
      readonly documentGovernanceFingerprint?: string
      readonly workflowPlanFingerprint?: string
    },
  ): Promise<WorkflowRun>
  /** Policy/loop are immutable; rebinding the same run to a later iteration advances its current pointer. */
  bindAutomationPolicy(
    changeDir: string,
    policy: AutomationPolicySnapshot,
    binding?: { readonly loopId: string; readonly iterationId: string },
  ): Promise<WorkflowRun>
  /** Persist an exact per-attempt authority snapshot before state claim; exact replay is idempotent. */
  bindWorkflowActionAuthority(
    changeDir: string,
    snapshot: WorkflowActionAuthoritySnapshotV1,
  ): Promise<WorkflowRun>
}
