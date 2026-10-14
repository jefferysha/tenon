/**
 * IR guard handler 注册表（G2 P1）——default 轨（DefaultEventPolicy，G2 P3 起）与 custom 轨共用的
 * 前置判定实现，语义源两处：
 *   · 老仓 skills/pipeline/scripts/state-transition.sh cmd_transition 各事件前置校验
 *     → field-nonempty / file-exists / field-equals / field-in / full-direct-override /
 *       build-head-unchanged 六个基础 guard 的组合。
 *   · workflow/stepGuard.ts evaluateStepGuards 两个 v1 guard
 *     → tasks-at-least 原样、nonempty-output 由 compileWorkflow 编译期展开（本表只留兜底）。
 *   · 设计 consolidate-workflow-tracks §1b 的三个通用离开条件 tasks-through-step / not-afk-queued /
 *     dependencies-ended，以及文档机制重做的 required-output：判定全部来自 GuardInput 的同名能力，
 *     能力缺失 = 失败关闭（不是 skipped）。
 * 每个 handler 的判定逐条对齐老仓 case 块语义（就地注释标注）；单测 guard-handlers.test.ts 逐分支
 * 手写期望值（对齐老仓，不 import 任何旧函数当 oracle）。
 *
 * 分层（裁决钉死）：handler 只回结构化 GuardDecision，不拼错误文案——渲染是另一层的职责。
 * 注册表是 exhaustive mapped type 静态闭集（属性 readonly + 对象 Object.freeze）：新增变体 =
 * 改 ir.ts 联合，此处随之编译报错；刻意没有运行时注册/替换 API。
 */
import { taskCount } from '../flow/guard.js'
import { matchesTrackPredicate } from './predicates.js'
import type { FieldName } from '../types.js'
import type { WorkflowGuardConfig } from './types.js'
import type {
  CompiledGuardConfig, GuardDecision, GuardInput, OutputPresentGuard, UniversalGuardCapabilityName,
} from './ir.js'
import { effectiveBuildIsolation, makeBuildRevisionBlocker, safeRevisionHash } from './build-revision.js'

export type GuardHandler<C extends WorkflowGuardConfig> = (
  config: C,
  input: GuardInput,
) => GuardDecision | Promise<GuardDecision>

/**
 * 注册表按**定义层** WorkflowGuardConfig 全部变体建（含 nonempty-output）：nonempty-output 只留
 * fail-loud 兜底 handler，防有人绕过编译器直接构造它进运行期；而 evaluateGuards / 编译产物的
 * guards[] 用运行层 CompiledGuardConfig（严格 typed guard + output-present）。dispatchGuard
 * 先单独派发 output-present（编译产物，不在定义层注册表内，见 evalOutputPresent），其余变体的 type
 * ⊆ 本注册表键集（定义层的子集），索引恒命中。
 */
export type GuardHandlerRegistry = {
  readonly [K in WorkflowGuardConfig['type']]: GuardHandler<Extract<WorkflowGuardConfig, { type: K }>>
}

/** 字段读值：编译产物保证 scalar guard 的 field 非列表字段（compile.ts scalarField 闸），
 *  运行期读到数组 = 调用方绕过了编译器 → fail-loud（同 nonempty-output handler 的兜底
 *  先例）；非数组沿老内核 fstr 的缺省支（缺省/undefined → ''）。 */
function scalarValue(fields: GuardInput['fields'], k: FieldName): string {
  const v = fields[k]
  if (Array.isArray(v)) {
    throw new Error(
      `guard 读到列表字段 '${k}' 的数组值：scalar guard 不定义列表语义，compileWorkflow 编译期拒绝列表字段——运行期出现 = 绕过编译器`,
    )
  }
  return v ?? ''
}

/** 老内核 cmd_get 口径：字面 'null'（init heredoc）或空串都算未设。 */
function isUnset(v: string): boolean {
  return v === '' || v === 'null'
}

const PASSED: GuardDecision = { kind: 'passed' }

type UniversalGuardType = 'tasks-through-step' | 'not-afk-queued' | 'dependencies-ended' | 'required-output'

/** 通用离开条件的能力没注入：失败关闭并点名缺什么（不同于文件面能力的 skipped 降级）。 */
function capabilityUnavailable(guardType: UniversalGuardType, capability: UniversalGuardCapabilityName): GuardDecision {
  return { kind: 'failed', guardType, actual: 'capability-unavailable', missingCapability: capability }
}

/** 能力抛错也失败关闭；异常原文可能带路径，不进判定结果。 */
function evaluationError(guardType: UniversalGuardType): GuardDecision {
  return { kind: 'failed', guardType, actual: 'evaluation-error' }
}

export const GUARD_HANDLERS: GuardHandlerRegistry = Object.freeze({
  /** stepGuard.ts L38-44 同语义：tasks.md 任务数 ≥ n。文件读取走 readText 能力注入
   *  （stepGuard 直接 readFileSync，本层纯函数化）；readText 注入但文件缺失 → undefined →
   *  taskCount=0（stepGuard L17-24 缺失=0 同口径），能力本身未注入才是 skipped。 */
  'tasks-at-least': (config, input) => {
    if (!input.readText) return { kind: 'skipped', capability: 'readText' }
    const count = taskCount(input.readText('tasks.md'))
    if (count < config.n) {
      return { kind: 'failed', guardType: 'tasks-at-least', actual: String(count), expected: [String(config.n)] }
    }
    return PASSED
  },

  /** 纯定义层变体：compileWorkflow 按 step.outputs 展开成 field-nonempty 集合，经编译的 IR
   *  里不存在它。handler 拿不到 step.outputs（GuardInput 刻意不带 step 形状），运行期收到它
   *  = 调用方绕过了编译器，fail-loud。 */
  'nonempty-output': () => {
    throw new Error(
      "guard 'nonempty-output' 是 v1 定义层变体，compileWorkflow 按 step.outputs 展开为 field-nonempty；运行期注册表不实现它",
    )
  },

  /** 老仓 state-transition.sh 各事件的字段非空面：isUnset（''/'null'）→ failed。
   *  纯字段谓词，无能力依赖，永不 skipped。 */
  'field-nonempty': (config, input) => {
    const v = scalarValue(input.fields, config.field)
    if (isUnset(v)) {
      return { kind: 'failed', guardType: 'field-nonempty', field: config.field, actual: v }
    }
    return PASSED
  },

  /** 老仓 state-transition.sh 各事件的文件存在面：字段值即项目根相对路径。
   *  字段未设 → failed（未设的路径必不存在；与 field-nonempty 前置搭配时被首错截断，
   *  单独使用时行为自洽）；fileExists 未注入 → skipped（L92-93 降级视为存在）。 */
  'file-exists': (config, input) => {
    const v = scalarValue(input.fields, config.path.field)
    if (isUnset(v)) {
      return { kind: 'failed', guardType: 'file-exists', field: config.path.field, actual: v }
    }
    if (!input.fileExists) return { kind: 'skipped', capability: 'fileExists' }
    if (!input.fileExists(v)) {
      return { kind: 'failed', guardType: 'file-exists', field: config.path.field, actual: v }
    }
    return PASSED
  },

  /** 老仓 state-transition.sh verify-pass 的等值面（branch_status=handled、双 review=pass）。 */
  'field-equals': (config, input) => {
    const v = scalarValue(input.fields, config.field)
    if (v !== config.value) {
      return { kind: 'failed', guardType: 'field-equals', field: config.field, actual: v, expected: [config.value] }
    }
    return PASSED
  },

  /** build-complete 的隔离枚举面（branch/worktree，或受限 agent 的显式 in-place），expected 带全量合法值。 */
  'field-in': (config, input) => {
    const v = scalarValue(input.fields, config.field)
    if (!config.values.includes(v)) {
      return { kind: 'failed', guardType: 'field-in', field: config.field, actual: v, expected: config.values }
    }
    return PASSED
  },

  /** 老仓 state-transition.sh build-complete：preset=full ∧ build_mode=direct → direct_override 必须
   *  字面 'true'（set 闸之外的纵深防线）。条件不齐（非 full / 非 direct）→ passed。 */
  'full-direct-override': (_config, input) => {
    const override = scalarValue(input.fields, 'direct_override')
    if (scalarValue(input.fields, 'preset') === 'full' && scalarValue(input.fields, 'build_mode') === 'direct' && override !== 'true') {
      return { kind: 'failed', guardType: 'full-direct-override', field: 'direct_override', actual: override, expected: ['true'] }
    }
    return PASSED
  },

  /** Verify-like success barrier：只消费由 Build capture 写入的 canonical `build:v1` token。
   *  assessor 缺失、输入不可信、物理 identity/provenance/evaluation 任一失败都返回 typed
   *  `verify-build-revision-untrusted` blocker；不得把旧裸 SHA、workspace baseline 或缺能力
   *  降级成 skipped/pass。worktree / in-place 通过 workspace assessor 求值，不读取 Git HEAD。 */
  'build-head-unchanged': async (config, input) => {
    // Default guard views normalize legacy scalar fields (including arrays) before dispatch.
    // Preserve the canonical candidate at the GuardInput boundary so an array build_sha remains
    // ambiguous instead of being joined into a malformed-looking string.
    const buildSha = config.field === 'build_sha' && input.rawBuildSha !== undefined
      ? input.rawBuildSha
      : input.fields[config.field]
    // Default guards receive a legacy scalar-normalized view; use the raw canonical state hash
    // injected at the GuardInput boundary so valid list-valued state cannot appear stale.
    const stateHash = input.stateHash ?? safeRevisionHash(input.fields)
    if (!input.assessBuildRevision) {
      return {
        kind: 'failed',
        guardType: 'build-head-unchanged',
        field: config.field,
        blocker: makeBuildRevisionBlocker('capability-unavailable', stateHash),
      }
    }
    try {
      const result = await input.assessBuildRevision({
        buildSha,
        isolation: effectiveBuildIsolation(scalarValue(input.fields, 'isolation')),
        expectedStep: input.currentStep,
        stateHash,
      })
      if (result.trusted) return PASSED
      return {
        kind: 'failed',
        guardType: 'build-head-unchanged',
        field: config.field,
        blocker: result.blocker,
      }
    } catch {
      return {
        kind: 'failed',
        guardType: 'build-head-unchanged',
        field: config.field,
        blocker: makeBuildRevisionBlocker('evaluation-error', stateHash),
      }
    }
  },

  /** Ship 迁移门禁是 fail-closed 能力：adapter 未绑定、证据损坏或目标摘要漂移都拒绝。 */
  'spec-migration-applied': async (_config, input) => {
    if (!input.specMigrationStatus) {
      return {
        kind: 'failed',
        guardType: 'spec-migration-applied',
        actual: 'capability-unavailable',
        expected: ['not-required', 'applied'],
      }
    }
    const status = await input.specMigrationStatus()
    if (status.kind === 'not-required' || status.kind === 'applied') return PASSED
    return {
      kind: 'failed',
      guardType: 'spec-migration-applied',
      actual: status.reason,
      expected: ['not-required', 'applied'],
    }
  },

  /** 设计 §1b Q5：截至当前步骤的任务都已勾选。判定本身来自 `tasksThroughStep` 能力（沿用 TaskPlan /
   *  tasks.md 现有口径，本层不另数任务）；当前步骤未知时无从判定，同样失败关闭。 */
  'tasks-through-step': async (_config, input) => {
    if (!input.tasksThroughStep) return capabilityUnavailable('tasks-through-step', 'tasksThroughStep')
    const step = input.currentStep
    if (step === undefined || step === '') {
      return { kind: 'failed', guardType: 'tasks-through-step', actual: 'current-step-unavailable' }
    }
    try {
      const result = await input.tasksThroughStep(step)
      return result.complete ? PASSED : { kind: 'failed', guardType: 'tasks-through-step', detail: result.unchecked }
    } catch {
      return evaluationError('tasks-through-step')
    }
  },

  /** 设计 §1b Q7：AFK 排队中的任务不能被手动推进。调度器自己执行时由调用方注入恒 false。 */
  'not-afk-queued': async (_config, input) => {
    if (!input.afkQueued) return capabilityUnavailable('not-afk-queued', 'afkQueued')
    try {
      return (await input.afkQueued()) ? { kind: 'failed', guardType: 'not-afk-queued', actual: 'queued' } : PASSED
    } catch {
      return evaluationError('not-afk-queued')
    }
  },

  /** 设计 §1b Q8：`depends_on` 的依赖都已结束；失败时 detail 只点名未结束的依赖。 */
  'dependencies-ended': async (_config, input) => {
    if (!input.dependencyStates) return capabilityUnavailable('dependencies-ended', 'dependencyStates')
    try {
      const pending = (await input.dependencyStates()).filter((dependency) => !dependency.ended).map((dependency) => dependency.name)
      return pending.length === 0 ? PASSED : { kind: 'failed', guardType: 'dependencies-ended', detail: pending }
    } catch {
      return evaluationError('dependencies-ended')
    }
  },

  /** 文档机制重做 §6：本任务里当前这一步必须产出匹配 `path` 的文件。判定来自 `requiredOutput` 能力（观察到的产出账本，
   *  观察不可用时退化为文件存在）；能力缺失、当前步骤未知、能力抛错都失败关闭，不降级为跳过。 */
  'required-output': async (config, input) => {
    // 失败决策都带原样的路径模式：`{change}` 不在这里展开——同一工作流里停在同一步的任务因此得到逐字相同的离开条件，
    // Dashboard 快照才能把它们合并成一份；显示时由客户端换成任务名（CLI 文案另由 renderGuardFailure 展开）。
    const path = config.path
    const failure = (decision: GuardDecision): GuardDecision => decision.kind === 'failed' ? { ...decision, path } : decision
    if (!input.requiredOutput) return failure(capabilityUnavailable('required-output', 'requiredOutput'))
    const step = input.currentStep
    if (step === undefined || step === '') {
      return failure({ kind: 'failed', guardType: 'required-output', actual: 'current-step-unavailable' })
    }
    try {
      return (await input.requiredOutput(step, config.path)) ? PASSED : failure({ kind: 'failed', guardType: 'required-output', actual: 'missing' })
    } catch {
      return failure(evaluationError('required-output'))
    }
  },
})

/**
 * output-present 求值（compile 从 v1 nonempty-output 对「列表 / 未知惰性 output 字段」下沉出的
 * 编译产物，不在定义层 WorkflowGuardConfig 里，故不进上面的 exhaustive 注册表，而由 dispatchGuard
 * 单独派发）。按旧 stepGuard.scalar 折值——数组或未设 → ''（列表字段恒 fail、未知惰性字段永不
 * 落值恒 fail），非空标量放行。产出普通 guard failure（不 throw）：nonempty-output 遇列表/惰性
 * 是 v1 兼容的合法输入，不是绕过编译器，与 field-nonempty 对数组的 fail-loud 越界兜底刻意分道。
 */
function evalOutputPresent(config: OutputPresentGuard, input: GuardInput): GuardDecision {
  const raw = input.fields[config.field as FieldName]
  const v = Array.isArray(raw) ? '' : (raw ?? '')
  if (isUnset(v)) {
    return { kind: 'failed', guardType: 'output-present', field: config.field as FieldName, actual: v }
  }
  return PASSED
}

/** 单个 guard 的评估结果：guard 原配置 + 判定，evaluateGuards 的输出元素。 */
export interface GuardEvaluation {
  readonly guard: CompiledGuardConfig
  readonly decision: GuardDecision
}

/** 注册表按 type 收窄的派发点。output-present 是编译产物（不在定义层注册表）先单独派发；其余
 *  strict 变体的 type ⊆ WorkflowGuardConfig['type']（注册表键集），收窄机械安全（相关联合的已知
 *  限制下用 cast 桥接）。 */
function dispatchGuard(config: CompiledGuardConfig, input: GuardInput): GuardDecision | Promise<GuardDecision> {
  if (config.type === 'output-present') return evalOutputPresent(config, input)
  const handler = GUARD_HANDLERS[config.type] as GuardHandler<typeof config>
  return handler(config, input)
}

/** evaluateGuards 的评估策略。stopOnFirstFailure：
 *   · true（缺省）——首个 failed 即停，对齐老仓 cmd_transition 每个 case 首个违反
 *     立即 return 的首错优先语义（transition/edge 前置校验用）。
 *   · false——评估全部适用 guard、收集全部 failed，对齐旧 evaluateStepGuards 逐条列全部未过
 *     项的 step-guard 语义（custom step 出口 guard 用，令旧 YAML 多失败项行为逐字不变）。 */
export interface EvaluateGuardsOptions {
  readonly stopOnFirstFailure?: boolean
}

/**
 * 按声明顺序评估一组 guard：
 *   · when 谓词不命中 → 该 guard 整体不适用，不产生任何 decision（不算 failed 也不算
 *     skipped-capability）；命中（或无 when）才评估。
 *   · stopOnFirstFailure（缺省 true）时首个 failed 即停（其后的 guard 不评估、不触发其能力
 *     IO）；false 时评估全部适用 guard 并收集全部 failed。
 *   · skipped（能力缺失降级）不打断评估。
 * 返回按评估顺序的 (guard, decision) 对；全适用全通过时长度 = 适用 guard 数。
 */
export async function evaluateGuards(
  guards: readonly CompiledGuardConfig[],
  input: GuardInput,
  options: EvaluateGuardsOptions = {},
): Promise<readonly GuardEvaluation[]> {
  const stopOnFirstFailure = options.stopOnFirstFailure ?? true
  const evaluated: GuardEvaluation[] = []
  for (const guard of guards) {
    if (guard.when !== undefined && !matchesTrackPredicate(guard.when, input.track)) continue
    const decision = await dispatchGuard(guard, input)
    evaluated.push({ guard, decision })
    if (decision.kind === 'failed' && stopOnFirstFailure) break
  }
  return evaluated
}
