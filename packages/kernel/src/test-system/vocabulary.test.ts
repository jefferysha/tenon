import { describe, expect, it } from 'vitest'
import {
  EXIT_CODE_KINDS, RUNNER_FORMATS, TEST_CLASSES, TEST_KINDS, TEST_RUNNERS, defaultReportFormat, isCaseReportFormat,
  isTestClass, isTestKind, kindForDirection, kindFormatProblem, kindRunnerProblem, looksLikeTestFile, testClassOf,
} from './vocabulary.js'
import type { TestKind } from './vocabulary.js'

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

describe('测试类', () => {
  it('六个类，闭集守卫', () => {
    expect([...TEST_CLASSES]).toEqual(['unit', 'integration', 'e2e', 'static', 'benchmark', 'custom'])
    for (const name of TEST_CLASSES) expect(isTestClass(name)).toBe(true)
    for (const bad of ['coverage', 'typecheck', '', 'Unit', undefined, null, 7]) expect(isTestClass(bad)).toBe(false)
  })

  it('static 是合法种类', () => {
    expect(TEST_KINDS).toContain('static')
    expect(isTestKind('static')).toBe(true)
  })

  it('旧种类 → 类', () => {
    const expected: ReadonlyArray<readonly [TestKind, string]> = [
      ['unit', 'unit'], ['coverage', 'unit'],
      ['integration', 'integration'], ['regression', 'integration'], ['contract', 'integration'], ['smoke', 'integration'],
      ['e2e', 'e2e'], ['playwright', 'e2e'], ['browser', 'e2e'], ['a11y', 'e2e'], ['visual', 'e2e'],
      ['typecheck', 'static'], ['lint', 'static'], ['code-size', 'static'], ['design-system', 'static'], ['static', 'static'],
      ['benchmark', 'benchmark'], ['custom', 'custom'],
    ]
    for (const [kind, name] of expected) expect(testClassOf(kind), kind).toBe(name)
  })

  it('每个种类都归入某个类', () => {
    for (const kind of TEST_KINDS) expect(isTestClass(testClassOf(kind)), kind).toBe(true)
  })
})

describe('static 种类的组合规则', () => {
  it('可以不产出报告、只看退出码', () => {
    expect(EXIT_CODE_KINDS.has('static')).toBe(true)
    expect(kindFormatProblem('static', 'tsc', 'exit-code')).toBeUndefined()
    expect(kindFormatProblem('static', 'custom', 'exit-code')).toBeUndefined()
    expect(kindFormatProblem('static', 'eslint', 'exit-code')).toBeUndefined()
  })

  it('runner 放行规则是 typecheck 与 lint 的并集', () => {
    expect(kindRunnerProblem('static', 'tsc')).toBeUndefined()
    expect(kindRunnerProblem('static', 'eslint')).toBeUndefined()
    expect(kindRunnerProblem('static', 'custom')).toBeUndefined()
    expect(kindRunnerProblem('static', 'vitest')).toBeUndefined()
    for (const runner of TEST_RUNNERS) {
      const union = kindRunnerProblem('typecheck', runner) === undefined || kindRunnerProblem('lint', runner) === undefined
      expect(kindRunnerProblem('static', runner) === undefined, runner).toBe(union)
    }
    expect(kindRunnerProblem('static', 'playwright')).toMatch(/不能承载种类 'static'/)
    expect(kindRunnerProblem('static', 'k6')).toMatch(/不能承载种类 'static'/)
  })

  it('不能借 static 绕开报告格式规则', () => {
    expect(kindFormatProblem('static', 'custom', 'benchmark-json')).toMatch(/只用于 benchmark/)
    expect(kindFormatProblem('static', 'custom', 'lighthouse-json')).toMatch(/只用于 benchmark 或 a11y/)
    expect(kindFormatProblem('static', 'tsc', 'junit')).toMatch(/不产出报告格式 'junit'/)
  })
})

describe('looksLikeTestFile', () => {
  it('源码扩展名的测试文件为真', () => {
    for (const path of ['src/a.test.ts', 'test_x.py', 'x_test.go', 'e2e/dashboard/a.spec.ts', 'bench/a.bench.mjs']) {
      expect(looksLikeTestFile(path), path).toBe(true)
    }
  })

  it('非源码扩展名的证据 / 数据 / 报告文件为假', () => {
    for (const path of [
      'openspec/changes/archive/x/.pipeline-run/review-attempt-reports/a.spec.report',
      'fixtures/data.spec.json',
      'e2e/fixtures/seed.json',
      'src/a.test.snap',
      'docs/e2e/readme.md',
    ]) {
      expect(looksLikeTestFile(path), path).toBe(false)
    }
  })

  it('原有边界不变', () => {
    for (const path of ['src/testing.ts', 'latest.ts', 'e2e.ts']) expect(looksLikeTestFile(path), path).toBe(false)
  })
})
