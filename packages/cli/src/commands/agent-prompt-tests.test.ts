import { describe, expect, it } from 'vitest'
import type { FrozenAgent, SuiteVerdict, TestPolicyReport } from '@tenon/kernel'
import { renderAgentPrompt } from './agent-prompt.js'
import { renderTestPolicySummary } from './agent-prompt-tests.js'

function report(suites: readonly SuiteVerdict[]): TestPolicyReport {
  return {
    stepId: 'verify', pass: false, blockers: [], notices: [], suites, trace: [],
    files: { checked: false, unregistered: [], orphans: [] }, chain: 'intact',
  }
}

const totals = { cases: 48, pass: 44, fail: 2, skip: 1, flaky: 1, known_fail: 0 }

const UNIT: SuiteVerdict = {
  suite: 'web-unit', origin: 'catalog', kind: 'unit', label: '前端单测', reason: 'run', state: 'failed',
  totals, failing: ['src/a.test.ts › 登录', 'src/b.test.ts › 退出'], flaky: ['src/c.test.ts › 重试'],
  coverage: { lines: 78.26, branches: 71, changed_lines: 95 },
}

const BENCH: SuiteVerdict = {
  suite: 'api-bench', origin: 'catalog', kind: 'benchmark', reason: 'if-registered', state: 'failed',
  benchmark: [
    { name: 'p95_ms', unit: 'ms', better: 'lower', summary: { median: 13.2, p95: 14, mad: 0.2, samples: 5 }, baseline: 11, delta_pct: 20, failed: true, baselineMissing: false, noisy: false, details: [] },
    { name: 'rps', unit: 'req/s', better: 'higher', summary: { median: 900, p95: 950, mad: 5, samples: 5 }, baseline: null, delta_pct: null, failed: false, baselineMissing: true, noisy: true, details: [] },
  ],
}

describe('评审者的 v2 测试摘要', () => {
  it('失败用例、flaky、覆盖率对照门槛、基准相对基线的变化各自成行', () => {
    const lines = renderTestPolicySummary(report([UNIT, BENCH]), { lines: 80, branches: 70 })
    expect(lines).toEqual([
      '测试摘要（目录套件的最新运行）：',
      '- 前端单测（web-unit） unit 不通过；44/48 通过，2 失败，1 flaky，1 跳过；覆盖率 lines 78.3%（门槛 80%，不足），branches 71%（门槛 70%），changed_lines 95%',
      '  失败用例：src/a.test.ts › 登录；src/b.test.ts › 退出',
      '  flaky 用例：src/c.test.ts › 重试',
      '- api-bench benchmark 不通过',
      '  基准：p95_ms 13.2ms（基线 11ms，+20.0%，退化）；rps 900req/s（无同画像基线，波动大）',
    ])
  })

  it('过期与未运行如实说，旧步骤内联测试不在摘要里，没有目录套件就没有摘要', () => {
    const stale: SuiteVerdict = { suite: 'e2e', origin: 'catalog', kind: 'playwright', reason: 'run', state: 'stale', staleBecause: ['candidate', 'plan'] }
    const missing: SuiteVerdict = { suite: 'types', origin: 'catalog', kind: 'typecheck', reason: 'run', state: 'missing', detail: '只跑了 changed 范围' }
    const inline: SuiteVerdict = { suite: 'step:old', origin: 'step', kind: 'unit', reason: 'inline', state: 'passed' }
    const lines = renderTestPolicySummary(report([stale, missing, inline]))
    expect(lines).toEqual([
      '测试摘要（目录套件的最新运行）：',
      '- e2e playwright 过期；过期项 candidate、plan',
      '- types typecheck 未运行；只跑了 changed 范围',
    ])
    expect(renderTestPolicySummary(report([inline]))).toEqual([])
    expect(renderTestPolicySummary(undefined)).toEqual([])
  })

  it('大型套件的失败用例只列前 10 个，其余折叠', () => {
    const many = Array.from({ length: 13 }, (_, index) => `t${index}.test.ts › c`)
    const lines = renderTestPolicySummary(report([{ ...UNIT, failing: many, flaky: [], coverage: null }]))
    expect(lines.find((line) => line.startsWith('  失败用例'))).toBe(`  失败用例：${many.slice(0, 10).join('；')}；等 13 个`)
  })
})

describe('提示词附带摘要', () => {
  const frozen: FrozenAgent = {
    name: 'qa', source: 'builtin', digest: `sha256:${'0'.repeat(64)}`,
    definition: { name: 'qa', description: 'd', skills: [], tools: [], body: '正文' },
  }
  const base = {
    change: 'c', step: 'verify', role: 'reviewer' as const, runId: 'r1', candidate: `sha256:${'1'.repeat(64)}`,
    frozen, reportPath: 'r.md', tests: [],
  }

  it('摘要行紧跟在测试之后、步骤说明之前；不传就与之前逐字相同', () => {
    const summary = renderTestPolicySummary(report([UNIT]), { lines: 80 })
    const lines = renderAgentPrompt({ ...base, stepPrompt: '按清单走', testSummary: summary }).split('\n')
    const at = lines.indexOf('测试摘要（目录套件的最新运行）：')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + summary.length]).toBe('步骤说明：按清单走')
    expect(renderAgentPrompt({ ...base, stepPrompt: '按清单走' })).toBe(renderAgentPrompt({ ...base, stepPrompt: '按清单走', testSummary: [] }))
  })
})
