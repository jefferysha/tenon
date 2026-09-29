import { describe, expect, it } from 'vitest'
import type { WbStepTestPolicy } from '../api/governanceTypes'
import {
  newPolicy, parseLimit, parsePercent, withCoverage, withFlakyMax, withKinds, withRequireBaseline, withScenarios, withScope,
} from './testPolicyEdits'

const FULL: WbStepTestPolicy = {
  plan: 'required',
  kinds: ['unit'],
  run: ['unit', 'regression'],
  run_if_registered: ['benchmark'],
  scope: 'full',
  files: 'registered',
  scenarios: 'required',
  coverage: { lines: 80, functions: 60, statements: 55 },
  flaky: { max: 2, fail_on_new: true },
  benchmark: { require_baseline: true },
  browsers: ['chromium'],
}

describe('testPolicyEdits', () => {
  it('新建策略只写 plan', () => {
    expect(newPolicy()).toEqual({ plan: 'required' })
  })

  it('每次编辑只动一个键，其余键原样保留；入参不被改', () => {
    const before = JSON.stringify(FULL)
    expect(withKinds(FULL, 'kinds', ['unit', 'playwright'])).toEqual({ ...FULL, kinds: ['unit', 'playwright'] })
    expect(withScope(FULL, 'changed')).toEqual({ ...FULL, scope: 'changed' })
    expect(withScenarios(FULL, 'passing')).toEqual({ ...FULL, scenarios: 'passing' })
    expect(withCoverage(FULL, 'branches', 70).coverage).toEqual({ lines: 80, functions: 60, statements: 55, branches: 70 })
    expect(withFlakyMax(FULL, 5).flaky).toEqual({ max: 5, fail_on_new: true })
    expect(JSON.stringify(FULL)).toBe(before)
  })

  it('种类清空就删键（稀疏）', () => {
    const cleared = withKinds(FULL, 'run', [])
    expect(cleared).not.toHaveProperty('run')
    expect(cleared.kinds).toEqual(['unit'])
    expect(withKinds({ plan: 'required' }, 'kinds', [])).toEqual({ plan: 'required' })
  })

  it('覆盖率：清掉一项保留其余；三项都空且没有 functions/statements 时整个 coverage 删掉', () => {
    expect(withCoverage(FULL, 'lines', undefined).coverage).toEqual({ functions: 60, statements: 55 })
    expect(withCoverage({ plan: 'required', coverage: { lines: 80 } }, 'lines', undefined)).toEqual({ plan: 'required' })
    expect(withCoverage({ plan: 'required' }, 'changed_lines', 90)).toEqual({ plan: 'required', coverage: { changed_lines: 90 } })
  })

  it('flaky 上限清空删整个 flaky；新设上限不带 fail_on_new', () => {
    expect(withFlakyMax(FULL, undefined)).not.toHaveProperty('flaky')
    expect(withFlakyMax({ plan: 'required' }, 0)).toEqual({ plan: 'required', flaky: { max: 0 } })
  })

  it('要求基线：开 = benchmark.require_baseline true，关 = 删键', () => {
    expect(withRequireBaseline({ plan: 'required' }, true)).toEqual({ plan: 'required', benchmark: { require_baseline: true } })
    expect(withRequireBaseline(FULL, false)).not.toHaveProperty('benchmark')
  })

  it('百分比输入：空 = 清除；0–100 含小数 = 值；越界、负数、非数字、科学计数法 = 无效', () => {
    expect(parsePercent('')).toEqual({ kind: 'empty' })
    expect(parsePercent('  ')).toEqual({ kind: 'empty' })
    expect(parsePercent('0')).toEqual({ kind: 'value', value: 0 })
    expect(parsePercent('82.5')).toEqual({ kind: 'value', value: 82.5 })
    expect(parsePercent('100')).toEqual({ kind: 'value', value: 100 })
    for (const bad of ['101', '-1', 'abc', '1e2', '8 0', '80%', '.5', '5.']) expect(parsePercent(bad)).toEqual({ kind: 'invalid' })
  })

  it('上限输入：空 = 清除；0–1000 整数 = 值；小数、负数、越界无效', () => {
    expect(parseLimit('')).toEqual({ kind: 'empty' })
    expect(parseLimit('0')).toEqual({ kind: 'value', value: 0 })
    expect(parseLimit('1000')).toEqual({ kind: 'value', value: 1000 })
    for (const bad of ['1001', '-1', '1.5', 'x']) expect(parseLimit(bad)).toEqual({ kind: 'invalid' })
  })
})
