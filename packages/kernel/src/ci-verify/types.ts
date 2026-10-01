/**
 * `tenon verify --ci` 的报告形状。CI 没有用户本机的封存（HMAC 链头、人工批准），所以报告只陈述
 * 「对已提交内容独立重算得到了什么」，并把「CI 验证不了什么」作为报告的固定组成部分带出。
 */

export const CI_REPORT_SCHEMA = 'tenon-verify-ci/v1'

export type CiSeverity = 'error' | 'warning' | 'note'
/** `policy` = 来自步骤测试策略判定的阻塞 / 提示；`ci` = CI 独有的检查。 */
export type CiFindingSource = 'ci' | 'policy'

export interface CiFinding {
  /** 稳定码：策略阻塞码（`test-stale` …）或 CI 独有码（`candidate-mismatch` …）。 */
  readonly code: string
  readonly severity: CiSeverity
  readonly change: string | null
  readonly message: string
  /** 仓库相对路径（SARIF 的位置）；不知道时缺省，渲染层用任务的 `.pipeline.yaml` 兜底。 */
  readonly path?: string
  readonly fix?: string
  /** 涉及的对象：套件 id、种类、文件路径等；参与 SARIF 指纹。 */
  readonly subject?: string
  readonly source: CiFindingSource
}

/** 锚点判定：`none` 没有锚点；`verified` 链头一致；`behind` 锚点之后又追加了记录；`unverifiable` 锚点链头不在链里但链被清理过；`mismatch` 链被重写。 */
export type AnchorState = 'none' | 'verified' | 'behind' | 'unverifiable' | 'mismatch'

export interface CiChainSummary {
  /** 用户目录名（slug）。 */
  readonly user: string
  readonly state: 'empty' | 'intact' | 'broken'
  readonly head: string | null
  readonly records: number
}

export interface CiChangeReport {
  readonly change: string
  /** 任务目录（仓库相对路径，活跃或归档）。 */
  readonly dir: string
  readonly phase: string | null
  /** 判定用的步骤；任务状态读不出时 null。 */
  readonly step: string | null
  /** 步骤没有声明测试策略 = `none`，不是通过的证据。 */
  readonly policy: 'pass' | 'fail' | 'none'
  /** 判定用的链属于哪个用户目录；没有任何链时 null。 */
  readonly evaluatedUser: string | null
  readonly chains: readonly CiChainSummary[]
  readonly anchor: AnchorState
  readonly findings: readonly CiFinding[]
}

export interface CiTrust {
  /** 本次实际重算并通过 / 报告了的校验。 */
  readonly verified: readonly string[]
  /** 没有本机 HMAC 密钥就无法在 CI 里证明的事。 */
  readonly unverifiable: readonly string[]
}

export type CiSelector =
  | { readonly kind: 'change'; readonly change: string }
  | { readonly kind: 'all-open' }
  | { readonly kind: 'since'; readonly ref: string }

export type CandidateMode = 'error' | 'warn' | 'off'

export interface CiVerifyOptions {
  readonly candidate: CandidateMode
  readonly requireAnchor: boolean
}

export interface CiSummary {
  readonly changes: number
  readonly errors: number
  readonly warnings: number
  readonly notes: number
  readonly pass: boolean
}

export interface CiVerifyReport {
  readonly schema: typeof CI_REPORT_SCHEMA
  readonly tenon: string
  readonly generated_at: string
  readonly head: string | null
  readonly selector: CiSelector
  readonly options: CiVerifyOptions
  readonly changes: readonly CiChangeReport[]
  /** 不属于任何任务的发现（选择器、仓库级问题）。 */
  readonly findings: readonly CiFinding[]
  readonly summary: CiSummary
  readonly trust: CiTrust
}

export function allFindings(report: Pick<CiVerifyReport, 'changes' | 'findings'>): readonly CiFinding[] {
  return [...report.findings, ...report.changes.flatMap((change) => change.findings)]
}

export function summarizeFindings(findings: readonly CiFinding[], changes: number): CiSummary {
  const count = (severity: CiSeverity): number => findings.filter((item) => item.severity === severity).length
  const errors = count('error')
  return { changes, errors, warnings: count('warning'), notes: count('note'), pass: errors === 0 }
}
