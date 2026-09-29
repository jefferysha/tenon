/**
 * 测试体系的 HTTP 响应形状（camelCase）。响应对象只含 Dashboard 展示所需的最小字段，不透传 kernel 记录；
 * 摘要、绝对路径和环境变量值永远不出现在响应里。kernel 记录（snake_case）到这些形状的转换在
 * testSystemDto.ts 与 testPolicyDto.ts，IO 在 testSystemReads.ts。
 */

export const MAX_DTO_CASES = 500
export const MAX_DTO_TRACE_ROWS = 200
export const MAX_DTO_BLOCKERS = 200

export interface CoverageDto {
  readonly lines?: number
  readonly branches?: number
  readonly functions?: number
  readonly statements?: number
  readonly changedLines?: number
}

export interface TotalsDto {
  readonly cases: number
  readonly pass: number
  readonly fail: number
  readonly skip: number
  readonly flaky: number
  readonly knownFail: number
}

export interface MetricSpecDto {
  readonly name: string
  readonly unit?: string
  readonly better: 'lower' | 'higher'
  readonly maxRegressionPct?: number
  readonly max?: number
  readonly min?: number
}

export interface CatalogSuiteDto {
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
  readonly benchmark?: { readonly runs: number; readonly warmup: number; readonly metrics: readonly MetricSpecDto[] }
}

export interface CatalogServiceDto {
  readonly id: string
  readonly start: string
  readonly cwd: string
  readonly ready: { readonly kind: 'url' | 'port' | 'log'; readonly value: string | number; readonly timeoutS: number }
  readonly stop: string
}

export type CatalogDto =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly issues: readonly string[] }
  | {
      readonly state: 'ok'
      readonly suites: readonly CatalogSuiteDto[]
      readonly services: readonly CatalogServiceDto[]
    }

export interface KnownFailureDto {
  readonly suite: string
  readonly test: string
  readonly reason: string
  readonly link?: string
  readonly expires: string
  readonly addedBy: string
  readonly expired: boolean
}

export type KnownFailuresDto =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly issues: readonly string[] }
  | { readonly state: 'ok'; readonly entries: readonly KnownFailureDto[] }

export interface SuiteLatestDto {
  readonly suite: string
  readonly runId: string
  readonly change: string
  readonly user: string
  readonly finishedAt: string
  readonly result: 'pass' | 'fail'
  readonly totals: TotalsDto
}

export interface BaselineMetricDto {
  readonly median: number
  readonly p95: number
  readonly mad: number
  readonly samples: number
  readonly better: 'lower' | 'higher'
  readonly unit?: string
}

export interface BaselineHistoryDto {
  readonly updatedAt: string
  readonly metrics: Readonly<Record<string, BaselineMetricDto>>
}

export interface BaselineDto extends BaselineHistoryDto {
  readonly profile: string
  readonly profileLabel: string
  readonly source: { readonly change: string; readonly runId: string; readonly commit: string | null }
  readonly history: readonly BaselineHistoryDto[]
}

export type PlanDto =
  | { readonly state: 'missing' }
  | { readonly state: 'tampered'; readonly reason: string }
  | {
      readonly state: 'ok'
      readonly suites: readonly { readonly suite: string; readonly kind: string | null; readonly scope: string; readonly pattern?: string }[]
      readonly files: readonly { readonly path: string; readonly suite?: string; readonly kind?: string }[]
      readonly cases: readonly { readonly covers: string; readonly tests: readonly string[] }[]
      readonly waivers: readonly { readonly kind?: string; readonly covers?: string; readonly reason: string; readonly approvedBy: string | null }[]
    }

/** 快照里的计划概要：矩阵只需要知道登记了哪些套件（含种类）和豁免；文件与映射在 /api/tests/plan。 */
export type PlanBriefDto =
  | { readonly state: 'missing' }
  | { readonly state: 'tampered'; readonly reason: string }
  | {
      readonly state: 'ok'
      readonly suites: readonly { readonly suite: string; readonly kind: string | null; readonly scope: string }[]
      readonly waivers: readonly { readonly kind?: string; readonly covers?: string; readonly approved: boolean }[]
      readonly files: number
      readonly cases: number
    }

export interface PolicyDto {
  readonly plan: 'required' | 'optional'
  readonly kinds: readonly string[]
  readonly run: readonly string[]
  readonly runIfRegistered: readonly string[]
  readonly scope: 'changed' | 'full'
  readonly files: 'registered' | 'any'
  readonly scenarios: 'off' | 'required' | 'passing'
  readonly coverage?: CoverageDto
  readonly flaky?: { readonly max: number; readonly failOnNew: boolean }
  readonly requireBaseline: boolean
  readonly browsers: readonly string[]
}

export interface BlockerDto {
  readonly code: string
  readonly blocking: boolean
  readonly message: string
  readonly fix?: string
  readonly subject?: string
}

export interface NoticeDto {
  readonly code: string
  readonly message: string
  readonly fix?: string
  readonly subject?: string
}

export interface BenchmarkVerdictDto {
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

export interface SuiteVerdictDto {
  readonly suite: string
  readonly origin: 'catalog' | 'step'
  readonly kind: string
  readonly label?: string
  readonly reason: 'run' | 'if-registered' | 'inline'
  readonly state: 'passed' | 'failed' | 'stale' | 'missing' | 'running'
  readonly runId?: string
  readonly finishedAt?: string
  readonly staleBecause?: readonly string[]
  readonly totals?: TotalsDto
  readonly failing?: readonly string[]
  readonly flaky?: readonly string[]
  readonly coverage?: CoverageDto
  readonly benchmark?: readonly BenchmarkVerdictDto[]
  readonly detail?: string
}

export interface TraceRowDto {
  readonly covers: string
  readonly kind: 'spec' | 'task'
  readonly title: string
  readonly tests: readonly { readonly ref: string; readonly status: string; readonly suite?: string; readonly runId?: string }[]
  readonly waiver?: { readonly approved: boolean; readonly reason: string }
  readonly state: 'uncovered' | 'mapped' | 'passing' | 'failing' | 'waived'
}

export interface PolicyReportDto {
  readonly stepId: string
  readonly pass: boolean
  readonly chain: 'empty' | 'intact' | 'broken'
  readonly policy: PolicyDto | null
  readonly blockers: readonly BlockerDto[]
  readonly notices: readonly NoticeDto[]
  readonly suites: readonly SuiteVerdictDto[]
  readonly trace: readonly TraceRowDto[]
  readonly files: {
    readonly checked: boolean
    readonly unregistered: readonly { readonly path: string; readonly suites: readonly string[] }[]
    readonly orphans: readonly string[]
  }
}

export interface ArtifactDto {
  readonly path: string
  readonly bytes: number
  readonly media: string
  readonly entry: boolean
  /** 本机文件是否仍在（保留策略可能已清理）。 */
  readonly present: boolean
}

export interface CaseDto {
  readonly file: string
  readonly line?: number
  readonly name: string
  readonly suitePath: readonly string[]
  readonly project: string | null
  readonly status: string
  readonly durationMs: number
  readonly attempts: number
  readonly failure?: { readonly message: string; readonly stack?: string; readonly expected?: string; readonly actual?: string }
  readonly artifacts: readonly string[]
}

export interface SuiteRunDto {
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
  readonly totals: TotalsDto
  readonly cases: readonly CaseDto[]
  readonly casesTruncated: boolean
  readonly projects: readonly string[]
  readonly coverage: CoverageDto | null
  readonly metrics: readonly { readonly name: string; readonly unit?: string; readonly better: 'lower' | 'higher'; readonly median: number; readonly p95: number; readonly mad: number; readonly samples: number }[]
  readonly artifacts: readonly ArtifactDto[]
  readonly artifactsTruncated: boolean
  readonly log: { readonly artifact: string; readonly bytesTotal: number; readonly bytesKept: number; readonly truncated: boolean; readonly present: boolean }
}

export interface ServiceRunDto {
  readonly id: string
  readonly readyMs: number | null
  readonly exit: string
  readonly log: string | null
  readonly logPresent: boolean
  readonly leaked: number
}

export interface RecordSummaryDto {
  readonly user: string
  /** 记录在当前完好的哈希链上；false = 断链或已被取代，视为未运行。 */
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
    readonly totals: TotalsDto
    readonly coverage: CoverageDto | null
  }[]
}

export interface RecordDetailDto {
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
  /** 本次运行的产物目录（相对项目根，正斜杠）：复制 `npx playwright show-trace <路径>` 用，不含绝对路径。 */
  readonly artifactsDir: string
  readonly actor: { readonly id: string; readonly name: string }
  readonly services: readonly ServiceRunDto[]
  readonly suites: readonly SuiteRunDto[]
}
