/**
 * 测试体系的客户端响应类型（camelCase）。与 server 的 testSystemDtoTypes.ts 是同一份契约的两端声明，
 * 由 testSystemDecoders.ts 的严格解码器保证：形状不合即拒绝，不猜测、不补默认值。
 */

export interface TestCoverage {
  readonly lines?: number
  readonly branches?: number
  readonly functions?: number
  readonly statements?: number
  readonly changedLines?: number
}

export interface TestTotals {
  readonly cases: number
  readonly pass: number
  readonly fail: number
  readonly skip: number
  readonly flaky: number
  readonly knownFail: number
}

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
  | { readonly state: 'ok'; readonly suites: readonly CatalogSuite[]; readonly services: readonly CatalogService[] }

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
      readonly waivers: readonly { readonly kind?: string; readonly covers?: string; readonly reason: string; readonly approvedBy: string | null }[]
    }

/** 快照里的计划概要（矩阵只需要登记了哪些套件与豁免）。 */
export type TestPlanBrief =
  | { readonly state: 'missing' }
  | { readonly state: 'tampered'; readonly reason: string }
  | {
      readonly state: 'ok'
      readonly suites: readonly { readonly suite: string; readonly kind: string | null; readonly scope: string }[]
      readonly waivers: readonly { readonly kind?: string; readonly covers?: string; readonly approved: boolean }[]
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
  readonly coverage?: TestCoverage
  readonly flaky?: { readonly max: number; readonly failOnNew: boolean }
  readonly requireBaseline: boolean
  readonly browsers: readonly string[]
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

export type SuiteState = 'passed' | 'failed' | 'stale' | 'missing' | 'running'
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
  readonly tests: readonly { readonly ref: string; readonly status: TraceCaseStatus; readonly suite?: string; readonly runId?: string }[]
  readonly waiver?: { readonly approved: boolean; readonly reason: string }
  readonly state: 'uncovered' | 'mapped' | 'passing' | 'failing' | 'waived'
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
    readonly unregistered: readonly { readonly path: string; readonly suites: readonly string[] }[]
    readonly orphans: readonly string[]
  }
}

export interface RunArtifact {
  readonly path: string
  readonly bytes: number
  readonly media: 'image' | 'video' | 'trace' | 'html' | 'json' | 'text' | 'other'
  readonly entry: boolean
  readonly present: boolean
}

export type CaseStatus = 'pass' | 'fail' | 'skip' | 'flaky' | 'known-fail'

export interface RunCase {
  readonly file: string
  readonly line?: number
  readonly name: string
  readonly suitePath: readonly string[]
  readonly project: string | null
  readonly status: CaseStatus
  readonly durationMs: number
  readonly attempts: number
  readonly failure?: { readonly message: string; readonly stack?: string; readonly expected?: string; readonly actual?: string }
  readonly artifacts: readonly string[]
}

export interface RunMetric {
  readonly name: string
  readonly unit?: string
  readonly better: 'lower' | 'higher'
  readonly median: number
  readonly p95: number
  readonly mad: number
  readonly samples: number
}

export interface SuiteRun {
  readonly suite: string
  readonly origin: 'catalog' | 'step'
  readonly kind: string
  readonly runner: string
  readonly scope: string
  readonly command: string
  readonly cwd: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  readonly result: 'pass' | 'fail'
  readonly reasons: readonly { readonly code: string; readonly detail?: string }[]
  readonly totals: TestTotals
  readonly cases: readonly RunCase[]
  readonly casesTruncated: boolean
  readonly projects: readonly string[]
  readonly coverage: TestCoverage | null
  readonly metrics: readonly RunMetric[]
  readonly artifacts: readonly RunArtifact[]
  readonly artifactsTruncated: boolean
  readonly log: { readonly artifact: string; readonly bytesTotal: number; readonly bytesKept: number; readonly truncated: boolean; readonly present: boolean }
}

export interface RunService {
  readonly id: string
  readonly readyMs: number | null
  readonly exit: string
  readonly log: string | null
  readonly logPresent: boolean
  readonly leaked: number
}

export interface RecordDetail {
  readonly user: string
  readonly trusted: boolean
  readonly runId: string
  readonly change: string
  readonly step: string
  readonly workflow: string
  readonly track: string
  readonly result: 'pass' | 'fail'
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly machineProfile: string
  readonly machineLabel: string
  /** 本次运行的产物目录（相对项目根，正斜杠）。 */
  readonly artifactsDir: string
  readonly actor: { readonly id: string; readonly name: string }
  readonly services: readonly RunService[]
  readonly suites: readonly SuiteRun[]
}

export interface RecordSummary {
  readonly user: string
  readonly trusted: boolean
  readonly runId: string
  readonly step: string
  readonly result: 'pass' | 'fail'
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly machineLabel: string
  readonly actor: { readonly id: string; readonly name: string }
  readonly suites: readonly {
    readonly suite: string
    readonly kind: string
    readonly scope: string
    readonly result: 'pass' | 'fail'
    readonly totals: TestTotals
    readonly coverage: TestCoverage | null
  }[]
}

export interface RecordListResponse {
  readonly users: readonly { readonly user: string; readonly chain: 'empty' | 'intact' | 'broken'; readonly reason?: string }[]
  readonly runs: readonly RecordSummary[]
}
