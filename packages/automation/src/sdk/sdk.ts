/**
 * 对外 SDK（BACKLOG #29）—— AFK 自动化的编排入口。
 *
 * 老仓真相源：sdk/src/{createSandbox,run}.ts（编排入口）+ scheduler/main.ts（daemon 装配）。
 * lite 把队列面收敛成 3 个动词：enqueue（挂队）/ scanReady（就绪扫描）/ runRound（跑一轮）。
 *
 * 全部经 @tenon/kernel StateStore 真读写 change 的 automation_* 字段（只 import 不改 kernel）。
 * 默认 L1 report-only（成功停 paused，不自动 merge）——GOAL A5 安全默认。
 */
import { join } from 'node:path'
import {
  createLoopLedgerStore,
  loadRegistry,
  type StateStore,
  type TrackPolicyProfile,
} from '@tenon/kernel'
import { readAutomationJson, type AutomationJsonFs } from '../config/automationJson.js'
import {
  createLoopAdmission,
  type LoopAdmission,
  type LoopAdmissionDeps,
} from '../admission/loop-admission.js'
import { markNonLoopPrepared, type ExecutionContext, type ExecutionPreparationPort, type PrepareOutcome } from '../admission/execution-context.js'
import { claim, commitFailureOwned, getAutomation, markQueued, setAutomationOwned, setAutomationOwnedWithFields } from '../queue/claim.js'
import { shouldEnqueueOnSpecComplete } from '../queue/gate.js'
import { scanReadyFromFs } from '../queue/scan.js'
import {
  createScheduler,
  type ExecutionWiringValidationResult,
  type RegisterShutdown,
  type RoundReport,
  type RunChange,
  type StateWriter,
} from '../scheduler/scheduler.js'
import { type AutomationConfig, DEFAULT_CONFIG } from '../types.js'
import {
  createAfkSkillInvocationLifecycle,
  type AfkInteractionReceiptPort,
} from '../skillInvocationAfkLifecycle.js'

/**
 * 二次任务（queued 卡死回归修复）：createAutomation 未显式注入 `deps.preparation` 时的缺省
 * `ExecutionPreparationPort`——比照 `deps.admission` 的既有缺省装配惯例（第 82 行下方），不再让
 * `SchedulerDeps.preparation` 缺席、不再触发 scheduler.ts::runRoundOnce 的整轮 config 短路。
 *
 * 两条分支严格对齐 execution-context.ts 头注的语义划分：
 *   · `ctx.skill_bundle_id` 缺席/null（无 bundle 绑定——非 loop 的 AFK 直跑，或本包所有既有 fake
 *     admission 测试 context）→ 直通产出不带 `skillBundle` 的 PreparedExecutionContext（不物化
 *     CAS、不写 ledger 事件），绝不整轮短路、绝不 pause。
 *   · `ctx.skill_bundle_id` 有值（真实 loop-admission reserve() 产出、bundle 绑定的 context）→
 *     本缺省装配不解析/物化 bundle：那需要 resolver、locator 与 `ExecutionCoordinatePort`（捕获当前
 *     workflow 坐标），由调用方用 `createExecutionPreparation` 装配后经 `deps.preparation` 注入——
 *     生产入口 `tenon afk run` / `tenon loops run` 在 packages/cli/src/commands/afk-executor.ts 就是
 *     这样注入的。故缺省装配 throw 一个 config 类错误（fail-loud，按候选粒度——只有这一个
 *     candidate 的 handleOne 被打断，其余候选不受影响，见 scheduler.ts::handlePreparationThrow）；
 *     镜像 loop-admission.ts::SkillProfileValidatorUnconfiguredError 对「装配缺口 vs 业务判定」的
 *     既有区分：不伪装成某个 `PreparationFailureReason` 业务结论持久化，也不静默放行当作已 prepare。
 */
export class SkillBundlePreparationUnconfiguredError extends Error {
  readonly _tag = 'SkillBundlePreparationUnconfiguredError'
  constructor(message: string) { super(message); this.name = 'SkillBundlePreparationUnconfiguredError' }
}

/** 见上方 SkillBundlePreparationUnconfiguredError 头注——createAutomation 的默认 preparation 装配。 */
export const createDefaultExecutionPreparation = (): ExecutionPreparationPort => ({
  async prepare(ctx: ExecutionContext): Promise<PrepareOutcome> {
    if (ctx.skill_bundle_id === null || ctx.skill_bundle_id === undefined) {
      // H10 r1 阻断3/D5 返工（任务B1）：唯一合法构造点是 markNonLoopPrepared()（判别联合的
      // non-loop 分支），不再手写字面量冒充满足 PreparedExecutionContext。
      return { ok: true, context: markNonLoopPrepared(ctx) }
    }
    throw new SkillBundlePreparationUnconfiguredError(
      `change「${ctx.change}」归属 loop「${ctx.loop_id}」的 skill_bundle_id="${ctx.skill_bundle_id}"（bundle 绑定）` +
      '需要 skill bundle 解析/CAS 物化依赖（resolver/locator/coordinates）；本次 createAutomation ' +
      '没有注入 deps.preparation（用 createExecutionPreparation 装配后注入）——fail-closed，不放行、不伪造业务判定',
    )
  },
})

export interface AutomationDeps {
  readonly repoRoot: string
  readonly store: StateStore
  readonly clock: () => string
  /** 部分配置覆盖；缺省保持 DEFAULT_CONFIG 的 fail-safe OFF。 */
  readonly config?: Partial<AutomationConfig>
  /** automation.json 读取的 fs 注入面（测试用）；缺省真 node fs。 */
  readonly configFs?: AutomationJsonFs
  /**
   * GOAL H · Stage C：loop admission 权威闸门（缺省由本 repoRoot/store/clock/level + createLoopLedgerStore
   * + kernel loadRegistry 装配）。测试注入 fake 断言编排；afk.ts 注入携带 image/自定义时钟的实例。
   */
  readonly admission?: LoopAdmission
  /** Canonical WorkflowRun policy binding used only by the default admission wiring. */
  readonly bindAutomationPolicy?: LoopAdmissionDeps['bindAutomationPolicy']
  /** Kernel-owned immutable effective authority snapshot binding used by default admission. */
  readonly bindWorkflowActionAuthority?: LoopAdmissionDeps['bindWorkflowActionAuthority']
  /** Holds the exact TrackRegistry snapshot through final authority resolution and state claim. */
  readonly withWorkflowActionAuthorityLock?: LoopAdmissionDeps['withWorkflowActionAuthorityLock']
  /** Fresh non-Workflow permission layers used only by the default admission wiring. */
  readonly workflowActionAuthority?: LoopAdmissionDeps['workflowActionAuthority']
  /** ExecutionContext.image（写进 reservation 快照的沙箱镜像）；缺省 admission 装配点透传。 */
  readonly image?: string
  /** on_exceed=pause-loop 时把 loop status 改 paused（缺省无 → 降级 skip-run + 记 report）。 */
  readonly pauseLoop?: (loopId: string) => Promise<void>
  /** H11：reserve 后、claim 前 fresh 完整 wiring 闸；生产 CLI 注入共享 evaluator。 */
  readonly validateExecutionWiring?: (
    context: ExecutionContext,
  ) => Promise<ExecutionWiringValidationResult>
  /**
   * 二次任务（queued 卡死回归修复）：claim 后、activate 前的 prepareSkillBundle 编排口（缺省
   * createDefaultExecutionPreparation()，见其头注）。真实 loop-bundle 全依赖装配由生产调用方
   * 在此注入替换；测试可注入 fake 断言编排（同 deps.admission 既有惯例）。
   */
  readonly preparation?: ExecutionPreparationPort
  /** Process/runtime shutdown registration. Production defaults to SIGINT/SIGTERM with async drain. */
  readonly registerShutdown?: RegisterShutdown
  /** Verified PR3 InteractionPolicy receipts; absence means AFK records no synthetic default. */
  readonly interactionReceipts?: AfkInteractionReceiptPort
}

const registerProcessShutdown: RegisterShutdown = (teardown) => {
  let active = true
  const handle = (): void => {
    if (!active) return
    active = false
    process.off('SIGINT', handle)
    process.off('SIGTERM', handle)
    void Promise.resolve(teardown()).catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGINT', handle)
  process.once('SIGTERM', handle)
  return () => {
    active = false
    process.off('SIGINT', handle)
    process.off('SIGTERM', handle)
  }
}

/**
 * automation 的有效配置唯一装配点。手动 enqueue、spec-complete 自动入队与调度器必须看到
 * 同一份优先级：调用方显式注入 > 项目 automation.json > SDK 的安全可用默认值。
 */
export function resolveAutomationConfig(
  deps: Pick<AutomationDeps, 'repoRoot' | 'config' | 'configFs'>,
  entrypointDefaults: Partial<AutomationConfig> = {},
): AutomationConfig {
  const { image: _image, ...fileCfg } = readAutomationJson(deps.repoRoot, deps.configFs)
  return { ...DEFAULT_CONFIG, ...entrypointDefaults, ...fileCfg, ...deps.config }
}

/** H14 real-run 选择器落地后的单个目标；owner 是观察值，admission 会在锁内重新解析并复核。 */
export interface TargetedRunCandidate {
  readonly change: string
  readonly expectedLoopId: string
  /** selector 的默认 autonomy 快照；null 表示用户显式 --level 覆盖，不做默认值 CAS。 */
  readonly expectedAutonomyLevel: AutomationConfig['level'] | null
}

export interface Automation {
  /**
   * 挂队：读 change.track → 由调用者从当前项目 effective registry 解析 policy →
   * off→queued + queued_at。resolver 对 orphan/损坏 registry 的异常原样 fail-loud。
   */
  enqueue(name: string, resolveTrackPolicy: (trackId: string) => TrackPolicyProfile): Promise<boolean>
  /** 就绪扫描：真扫 openspec/changes/* 的 build+queued+deps 满足集（FIFO）。 */
  scanReady(): Promise<string[]>
  /** 跑一轮：scanReady → 逐 change admission.reserve + claim + runChange(context) + 分级 settle
   *  + 关闭 reservation。返回结构化 RoundReport（CLI 据 ledger/admission failure 返非零）。 */
  runRound(runChange: RunChange): Promise<RoundReport>
  /** fresh scan 后仅执行仍 ready 且被点名的 change；ready FIFO 是唯一执行顺序真相源。 */
  runTargeted(targets: readonly TargetedRunCandidate[], runChange: RunChange): Promise<RoundReport>
  /** 当前生效配置（含 level）。 */
  readonly config: AutomationConfig
}

const scalar = (v: string | string[] | undefined): string => (typeof v === 'string' ? v : '')

/** 把 kernel StateStore 适配成 scheduler 的 StateWriter port（每个方法定位到 changeDir(name)）。 */
export const storeWriter = (store: StateStore, changeDir: (name: string) => string): StateWriter => ({
  claim: (name, expectedTrackId, expectedRun) =>
    claim(store, changeDir(name), expectedTrackId, expectedRun),
  setAutomation: (name, s) => store.set(changeDir(name), 'automation', s),
  setField: (name, field, value) => store.set(changeDir(name), field as never, value),
  commitFailureOwned: (name, input) => commitFailureOwned(store, changeDir(name), input),
  getAutomation: (name) => getAutomation(store, changeDir(name)),
  setAutomationOwned: (name, next) => setAutomationOwned(store, changeDir(name), next),
  setAutomationOwnedWithFields: (name, next, fields) => setAutomationOwnedWithFields(store, changeDir(name), next, fields),
  markFailedSync: (name, reason) => {
    // shutdown 同步 best-effort：无法 await，fire-and-forget（错误吞掉）。
    // F-b 同写纪律：cause 同批落空串——中断 reason 是自由文本（非 tag，无法干净定成因），空串交
    // 读取端 regex 兜底；覆盖式写掉上一轮残留 cause，防与新 last_error 撕裂。
    void store.setMany(changeDir(name), { automation: 'failed', automation_last_error: reason, automation_cause: '' }).catch(() => {})
  },
})

export function createAutomation(deps: AutomationDeps): Automation {
  // T21 装配优先级：显式 deps.config > <root>/.pipeline/automation.json > DEFAULT_CONFIG。
  // 文件里的 image 归 dockerRunChange 装配点消费（cli/commands/afk.ts）。
  // Constructing the execution SDK is itself an explicit operator/runtime entrypoint. Preserve
  // manual AFK behavior here; lifecycle callbacks call resolveAutomationConfig directly and
  // therefore remain fail-safe unless the project-level enabled/default_opt_in switches are set.
  const config = resolveAutomationConfig(deps, { enabled: true, defaultOptIn: true })
  const { store, clock } = deps
  const changesDir = join(deps.repoRoot, 'openspec', 'changes')
  const changeDir = (name: string): string => join(changesDir, name)

  // GOAL H · Stage C：admission 权威闸门（缺省装配——ledger store + kernel registry + 本 store 读
  // automation 态供崩溃恢复）。afk.ts 可注入携带 image/自定义时钟的实例。
  const admission: LoopAdmission = deps.admission ?? createLoopAdmission({
    repoRoot: deps.repoRoot,
    ledger: createLoopLedgerStore(),
    loadRegistry: (root) => loadRegistry(root),
    clock,
    level: config.level,
    image: deps.image,
    getAutomation: (change) => getAutomation(store, changeDir(change)),
    bindAutomationPolicy: deps.bindAutomationPolicy,
    bindWorkflowActionAuthority: deps.bindWorkflowActionAuthority,
    withWorkflowActionAuthorityLock: deps.withWorkflowActionAuthorityLock,
    workflowActionAuthority: deps.workflowActionAuthority,
  })
  // 二次任务（queued 卡死回归修复）：路由 SchedulerDeps.preparation——缺省 createDefaultExecutionPreparation()
  // （none-bundle 直通 + bundle 绑定 fail-loud，见其头注），不再让 runRound 因 preparation 缺席整轮短路成
  // config RoundFailure；显式 production preparation 与安全缺省都经同一字段传给 createScheduler。
  const preparation: ExecutionPreparationPort = deps.preparation ?? createDefaultExecutionPreparation()
  const skillInvocations = createAfkSkillInvocationLifecycle(changeDir, deps.interactionReceipts)
  const schedulerFor = (runChange: RunChange) => createScheduler({
    state: storeWriter(store, changeDir),
    runChange,
    registerShutdown: deps.registerShutdown ?? registerProcessShutdown,
    config: { maxParallel: config.maxParallel, maxRetries: config.maxRetries, level: config.level },
    admission,
    preparation,
    pauseLoop: deps.pauseLoop,
    validateExecutionWiring: deps.validateExecutionWiring,
    skillInvocations,
  })

  return {
    config,
    async enqueue(name, resolveTrackPolicy) {
      const state = await store.read(changeDir(name))
      const policy = resolveTrackPolicy(scalar(state.fields.track))
      const eligible = shouldEnqueueOnSpecComplete({
        enabled: config.enabled,
        automationEligible: policy.automationEligible,
        automation: scalar(state.fields.automation),
        defaultOptIn: config.defaultOptIn,
      })
      if (!eligible) return false
      await markQueued(store, changeDir(name), clock)
      return true
    },
    scanReady() {
      return scanReadyFromFs(changesDir, store)
    },
    async runRound(runChange) {
      const candidates = await scanReadyFromFs(changesDir, store)
      return schedulerFor(runChange).runRoundOnce(candidates)
    },
    async runTargeted(targets, runChange) {
      const ready = await scanReadyFromFs(changesDir, store)
      const expectedLoopIdByChange = new Map<string, string>()
      const expectedAutonomyLevelByChange = new Map<string, AutomationConfig['level'] | null>()
      for (const target of targets) {
        const prior = expectedLoopIdByChange.get(target.change)
        if (prior !== undefined && prior !== target.expectedLoopId) {
          throw new Error(
            `同一 change「${target.change}」不能同时声明不同 expected loop：` +
            `「${prior}」与「${target.expectedLoopId}」`,
          )
        }
        const priorLevel = expectedAutonomyLevelByChange.get(target.change)
        if (expectedAutonomyLevelByChange.has(target.change)
          && priorLevel !== target.expectedAutonomyLevel) {
          throw new Error(
            `同一 change「${target.change}」不能同时声明不同 expected autonomy：` +
            `「${String(priorLevel)}」与「${String(target.expectedAutonomyLevel)}」`,
          )
        }
        expectedLoopIdByChange.set(target.change, target.expectedLoopId)
        expectedAutonomyLevelByChange.set(target.change, target.expectedAutonomyLevel)
      }
      const candidates = ready.filter((change) => expectedLoopIdByChange.has(change))
      return schedulerFor(runChange).runRoundOnce(candidates, {
        expectedLoopIdByChange,
        expectedAutonomyLevelByChange,
      })
    },
  }
}
