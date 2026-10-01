import { describe, expect, it } from 'vitest'
import { CI_EXIT_FAIL, CI_EXIT_PASS, CI_UNVERIFIABLE, buildCiReport, ciExitCode } from './report.js'
import { renderCiMarkdown, renderCiText } from './render.js'
import { CI_RULES, ciRule } from './rules.js'
import { toSarif } from './sarif.js'
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
    options: { candidate: 'error', requireAnchor: false }, changes, findings,
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
    expect(none.trust.unverifiable).toBe(CI_UNVERIFIABLE)
    expect(none.trust.unverifiable.join('\n')).toMatch(/HMAC.*封存|封存.*HMAC/su)
    expect(none.trust.verified.at(-1)).toContain('未核对')
    expect(report([change([], { anchor: 'verified' })]).trust.verified.at(-1)).toContain('在已提交的记录链里')
  })
})

describe('rules', () => {
  it('每个发现码都有规则；CI 独有的码与策略阻塞码都在目录里', () => {
    for (const code of ['candidate-mismatch', 'protected-unapproved', 'anchor-mismatch', 'record-chain-broken', 'test-stale', 'known-failure-expired']) {
      expect(ciRule(code), code).toBeDefined()
    }
    expect(new Set(CI_RULES.map((rule) => rule.id)).size).toBe(CI_RULES.length)
  })
})

describe('toSarif', () => {
  const log = toSarif(report([change([finding({ path: '.tenon/users/a-at-x.io/tests/demo/r.json', subject: 'unit' }), finding({ code: 'candidate-unchecked', severity: 'note', source: 'ci' })])]))

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
    const again = toSarif(report([change([finding({ subject: 'unit' })])]))
    expect(again.runs[0].results[0]?.partialFingerprints).toEqual({ 'tenon/v1': run.results[0]?.partialFingerprints['tenon/v1'] })
    const other = toSarif(report([change([finding({ subject: 'integration' })])]))
    expect(other.runs[0].results[0]?.partialFingerprints['tenon/v1']).not.toBe(run.results[0]?.partialFingerprints['tenon/v1'])
  })

  it('路径里的 .. 与前导斜杠被清掉；版本不是 semver 时不写 semanticVersion', () => {
    const odd = toSarif(report([change([finding({ path: '/../a/../b.json' })])], [], 'unknown'))
    expect(odd.runs[0].results[0]?.locations[0].physicalLocation.artifactLocation.uri).toBe('a/b.json')
    expect(odd.runs[0].tool.driver.semanticVersion).toBeUndefined()
    expect(odd.runs[0].properties.tenon.trust).toBeDefined()
  })
})

describe('渲染', () => {
  const failing = report([change([finding({ fix: 'tenon test run demo --stage', path: 'a.json' })])])

  it('text：结论在最前，逐任务列发现，末尾固定有「本次校验了」与「CI 里无法证明」', () => {
    const text = renderCiText(failing)
    expect(text.split('\n')[0]).toBe('[VERIFY-CI] Tenon CI 校验 未通过：1 个任务，1 个失败，0 个警告（--since origin/main）')
    expect(text).toContain('[FAIL] record-chain-broken: 测试记录被改动 [a.json]；执行 tenon test run demo --stage')
    expect(text.indexOf('本次校验了')).toBeLessThan(text.indexOf('CI 里无法证明'))
    for (const item of CI_UNVERIFIABLE) expect(text).toContain(item)
    expect(renderCiText(report([]))).toContain('范围内没有受 Tenon 治理的任务')
  })

  it('markdown：表格单元里的竖线被转义，信任边界同样固定带出', () => {
    const markdown = renderCiMarkdown(report([change([finding({ message: 'a | b' })])]))
    expect(markdown).toContain('## FAIL')
    expect(markdown).toContain('a \\| b')
    expect(markdown).toContain('### CI 里无法证明')
    expect(renderCiMarkdown(report([change([], { policy: 'pass' })]))).toContain('## PASS')
  })
})
