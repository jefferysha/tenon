/**
 * `tenon verify --ci` 报告的人读渲染：text（终端 / CI 日志）与 markdown（GitHub 作业摘要）。
 * 两份都以结论开头，逐任务列发现，最后固定陈述 CI 验证了什么、验证不了什么。
 * 固定文案按键取（text.ts），语言由调用方给的文本源决定；`[FAIL]` / `[WARN]` / `[NOTE]` 标记与 PASS / FAIL 不翻译。
 */
import type { CiText } from './text.js'
import { CI_REPORT_SCHEMA, type CiChangeReport, type CiFinding, type CiSeverity, type CiVerifyReport } from './types.js'

const MARK: Readonly<Record<CiSeverity, string>> = { error: 'FAIL', warning: 'WARN', note: 'NOTE' }

function selectorText(report: CiVerifyReport): string {
  const selector = report.selector
  return selector.kind === 'change' ? `--change ${selector.change}`
    : selector.kind === 'since' ? `--since ${selector.ref}` : '--all-open'
}

function headline(report: CiVerifyReport, text: CiText): string {
  const { summary } = report
  return text('headline', {
    verdict: text(summary.pass ? 'verdict.pass' : 'verdict.fail'),
    changes: summary.changes, errors: summary.errors, warnings: summary.warnings, selector: selectorText(report),
  })
}

function findingLine(item: CiFinding, text: CiText): string {
  const where = item.path === undefined ? '' : ` [${item.path}]`
  const fix = item.fix === undefined ? '' : text('fixSuffix', { fix: item.fix })
  return `${item.message}${where}${fix}`
}

function chainText(change: CiChangeReport, text: CiText): string {
  if (change.chains.length === 0) return text('chain.none')
  return change.chains.map((chain) =>
    `${chain.user}:${chain.state === 'intact' ? text('chain.records', { count: chain.records }) : chain.state === 'empty' ? text('chain.empty') : text('chain.broken')}${chain.user === change.evaluatedUser ? '*' : ''}`).join(' ')
}

function changeLine(change: CiChangeReport, text: CiText): string {
  const policy = change.policy === 'none' ? text('policy.none') : change.policy === 'pass' ? text('policy.pass') : text('policy.fail')
  return text('changeLine', {
    change: change.change, step: change.step ?? '—', policy, chains: chainText(change, text), anchor: change.anchor,
  })
}

export function renderCiText(report: CiVerifyReport, text: CiText): string {
  const lines = [`[VERIFY-CI] ${headline(report, text)}`]
  const scoped = (change: CiChangeReport): readonly CiFinding[] => change.findings
  for (const change of report.changes) {
    lines.push('', changeLine(change, text))
    if (scoped(change).length === 0) lines.push(`  ${text('noFindings')}`)
    for (const item of scoped(change)) lines.push(`  [${MARK[item.severity]}] ${item.code}: ${findingLine(item, text)}`)
  }
  for (const item of report.findings) lines.push(`[${MARK[item.severity]}] ${item.code}: ${findingLine(item, text)}`)
  if (report.changes.length === 0 && report.findings.length === 0) lines.push('', text('noChangesInScope'))
  lines.push('', text('verifiedHeading'), ...report.trust.verified.map((item) => `  + ${item}`))
  lines.push('', text('unverifiableHeading'), ...report.trust.unverifiable.map((item) => `  - ${item}`))
  lines.push('', text('footer', { schema: CI_REPORT_SCHEMA, tenon: report.tenon, head: report.head ?? text('unknown') }))
  return `${lines.join('\n')}\n`
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderCiMarkdown(report: CiVerifyReport, text: CiText): string {
  const out = [`## ${report.summary.pass ? 'PASS' : 'FAIL'} — ${headline(report, text)}`, '']
  if (report.changes.length === 0 && report.findings.length === 0) {
    out.push(text('noChangesInScope'), '')
  }
  if (report.changes.length > 0) {
    const columns = (['md.colChange', 'md.colStep', 'md.colPolicy', 'md.colChains', 'md.colAnchor', 'md.colErrors', 'md.colWarnings'] as const).map((key) => text(key))
    out.push(`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`)
    for (const change of report.changes) {
      const count = (severity: CiSeverity): number => change.findings.filter((item) => item.severity === severity).length
      out.push(`| \`${change.change}\` | ${change.step ?? '—'} | ${change.policy} | ${escapeCell(chainText(change, text))} | ${change.anchor} | ${count('error')} | ${count('warning')} |`)
    }
    out.push('')
  }
  const findings = [...report.findings, ...report.changes.flatMap((change) => change.findings)]
  if (findings.length > 0) {
    const columns = (['md.colSeverity', 'md.colCode', 'md.colTask', 'md.colMessage'] as const).map((key) => text(key))
    out.push(`### ${text('md.findingsHeading')}`, '', `| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`)
    for (const item of findings) {
      out.push(`| ${text(`severity.${item.severity}`)} | \`${item.code}\` | ${item.change === null ? '—' : `\`${item.change}\``} | ${escapeCell(findingLine(item, text))} |`)
    }
    out.push('')
  }
  out.push(`### ${text('md.verifiedHeading')}`, '', ...report.trust.verified.map((item) => `- ${item}`), '')
  out.push(`### ${text('md.unverifiableHeading')}`, '', text('md.unverifiableLead'), '', ...report.trust.unverifiable.map((item) => `- ${item}`), '')
  return `${out.join('\n')}\n`
}
