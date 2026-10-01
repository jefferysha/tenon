import { describe, expect, it } from 'vitest'
import type { RecordFileEntry } from '../test-system/record-chain.js'
import { fixtureCase, fixtureChain, fixtureRecordDraft, fixtureSuiteRun } from '../test-system/test-support.js'
import { recordInvariantProblems } from './record-checks.js'

const SLUG = 'tester-at-tenon.test'

function entries(overrides: Parameters<typeof fixtureRecordDraft>[0] = {}): RecordFileEntry[] {
  return fixtureChain([fixtureRecordDraft(overrides)]).map((record) => ({ file: `${record.run_id}.json`, record }))
}

describe('recordInvariantProblems', () => {
  it('tenon test run 写出的记录没有问题', () => {
    expect(recordInvariantProblems({ change: 'demo', slug: SLUG, records: entries() })).toEqual([])
  })

  it('记录属于别的任务、执行人与用户目录不符：record-misplaced', () => {
    const problems = recordInvariantProblems({ change: 'other', slug: 'someone-at-else.test', records: entries() })
    expect(problems.map((item) => item.code)).toEqual(['record-misplaced', 'record-misplaced'])
    expect(problems[0]?.message).toContain('属于任务 demo')
    expect(problems[1]?.message).toContain('tester@tenon.test')
  })

  it('记录结论与套件结论矛盾：record-inconsistent', () => {
    const failing = fixtureSuiteRun({ suite: 'web-unit', result: 'fail' })
    const problems = recordInvariantProblems({ change: 'demo', slug: SLUG, records: entries({ suites: [failing], result: 'pass' }) })
    expect(problems).toEqual([expect.objectContaining({ code: 'record-inconsistent', message: expect.stringContaining('应为 fail') })])
  })

  it('留存的用例比统计的还多：record-inconsistent', () => {
    const base = fixtureSuiteRun({ suite: 'web-unit' })
    const forged = {
      ...base,
      cases: [fixtureCase({ file: 'a.test.ts', name: 'a' }), fixtureCase({ file: 'a.test.ts', name: 'b' })],
      totals: { ...base.totals, cases: 1, pass: 1 },
    }
    const problems = recordInvariantProblems({ change: 'demo', slug: SLUG, records: entries({ suites: [forged] }) })
    expect(problems).toEqual([expect.objectContaining({ code: 'record-inconsistent', message: expect.stringContaining('留存了 2 个 pass') })])
  })
})
