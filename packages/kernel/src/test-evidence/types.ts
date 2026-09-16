/**
 * 测试运行记录与基准的线上形状（snake_case，追加式版本化）。记录由 `tenon test run` 独占写入；
 * 摘要进 git，完整日志与大文件只留本机（gitignored `local/`）。
 */
import type { RecordActor } from '../users/user.js'
import type { TestOutputKind } from '../workflow/types.js'

export const TEST_RUN_SCHEMA = 'tenon-test-run-v1'
export const TEST_BASELINE_SCHEMA = 'tenon-test-baseline-v1'
export const TEST_RUN_ID_RE = /^\d{8}T\d{6}Z-[a-f0-9]{6}$/
export const TEST_LOG_ARTIFACT = 'output.log'
export const BASELINE_HISTORY_LIMIT = 20

export const TEST_RUN_REASON_CODES = [
  'exit-code', 'command-not-found', 'not-executable', 'spawn-error', 'cwd-invalid', 'timeout',
  'interrupted', 'output-missing', 'metric-unreadable', 'metric-threshold', 'metric-regression',
  'candidate-unavailable', 'sandbox-denied', 'workspace-changed', 'log-truncated',
  'baseline-missing', 'baseline-mismatch',
] as const

export type TestRunReasonCode = (typeof TEST_RUN_REASON_CODES)[number]

/** 只有这些原因判失败；其余是提示（记录里保留，不影响结论）。 */
export const FAILING_TEST_REASONS: ReadonlySet<TestRunReasonCode> = new Set<TestRunReasonCode>([
  'exit-code', 'command-not-found', 'not-executable', 'spawn-error', 'cwd-invalid', 'timeout',
  'interrupted', 'output-missing', 'metric-unreadable', 'metric-threshold', 'metric-regression',
  'candidate-unavailable', 'sandbox-denied',
])

export type TestHostKind = 'claude-code' | 'codex' | 'terminal'

export interface TestRunReason { readonly code: TestRunReasonCode; readonly detail?: string }

export type TestInputRecord =
  | {
      readonly kind: 'document'
      readonly ref: string
      readonly present: boolean
      readonly entries: readonly { readonly path: string; readonly digest: string }[]
    }
  | { readonly kind: 'file'; readonly path: string; readonly present: boolean; readonly digest: string | null; readonly files: number }
  | { readonly kind: 'env'; readonly name: string; readonly present: boolean; readonly digest: string | null }
  | { readonly kind: 'service'; readonly name: string; readonly url?: string }

export interface TestOutputRecord {
  readonly path: string
  readonly kind: TestOutputKind
  readonly required: boolean
  readonly present: boolean
  readonly digest: string | null
  readonly bytes: number
  readonly files: number
  /** run 目录内的副本相对路径；未复制时 null。 */
  readonly artifact: string | null
}

export interface TestMetricRecord {
  readonly name: string
  readonly value: number | null
  readonly baseline: number | null
  readonly delta_pct: number | null
  readonly max?: number
  readonly min?: number
  readonly max_regression_pct?: number
  readonly better: 'lower' | 'higher'
  readonly ok: boolean
}

export interface TestRunLog {
  readonly artifact: string
  readonly bytes_total: number
  readonly bytes_kept: number
  readonly truncated: boolean
  readonly digest: string
}

export interface TestRunRecordV1 {
  readonly schema: typeof TEST_RUN_SCHEMA
  readonly run_id: string
  readonly change: string
  readonly workflow_run_id: string
  readonly workflow: string
  readonly workflow_fingerprint: string
  readonly track: string
  readonly step: string
  readonly step_visit: { readonly run_id: string; readonly transition_sequence: number }
  readonly test_id: string
  readonly test_digest: string
  readonly direction: string
  readonly label?: string
  readonly command: string
  readonly cwd: string
  readonly timeout_s: number
  readonly required: boolean
  readonly actor: RecordActor
  readonly host: { readonly kind: TestHostKind; readonly sandbox: string | null }
  readonly candidate_before: string | null
  readonly candidate: string | null
  readonly git_head: string | null
  readonly build_sha: string | null
  readonly started_at: string
  readonly finished_at: string
  readonly duration_ms: number
  readonly exit_code: number | null
  readonly signal: string | null
  readonly result: 'pass' | 'fail'
  readonly reasons: readonly TestRunReason[]
  readonly inputs: readonly TestInputRecord[]
  readonly outputs: readonly TestOutputRecord[]
  readonly metrics: readonly TestMetricRecord[]
  readonly log: TestRunLog
}

export interface TestBaselineEntry {
  readonly command: string
  readonly cwd: string
  readonly metrics: Readonly<Record<string, number>>
  readonly source: { readonly change: string; readonly run_id: string }
  readonly actor: RecordActor
  readonly updated_at: string
}

export interface TestBaselineV1 extends TestBaselineEntry {
  readonly schema: typeof TEST_BASELINE_SCHEMA
  readonly test_id: string
  /** 历史条目，新的在前，≤20；与被跟踪文件的 git 历史一起构成基准留痕。 */
  readonly history: readonly TestBaselineEntry[]
}

/** 运行中标记（gitignored）。没有 pid 探测：Codex 里 `/bin/ps` 与跨进程 kill 都不可靠。 */
export interface TestRunningMarker {
  readonly run_id: string
  readonly pid: number
  readonly started_at: string
  readonly deadline_at: string
}

/** 过期标记的回收宽限：命令已经超时被杀，再等一分钟仍无人收尾就认定可以重跑。 */
export const RUNNING_MARKER_GRACE_MS = 60_000

export function testRunFailed(reasons: readonly TestRunReason[]): boolean {
  return reasons.some((reason) => FAILING_TEST_REASONS.has(reason.code))
}
