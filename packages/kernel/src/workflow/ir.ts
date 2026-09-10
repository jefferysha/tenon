/**
 * Workflow IR（G2 P1，2026-07-17）——自定义 workflow 的运行/编译层类型：归一化 guard 闭集
 * + 编译产物（已补默认值、深冻结）的 step/transition/artifact 形态。
 *
 * 与定义层（./types.ts）的分工（G2 P2 落地）：
 *   · 定义层 WorkflowGuardConfig（9 变体，含 nonempty-output）= parse 产出 / serialize 写回 /
 *     validate 校验的形状，变体清单单一真相源在 types.ts。
 *   · 运行层 CompiledGuardConfig = 严格 typed guard（WorkflowGuardConfig **Exclude 掉
 *     nonempty-output**，8 变体）+ output-present。compileWorkflow 按 step.outputs 把 nonempty-output
 *     逐字段下沉：已知非列表字段 → field-nonempty，列表/未知惰性字段 → output-present（G2 P2
 *     兼容回退，见 OutputPresentGuard）。经编译产出的 IR 里不存在定义层 nonempty-output（已展开）。
 *     运行期注册表（guard-handlers.ts）仍保留一枚 nonempty-output fail-loud handler 作纵深防线
 *     （有人绕过编译器直接构造定义层变体），但静态类型上编译后的 guards[] 永不含它。
 *
 * 分层裁决（G2 设计钉死）：handler 只回结构化 GuardDecision / ActionOutcome，错误文案的
 * 渲染是另一层的职责，本层零文案——语义对照落在结构上而非字符串上。
 *
 * 消费面：本模块被 compile.ts / guard-handlers.ts / action-handlers.ts / engine.ts / stepGuard.ts
 * 及其单测引用；transition-application.ts 经 engine/handler 间接消费编译产物。
 */
import type { FieldName } from '../types.js'
import type {
  ArtifactProducerPolicy, FieldRef, GateKind, SkillRef, WorkflowActionConfig, WorkflowConditional,
  WorkflowDecompositionPolicyV1, WorkflowDocumentContractV1, WorkflowGuardConfig,
  WorkflowInteractionPolicyV1, WorkflowReviewBudgetPolicyV1,
} from './types.js'
import type { TrackPredicate } from './predicates.js'
import type {
  BuildRevisionAssessment, BuildRevisionAssessmentRequest, BuildRevisionBlocker,
} from './build-revision.js'

/**
 * 运行/编译层严格 guard 闭集：定义层 9 变体去掉 nonempty-output（后者编译期已按 outputs 下沉）。
 * 这些是「真求值 typed guard」——其 field 一律 ∈ FIELD_ORDER 且非列表字段（compileWorkflow 的
 * scalarField 闸保证），运行期 handler 只对绕过编译器的越界（列表/未知字段）输入留 fail-loud 兜底。
 */
type StrictCompiledGuardConfig = Exclude<WorkflowGuardConfig, { readonly type: 'nonempty-output' }>

/**
 * v1 nonempty-output 下沉到「列表字段 / 未知惰性 output 字段」的编译产物（G2 P2 兼容回退）。
 * field 是 string（可为 LIST_FIELDS 成员或不在 FIELD_ORDER 的惰性字段，故刻意不收窄 FieldName）。
 * 运行期保留 v1 旧 stepGuard 语义——数组/未设值折成 '' → 普通 guard failure（不编译期拒、不运行期
 * throw），与「新 scalar guard 列表字段编译期拒 + 运行期数组 fail-loud」的严格面刻意分道：
 * nonempty-output 是 v1 兼容 guard，其列表/惰性下沉走旧运行期失败，不是 P1 那条 typed guard 严格
 * 校验的对象。nonempty-output 下沉到「已知非列表字段」仍产出 field-nonempty（真求值），不走本变体。
 */
export interface OutputPresentGuard extends WorkflowConditional {
  readonly type: 'output-present'
  readonly field: string
}

/**
 * 运行/编译层 guard 闭集 = 严格 typed guard（8 变体）+ output-present（v1 nonempty-output 的
 * 列表/惰性下沉产物）。经本编译器产出的 IR guards[] 永不含定义层的 nonempty-output（已展开）。
 */
export type CompiledGuardConfig = StrictCompiledGuardConfig | OutputPresentGuard

/**
 * 运行/编译层 action 闭集——与定义层同型（5 变体全部原样通过编译，无 nonempty-output 式的
 * 编译期展开），故直接复用定义层联合，不另立一份。
 */
export type ActionConfig = WorkflowActionConfig

/** guard handler 的注入面（同 TransitionContext / GuardContext 的可选能力做法）。 */
export interface GuardInput {
  readonly fields: Readonly<Record<FieldName, string | string[]>>
  /** Hash of the raw canonical state fields. Default guard views may normalize arrays for legacy
   * scalar semantics, but revision trust must always bind to this unmodified state snapshot. */
  readonly stateHash?: string
  /** Raw canonical build revision candidate. Default guard views normalize scalar fields for
   * legacy compatibility, but an array build_sha is ambiguous and must remain distinguishable. */
  readonly rawBuildSha?: unknown
  readonly track: string
  /** 文件存在（项目根相对路径，已绑定）；缺省 = 文件面降级跳过（skipped）。 */
  readonly fileExists?: (repoRelativePath: string) => boolean
  /** 读 change 目录内文本（change 相对路径）；tasks-at-least 用；缺省 = 降级跳过。 */
  readonly readText?: (changeRelativePath: string) => string | undefined
  /** `git rev-parse HEAD` stdout（trim 前）；缺省 = SHA 面降级跳过。 */
  readonly gitHeadSha?: () => Promise<string>
  /** in-place build 的内容寻址工作区基线；缺省 = workspace baseline guard 降级跳过。 */
  readonly workspaceFingerprint?: () => Promise<string>
  /** 当前 Change 的主规格迁移机器证据；Ship 门禁缺少能力时必须失败关闭。 */
  readonly specMigrationStatus?: () => Promise<SpecMigrationGuardStatus>
  /** Current Build revision trust evaluator. Missing capability is a hard blocker, never skipped. */
  readonly assessBuildRevision?: (
    request: Omit<BuildRevisionAssessmentRequest, 'observe' | 'provenance'>,
  ) => Promise<BuildRevisionAssessment>
  /** Current Verify-like step used by the provenance evaluator. */
  readonly currentStep?: string
}

export type SpecMigrationGuardStatus =
  | { readonly kind: 'not-required' }
  | { readonly kind: 'applied' }
  | { readonly kind: 'invalid'; readonly reason: string }

/** skipped.capability 的闭集 = 可降级的 GuardInput 注入点；迁移门禁不允许降级，故不在本闭集。 */
export type GuardCapability = 'readText' | 'fileExists' | 'gitHeadSha' | 'workspaceFingerprint'

/**
 * guard 判定结果（结构化，零文案）：
 *   passed  —— 满足。
 *   skipped —— 依赖的能力未注入 → 降级跳过（对齐 TransitionContext 缺省语义：文件面视为
 *              存在、SHA 面跳过）；capability 指明缺的是哪个注入点。
 *   failed  —— 不满足；guardType + field/actual/expected 供渲染层组织文案。
 */
export type GuardDecision =
  | { readonly kind: 'passed' }
  | { readonly kind: 'skipped'; readonly capability: GuardCapability }
  | {
      readonly kind: 'failed'
      readonly guardType: CompiledGuardConfig['type']
      readonly field?: FieldName
      readonly actual?: string
      readonly expected?: readonly string[]
      /** Stable trust blocker; raw candidates and exceptions never cross this boundary. */
      readonly blocker?: BuildRevisionBlocker
    }

/** Legacy action signal union retained for ABI compatibility. The current freeze action throws a
 * typed revision blocker instead of emitting a warning when capture is unavailable. */
export type ActionSignal = { readonly kind: 'build-sha-missing' }

/** action handler 的注入面。fields 是只读视图——handler 绝不原地 mutate，改动走 patch。 */
export interface ActionInput {
  readonly fields: Readonly<Record<FieldName, string | string[]>>
  readonly clock: () => string
  readonly gitHeadSha?: () => Promise<string>
  /** in-place build 的内容寻址工作区基线；此能力缺失时 freeze 必须拒绝，不能降级为假 SHA。 */
  readonly workspaceFingerprint?: () => Promise<string>
  /** Trusted Build revision capture; receives the current isolation value. */
  readonly captureBuildRevision?: (isolation: string) => Promise<string>
}

/** action 产出：字段增量（不原地 mutate）+ IO 信号。 */
export interface ActionOutcome {
  readonly patch: Partial<Record<FieldName, string | string[]>>
  readonly signals: readonly ActionSignal[]
}

/**
 * step 产物声明：kind:'file' 挂在本 step outputs 里 type:'file_path' 的 FieldRef 上
 * （compileWorkflow 强制，其余形态编译期拒绝）；producerPolicy 属 ArtifactProducerPolicy 闭集
 * （custom 派生默认 'effective-step-skills'；default.yaml 显式声明可为 'effective-phase-skills'，
 * 见 types.ts）；requiredWhen 缺省 = 全轨必需。
 */
export interface ArtifactDeclaration {
  readonly kind: 'file'
  readonly field: FieldName
  readonly producerPolicy: ArtifactProducerPolicy
  readonly requiredWhen?: TrackPredicate
}

/** 转换边的 IR 形态：edge 级 guards（该边专属前置）+ actions（走该边的副作用）。
 *  compileWorkflow 补默认值，两者恒为数组（v1 输入无声明 → []）。 */
export interface StepTransitionIR {
  readonly event: string
  readonly to: string
  readonly guards: readonly CompiledGuardConfig[]
  readonly actions: readonly ActionConfig[]
}

/** step 的 IR 形态。step 级 guards 是公共出口 guard（任何离开本 step 的边都适用）；
 *  edge 级 guards 在 transitions[].guards——两层都进 IR。 */
export interface StepIR {
  readonly id: string
  readonly label: string
  readonly gate: GateKind
  /** 冻结后的 step agent 指令；缺席表示只使用生产 runner 的固定安全 prompt。 */
  readonly prompt?: string
  /** Always present on newly compiled plans; optional only for historical snapshot compatibility. */
  readonly reviewLanes?: readonly string[]
  readonly skills: readonly SkillRef[]
  readonly inputs: readonly FieldRef[]
  readonly outputs: readonly FieldRef[]
  readonly guards: readonly CompiledGuardConfig[]
  readonly artifacts: readonly ArtifactDeclaration[]
  readonly transitions: readonly StepTransitionIR[]
}

/** 编译产物：compileWorkflow 全量新建对象并深冻结（Object.isFrozen 对任意嵌套层成立）。 */
export interface WorkflowIR {
  readonly name: string
  readonly decomposition: WorkflowDecompositionPolicyV1
  readonly interaction: WorkflowInteractionPolicyV1
  readonly reviewBudget: WorkflowReviewBudgetPolicyV1
  /** Preserved from WorkflowDef after compile-time validation; absent means an ordinary custom workflow. */
  readonly openspecContract?: 'required'
  readonly documentContract?: WorkflowDocumentContractV1
  readonly steps: readonly StepIR[]
  /** track 分支（编译后）；有效计划按 change 的 track 选中一条后即从 IR 剥离，冻结快照里不再出现。 */
  readonly tracks?: Readonly<Record<string, { readonly label?: string; readonly steps: readonly StepIR[] }>>
}
