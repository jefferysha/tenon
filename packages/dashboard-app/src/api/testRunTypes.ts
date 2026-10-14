/**
 * 测试运行记录的客户端响应类型（camelCase）：用例计数、覆盖率与一次运行的明细 / 列表。
 * 从 testSystemTypes.ts 拆出（那里 re-export 这些名字，导入方不用改），同样由 testSystemDecoders.ts 严格解码。
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
