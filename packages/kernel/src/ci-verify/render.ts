/**
 * `tenon verify --ci` 报告的人读渲染：text（终端 / CI 日志）与 markdown（GitHub 作业摘要）。
 * 两份都以结论开头，逐任务列发现，最后固定陈述 CI 验证了什么、验证不了什么。
 */
import { CI_REPORT_SCHEMA, type CiChangeReport, type CiFinding, type CiSeverity, type CiVerifyReport } from './types.js'

const WORD: Readonly<Record<CiSeverity, string>> = { error: '失败', warning: '警告', note: '提示' }
const MARK: Readonly<Record<CiSeverity, string>> = { error: 'FAIL', warning: 'WARN', note: 'NOTE' }

function selectorText(report: CiVerifyReport): string {
  const selector = report.selector
  return selector.kind === 'change' ? `--change ${selector.change}`
    : selector.kind === 'since' ? `--since ${selector.ref}` : '--all-open'
}

function headline(report: CiVerifyReport): string {
  const { summary } = report
  const verdict = summary.pass ? '通过' : '未通过'
  return `Tenon CI 校验 ${verdict}：${summary.changes} 个任务，${summary.errors} 个失败，${summary.warnings} 个警告（${selectorText(report)}）`
}

function findingLine(item: CiFinding): string {
  const where = item.path === undefined ? '' : ` [${item.path}]`
  const fix = item.fix === undefined ? '' : `；执行 ${item.fix}`
  return `${item.message}${where}${fix}`
}

function chainText(change: CiChangeReport): string {
  if (change.chains.length === 0) return '无记录链'
  return change.chains.map((chain) =>
    `${chain.user}:${chain.state === 'intact' ? `${chain.records} 条` : chain.state === 'empty' ? '空' : '已断'}${chain.user === change.evaluatedUser ? '*' : ''}`).join(' ')
}

function changeHeader(change: CiChangeReport): string {
  const policy = change.policy === 'none' ? '该步骤没有测试策略' : change.policy === 'pass' ? '策略通过' : '策略未通过'
  return `${change.change}  步骤 ${change.step ?? '—'}  ${policy}  记录链 ${chainText(change)}  锚点 ${change.anchor}`
}

export function renderCiText(report: CiVerifyReport): string {
  const lines = [`[VERIFY-CI] ${headline(report)}`]
  const scoped = (change: CiChangeReport): readonly CiFinding[] => change.findings
  for (const change of report.changes) {
    lines.push('', `任务 ${changeHeader(change)}`)
    if (scoped(change).length === 0) lines.push('  （没有发现）')
    for (const item of scoped(change)) lines.push(`  [${MARK[item.severity]}] ${item.code}: ${findingLine(item)}`)
  }
  for (const item of report.findings) lines.push(`[${MARK[item.severity]}] ${item.code}: ${findingLine(item)}`)
  if (report.changes.length === 0 && report.findings.length === 0) lines.push('', '范围内没有受 Tenon 治理的任务，没有可校验的内容。')
  lines.push('', '本次校验了：', ...report.trust.verified.map((item) => `  + ${item}`))
  lines.push('', 'CI 里无法证明（没有用户本机的 HMAC 密钥）：', ...report.trust.unverifiable.map((item) => `  - ${item}`))
  lines.push('', `报告格式 ${CI_REPORT_SCHEMA}；Tenon ${report.tenon}；提交 ${report.head ?? '未知'}`)
  return `${lines.join('\n')}\n`
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderCiMarkdown(report: CiVerifyReport): string {
  const out = [`## ${report.summary.pass ? 'PASS' : 'FAIL'} — ${headline(report)}`, '']
  if (report.changes.length === 0 && report.findings.length === 0) {
    out.push('范围内没有受 Tenon 治理的任务，没有可校验的内容。', '')
  }
  if (report.changes.length > 0) {
    out.push('| 任务 | 步骤 | 策略 | 记录链 | 锚点 | 失败 | 警告 |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const change of report.changes) {
      const count = (severity: CiSeverity): number => change.findings.filter((item) => item.severity === severity).length
      out.push(`| \`${change.change}\` | ${change.step ?? '—'} | ${change.policy} | ${escapeCell(chainText(change))} | ${change.anchor} | ${count('error')} | ${count('warning')} |`)
    }
    out.push('')
  }
  const findings = [...report.findings, ...report.changes.flatMap((change) => change.findings)]
  if (findings.length > 0) {
    out.push('### 发现', '', '| 级别 | 码 | 任务 | 说明 |', '| --- | --- | --- | --- |')
    for (const item of findings) {
      out.push(`| ${WORD[item.severity]} | \`${item.code}\` | ${item.change === null ? '—' : `\`${item.change}\``} | ${escapeCell(findingLine(item))} |`)
    }
    out.push('')
  }
  out.push('### 本次校验了', '', ...report.trust.verified.map((item) => `- ${item}`), '')
  out.push('### CI 里无法证明', '', '没有用户本机的 HMAC 密钥，以下几件事 CI 证明不了：', '', ...report.trust.unverifiable.map((item) => `- ${item}`), '')
  return `${out.join('\n')}\n`
}
