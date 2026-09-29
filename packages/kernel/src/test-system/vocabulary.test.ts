import { describe, expect, it } from 'vitest'
import {
  RUNNER_FORMATS, TEST_RUNNERS, defaultReportFormat, isCaseReportFormat, kindForDirection, kindFormatProblem,
  kindRunnerProblem,
} from './vocabulary.js'

describe('闭集组合规则', () => {
  it('每个 runner 的默认报告格式在它的可选格式里', () => {
    for (const runner of TEST_RUNNERS) expect(RUNNER_FORMATS[runner]).toContain(defaultReportFormat(runner))
    expect(defaultReportFormat('tsc')).toBe('exit-code')
    expect(defaultReportFormat('playwright')).toBe('playwright-json')
  })

  it('种类 × runner', () => {
    expect(kindRunnerProblem('playwright', 'playwright')).toBeUndefined()
    expect(kindRunnerProblem('playwright', 'vitest')).toMatch(/必须用 runner 'playwright'/)
    expect(kindRunnerProblem('browser', 'playwright')).toMatch(/不能承载种类 'browser'/)
    expect(kindRunnerProblem('browser', 'cypress')).toBeUndefined()
    expect(kindRunnerProblem('unit', 'tsc')).toMatch(/不能承载/)
    expect(kindRunnerProblem('benchmark', 'k6')).toBeUndefined()
    expect(kindRunnerProblem('unit', 'k6')).toMatch(/不能承载/)
  })

  it('种类 × 报告格式', () => {
    expect(kindFormatProblem('typecheck', 'tsc', 'exit-code')).toBeUndefined()
    expect(kindFormatProblem('unit', 'custom', 'exit-code')).toMatch(/必须有可解析的报告/)
    expect(kindFormatProblem('benchmark', 'custom', 'junit')).toMatch(/基准套件的报告格式/)
    expect(kindFormatProblem('benchmark', 'hyperfine', 'benchmark-json')).toBeUndefined()
    expect(kindFormatProblem('a11y', 'lighthouse', 'lighthouse-json')).toBeUndefined()
    expect(kindFormatProblem('smoke', 'custom', 'lighthouse-json')).toMatch(/只用于 benchmark 或 a11y/)
    expect(kindFormatProblem('unit', 'custom', 'k6-summary')).toMatch(/只用于 benchmark/)
    expect(kindFormatProblem('unit', 'go', 'tap')).toMatch(/不产出报告格式 'tap'/)
    expect(isCaseReportFormat('junit')).toBe(true)
    expect(isCaseReportFormat('benchmark-json')).toBe(false)
  })

  it('旧测试方向 → 种类', () => {
    expect(kindForDirection('integration')).toBe('integration')
    expect(kindForDirection('design-system')).toBe('design-system')
    expect(kindForDirection('my-direction')).toBe('custom')
  })
})
