/**
 * 测试体系的客户端响应类型（camelCase）。与 server 的 testSystemDtoTypes.ts 是同一份契约的两端声明，
 * 由 testSystemDecoders.ts 的严格解码器保证：形状不合即拒绝，不猜测、不补默认值。
 */
import type { TestClass } from '@tenon/kernel/test-system/vocabulary'
import type { TestCoverage, TestTotals } from './testRunTypes'

export type {
  CaseStatus, RecordDetail, RecordListResponse, RecordSummary, RunArtifact, RunCase, RunMetric, RunService, SuiteRun,
  TestCoverage, TestTotals,
} from './testRunTypes'

export interface TestMetricSpec {
  readonly name: string
  readonly unit?: string
  readonly better: 'lower' | 'higher'
  readonly maxRegressionPct?: number
  readonly max?: number
  readonly min?: number
}

export interface CatalogSuite {
  readonly id: string
  readonly label?: string
  readonly kind: string
  readonly runner: string
  readonly command: string
  readonly cwd: string
  readonly timeoutS: number
  readonly report: { readonly format: string; readonly path?: string }
  readonly coverage?: { readonly format: string; readonly path: string }
  readonly services: readonly string[]
  readonly retries: number
  readonly parallel: boolean
  readonly tags: readonly string[]
  readonly browsers: readonly string[]
  readonly benchmark?: { readonly runs: number; readonly warmup: number; readonly metrics: readonly TestMetricSpec[] }
}

export interface CatalogService {
  readonly id: string
  readonly start: string
  readonly cwd: string
  readonly ready: { readonly kind: 'url' | 'port' | 'log'; readonly value: string | number; readonly timeoutS: number }
  readonly stop: string
}

export type TestCatalogView =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly issues: readonly string[] }
  | {
      readonly state: 'ok'
      readonly suites: readonly CatalogSuite[]
      readonly services: readonly CatalogService[]
      /** 三档（plan、changed、full）的生效定义，按这个顺序。 */
      readonly levels: readonly CatalogLevel[]
    }

export type LevelName = 'plan' | 'changed' | 'full'

/**
 * 一个档位的生效定义：必需类 / 碰到才跑的类（测试类 id）与门槛。
 * source = catalog 表示目录写了这一档的任意键，default 表示整档来自内建缺省。
 */
export interface CatalogLevel {
  readonly name: LevelName
  readonly required: readonly TestClass[]
  readonly touched: readonly TestClass[]
  readonly scenarios: 'off' | 'required' | 'passing'
  readonly coverage?: TestCoverage
  readonly flaky?: { readonly max: number; readonly failOnNew: boolean }
  readonly requireBaseline: boolean
  readonly source: 'catalog' | 'default'
}

export interface KnownFailure {
  readonly suite: string
  readonly test: string
  readonly reason: string
  readonly link?: string
  readonly expires: string
  readonly addedBy: string
  readonly expired: boolean
}

export type KnownFailuresView =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly issues: readonly string[] }
  | { readonly state: 'ok'; readonly entries: readonly KnownFailure[] }

export interface SuiteLatest {
  readonly suite: string
  readonly runId: string
  readonly change: string
  readonly user: string
  readonly finishedAt: string
  readonly result: 'pass' | 'fail'
  readonly totals: TestTotals
}

export interface TestCatalogResponse {
  readonly catalog: TestCatalogView
  readonly knownFailures: KnownFailuresView
  readonly latest: readonly SuiteLatest[]
}

export interface BaselineMetric {
  readonly median: number
  readonly p95: number
  readonly mad: number
  readonly samples: number
  readonly better: 'lower' | 'higher'
  readonly unit?: string
}

export interface BaselineHistoryEntry {
  readonly updatedAt: string
  readonly metrics: Readonly<Record<string, BaselineMetric>>
}

export interface SuiteBaseline extends BaselineHistoryEntry {
  readonly profile: string
  readonly profileLabel: string
  readonly source: { readonly change: string; readonly runId: string; readonly commit: string | null }
  readonly history: readonly BaselineHistoryEntry[]
}

export interface SuiteBaselinesResponse {
  readonly suite: string
  readonly baselines: readonly SuiteBaseline[]
  readonly corrupt: readonly string[]
}

export type TestPlanView =
  | { readonly state: 'missing' }
  | { readonly state: 'tampered'; readonly reason: string }
  | {
      readonly state: 'ok'
      readonly suites: readonly { readonly suite: string; readonly kind: string | null; readonly scope: string; readonly pattern?: string }[]
      readonly files: readonly { readonly path: string; readonly suite?: string; readonly kind?: string }[]
      readonly cases: readonly { readonly covers: string; readonly tests: readonly string[] }[]
      readonly waivers: readonly { readonly kind?: string; readonly covers?: string; readonly test?: string; readonly reason: string; readonly approvedBy: string | null }[]
    }

/** 快照里的计划概要（矩阵只需要登记了哪些套件与豁免）。 */
export type TestPlanBrief =
  | { readonly state: 'missing' }
  | { readonly state: 'tampered'; readonly reason: string }
  | {
      readonly state: 'ok'
      readonly suites: readonly { readonly suite: string; readonly kind: string | null; readonly scope: string }[]
      readonly waivers: readonly { readonly kind?: string; readonly covers?: string; readonly test?: string; readonly approved: boolean }[]
      readonly files: number
      readonly cases: number
    }

export interface TestPolicyView {
  readonly plan: 'required' | 'optional'
  readonly kinds: readonly string[]
  readonly run: readonly string[]
  readonly runIfRegistered: readonly string[]
  readonly scope: 'changed' | 'full'
  readonly files: 'registered' | 'any'
  readonly scenarios: 'off' | 'required' | 'passing'
  /** 测试完整性策略：notice（缺省）只提示，block 让信号挡住出口。 */
  readonly integrity: 'notice' | 'block'
  readonly coverage?: TestCoverage
  readonly flaky?: { readonly max: number; readonly failOnNew: boolean }
  readonly requireBaseline: boolean
  readonly browsers: readonly string[]
  /** 只在档位（工作流 `test:`）派生的策略上有；旧 `test_policy` 没有。 */
  readonly level?: PolicyLevel
}

/** 策略里的档位：名称、必需类、碰到才跑的类与定义来源（门槛已摊在策略的各字段上）。 */
export interface PolicyLevel {
  readonly name: LevelName
  readonly required: readonly TestClass[]
  readonly touched: readonly TestClass[]
  readonly source: 'catalog' | 'default'
}

export interface TestBlocker {
  readonly code: string
  readonly blocking: boolean
  readonly message: string
  readonly fix?: string
  readonly subject?: string
}

export interface TestNotice {
  readonly code: string
  readonly message: string
  readonly fix?: string
  readonly subject?: string
}

export interface BenchmarkVerdict {
  readonly name: string
  readonly unit?: string
  readonly better: 'lower' | 'higher'
  readonly median: number | null
  readonly p95: number | null
  readonly baseline: number | null
  readonly deltaPct: number | null
  readonly failed: boolean
  readonly baselineMissing: boolean
  readonly noisy: boolean
  readonly details: readonly string[]
}

/** `waived` / `waiver-pending` 只出现在失败后带 `test:<id>` 豁免的步骤测试上：已批准放行 / 等评审批准。 */
export type SuiteState = 'passed' | 'failed' | 'stale' | 'missing' | 'running' | 'waived' | 'waiver-pending'
export type StaleBinding = 'candidate' | 'workflow' | 'catalog' | 'plan' | 'policy'

export interface SuiteVerdict {
  readonly suite: string
  readonly origin: 'catalog' | 'step'
  readonly kind: string
  readonly label?: string
  readonly reason: 'run' | 'if-registered' | 'inline'
  readonly state: SuiteState
  readonly runId?: string
  readonly finishedAt?: string
  readonly staleBecause?: readonly StaleBinding[]
  readonly totals?: TestTotals
  readonly failing?: readonly string[]
  readonly flaky?: readonly string[]
  readonly coverage?: TestCoverage
  readonly benchmark?: readonly BenchmarkVerdict[]
  readonly detail?: string
}

export type TraceCaseStatus = 'pass' | 'fail' | 'skip' | 'flaky' | 'known-fail' | 'not-run'

export interface TraceRow {
  readonly covers: string
  readonly kind: 'spec' | 'task'
  readonly title: string
  /** 任务条目所在的阶段小节 id；场景没有。 */
  readonly stage?: string
  /** 要求映射用例：场景一律；任务只有实现阶段小节里的。false = 可选，不挡。 */
  readonly required: boolean
  readonly tests: readonly { readonly ref: string; readonly status: TraceCaseStatus; readonly suite?: string; readonly runId?: string }[]
  readonly waiver?: { readonly approved: boolean; readonly reason: string }
  readonly state: 'uncovered' | 'mapped' | 'passing' | 'failing' | 'waived'
}

/** 目录里声明的项目级「不适用」种类：approved = 已经评审批准（生效），否则待批准。 */
export interface NotApplicableKind {
  readonly kind: string
  readonly reason: string
  readonly approved: boolean
}

export interface IntegritySignal {
  readonly code: string
  readonly subject: string
  readonly detail: string
  readonly suite?: string
}

/** 测试完整性报告：相对任务起点，证据有没有变弱。 */
export interface IntegrityReport {
  readonly mode: 'notice' | 'block'
  readonly state: 'ok' | 'unavailable'
  readonly reason?: string
  readonly signals: readonly IntegritySignal[]
  readonly truncated?: { readonly found: number; readonly limit: number }
}

/** 一个策略步骤的判定（快照 `testPolicy[]` 的一项）。 */
export interface PolicyReport {
  readonly stepId: string
  readonly pass: boolean
  readonly chain: 'empty' | 'intact' | 'broken'
  readonly policy: TestPolicyView | null
  readonly blockers: readonly TestBlocker[]
  readonly notices: readonly TestNotice[]
  readonly suites: readonly SuiteVerdict[]
  readonly trace: readonly TraceRow[]
  readonly files: {
    readonly checked: boolean
    /** 本任务改动过、被套件 files glob 自动认领的测试文件。 */
    readonly claimed: readonly { readonly path: string; readonly suites: readonly string[] }[]
    /** 像测试却没有任何套件认领的改动文件。 */
    readonly orphans: readonly string[]
  }
  /** 服务端从目录读出的项目级不适用声明；展示只据此区分「不适用」与「缺」，不自己重新判定。 */
  readonly notApplicable: readonly NotApplicableKind[]
  /** 步骤会运行测试（或声明了 integrity: block）且服务端读到了改动行时才有。 */
  readonly integrity?: IntegrityReport
}
