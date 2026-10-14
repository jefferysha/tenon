/**
 * 档位 / 旧策略 → 有效策略（M1）：档位含义来自目录 `levels` 或内建缺省，旧 `test_policy` 原样返回。
 */
import { describe, expect, it } from 'vitest'
import { compileStepTestPolicy } from '../workflow/compile-test-policy.js'
import { parseTestCatalog } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import {
  INERT_TEST_POLICY, policyChecksChangedFiles, policyRunsSuites, resolveStepTestPolicy, stepHasTestPolicy,
} from './resolve-policy.js'

function catalogOf(text: string): TestCatalog {
  const result = parseTestCatalog(`schema: tenon-test-catalog/v1\n${text}suites: []\n`)
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('\n'))
  return result.catalog
}

describe('resolveStepTestPolicy', () => {
  it('test: none 与什么都不写 → undefined', () => {
    expect(resolveStepTestPolicy({ test: 'none' }, undefined)).toBeUndefined()
    expect(resolveStepTestPolicy({}, undefined)).toBeUndefined()
  })

  it('test: changed，目录没有 levels → 缺省档位：scope changed、files any、必需类 unit', () => {
    const policy = resolveStepTestPolicy({ test: 'changed' }, catalogOf(''))
    expect(policy).toMatchObject({
      plan: 'required', kinds: [], run: [], run_if_registered: [], scope: 'changed', files: 'any', scenarios: 'off',
      benchmark: { require_baseline: false }, browsers: [],
    })
    expect(policy?.level?.name).toBe('changed')
    expect(policy?.level?.required).toEqual(['unit'])
    expect(policy?.level?.touched).toEqual(['static'])
    expect(policy?.level?.source).toBe('default')
    expect(policy).not.toHaveProperty('coverage')
    expect(policy).not.toHaveProperty('flaky')
    expect(policy).not.toHaveProperty('integrity')
  })

  it('目录为 undefined 时用缺省档位；plan 与 changed 都记 scope changed，full 记 full', () => {
    expect(resolveStepTestPolicy({ test: 'plan' }, undefined)).toMatchObject({ scope: 'changed', level: { name: 'plan', touched: [] } })
    expect(resolveStepTestPolicy({ test: 'changed' }, undefined)?.scope).toBe('changed')
    expect(resolveStepTestPolicy({ test: 'full' }, undefined)).toMatchObject({
      scope: 'full', level: { name: 'full', required: ['unit'], touched: ['integration', 'e2e', 'static', 'benchmark'] },
    })
  })

  it('目录 levels 的阈值带进策略：scenarios、coverage、flaky、require_baseline', () => {
    const catalog = catalogOf(`levels:
  full:
    scenarios: required
    coverage: { lines: 80 }
    flaky: { max: 2, fail_on_new: true }
    require_baseline: true
`)
    const policy = resolveStepTestPolicy({ test: 'full' }, catalog)
    expect(policy).toMatchObject({
      scenarios: 'required', coverage: { lines: 80 }, flaky: { max: 2, fail_on_new: true },
      benchmark: { require_baseline: true }, level: { source: 'catalog' },
    })
  })

  it('旧 test_policy 原样返回（同一个对象）', () => {
    const legacy = compileStepTestPolicy({ run: ['unit'], scope: 'changed', files: 'registered' }, 'test')
    expect(legacy).toBeDefined()
    expect(resolveStepTestPolicy({ test_policy: legacy }, catalogOf(''))).toBe(legacy)
    expect(legacy).not.toHaveProperty('level')
  })

  it('同一步档位与旧策略并存（编译会拒，这里是纵深防线）时旧策略优先', () => {
    const legacy = compileStepTestPolicy({ run: ['unit'] }, 'test')
    expect(resolveStepTestPolicy({ test: 'full', test_policy: legacy }, undefined)).toBe(legacy)
  })
})

describe('策略形态判定', () => {
  it('stepHasTestPolicy：档位（非 none）或旧策略', () => {
    const legacy = compileStepTestPolicy({ run: ['unit'] }, 'test')
    expect(stepHasTestPolicy({})).toBe(false)
    expect(stepHasTestPolicy({ test: 'none' })).toBe(false)
    expect(stepHasTestPolicy({ test: 'plan' })).toBe(true)
    expect(stepHasTestPolicy({ test_policy: legacy })).toBe(true)
  })

  it('policyChecksChangedFiles：旧 files: registered、档位 changed / full；plan 档与 files: any 不读改动列表', () => {
    const registered = compileStepTestPolicy({ run: ['unit'], files: 'registered' }, 'test')
    const any = compileStepTestPolicy({ run: ['unit'] }, 'test')
    expect(registered && policyChecksChangedFiles(registered)).toBe(true)
    expect(any && policyChecksChangedFiles(any)).toBe(false)
    expect(policyChecksChangedFiles(resolveStepTestPolicy({ test: 'changed' }, undefined) ?? INERT_TEST_POLICY)).toBe(true)
    expect(policyChecksChangedFiles(resolveStepTestPolicy({ test: 'full' }, undefined) ?? INERT_TEST_POLICY)).toBe(true)
    expect(policyChecksChangedFiles(resolveStepTestPolicy({ test: 'plan' }, undefined) ?? INERT_TEST_POLICY)).toBe(false)
    expect(policyChecksChangedFiles(INERT_TEST_POLICY)).toBe(false)
  })

  it('policyRunsSuites：旧策略 run / run_if_registered 非空，或档位 changed / full', () => {
    const none = compileStepTestPolicy({ plan: 'required', kinds: ['unit'] }, 'test')
    const some = compileStepTestPolicy({ run_if_registered: ['typecheck'] }, 'test')
    expect(none && policyRunsSuites(none)).toBe(false)
    expect(some && policyRunsSuites(some)).toBe(true)
    expect(policyRunsSuites(resolveStepTestPolicy({ test: 'plan' }, undefined) ?? INERT_TEST_POLICY)).toBe(false)
    expect(policyRunsSuites(resolveStepTestPolicy({ test: 'changed' }, undefined) ?? INERT_TEST_POLICY)).toBe(true)
    expect(policyRunsSuites(INERT_TEST_POLICY)).toBe(false)
  })
})
