import { describe, expect, it } from 'vitest'
import { CI_EXIT_FAIL, CI_EXIT_PASS, buildCiReport, ciExitCode, ciUnverifiable } from './report.js'
import { renderCiMarkdown, renderCiText } from './render.js'
import { CI_RULES, ciRule } from './rules.js'
import { toSarif } from './sarif.js'
import { CI_TEXT_KEYS, ciKeyText } from './text.js'
import type { CiChangeReport, CiFinding, CiVerifyReport } from './types.js'

function finding(overrides: Partial<CiFinding> = {}): CiFinding {
  return { code: 'record-chain-broken', severity: 'error', change: 'demo', message: '测试记录被改动', source: 'policy', ...overrides }
}

function change(findings: readonly CiFinding[], overrides: Partial<CiChangeReport> = {}): CiChangeReport {
  return {
    change: 'demo', dir: 'openspec/changes/demo', phase: 'build', step: 'build', policy: 'fail', evaluatedUser: 'a-at-x.io',
    chains: [{ user: 'a-at-x.io', state: 'broken', head: null, records: 1 }], anchor: 'none', findings, ...overrides,
  }
}

function report(changes: readonly CiChangeReport[], findings: readonly CiFinding[] = [], tenon = '0.2.0'): CiVerifyReport {
  return buildCiReport({
    tenon, generatedAt: '2026-08-01T00:00:00Z', head: 'b'.repeat(40), selector: { kind: 'since', ref: 'origin/main' },
    options: { candidate: 'error', requireAnchor: false }, changes, findings, text: ciKeyText,
  })
}

describe('buildCiReport', () => {
  it('汇总级别与退出码：有 error 才失败，警告和提示不挡', () => {
    const passing = report([change([finding({ severity: 'warning' }), finding({ severity: 'note' })], { policy: 'pass' })])
    expect(passing.summary).toEqual({ changes: 1, errors: 0, warnings: 1, notes: 1, pass: true })
    expect(ciExitCode(passing)).toBe(CI_EXIT_PASS)
    const failing = report([change([finding()])], [finding({ code: 'anchor-mismatch', change: null })])
    expect(failing.summary).toMatchObject({ errors: 2, pass: false })
    expect(ciExitCode(failing)).toBe(CI_EXIT_FAIL)
  })

  it('信任边界固定带出：HMAC 密钥、封存、报告伪造、身份；锚点是否核对随是否有锚点变化', () => {
    const none = report([change([])])
    // 固定文案按键取：四件 CI 证明不了的事（记录来源、评审批准、报告真伪、身份）一件不少。
    expect(none.trust.unverifiable).toEqual(ciUnverifiable(ciKeyText))
    expect(none.trust.unverifiable).toEqual([
      'trust.unverifiable.records', 'trust.unverifiable.approvals', 'trust.unverifiable.reports', 'trust.unverifiable.identity',
    ])
    expect(none.trust.verified.at(-1)).toBe('trust.verified.anchorNone')
    expect(report([change([], { anchor: 'verified' })]).trust.verified.at(-1)).toBe('trust.verified.anchor')
    expect(report([change([])]).trust.verified.at(-4)).toBe('trust.verified.candidate')
  })
})

describe('rules', () => {
  it('每个发现码都有规则；CI 独有的码与策略阻塞码都在目录里', () => {
    for (const code of ['candidate-mismatch', 'protected-unapproved', 'anchor-mismatch', 'record-chain-broken', 'test-stale', 'known-failure-expired']) {
      expect(ciRule(code), code).toBeDefined()
    }
    expect(new Set(CI_RULES.map((rule) => rule.id)).size).toBe(CI_RULES.length)
  })

  it('既是阻塞又是提示的码（test-integrity：block 时阻塞、notice 时提示）只有一条规则，每条发现按自己的级别出结果', () => {
    expect(CI_RULES.filter((rule) => rule.id === 'test-integrity')).toHaveLength(1)
    const log = toSarif(report([change([
      finding({ code: 'test-integrity', severity: 'note', subject: 'a' }),
      finding({ code: 'test-integrity', severity: 'error', subject: 'b' }),
    ])]), ciKeyText)
    const run = log.runs[0]
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual(['tenon/test-integrity'])
    expect(run.results.map((result) => result.level)).toEqual(['note', 'error'])
  })
})

describe('toSarif', () => {
  const log = toSarif(report([change([finding({ path: '.tenon/users/a-at-x.io/tests/demo/r.json', subject: 'unit' }), finding({ code: 'candidate-unchecked', severity: 'note', source: 'ci' })])]), ciKeyText)

  it('GitHub code scanning 要求的字段：ruleId、message、相对 uri + region、partialFingerprints', () => {
    const run = log.runs[0]
    expect(log.version).toBe('2.1.0')
    expect(run.tool.driver).toMatchObject({ name: 'Tenon', version: '0.2.0', semanticVersion: '0.2.0' })
    expect(run.results).toHaveLength(2)
    const [first, second] = run.results
    expect(first).toMatchObject({
      ruleId: 'tenon/record-chain-broken', level: 'error',
      locations: [{ physicalLocation: { artifactLocation: { uri: '.tenon/users/a-at-x.io/tests/demo/r.json', uriBaseId: '%SRCROOT%' }, region: { startLine: 1 } } }],
    })
    expect(first?.partialFingerprints['tenon/v1']).toMatch(/^[0-9a-f]{32}$/u)
    // 没有具体文件的发现落在任务的 .pipeline.yaml。
    expect(second?.locations[0].physicalLocation.artifactLocation.uri).toBe('openspec/changes/demo/.pipeline.yaml')
    expect(second?.level).toBe('note')
  })

  it('规则只列用到的，ruleIndex 指向它；同一问题的指纹稳定、不同对象的指纹不同', () => {
    const run = log.runs[0]
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual(['tenon/candidate-unchecked', 'tenon/record-chain-broken'])
    for (const result of run.results) expect(run.tool.driver.rules[result.ruleIndex]?.id).toBe(result.ruleId)
    const again = toSarif(report([change([finding({ subject: 'unit' })])]), ciKeyText)
    expect(again.runs[0].results[0]?.partialFingerprints).toEqual({ 'tenon/v1': run.results[0]?.partialFingerprints['tenon/v1'] })
    const other = toSarif(report([change([finding({ subject: 'integration' })])]), ciKeyText)
    expect(other.runs[0].results[0]?.partialFingerprints['tenon/v1']).not.toBe(run.results[0]?.partialFingerprints['tenon/v1'])
  })

  it('路径里的 .. 与前导斜杠被清掉；版本不是 semver 时不写 semanticVersion', () => {
    const odd = toSarif(report([change([finding({ path: '/../a/../b.json' })])], [], 'unknown'), ciKeyText)
    expect(odd.runs[0].results[0]?.locations[0].physicalLocation.artifactLocation.uri).toBe('a/b.json')
    expect(odd.runs[0].tool.driver.semanticVersion).toBeUndefined()
    expect(odd.runs[0].properties.tenon.trust).toBeDefined()
  })
})

describe('渲染', () => {
  const failing = report([change([finding({ fix: 'tenon test run demo --stage', path: 'a.json' })])])

  it('text：结论在最前，逐任务列发现，末尾固定有「本次校验了」与「CI 里无法证明」', () => {
    const text = renderCiText(failing, ciKeyText)
    expect(text.split('\n')[0]).toBe('[VERIFY-CI] headline {"verdict":"verdict.fail","changes":1,"errors":1,"warnings":0,"selector":"--since origin/main"}')
    expect(text).toContain('[FAIL] record-chain-broken: 测试记录被改动 [a.json]fixSuffix {"fix":"tenon test run demo --stage"}')
    expect(text.indexOf('verifiedHeading')).toBeLessThan(text.indexOf('unverifiableHeading'))
    for (const item of ciUnverifiable(ciKeyText)) expect(text).toContain(item)
    expect(renderCiText(report([]), ciKeyText)).toContain('noChangesInScope')
  })

  it('markdown：表格单元里的竖线被转义，信任边界同样固定带出', () => {
    const markdown = renderCiMarkdown(report([change([finding({ message: 'a | b' })])]), ciKeyText)
    expect(markdown).toContain('## FAIL')
    expect(markdown).toContain('a \\| b')
    expect(markdown).toContain('### md.unverifiableHeading')
    expect(renderCiMarkdown(report([change([], { policy: 'pass' })]), ciKeyText)).toContain('## PASS')
  })
})

describe('文本键', () => {
  it('键没有重复；文本源给什么渲染层就写什么（语言在调用方，kernel 里没有任何一种语言的固定文案）', () => {
    expect(new Set(CI_TEXT_KEYS).size).toBe(CI_TEXT_KEYS.length)
    const probe = renderCiText(report([change([finding({ fix: 'x' })], { policy: 'none' })], [finding({ code: 'anchor-missing', change: null })]), (key, params) => `<${key}${params === undefined ? '' : `:${Object.keys(params).join(',')}`}>`)
    expect(probe).toContain('<headline:verdict,changes,errors,warnings,selector>')
    expect(probe).toContain('<changeLine:change,step,policy,chains,anchor>')
    expect(probe).not.toMatch(/本次校验了|CI 里无法证明|任务 demo/u)
  })
})
