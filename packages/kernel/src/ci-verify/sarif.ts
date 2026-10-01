/**
 * `tenon verify --ci` 报告 → SARIF 2.1.0（GitHub code scanning 的输入）。
 *
 * GitHub 的要求：每条 result 有 `ruleId`、`message.text`、至少一个 `physicalLocation`（仓库相对 uri + region），
 * 并带 `partialFingerprints` 让同一问题在多次运行间归并。位置是「相关文件」（记录文件 / 计划 / 目录 / 受保护文件），
 * 没有具体文件时落在任务的 `.pipeline.yaml`。run 级 `properties.tenon` 带摘要与信任边界。
 */
import { sha256Hex } from '../sha256.js'
import { ciRule, type CiRule } from './rules.js'
import { allFindings, type CiFinding, type CiSeverity, type CiVerifyReport } from './types.js'

export const SARIF_VERSION = '2.1.0'
export const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json'
const INFORMATION_URI = 'https://github.com/jefferysha/tenon'
const HELP_URI = 'https://github.com/jefferysha/tenon/blob/main/docs/usage/ci-verification.md'
const RULE_PREFIX = 'tenon/'

export interface SarifRule {
  readonly id: string
  readonly name: string
  readonly shortDescription: { readonly text: string }
  readonly fullDescription: { readonly text: string }
  readonly help: { readonly text: string }
  readonly helpUri: string
  readonly defaultConfiguration: { readonly level: CiSeverity }
  readonly properties: { readonly tags: readonly string[] }
}

export interface SarifResult {
  readonly ruleId: string
  readonly ruleIndex: number
  readonly level: CiSeverity
  readonly message: { readonly text: string }
  readonly locations: readonly [{
    readonly physicalLocation: {
      readonly artifactLocation: { readonly uri: string; readonly uriBaseId: '%SRCROOT%' }
      readonly region: { readonly startLine: number }
    }
  }]
  readonly partialFingerprints: { readonly 'tenon/v1': string }
  readonly properties: Readonly<Record<string, string>>
}

export interface SarifLog {
  readonly $schema: string
  readonly version: typeof SARIF_VERSION
  readonly runs: readonly [{
    readonly tool: {
      readonly driver: {
        readonly name: 'Tenon'
        readonly version: string
        readonly semanticVersion?: string
        readonly informationUri: string
        readonly rules: readonly SarifRule[]
      }
    }
    readonly results: readonly SarifResult[]
    readonly invocations: readonly [{ readonly executionSuccessful: true }]
    readonly properties: { readonly tenon: Readonly<Record<string, unknown>> }
  }]
}

function fallbackRule(code: string, level: CiSeverity): CiRule {
  return { id: code, name: code, short: code, help: 'Reported by tenon verify --ci.', level }
}

function sarifRule(rule: CiRule): SarifRule {
  return {
    id: `${RULE_PREFIX}${rule.id}`,
    name: rule.name,
    shortDescription: { text: rule.short },
    fullDescription: { text: rule.help },
    help: { text: rule.help },
    helpUri: HELP_URI,
    defaultConfiguration: { level: rule.level },
    properties: { tags: ['tenon', 'test-evidence'] },
  }
}

/** 仓库相对 uri：去掉前导 `./` 与 `/`，反斜杠换成斜杠；SARIF 的 uri 不带 `..`。 */
function uriOf(path: string): string {
  return path.replaceAll('\\', '/').replace(/^(\.\/|\/)+/u, '').split('/').filter((part) => part !== '..').join('/')
}

function locationPath(finding: CiFinding, dirOf: ReadonlyMap<string, string>): string {
  if (finding.path !== undefined) return uriOf(finding.path)
  const dir = finding.change === null ? undefined : dirOf.get(finding.change)
  return dir === undefined ? 'openspec/changes' : `${uriOf(dir)}/.pipeline.yaml`
}

function fingerprint(finding: CiFinding): string {
  return sha256Hex([finding.code, finding.change ?? '', finding.subject ?? ''].join('\0')).slice(0, 32)
}

export function toSarif(report: CiVerifyReport): SarifLog {
  const findings = allFindings(report)
  const dirOf = new Map(report.changes.map((change) => [change.change, change.dir]))
  const used = new Map<string, CiRule>()
  for (const finding of findings) {
    if (!used.has(finding.code)) used.set(finding.code, ciRule(finding.code) ?? fallbackRule(finding.code, finding.severity))
  }
  const rules = [...used.values()].sort((left, right) => left.id.localeCompare(right.id))
  const indexOf = new Map(rules.map((rule, index) => [`${RULE_PREFIX}${rule.id}`, index]))
  const results: SarifResult[] = findings.map((finding) => ({
    ruleId: `${RULE_PREFIX}${finding.code}`,
    ruleIndex: indexOf.get(`${RULE_PREFIX}${finding.code}`) ?? 0,
    level: finding.severity,
    message: { text: finding.fix === undefined ? finding.message : `${finding.message}；执行 ${finding.fix}` },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: locationPath(finding, dirOf), uriBaseId: '%SRCROOT%' },
        region: { startLine: 1 },
      },
    }],
    partialFingerprints: { 'tenon/v1': fingerprint(finding) },
    properties: {
      source: finding.source,
      ...(finding.change === null ? {} : { change: finding.change }),
      ...(finding.subject === undefined ? {} : { subject: finding.subject }),
    },
  }))
  return {
    $schema: SARIF_SCHEMA_URI,
    version: SARIF_VERSION,
    runs: [{
      tool: {
        driver: {
          name: 'Tenon', version: report.tenon, informationUri: INFORMATION_URI,
          ...(/^\d+\.\d+\.\d+/u.test(report.tenon) ? { semanticVersion: report.tenon } : {}),
          rules: rules.map(sarifRule),
        },
      },
      results,
      invocations: [{ executionSuccessful: true }],
      properties: {
        tenon: { schema: report.schema, head: report.head, selector: report.selector, summary: report.summary, trust: report.trust },
      },
    }],
  }
}
