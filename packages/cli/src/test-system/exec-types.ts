/** 套件执行用到的共同类型：运行集条目、一次运行的共享上下文、单个套件的执行结果。 */
import type {
  CatalogSuite, KnownFailure, PlanScope, StepTestPolicyIR, SuiteRunV2, TestBaselineV2, TestNotice, TestPlan, TestRunRecordV2,
} from '@tenon/kernel'
import type { ArtifactBudget } from './artifacts.js'

export interface RunItem {
  readonly suite: CatalogSuite
  readonly scope: PlanScope
  readonly pattern?: string
  readonly files?: readonly string[]
  /** 为什么在运行集里：策略必跑 / 有则跑 / 命令行点名。 */
  readonly why: 'run' | 'if-registered' | 'explicit'
}

export interface ExecContext {
  readonly repoRoot: string
  readonly runId: string
  readonly runDir: string
  readonly change: string
  readonly env: NodeJS.ProcessEnv
  readonly plan: TestPlan | undefined
  readonly policy: StepTestPolicyIR
  readonly knownFailures: readonly KnownFailure[]
  readonly today: string
  /** undefined = 读不到 diff。 */
  readonly changedFiles: readonly string[] | undefined
  readonly changedLines: () => Promise<ReadonlyMap<string, ReadonlySet<number>> | undefined>
  readonly baseline: (suiteId: string) => Promise<TestBaselineV2 | undefined>
  /** 仅用于套件判定的记录外壳（画像、run-id 等），不落盘。 */
  readonly evalRecord: TestRunRecordV2
  readonly budget: ArtifactBudget
  readonly signal: AbortSignal
  readonly sandbox: string | null
}

export interface SuiteOutcome {
  readonly run: SuiteRunV2
  readonly notices: readonly TestNotice[]
  readonly notes: readonly string[]
  /** 最后一次调用输出的尾部，失败时给人看。 */
  readonly tail: string
  readonly sandboxDenied: boolean
}
