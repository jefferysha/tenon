import { describe, expect, it } from 'vitest'
import {
  TEST_REPORT_BEGIN, TEST_REPORT_END, replaceTestReportBlock, reportCarriesRuns, testReportBlock,
} from './report-block.js'

describe('验证报告的测试追溯块', () => {
  it('没有块就在末尾追加；再写一次只换块里的内容，块外字节不动', () => {
    const report = '# 验证报告\n\n手写的结论。\n'
    const first = replaceTestReportBlock(report, '| unit | r-1 | pass |')
    expect(first).toBe(`# 验证报告\n\n手写的结论。\n\n${TEST_REPORT_BEGIN}\n| unit | r-1 | pass |\n${TEST_REPORT_END}\n`)
    const edited = first.replace('手写的结论。', '改过的结论。')
    const second = replaceTestReportBlock(edited, '| unit | r-2 | pass |')
    expect(second).toBe(`# 验证报告\n\n改过的结论。\n\n${TEST_REPORT_BEGIN}\n| unit | r-2 | pass |\n${TEST_REPORT_END}\n`)
    expect(replaceTestReportBlock(second, '| unit | r-2 | pass |')).toBe(second)
  })

  it('块后面还有正文时原样保留', () => {
    const text = `前文\n${TEST_REPORT_BEGIN}\nold\n${TEST_REPORT_END}\n\n## 后记\n`
    expect(replaceTestReportBlock(text, 'new')).toBe(`前文\n${TEST_REPORT_BEGIN}\nnew\n${TEST_REPORT_END}\n\n## 后记\n`)
  })

  it('标记不成对当作没有块', () => {
    expect(testReportBlock(`x\n${TEST_REPORT_BEGIN}\nno end`)).toBeUndefined()
    expect(testReportBlock(`${TEST_REPORT_END}\n${TEST_REPORT_BEGIN}`)).toBeUndefined()
    expect(replaceTestReportBlock(`x\n${TEST_REPORT_BEGIN}\nno end\n`, 'b')).toBe(`x\n${TEST_REPORT_BEGIN}\nno end\n\n${TEST_REPORT_BEGIN}\nb\n${TEST_REPORT_END}\n`)
  })

  it('块引用了每个 run id 才算带上最新运行；块外提到不算', () => {
    const text = `run r-9 在块外\n${TEST_REPORT_BEGIN}\nr-1 r-2\n${TEST_REPORT_END}\n`
    expect(reportCarriesRuns(text, ['r-1', 'r-2'])).toBe(true)
    expect(reportCarriesRuns(text, ['r-1', 'r-9'])).toBe(false)
    expect(reportCarriesRuns('没有块 r-1', ['r-1'])).toBe(false)
    expect(reportCarriesRuns(text, [])).toBe(true)
  })
})
