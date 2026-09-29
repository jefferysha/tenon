import { describe, expect, it } from 'vitest'
import { emptyTestPlan, extractScenarios, extractTaskItems, parseTestCatalog, type StepTestPolicyIR, type TestCatalog } from '@tenon/kernel'
import { seedPlan, splitUnmapped, withCase, withFiles, withSuite, withWaiver, withoutTarget } from './plan-edit.js'

const parsed = parseTestCatalog(`schema: tenon-test-catalog/v1
suites:
  - id: web-unit
    kind: unit
    runner: vitest
    command: npx vitest run
    cwd: web
    files: ["src/**/*.test.ts"]
    covers: ["src/**/*.ts"]
    report: { format: vitest-json, path: test-results/v.json }
  - id: web-e2e
    kind: playwright
    runner: playwright
    command: npx playwright test
    files: ["e2e/**/*.spec.ts"]
    report: { format: playwright-json, path: test-results/p.json }
  - id: api-regression
    kind: regression
    runner: vitest
    command: npx vitest run regression
    files: ["tests/regression/**/*.test.ts"]
    report: { format: vitest-json, path: test-results/r.json }
`)
if (!parsed.ok) throw new Error('fixture catalog')
const CATALOG: TestCatalog = parsed.catalog

function policy(kinds: TestCatalog['suites'][number]['kind'][], run: TestCatalog['suites'][number]['kind'][] = []): StepTestPolicyIR {
  return { plan: 'required', kinds, run, run_if_registered: [], scope: 'changed', files: 'registered', scenarios: 'off', benchmark: { require_baseline: false }, browsers: [] }
}

describe('计划编辑', () => {
  it('withSuite / withFiles / withCase 同键覆盖或合并', () => {
    let plan = withSuite(emptyTestPlan('demo'), { suite: 'web-unit', scope: 'changed' })
    plan = withSuite(plan, { suite: 'web-unit', scope: 'full' })
    expect(plan.suites).toEqual([{ suite: 'web-unit', scope: 'full' }])
    plan = withFiles(withFiles(plan, [{ path: 'a.test.ts', suite: 'web-unit' }]), [{ path: 'a.test.ts', kind: 'unit' }, { path: 'b.test.ts' }])
    expect(plan.files).toEqual([{ path: 'a.test.ts', kind: 'unit' }, { path: 'b.test.ts' }])
    plan = withCase(withCase(plan, 'task:1.1', ['a.test.ts › x']), 'task:1.1', ['a.test.ts › y', 'a.test.ts › x'])
    expect(plan.cases).toEqual([{ covers: 'task:1.1', tests: ['a.test.ts › x', 'a.test.ts › y'] }])
  })

  it('withWaiver：原因没变保留批准；原因变了批准清零；按 kind 与按 covers 各自一键', () => {
    const approved = { ...emptyTestPlan('demo'), waivers: [{ kind: 'benchmark' as const, reason: '无性能路径', approved_by: 'boss@x.io' }] }
    expect(withWaiver(approved, { kind: 'benchmark', reason: '无性能路径', approved_by: null })).toBe(approved)
    expect(withWaiver(approved, { kind: 'benchmark', reason: '换了理由', approved_by: null }).waivers).toEqual([
      { kind: 'benchmark', reason: '换了理由', approved_by: null },
    ])
    const both = withWaiver(withWaiver(emptyTestPlan('demo'), { kind: 'a11y', reason: 'r1', approved_by: null }), { covers: 'task:1', reason: 'r2', approved_by: null })
    expect(both.waivers).toHaveLength(2)
  })

  it('withoutTarget：按套件 / 文件 / 映射 / 单个用例 / 豁免移除，并如实计数', () => {
    let plan = withSuite(emptyTestPlan('demo'), { suite: 'web-unit', scope: 'full' })
    plan = withFiles(plan, [{ path: 'a.test.ts' }])
    plan = withCase(plan, 'task:1', ['a.test.ts › x', 'a.test.ts › y'])
    plan = withWaiver(plan, { kind: 'a11y', reason: 'r', approved_by: null })
    expect(withoutTarget(plan, { suite: 'nope' }).removed).toBe(0)
    expect(withoutTarget(plan, { suite: 'web-unit' }).removed).toBe(1)
    expect(withoutTarget(plan, { file: 'a.test.ts' }).plan.files).toEqual([])
    const partial = withoutTarget(plan, { covers: 'task:1', test: 'a.test.ts › x' })
    expect(partial).toMatchObject({ removed: 1, plan: { cases: [{ covers: 'task:1', tests: ['a.test.ts › y'] }] } })
    expect(withoutTarget(plan, { covers: 'task:1' }).plan.cases).toEqual([])
    expect(withoutTarget(plan, { waiverKind: 'a11y' }).plan.waivers).toEqual([])
  })
})

describe('seedPlan', () => {
  const scenarios = extractScenarios('auth', '## ADDED Requirements\n### Requirement: R\n#### Scenario: 登录成功\n#### Scenario: 密码错误\n')
  const tasks = extractTaskItems('## 1. Build\n- [ ] 1.1 做登录\n')

  it('diff 碰到的套件（改了测试文件或 covers 里的源码）→ changed；策略要求的种类补全量套件；未登记文件带上唯一认领的套件', () => {
    const result = seedPlan({
      catalog: CATALOG, plan: emptyTestPlan('demo'), policies: [policy(['unit'], ['regression'])],
      changedFiles: ['web/src/login.ts', 'web/src/login.test.ts', 'e2e/login.spec.ts', 'README.md', 'tools/x.spec.js'],
      scenarios, tasks,
    })
    expect([...result.plan.suites].sort((left, right) => left.suite.localeCompare(right.suite))).toEqual([
      { suite: 'api-regression', scope: 'full' }, { suite: 'web-e2e', scope: 'changed' }, { suite: 'web-unit', scope: 'changed' },
    ])
    expect(result.addedSuites.sort()).toEqual(['api-regression', 'web-e2e', 'web-unit'])
    expect(result.plan.files).toEqual([
      { path: 'e2e/login.spec.ts', suite: 'web-e2e', kind: 'playwright' },
      { path: 'web/src/login.test.ts', suite: 'web-unit', kind: 'unit' },
    ])
    expect(result.orphans).toEqual(['tools/x.spec.js'])
    expect(result.unmapped.map((item) => item.covers)).toEqual(['spec:auth/登录成功', 'spec:auth/密码错误', 'task:1.1'])
  })

  it('只增不减：已有计划里的套件、文件、映射、豁免原样保留，已映射的场景不再列为待映射', () => {
    let plan = withCase(withSuite(emptyTestPlan('demo'), { suite: 'web-unit', scope: 'grep', pattern: '@x' }), 'spec:auth/登录成功', ['web/src/login.test.ts › ok'])
    plan = withWaiver(plan, { kind: 'a11y', reason: 'r', approved_by: 'boss@x.io' })
    const result = seedPlan({ catalog: CATALOG, plan, policies: [policy(['unit'])], changedFiles: [], scenarios, tasks })
    expect(result.plan.suites).toEqual([{ suite: 'web-unit', scope: 'grep', pattern: '@x' }])
    expect(result.plan.waivers).toEqual(plan.waivers)
    expect(result.addedSuites).toEqual([])
    expect(result.unmapped.map((item) => item.covers)).toEqual(['spec:auth/密码错误', 'task:1.1'])
  })

  it('待映射分两组：场景与实现阶段小节的任务要求映射，其余阶段的任务与骨架提示词可选', () => {
    const mixed = extractTaskItems(['## 立项', '- [ ] 将本阶段目标拆成可验证任务。', '## 实现', '- [ ] 做登录', '## 验证', '- [ ] 手工回归'].join('\n'))
    const result = seedPlan({ catalog: CATALOG, plan: emptyTestPlan('demo'), policies: [], changedFiles: [], scenarios, tasks: mixed })
    const groups = splitUnmapped(result.unmapped)
    expect(groups.required.map((item) => item.covers)).toEqual(['spec:auth/登录成功', 'spec:auth/密码错误', 'task:2.1'])
    expect(groups.optional.map((item) => item.covers)).toEqual(['task:1.1', 'task:3.1'])
  })

  it('策略要求的种类目录里没有套件 → missingKinds；读不到 diff 时只按策略补套件', () => {
    const result = seedPlan({ catalog: CATALOG, plan: emptyTestPlan('demo'), policies: [policy(['unit', 'benchmark'])], changedFiles: undefined, scenarios: [], tasks: [] })
    expect(result.missingKinds).toEqual(['benchmark'])
    expect(result.plan.suites).toEqual([{ suite: 'web-unit', scope: 'full' }])
    expect(result.plan.files).toEqual([])
  })
})
