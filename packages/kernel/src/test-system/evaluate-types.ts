/**
 * 策略判定（evaluateTestPolicy，纯函数）的输入与输出形状。IO 装配在 load.ts；
 * `tenon status` / transition / 工作台读同一份输出。
 */
import type { TestBaselineV2 } from './baseline-v2.js'
import type { BenchmarkMetricVerdict } from './benchmark.js'
import type { TestBlocker, TestNotice } from './blockers.js'
import type { TestCatalog } from './catalog-types.js'
import type { KnownFailure } from './known-failures.js'
import type { ProtectedChange } from './protected-files.js'
import type { SealState, TestSeal } from './seal.js'
import type { OpenSpecScenario, TaskItem } from './openspec-trace.js'
import type { TestPlan } from './plan.js'
import type { InlineSuite } from './policy.js'
import type { ChainReport } from './record-chain.js'
import type { CaseStatus, CaseTotals, CoverageResult } from './record-v2-types.js'
import type { UnregisteredTestFile } from './test-files.js'
import type { TestKind } from './vocabulary.js'
import type { StepTestPolicyIR } from '../workflow/ir.js'

export type CatalogInput =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly issues: readonly string[] }
  | { readonly state: 'ok'; readonly catalog: TestCatalog }

export type PlanInput =
  | { readonly state: 'missing' }
  | { readonly state: 'tampered'; readonly reason: string }
  | { readonly state: 'ok'; readonly plan: TestPlan; readonly digest: string }

/** 旧步骤测试项经 v1 判定后的状态（evaluateTestEvidence 算出后传入）。 */
export interface InlineSuiteStatus {
  readonly suite: InlineSuite
  readonly status: 'passed' | 'failed' | 'stale' | 'missing' | 'running'
  readonly detail?: string
}

export interface CurrentBindings {
  /** undefined = 宿主没有工作区指纹能力（跳过候选比对）；null = 能力在但这次取不到（按未知判过期）。 */
  readonly candidate: string | null | undefined
  readonly workflowFingerprint: string
  /** 当前 workflow run；记录只在同一 run 内有效。取不到时一律视为未运行。 */
  readonly workflowRunId: string | undefined
}

/**
 * 证据来源的输入（R1 / R4）：本任务 diff 里的受保护配置改动，以及本机封存文件（记录链头、Tenon 命令的写入、人工批准）。
 * 不提供（纯函数单测、没有这两项能力的宿主）就整体跳过这些检查；生产装配（load.ts）恒提供。
 */
export interface ProtectedEvidenceInput {
  /** 本步是评审门：受保护改动的人工确认只能在评审门给出，无门步骤不判（否则没有人可批准）。 */
  readonly reviewGated: boolean
  /** undefined = 宿主没有提供读取受保护改动的能力。 */
  readonly changes: readonly ProtectedChange[] | undefined
  /** 宿主提供了能力，但这次读取失败（原因）：失败关闭。 */
  readonly changesError?: string
  readonly seal: TestSeal
  readonly sealState: SealState
}

export interface TestPolicyEvaluationInput {
  readonly change: string
  readonly stepId: string
  readonly policy: StepTestPolicyIR
  readonly inline: readonly InlineSuiteStatus[]
  readonly catalog: CatalogInput
  readonly plan: PlanInput
  readonly chain: ChainReport
  readonly knownFailures: readonly KnownFailure[]
  /** 键为 baselineKey(suite, profile)。 */
  readonly baselines: ReadonlyMap<string, TestBaselineV2>
  /** diff（相对 change 起点）里新增 / 修改的文件；undefined = 宿主不提供，跳过登记检查并提示。 */
  readonly changedFiles: readonly string[] | undefined
  /** 宿主提供了 diff 文件列表的能力，但这次读取失败（原因）：失败关闭，挡出口而不是降级为提示。 */
  readonly changedFilesError?: string
  readonly scenarios: readonly OpenSpecScenario[]
  readonly tasks: readonly TaskItem[]
  readonly bindings: CurrentBindings
  /** 正在运行的套件 id。 */
  readonly running?: ReadonlySet<string>
  /** YYYY-MM-DD，已知失败过期判定用。 */
  readonly today: string
  /** 离开本步的前进事件；豁免批准的修复命令用。 */
  readonly exitEvent?: string
  readonly protected?: ProtectedEvidenceInput
}

export type SuiteState = 'passed' | 'failed' | 'stale' | 'missing' | 'running'
export type StaleBinding = 'candidate' | 'workflow' | 'catalog' | 'plan' | 'policy'

export interface SuiteVerdict {
  readonly suite: string
  readonly origin: 'catalog' | 'step'
  readonly kind: TestKind
  readonly label?: string
  /** 为什么在本阶段运行集里：策略必跑 / 有则跑 / 旧步骤测试。 */
  readonly reason: 'run' | 'if-registered' | 'inline'
  readonly state: SuiteState
  readonly run_id?: string
  readonly finished_at?: string
  readonly staleBecause?: readonly StaleBinding[]
  readonly totals?: CaseTotals
  /** 阻塞的失败用例引用（清单外或已过期）。 */
  readonly failing?: readonly string[]
  readonly flaky?: readonly string[]
  readonly coverage?: CoverageResult | null
  readonly benchmark?: readonly BenchmarkMetricVerdict[]
  readonly detail?: string
}

export type TraceTestStatus = CaseStatus | 'not-run'

export interface TraceTest {
  readonly ref: string
  readonly status: TraceTestStatus
  readonly suite?: string
  readonly run_id?: string
}

export interface TraceRow {
  readonly covers: string
  readonly kind: 'spec' | 'task'
  readonly title: string
  /** 任务条目所在的阶段小节 id（tasks.md 里认得出阶段小节时）；场景没有。展示用，不参与判定。 */
  readonly stage?: string
  /** 要求映射用例：场景一律；任务只有实现阶段小节里的。false = 可选，不挡（只进矩阵与报告）。 */
  readonly required: boolean
  readonly tests: readonly TraceTest[]
  readonly waiver?: { readonly approved: boolean; readonly reason: string }
  /** uncovered：没有映射；mapped：有映射但本轮没有通过的结果；passing：至少一个通过且无失败；failing：有失败。 */
  readonly state: 'uncovered' | 'mapped' | 'passing' | 'failing' | 'waived'
}

export interface TestPolicyReport {
  readonly stepId: string
  readonly pass: boolean
  readonly blockers: readonly TestBlocker[]
  readonly notices: readonly TestNotice[]
  readonly suites: readonly SuiteVerdict[]
  readonly trace: readonly TraceRow[]
  readonly files: {
    readonly checked: boolean
    readonly unregistered: readonly UnregisteredTestFile[]
    readonly orphans: readonly string[]
  }
  readonly chain: ChainReport['state']
}

export function baselineKey(suite: string, profile: string): string {
  return `${suite}\u0000${profile}`
}
