/**
 * `tenon verify --ci` 报告的装配：汇总、固定的信任边界陈述、退出码。
 * 「CI 验证不了什么」是报告的固定组成部分，不是可选脚注：每份 text / markdown / json / SARIF 都带着它。
 */
import type { CiText } from './text.js'
import {
  CI_REPORT_SCHEMA, allFindings, summarizeFindings,
  type CiChangeReport, type CiFinding, type CiSelector, type CiTrust, type CiVerifyOptions, type CiVerifyReport,
} from './types.js'

export const CI_EXIT_PASS = 0
export const CI_EXIT_FAIL = 2

/** 没有用户本机 HMAC 密钥（本机目录里被 gitignore 的 env.key 与封存文件）就无法在 CI 里证明的事。 */
export function ciUnverifiable(text: CiText): readonly string[] {
  return [
    text('trust.unverifiable.records'),
    text('trust.unverifiable.approvals'),
    text('trust.unverifiable.reports'),
    text('trust.unverifiable.identity'),
  ]
}

export function ciTrust(options: CiVerifyOptions, anchored: boolean, text: CiText): CiTrust {
  return {
    verified: [
      text('trust.verified.chain'),
      text('trust.verified.consistent'),
      text('trust.verified.plan'),
      text('trust.verified.policy'),
      options.candidate === 'off'
        ? text('trust.verified.candidateOff')
        : text(options.candidate === 'warn' ? 'trust.verified.candidateWarn' : 'trust.verified.candidate'),
      text('trust.verified.protected'),
      text('trust.verified.integrity'),
      anchored ? text('trust.verified.anchor') : text('trust.verified.anchorNone'),
    ],
    unverifiable: ciUnverifiable(text),
  }
}

export function buildCiReport(input: {
  readonly tenon: string
  readonly generatedAt: string
  readonly head: string | null
  readonly selector: CiSelector
  readonly options: CiVerifyOptions
  readonly changes: readonly CiChangeReport[]
  readonly findings: readonly CiFinding[]
  /** 固定文案的文本源（语言由调用方定）。 */
  readonly text: CiText
}): CiVerifyReport {
  const partial = { changes: input.changes, findings: input.findings }
  return {
    schema: CI_REPORT_SCHEMA,
    tenon: input.tenon,
    generated_at: input.generatedAt,
    head: input.head,
    selector: input.selector,
    options: input.options,
    changes: input.changes,
    findings: input.findings,
    summary: summarizeFindings(allFindings(partial), input.changes.length),
    trust: ciTrust(input.options, input.changes.some((change) => change.anchor !== 'none'), input.text),
  }
}

export function ciExitCode(report: Pick<CiVerifyReport, 'summary'>): number {
  return report.summary.pass ? CI_EXIT_PASS : CI_EXIT_FAIL
}
