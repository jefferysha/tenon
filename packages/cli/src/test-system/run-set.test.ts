import { describe, expect, it } from 'vitest'
import {
  parseTestCatalog, emptyTestPlan, resolveStepTestPolicy, stageRunSet, type StepTestPolicyIR, type TestCatalog, type TestPlan,
} from '@tenon/kernel'
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
    expect(ids(planRunSet({ catalog: CATALOG, plan: PLAN, policy: undefined, flags: FLAGS, stepId: 'build', change: 'demo' }))[0]).toContain('没有测试档位')
    expect(ids(planRunSet({ catalog: CATALOG, plan: emptyTestPlan('demo'), policy: POLICY, flags: FLAGS, stepId: 'build', change: 'demo' }))[0]).toContain('tenon test register demo --suite')
  })

  it('策略没有必须运行的种类：计划里没有对应套件也不是错误，阶段运行集为空', () => {
    const optional = { ...POLICY, run: [], run_if_registered: ['playwright'] } satisfies StepTestPolicyIR
    expect(planRunSet({ catalog: CATALOG, plan: emptyTestPlan('demo'), policy: optional, flags: FLAGS, stepId: 'ship', change: 'demo' })).toEqual({ items: [] })
    expect(planRunSet({ catalog: CATALOG, plan: emptyTestPlan('demo'), policy: { ...optional, run_if_registered: [] }, flags: FLAGS, stepId: 'spec', change: 'demo' })).toEqual({ items: [] })
  })
})

describe('planRunSet —— 档位策略与 stageRunSet 同一份运行集', () => {
  const LEVEL_CATALOG_TEXT = `schema: tenon-test-catalog/v1
suites:
  - { id: unit, kind: unit, runner: vitest, command: "npx vitest run", files: ["src/**/*.test.ts"], covers: ["src/**"], report: { format: vitest-json, path: test-results/v.json } }
  - { id: docs-unit, kind: unit, runner: vitest, command: "npx vitest run docs", files: ["docs/**/*.test.ts"], covers: ["docs/**"], report: { format: vitest-json, path: test-results/d.json } }
  - { id: hooks, kind: integration, runner: custom, command: "bash hooks/test.sh", files: ["hooks/**/*.test.sh"], covers: ["hooks/**"], report: { format: junit, path: test-results/h.xml } }
  - { id: tsc, kind: typecheck, runner: tsc, command: "npx tsc", covers: ["tsconfig.json"], report: { format: exit-code } }
`
  const parsedLevels = parseTestCatalog(LEVEL_CATALOG_TEXT)
  if (!parsedLevels.ok) throw new Error('fixture level catalog')
  const LEVELS: TestCatalog = parsedLevels.catalog

  function level(test: 'plan' | 'changed' | 'full', catalog: TestCatalog = LEVELS): StepTestPolicyIR {
    const policy = resolveStepTestPolicy({ test }, catalog)
    if (policy === undefined) throw new Error('policy')
    return policy
  }

  /** CLI 运行集条目 → 与 StageRunItem 同形，便于逐项比较（why 与 reason 同值，explicit 不会出现）。 */
  function shapeOf(result: ReturnType<typeof planRunSet>) {
    if (!('items' in result)) throw new Error(result.error)
    return result.items.map((item) => ({ id: item.suite.id, scope: item.scope, reason: item.why, pattern: item.pattern, files: item.files }))
  }

  const scenarios: ReadonlyArray<readonly [string, StepTestPolicyIR, TestPlan, readonly string[] | undefined]> = [
    ['changed，只改 src', level('changed'), emptyTestPlan('demo'), ['src/a.ts']],
    ['changed，只改 README', level('changed'), emptyTestPlan('demo'), ['README.md']],
    ['changed，改了 tsconfig（静态类被碰到）', level('changed'), emptyTestPlan('demo'), ['tsconfig.json', 'docs/x.md']],
    ['changed，读不到改动', level('changed'), { ...emptyTestPlan('demo'), suites: [{ suite: 'hooks', scope: 'grep', pattern: '@gate' }] }, undefined],
    ['full，没碰 hooks', level('full'), emptyTestPlan('demo'), ['README.md']],
    ['full，碰了 hooks', level('full'), { ...emptyTestPlan('demo'), suites: [{ suite: 'docs-unit', scope: 'changed' }] }, ['hooks/gate.sh']],
    ['full，读不到改动', level('full'), emptyTestPlan('demo'), undefined],
    ['plan', level('plan'), emptyTestPlan('demo'), ['src/a.ts']],
    ['旧策略 files: registered', { ...POLICY, files: 'registered' }, { ...emptyTestPlan('demo'), suites: [{ suite: 'unit', scope: 'changed' }] }, ['src/a.test.ts', 'docs/a.test.ts']],
  ]

  it.each(scenarios)('--stage 与 stageRunSet 给出同一组套件与范围：%s', (_name, policy, plan, changedFiles) => {
    const cli = planRunSet({ catalog: LEVELS, plan, policy, flags: { ...FLAGS, stage: true }, stepId: 'build', change: 'demo', changedFiles })
    const kernel = stageRunSet({ policy, catalog: LEVELS, plan, changedFiles })
    expect(shapeOf(cli)).toEqual(kernel.items.map((item) => ({
      id: item.suite.id, scope: item.scope, reason: item.reason, pattern: item.pattern, files: item.files,
    })))
  })

  it('跑改动：只跑被碰到的套件（unit，范围 changed）', () => {
    expect(ids(planRunSet({ catalog: LEVELS, plan: emptyTestPlan('demo'), policy: level('changed'), flags: FLAGS, stepId: 'build', change: 'demo', changedFiles: ['src/a.ts'] })))
      .toEqual(['unit:changed:run'])
  })

  it('改动没碰到任何套件：空运行集不是错误（{ items: [] }）', () => {
    expect(planRunSet({ catalog: LEVELS, plan: emptyTestPlan('demo'), policy: level('changed'), flags: FLAGS, stepId: 'build', change: 'demo', changedFiles: ['README.md'] }))
      .toEqual({ items: [] })
    expect(planRunSet({ catalog: LEVELS, plan: emptyTestPlan('demo'), policy: level('plan'), flags: FLAGS, stepId: 'spec', change: 'demo', changedFiles: ['src/a.ts'] }))
      .toEqual({ items: [] })
  })

  it('计划缺失仍提示先生成计划；步骤没有测试声明时错误里说明档位与 test_policy', () => {
    expect(ids(planRunSet({ catalog: LEVELS, plan: undefined, policy: level('changed'), flags: FLAGS, stepId: 'build', change: 'demo', changedFiles: [] }))[0])
      .toContain('tenon test plan demo --seed')
    expect(ids(planRunSet({ catalog: LEVELS, plan: emptyTestPlan('demo'), policy: undefined, flags: FLAGS, stepId: 'build', change: 'demo' }))[0])
      .toContain('test_policy')
  })

  it('--changed 把档位推出的范围压成 changed；点名套件仍然优先', () => {
    expect(ids(planRunSet({ catalog: LEVELS, plan: emptyTestPlan('demo'), policy: level('full'), flags: { ...FLAGS, changed: true }, stepId: 'verify', change: 'demo', changedFiles: [] })))
      .toEqual(['unit:changed:run', 'docs-unit:changed:run'])
    expect(ids(planRunSet({ catalog: LEVELS, plan: emptyTestPlan('demo'), policy: level('changed'), flags: { ...FLAGS, suites: ['hooks'] }, stepId: 'build', change: 'demo', changedFiles: [] })))
      .toEqual(['hooks:full:explicit'])
  })

  it('旧策略 run 非空却没有套件时仍报原来的错误，档位策略不报', () => {
    expect(ids(planRunSet({ catalog: CATALOG, plan: emptyTestPlan('demo'), policy: POLICY, flags: FLAGS, stepId: 'build', change: 'demo' }))[0]).toContain('tenon test register demo --suite')
    expect(planRunSet({ catalog: LEVELS, plan: emptyTestPlan('demo'), policy: level('changed'), flags: FLAGS, stepId: 'build', change: 'demo', changedFiles: [] })).toEqual({ items: [] })
  })
})
