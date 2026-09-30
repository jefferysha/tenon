import { describe, expect, it } from 'vitest'
import { UNKNOWN_CASE_FILE } from '@tenon/kernel'
import { fixtureCase, fixtureSuiteRun } from '@tenon/kernel/test-system/test-support'
import { suiteLines } from './run-summary.js'

describe('suiteLines · 报告没给文件的用例（产品评估 P2：(unknown) 原样打出来很迷惑）', () => {
  it('失败与 flaky 用例的文件列写「未报告文件」，不打哨兵值；有文件的照旧', () => {
    const run = fixtureSuiteRun({
      suite: 'unit',
      result: 'fail',
      cases: [
        fixtureCase({ file: UNKNOWN_CASE_FILE, name: 'parses input', status: 'fail', failure: { message: 'boom' } }),
        fixtureCase({ file: 'src/b.test.ts', name: 'other', status: 'fail', failure: { message: 'nope' } }),
        fixtureCase({ file: UNKNOWN_CASE_FILE, name: 'wobbly', status: 'flaky', attempts: 2 }),
      ],
    })
    const text = suiteLines(run).join('\n')
    expect(text).toContain('✗ 未报告文件 › parses input — boom')
    expect(text).toContain('✗ src/b.test.ts › other — nope')
    expect(text).toContain('flaky（2 次尝试）未报告文件 › wobbly')
    expect(text).not.toContain('(unknown)')
  })
})
