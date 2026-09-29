import { describe, expect, it } from 'vitest'
import { parseTestCatalog, emptyTestPlan, type StepTestPolicyIR, type TestCatalog, type TestPlan } from '@tenon/kernel'
import { planRunSet, type RunFlags } from './run-set.js'

const CATALOG_TEXT = `schema: tenon-test-catalog/v1
suites:
  - { id: unit, kind: unit, runner: vitest, command: "npx vitest run", report: { format: vitest-json, path: test-results/v.json } }
  - { id: reg, kind: regression, runner: vitest, command: "npx vitest run reg", report: { format: vitest-json, path: test-results/r.json } }
  - { id: e2e, kind: playwright, runner: playwright, command: "npx playwright test", report: { format: playwright-json, path: test-results/p.json } }
  - { id: tsc, kind: typecheck, runner: tsc, command: "npx tsc", report: { format: exit-code } }
`
const parsed = parseTestCatalog(CATALOG_TEXT)
if (!parsed.ok) throw new Error('fixture catalog')
const CATALOG: TestCatalog = parsed.catalog

const POLICY: StepTestPolicyIR = {
  plan: 'required', kinds: [], run: ['unit', 'typecheck'], run_if_registered: ['playwright'], scope: 'changed', files: 'any',
  scenarios: 'off', benchmark: { require_baseline: false }, browsers: [],
}
const PLAN: TestPlan = {
  ...emptyTestPlan('demo'),
  suites: [{ suite: 'unit', scope: 'changed' }, { suite: 'reg', scope: 'full' }, { suite: 'e2e', scope: 'grep', pattern: '@smoke' }],
}
const FLAGS: RunFlags = { suites: [], kinds: [], stage: false, all: false, changed: false }

function ids(result: ReturnType<typeof planRunSet>): string[] {
  return 'items' in result ? result.items.map((item) => `${item.suite.id}:${item.scope}:${item.why}`) : [result.error]
}

describe('planRunSet', () => {
  it('没有任何选择参数 = --stage：策略 run 与 run_if_registered 里种类对应的计划套件，范围沿用计划', () => {
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: POLICY, flags: FLAGS, stepId: 'build', change: 'demo' })))
      .toEqual(['unit:changed:run', 'e2e:grep:if-registered'])
  })

  it('策略要求全量 → 阶段运行集一律 full（pattern / files 不再适用）', () => {
    const result = planRunSet({ catalog: CATALOG, plan: PLAN, policy: { ...POLICY, scope: 'full' }, flags: { ...FLAGS, stage: true }, stepId: 'verify', change: 'demo' })
    expect(ids(result)).toEqual(['unit:full:run', 'e2e:full:if-registered'])
    expect('items' in result && result.items.every((item) => item.pattern === undefined)).toBe(true)
  })

  it('--changed 把范围改成 changed', () => {
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: POLICY, flags: { ...FLAGS, changed: true }, stepId: 'build', change: 'demo' })))
      .toEqual(['unit:changed:run', 'e2e:changed:if-registered'])
  })

  it('--suite：点名的套件沿用计划范围，计划里没有就 full；未知 id 报可选项', () => {
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: POLICY, flags: { ...FLAGS, suites: ['e2e', 'tsc'] }, stepId: 'build', change: 'demo' })))
      .toEqual(['e2e:grep:explicit', 'tsc:full:explicit'])
    expect(ids(planRunSet({ catalog: CATALOG, plan: undefined, policy: undefined, flags: { ...FLAGS, suites: ['nope'] }, stepId: 'build', change: 'demo' })))
      .toEqual([expect.stringContaining("目录里没有套件 'nope'")])
  })

  it('--kind：计划里该种类的套件；没有计划时取目录里的；种类不合法 / 没有套件报错', () => {
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: POLICY, flags: { ...FLAGS, kinds: ['regression'] }, stepId: 'build', change: 'demo' }))).toEqual(['reg:full:explicit'])
    expect(ids(planRunSet({ catalog: CATALOG, plan: undefined, policy: undefined, flags: { ...FLAGS, kinds: ['typecheck'] }, stepId: 'build', change: 'demo' }))).toEqual(['tsc:full:explicit'])
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: POLICY, flags: { ...FLAGS, kinds: ['typecheck'] }, stepId: 'build', change: 'demo' }))[0]).toContain('任务计划里没有 typecheck')
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: POLICY, flags: { ...FLAGS, kinds: ['nope'] }, stepId: 'build', change: 'demo' }))[0]).toContain('不合法')
  })

  it('--all：计划里的全部套件（全量）；没有计划取目录全部', () => {
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: POLICY, flags: { ...FLAGS, all: true }, stepId: 'build', change: 'demo' }))).toEqual(['unit:full:explicit', 'reg:full:explicit', 'e2e:full:explicit'])
    expect(ids(planRunSet({ catalog: CATALOG, plan: undefined, policy: undefined, flags: { ...FLAGS, all: true }, stepId: 'build', change: 'demo' }))).toHaveLength(4)
  })

  it('选择参数组合按 id 去重，并按目录顺序排', () => {
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: POLICY, flags: { ...FLAGS, suites: ['reg'], kinds: ['unit'], stage: true }, stepId: 'build', change: 'demo' })))
      .toEqual(['unit:changed:explicit', 'reg:full:explicit', 'e2e:grep:if-registered'])
  })

  it('阶段运行集缺前提时给出可执行的提示', () => {
    expect(ids(planRunSet({ catalog: CATALOG, plan: undefined, policy: POLICY, flags: FLAGS, stepId: 'build', change: 'demo' }))[0]).toContain('tenon test plan demo --seed')
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: undefined, flags: FLAGS, stepId: 'build', change: 'demo' }))[0]).toContain('没有 test_policy')
    expect(ids(planRunSet({ catalog: CATALOG, plan: emptyTestPlan('demo'), policy: POLICY, flags: FLAGS, stepId: 'build', change: 'demo' }))[0]).toContain('tenon test register demo --suite')
  })
})
