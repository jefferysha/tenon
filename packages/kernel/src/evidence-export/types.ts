/**
 * 证据导出的输入：一个任务在某个提交上的事实快照（EvidenceBundle）。装配（读状态、记录链、历史、agent 台账、git）
 * 在 CLI 层；四种格式（Agent Trace、OTel、git notes、提交尾注）都是 bundle 的纯函数，所以同一份输入得到同一份输出。
 */
import type { CaseTotals } from '../test-system/record-v2-types.js'

export interface EvidenceSuiteSummary {
  readonly suite: string
  readonly kind: string
  readonly scope: string
  readonly result: 'pass' | 'fail'
  readonly duration_ms: number
  readonly totals: CaseTotals
  readonly coverage_lines: number | null
}

export interface EvidenceRecordSummary {
  readonly run_id: string
  readonly step: string
  readonly started_at: string
  readonly finished_at: string
  readonly result: 'pass' | 'fail'
  readonly digest: string
  readonly suites: readonly EvidenceSuiteSummary[]
}

export interface EvidenceAgentRun {
  readonly run_id: string
  readonly agent: string
  readonly role: 'executor' | 'reviewer'
  readonly step: string
  readonly result: string | null
  readonly findings: number
  readonly started_at: string
  readonly finished_at: string | null
  /** Tenon 宿主 id（claude / codex …）；旧台账行没有。 */
  readonly host: string | null
}

export interface EvidenceStepVisit {
  readonly step: string
  readonly entered_at: string
  readonly left_at: string | null
}

export interface EvidenceLineRange {
  readonly start_line: number
  readonly end_line: number
}

export interface EvidenceFileChange {
  readonly path: string
  /** 该文件新增 / 改动后的行区间（工作区口径）。 */
  readonly ranges: readonly EvidenceLineRange[]
}

export interface EvidenceBundle {
  readonly tenon: string
  readonly change: string
  readonly workflow: string
  readonly track: string
  readonly phase: string
  readonly owner: string | null
  readonly created_at: string | null
  /** 导出时刻（由命令的时钟给出）。 */
  readonly exported_at: string
  /** 40 位 git 提交。 */
  readonly commit: string
  readonly chain: {
    /** 记录链所属的用户目录名。 */
    readonly user: string
    readonly head: string
    readonly records: number
  }
  readonly last_result: 'pass' | 'fail'
  readonly plan_digest: string | null
  readonly records: readonly EvidenceRecordSummary[]
  readonly agents: readonly EvidenceAgentRun[]
  readonly steps: readonly EvidenceStepVisit[]
  readonly files: readonly EvidenceFileChange[]
  /** 文件或区间超过导出上限被截断。 */
  readonly files_truncated: boolean
}
