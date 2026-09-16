/**
 * workflow 自定义引擎类型（GOAL 清单 E）——双轨策略：workflow==='default' 时完全不使用
 * 这些类型，走 packages/kernel/src/flow/ 现有的硬编码路径；只有 workflow!=='default'
 * 才会加载、解析、消费这里定义的形状。
 *
 * 分层（G2 P2，2026-07-17）：本文件是**定义层**——parse 产出、serialize 写回、validate 校验、
 * 编辑器/测试夹具直接构造的形状（guard 的 9 变体闭集 + 4 action 变体 + edge 级 guards/actions +
 * when 谓词）。运行层（归一化、编译期展开 nonempty-output、字段收窄进 FIELD_ORDER 闭集）是
 * ./ir.ts 的 CompiledGuardConfig / WorkflowIR，由 compileWorkflow（./compile.ts）从本层翻译产出。
 * 运行层的 CompiledGuardConfig 从本层 WorkflowGuardConfig 派生（Exclude 掉 nonempty-output），
 * 变体清单单一真相源在此，ir.ts 不再重复罗列。
 */
import type { FieldName } from '../types.js'
import type { TrackPredicate } from './predicates.js'

export type FieldType = 'string' | 'file_path' | 'boolean'
export type GateKind = 'review' | 'auto' | null

export type WorkflowDecompositionMode = 'off' | 'suggest' | 'auto-safe' | 'require-review'
export type WorkflowDecompositionTarget = 'work-items' | 'child-pipelines'
export type WorkflowDecompositionStrategy = 'balanced' | 'breadth-first' | 'depth-first'
export type WorkflowDecompositionAutoCondition =
  | 'independent-work-items'
  | 'cross-component-boundary'
  | 'context-budget-risk'
export type WorkflowDecompositionAskCondition =
  | 'ambiguous-requirements'
  | 'hard-boundary'
  | 'missing-authorization'
  | 'limit-exceeded'

export interface WorkflowDecompositionPolicyV1 {
  readonly version: 'v1'
  readonly mode: WorkflowDecompositionMode
  readonly target: WorkflowDecompositionTarget
  readonly strategy: WorkflowDecompositionStrategy
  readonly max_items: number
  readonly max_depth: number
  readonly auto_when: readonly WorkflowDecompositionAutoCondition[]
  readonly ask_when: readonly WorkflowDecompositionAskCondition[]
}

export type WorkflowInteractionMode = 'interactive' | 'recommended-defaults' | 'afk'

export interface WorkflowInteractionPolicyV1 {
  readonly version: 'v1'
  readonly mode: WorkflowInteractionMode
}

export interface FieldRef {
  readonly field: string
  readonly type: FieldType
}

export interface SkillRef {
  readonly id: string
  /** 同 step 内其它 skill 的 id；无 = 无依赖，可立即调用。跨 step 引用是校验期错误（Task 4）。 */
  readonly depends_on?: readonly string[]
}

/** guard/action 的 track 适用条件（定义层）：无 when 对全轨生效；有 when 且谓词不命中 → 该
 *  guard 整体不适用（evaluateGuards 不产生任何 decision）。与运行层同结构（ir.ts 复用本形状）。 */
export interface WorkflowConditional {
  readonly when?: TrackPredicate
}

/**
 * guard 定义层闭集。前两个是 v1 变体（tasks-at-least / nonempty-output）；其余是
 * flow/transition-table.ts 事件前置校验下沉出的基础 guard。nonempty-output 是纯定义层变体——
 * compileWorkflow 按 step.outputs 展开成 field-nonempty 集合，运行层 CompiledGuardConfig 不含它。
 * 刻意没有任意 set-field/自由脚本类变体（防 custom workflow 获得改 phase/workflow 等系统字段的
 * 通用能力）。field 位用 FieldName（与运行层同型，令 CompiledGuardConfig 可从本联合 Exclude 派生）；
 * 字段名是否真属 FIELD_ORDER 闭集由 compileWorkflow 深校验，parse 只做语法层构造。
 */
export type WorkflowGuardConfig =
  | ({ readonly type: 'tasks-at-least'; readonly n: number } & WorkflowConditional)
  | ({ readonly type: 'nonempty-output' } & WorkflowConditional)
  | ({ readonly type: 'field-nonempty'; readonly field: FieldName } & WorkflowConditional)
  | ({ readonly type: 'file-exists'; readonly path: { readonly kind: 'field'; readonly field: FieldName } } & WorkflowConditional)
  | ({ readonly type: 'field-equals'; readonly field: FieldName; readonly value: string } & WorkflowConditional)
  | ({ readonly type: 'field-in'; readonly field: FieldName; readonly values: readonly [string, ...string[]] } & WorkflowConditional)
  /** preset=full ∧ build_mode=direct → direct_override 必须 'true'（老仓 state-transition.sh build-complete）。 */
  | ({ readonly type: 'full-direct-override' } & WorkflowConditional)
  /** barrier：HEAD 必须等于 build 冻结的 SHA（老仓 state-transition.sh verify-pass barrier，ADR 0005）。 */
  | ({ readonly type: 'build-head-unchanged'; readonly field: 'build_sha' } & WorkflowConditional)
  /** Ship 硬门禁：存在主规格迁移输入时，必须有身份/摘要绑定且与当前主规格一致的应用结果。 */
  | ({ readonly type: 'spec-migration-applied' } & WorkflowConditional)

/**
 * 每个 guard 变体在定义层允许的**顶层 data 键**（不含通用的 `type` 与可选 `when`）——附加字段闭集
 * 校验的单一真相源（G2 P2 阻断 3）。parse（YAML 早期友好报错）与 compile（结构化输入的纵深防线，
 * server workflows 直调走此路）**共用本表**，杜绝两处白名单漂移：结构化 `{type:'nonempty-output', n:2}`
 * 等附加键此前能过 validate/compile 再被 serialize 静默丢弃，现在两处都据本表 fail-loud。
 *
 * `satisfies Record<WorkflowGuardConfig['type'], …>` 把变体清单钉死同步于上面的联合——新增变体若忘了
 * 在此登记键集，编译期即报缺键。compile 直接按结构化 def 形状校验顶层键（file-exists 的叶子是嵌套
 * `path`）；parse 读的是 YAML 扁平子字段，除把 file-exists 的 `path` 折叠成扁平 `field` 外与本表逐键
 * 一致（见 parse.ts 的 GUARD_FLAT_FIELDS 派生）。
 */
export const GUARD_DATA_KEYS = {
  'tasks-at-least': ['n'],
  'nonempty-output': [],
  'field-nonempty': ['field'],
  'file-exists': ['path'],
  'field-equals': ['field', 'value'],
  'field-in': ['field', 'values'],
  'full-direct-override': [],
  'build-head-unchanged': ['field'],
  'spec-migration-applied': [],
} as const satisfies Record<WorkflowGuardConfig['type'], readonly string[]>

/**
 * action 定义层闭集（5 变体，与运行层同型）。除老仓 state-transition.sh cmd_transition
 * 的四个事件专属副作用体（build-complete/verify-pass/verify-fail/archived）外，新增一个
 * Tenon 全局 pre-Verify reset action；仍不提供任意 set-field action。
 */
export type WorkflowActionConfig =
  | { readonly type: 'freeze-build-sha' }
  | { readonly type: 'reset-pre-verify-review' }
  | { readonly type: 'mark-verification-passed' }
  | { readonly type: 'mark-verification-failed' }
  | { readonly type: 'archive-run' }

/**
 * artifact producer policy 闭集（G2 P4）——作者为一条 file artifact 声明「谁产出它」的策略 token，
 * 不是具体 skill id 列表：
 *   · effective-phase-skills —— default 轨：产出者值域 = 当前 phase×track 的 manifest 有效 skill
 *     集（default step 的 step.skills 恒空，见 default.yaml；真值域来自 flow/manifest.ts）。
 *   · effective-step-skills —— custom 轨：产出者值域 = 本 step 声明的有效 skill 集。
 * 具体 skill id 归一化（含 manifest 的 a|b 备选 token）由 artifact register（G2 P5）经
 * EffectiveSkillResolver 接缝定义；本层只钉 policy token 闭集。ir.ts 的 ArtifactDeclaration 复用本类型。
 */
export type ArtifactProducerPolicy = 'effective-step-skills' | 'effective-phase-skills'

/**
 * 显式 artifact 声明（定义层，G2 P4）——挂在本 step 一条 type:'file_path' 的 output 上，声明其
 * producer policy 与（可选）track 适用条件。compileWorkflow 深校验 field ∈ FIELD_ORDER 且必须对应
 * 本 step 的 file_path output（见 compile.ts compileArtifact）；parse 只做语法层构造（field as FieldName）。
 * requiredWhen 缺省 = 全轨适用；有则复用 TrackPredicate（YAML 侧 required_when: track_in/track_not_in）。
 */
export interface WorkflowArtifactConfig {
  readonly field: FieldName
  readonly type: 'file_path'
  readonly producerPolicy: ArtifactProducerPolicy
  readonly requiredWhen?: TrackPredicate
}

/**
 * 步骤测试项（定义层）。测试方向只是创作模板：`direction` 只记来源 id，执行所需的一切都抄进本项，
 * 所以冻结的工作流 IR 就是测试内容的冻结（父设计 X7），方向改动不影响在跑的任务。
 */
export type TestInputDef =
  | { readonly kind: 'document'; readonly ref: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'service'; readonly name: string; readonly url?: string }

export type TestOutputKind = 'report' | 'coverage' | 'metrics' | 'trace' | 'screenshot' | 'log' | 'other'

export interface TestOutputDef {
  readonly path: string
  readonly kind?: TestOutputKind
  readonly required?: boolean
}

export interface TestMetricCriterion {
  readonly name: string
  readonly max?: number
  readonly min?: number
  /** 相对本用户基线的退化上限（百分比）；无基线时只留提示，不判失败。 */
  readonly max_regression_pct?: number
  readonly better?: 'lower' | 'higher'
}

export interface StepTestPassDef {
  readonly exit_code?: number
  readonly metrics?: readonly TestMetricCriterion[]
}

export interface StepTestDef {
  readonly id: string
  /** 来源方向 id（仅溯源）。 */
  readonly direction: string
  readonly command: string
  readonly cwd?: string
  readonly label?: string
  readonly timeout_s?: number
  readonly required?: boolean
  readonly keep_runs?: number
  /** 回归范围：全量 / 已知问题集。 */
  readonly scope?: 'full' | 'known'
  readonly metrics_path?: string
  readonly pass?: StepTestPassDef
  readonly inputs?: readonly TestInputDef[]
  readonly outputs?: readonly TestOutputDef[]
}

/** 问题级别，由高到低 critical / high / medium / low；评审者的阻断级别取本闭集。 */
export type AgentSeverity = 'critical' | 'high' | 'medium' | 'low'

/** 步骤执行者：完成本步工作；depends_on 指同一步骤 executors 列表内的其它 agent。 */
export interface StepExecutorRef {
  readonly agent: string
  readonly depends_on?: readonly string[]
}

/**
 * 步骤评审者：在产出与必需测试就绪后、离开本步骤前检查。
 * `required` 决定它是否参与放行判定，`block_at` 决定多高级别的问题算不通过，
 * `reads_tests` 引用同一步骤 `tests[].id`（结果由 Tenon 执行后交给它，评审者自己不跑测试）。
 */
export interface StepReviewerRef {
  readonly agent: string
  readonly required: boolean
  readonly block_at: AgentSeverity
  readonly depends_on?: readonly string[]
  readonly reads_tests?: readonly string[]
}

/** 步骤 agent 块；两个列表都空时归一为「无 agents 键」，往返保真。 */
export interface StepAgentsDef {
  readonly executors: readonly StepExecutorRef[]
  readonly reviewers: readonly StepReviewerRef[]
}

/** step 间转换边——每个 step 自己声明"按哪个 event 名走向哪个下一个 step"，取代
 *  default workflow 依赖的全局 TRANSITION_EVENTS 表（那张表是 Record<Phase,...>，天然
 *  不适用任意自定义 step）。同一个 step 可以有多条边（不同 event 名指向不同下一个 step，
 *  对齐现有 verify-pass→ship / verify-fail→build 这种真实分支需求）。
 *  guards/actions（G2 P2）：edge 级前置守卫（走该边前必须全过）+ 副作用（走该边后改字段）；
 *  缺省（v1 旧 YAML 无这两键）→ undefined，编译期视作空数组，行为逐字不变。 */
export interface StepTransition {
  readonly event: string
  readonly to: string
  readonly guards?: readonly WorkflowGuardConfig[]
  readonly actions?: readonly WorkflowActionConfig[]
}

export interface StepDef {
  readonly id: string
  readonly label: string
  readonly gate: GateKind
  /** 该 step 交给运行时 agent 的任务补充指令。项目 YAML 以 `prompt: |-` literal block 保真落盘。 */
  readonly prompt?: string
  readonly skills: readonly SkillRef[]
  readonly inputs: readonly FieldRef[]
  readonly outputs: readonly FieldRef[]
  /** 显式 artifact 声明（G2 P4）——缺省（旧 YAML 无本键）= undefined，编译期视作无显式声明
   *  （artifact 仍从 file_path outputs 派生）；`artifacts: []` 显式空块与 undefined 是两种保留状态。 */
  readonly artifacts?: readonly WorkflowArtifactConfig[]
  /** 本步声明的测试项；缺省 = 无测试（编译后不出现 tests 键，指纹逐字不变）。 */
  readonly tests?: readonly StepTestDef[]
  /** 本步的执行者与评审者；两个列表都空时等同缺省。 */
  readonly agents?: StepAgentsDef
  readonly guards: readonly WorkflowGuardConfig[]
  readonly transitions: readonly StepTransition[]
}

/**
 * track 分支：同一工作流下某条 track 自己的完整 pipeline（阶段 / 技能 / 输入输出 / 门禁 / 守卫 / 转换全部自有）。
 * change 的有效计划 = 其 track 命中的分支；未命中任何分支的 track 用工作流顶层 `steps`（通用分支）。
 */
export interface TrackBranchDef {
  readonly label?: string
  /** 本分支的文档契约（引用本分支 steps）；有 tracks 时文档契约只写在分支下。 */
  readonly documentContract?: WorkflowDocumentContractV1
  readonly steps: readonly StepDef[]
}

export interface WorkflowDef {
  readonly name: string
  readonly decomposition?: Omit<Partial<WorkflowDecompositionPolicyV1>, 'version'> & { readonly version: 'v1' }
  readonly interaction?: Omit<Partial<WorkflowInteractionPolicyV1>, 'version'> & { readonly version: 'v1' }
  /** 唯一的 OpenSpec 开关：parse 只产出 true 或缺省；关闭时没有文档治理。 */
  readonly openspec?: boolean
  /** 只与顶层 steps 同在；有 tracks 时写在 tracks.<id>.documentContract。 */
  readonly documentContract?: WorkflowDocumentContractV1
  readonly steps: readonly StepDef[]
  readonly tracks?: Readonly<Record<string, TrackBranchDef>>
}

export interface WorkflowDocumentSlot {
  readonly kind: string
  readonly ownerStep: string
  /** 缺省 = produce；parse 与 compile 把 'produce' 归一为缺省。 */
  readonly role?: 'update' | 'require'
  /** role require 时为空数组。 */
  readonly producers: readonly string[]
}

export interface WorkflowDocumentRead {
  readonly step: string
  readonly kinds: readonly string[]
}

export interface WorkflowDocumentContractV1 {
  readonly version: 'v1'
  readonly slots: readonly WorkflowDocumentSlot[]
  readonly reads: readonly WorkflowDocumentRead[]
}
