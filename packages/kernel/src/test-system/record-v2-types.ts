/**
 * 运行记录 v2 的线上形状（snake_case）。每次 `tenon test run` 调用写一份，内含多个套件的结果、
 * 用例、覆盖率、基准指标、服务与产物索引；与候选代码指纹、目录摘要、计划摘要、策略摘要和工作流指纹
 * 绑定，并按 `prev_digest` 串成每用户每任务一条的哈希链。v1 记录（tenon-test-run-v1）继续可读，
 * 只参与旧步骤内联测试的判定。
 *
 * 用例列表只保留失败、flaky、已知失败以及计划登记的文件 / 映射里的用例全量；其余只进 totals 计数，
 * 大型套件不会让记录膨胀。「已登记用例未执行」的判定依赖这一约定，写入方必须遵守。
 */
import type { RecordActor } from '../users/user.js'
import type { TestHostKind, TestRunLog } from '../test-evidence/types.js'
import type { ReportFormat, RunScope, TestKind, TestRunner } from './vocabulary.js'

export const TEST_RUN_V2_SCHEMA = 'tenon-test-run-v2'

export const SUITE_REASON_CODES = [
  'test-failed', 'no-tests-ran', 'report-missing', 'report-unreadable', 'report-untrusted', 'exit-report-mismatch',
  'registered-test-not-executed', 'coverage-below', 'coverage-unreadable', 'benchmark-regression',
  'baseline-missing', 'flaky-over-limit', 'browser-project-missing', 'service-not-ready',
  'exit-code', 'command-not-found', 'not-executable', 'spawn-error', 'cwd-invalid', 'timeout', 'interrupted',
  'sandbox-denied', 'candidate-unavailable', 'workspace-changed', 'log-truncated', 'artifact-truncated',
] as const
export type SuiteReasonCode = (typeof SUITE_REASON_CODES)[number]

/** 只作提示、不判失败的原因；baseline-missing 是否阻塞由阶段策略决定，不在记录层定。 */
export const ADVISORY_SUITE_REASONS: ReadonlySet<SuiteReasonCode> = new Set<SuiteReasonCode>([
  'baseline-missing', 'workspace-changed', 'log-truncated', 'artifact-truncated',
])

export interface SuiteReason {
  readonly code: SuiteReasonCode
  readonly detail?: string
}

export const CASE_STATUSES = ['pass', 'fail', 'skip', 'flaky', 'known-fail'] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]

export interface CaseFailure {
  readonly message: string
  readonly stack?: string
  readonly expected?: string
  readonly actual?: string
}

export interface CaseResultV2 {
  /** 报告内稳定标识（缺省用 `<文件> › <标题路径>`）。 */
  readonly id: string
  readonly file: string
  readonly line?: number
  readonly name: string
  /** 从外到内的分组标题（describe …）。 */
  readonly suite_path: readonly string[]
  /** Playwright project（浏览器）；非浏览器套件为 null。 */
  readonly project: string | null
  readonly status: CaseStatus
  readonly duration_ms: number
  readonly attempts: number
  readonly failure?: CaseFailure
  /** 指向本记录产物索引里的路径（截图、trace、视频、差异图）。 */
  readonly artifacts: readonly string[]
}

export interface CaseTotals {
  readonly cases: number
  readonly pass: number
  readonly fail: number
  readonly skip: number
  readonly flaky: number
  readonly known_fail: number
}

export const ARTIFACT_MEDIA = ['image', 'video', 'trace', 'html', 'json', 'text', 'other'] as const
export type ArtifactMedia = (typeof ARTIFACT_MEDIA)[number]

export interface ArtifactIndexEntry {
  /** 相对本次运行产物目录的路径。 */
  readonly path: string
  readonly bytes: number
  readonly digest: string
  readonly media: ArtifactMedia
  /** HTML 报告的入口文件。 */
  readonly entry?: true
}

export interface CoverageResult {
  readonly lines?: number
  readonly branches?: number
  readonly functions?: number
  readonly statements?: number
  readonly changed_lines?: number
}

export interface BenchmarkMetricResult {
  readonly name: string
  readonly unit?: string
  readonly better: 'lower' | 'higher'
  readonly samples: readonly number[]
  readonly median: number
  readonly p95: number
  readonly mad: number
}

export const SERVICE_EXITS = ['stopped', 'crashed', 'not-ready', 'leaked'] as const
export type ServiceExit = (typeof SERVICE_EXITS)[number]

export interface ServiceRunV2 {
  readonly id: string
  readonly ready_ms: number | null
  readonly exit: ServiceExit
  /** 相对本次运行产物目录的服务日志；未保留时 null。 */
  readonly log: string | null
  readonly leaked_pids: readonly number[]
}

export interface SuiteReportRef {
  readonly format: ReportFormat
  /** 仓库相对路径；exit-code 格式为 null。 */
  readonly path: string | null
  readonly digest: string | null
}

export interface SuiteRunV2 {
  /** 目录套件 id，或旧步骤测试编译出的 `step:<test-id>`。 */
  readonly suite: string
  readonly origin: 'catalog' | 'step'
  readonly kind: TestKind
  readonly runner: TestRunner
  readonly scope: RunScope
  /** scope files 的文件或 grep 的模式；full / changed 按实际选中的文件列出（可为空）。 */
  readonly selection: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly exit_code: number | null
  readonly signal: string | null
  readonly duration_ms: number
  readonly result: 'pass' | 'fail'
  readonly reasons: readonly SuiteReason[]
  readonly totals: CaseTotals
  readonly cases: readonly CaseResultV2[]
  /** 报告里出现过的 Playwright project。 */
  readonly projects: readonly string[]
  readonly coverage: CoverageResult | null
  readonly metrics: readonly BenchmarkMetricResult[]
  readonly artifacts: readonly ArtifactIndexEntry[]
  readonly report: SuiteReportRef
  readonly log: TestRunLog
}

export interface ChainReset {
  /** 被取代的记录文件名（`<run-id>.json` 或无法读取的文件名），升序。 */
  readonly superseded: readonly string[]
}

export interface RecordBindings {
  /** 候选代码指纹；宿主取不到时 null（判定按未知处理，视为过期）。 */
  readonly candidate: string | null
  readonly workflow_fingerprint: string
  /** 本次运行涉及的目录套件摘要（catalogSuitesDigest）；只跑内联套件时 null。 */
  readonly catalog_digest: string | null
  readonly plan_digest: string | null
  /** 运行所在步骤的测试策略摘要；步骤无策略时 null。 */
  readonly policy_digest: string | null
}

export interface TestRunRecordV2 {
  readonly schema: typeof TEST_RUN_V2_SCHEMA
  readonly run_id: string
  readonly change: string
  readonly workflow_run_id: string
  readonly workflow: string
  readonly track: string
  readonly step: string
  readonly bindings: RecordBindings
  readonly machine_profile: string
  readonly machine_label: string
  readonly services: readonly ServiceRunV2[]
  readonly suites: readonly SuiteRunV2[]
  readonly result: 'pass' | 'fail'
  readonly actor: RecordActor
  readonly host: { readonly kind: TestHostKind; readonly sandbox: string | null }
  readonly git_head: string | null
  readonly started_at: string
  readonly finished_at: string
  readonly duration_ms: number
  /** 上一条记录的 digest；链首为 null。 */
  readonly prev_digest: string | null
  /**
   * 链断后重跑时另起新链：列出当时目录里全部 v2 记录与无法读取的文件名，它们从此被新链取代、
   * 一律视为未运行；新链之外再出现的任何记录或坏文件都判链断。
   */
  readonly chain_reset?: ChainReset
  /** 本条内容（除 digest 外全部字段）的规范 JSON 摘要。 */
  readonly digest: string
}

/** 写入方构造的草稿：链字段与摘要由 appendTestRunRecordV2 在锁内补齐。 */
export type TestRunRecordV2Draft = Omit<TestRunRecordV2, 'prev_digest' | 'chain_reset' | 'digest'>
