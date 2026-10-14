/**
 * 工作流执行接缝的类型面（实现见 execution-seam.ts）。
 *
 * 一个接缝两个适配器：step-graph（所有新任务）与 legacy-phase-manifest（只服务快照里记着旧执行模型的
 * 任务，与 legacy-phase-manifest/ 整目录同生共死）。接缝只收口「两种模型真正不同」的那几处：转换规划、就绪判定用的出边与
 * guard、出口报告用的相位出口表与单条出边 guard。编排与证据面（文档、测试、技能、agent、评审门）两种
 * 模型共用，仍留在各自的入口模块。
 *
 * 类型独立成文件：适配器要引用这些类型，而接缝本身又要引用适配器，放在一起会让类型层成环。
 */
import type { FlowEngine, PipelineState } from '../types.js'
import type { TransitionContext } from '../flow/transition-table.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { CompiledGuardConfig, GuardInput, StepIR, StepTransitionIR, UniversalGuardCapabilities } from './ir.js'
import type { PhaseExitFileContext } from './legacy-phase-manifest/phase-exit-context.js'
import type { StepGuardContext } from './stepGuard.js'
import type { PreparedTransition, TransitionCommand, TransitionRejection } from './transition-application-types.js'

export type ExecutionKind = 'legacy-phase-manifest' | 'step-graph'

export interface TransitionInput {
  readonly state: PipelineState
  readonly plan: EffectiveWorkflowPlan
  readonly command: TransitionCommand
  /** 旧引擎的事件边表与相位推进；step-graph 不读。 */
  readonly flow: FlowEngine
  readonly clock: () => string
}

/** 可提交的转换，或拒绝。规划全程不持久化。 */
export type TransitionPlanResult = PreparedTransition | TransitionRejection

export interface ReadinessInput {
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly context: StepGuardContext
}

/** 就绪判定里随执行模型而变的部分；求值循环、agent 阻断与错误归类在 transition-readiness.ts。 */
export interface ReadinessBasis {
  readonly guardInput: GuardInput
  /** 结构性出边（不按运行状态过滤），让就绪键与投影出来的规则一一对应。 */
  exitsOf(step: StepIR): readonly StepTransitionIR[]
  /** 一条出边适用的 guard；未知事件由适配器自己报错。 */
  guardsOf(step: StepIR, transition: StepTransitionIR): readonly CompiledGuardConfig[]
}

export interface ExitReportInput {
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly stepId: string
  readonly changeDir: string
  /** 相位出口规则表（kernel flow/guard.ts）的文件面；undefined = 只判字段面。 */
  readonly fileContext: PhaseExitFileContext | undefined
  readonly guardCheck: FlowEngine['guardCheck']
}

/** 出边 guard 的读取能力（含规格迁移回执），由出口报告统一构造后交给适配器。 */
export type ExitGuardContext = Pick<
  TransitionContext,
  'fileExists' | 'gitHeadSha' | 'workspaceFingerprint' | 'assessBuildRevision' | 'specMigrationStatus'
> & UniversalGuardCapabilities

export interface EdgeGuardBlocker {
  readonly source: 'guard' | 'revision'
  readonly code: string
  readonly message: string
}

/** 出口报告里随执行模型而变的部分；技能、文档、测试、评审者与 agent 的证据面在 step-exit-report.ts。 */
export interface ExitReportBasis {
  /** 「离开本步」的相位出口条件（只加给前进边）；step-graph 没有这张表，恒为空。 */
  readonly phaseExit: {
    readonly failures: readonly string[]
    /** 截至本步仍未勾选的任务原文，与 failures 里指向 tasks.md 的条目配套。 */
    readonly openTasks: readonly string[]
  }
  /** 一条出边自己的 guard 阻断。 */
  edgeGuards(
    edge: { readonly stepId: string; readonly event: string; readonly to: string },
    context: ExitGuardContext,
  ): Promise<readonly EdgeGuardBlocker[]>
}

export interface ExecutionAdapter {
  readonly kind: ExecutionKind
  planTransition(input: TransitionInput): Promise<TransitionPlanResult>
  readiness(input: ReadinessInput): ReadinessBasis
  exitReport(input: ExitReportInput): Promise<ExitReportBasis>
}
