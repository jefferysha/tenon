/**
 * 阶段运行集（M2）：档位 × 目录 × 计划 × 本任务改动 → 要跑的套件与范围。evaluate-v2 与 `tenon test run --stage` 共用，
 * 所以这里把设计 §5 与规格「阶段运行集」的每个场景落成用例。
 */
import { describe, expect, it } from 'vitest'
import { compileStepTestPolicy } from '../workflow/compile-test-policy.js'
import type { StepTestPolicyIR } from '../workflow/ir.js'
import type { TestLevel } from '../workflow/test-level.js'
import { parseTestCatalog } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import { emptyTestPlan, type TestPlan } from './plan.js'
import { resolveStepTestPolicy } from './resolve-policy.js'
import { stageRunSet, suitesWithoutCovers, suitesWithoutCoversNotice, touches } from './stage-run-set.js'

/** 各种类的合法 runner / 报告格式组合（目录校验会拒不合法的组合）。 */
const SHAPE: Readonly<Record<string, string>> = {
  playwright: 'runner: playwright, report: { format: playwright-json, path: test-results/results.json }',
  typecheck: 'runner: tsc, report: { format: exit-code }',
  lint: 'runner: eslint, report: { format: exit-code }',
}

const suite = (id: string, kind: string, files: string, covers: string, extra = ''): string =>
  `  - { id: ${id}, kind: ${kind}, ${SHAPE[kind] ?? `runner: vitest, report: { format: junit, path: test-results/${id}.xml }`}, command: run, files: ["${files}"], covers: ["${covers}"]${extra} }\n`

function catalogOf(suites: string, tail = ''): TestCatalog {
  const result = parseTestCatalog(`schema: tenon-test-catalog/v1\nsuites:\n${suites}${tail}`)
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('\n'))
  return result.catalog
}

const CATALOG = catalogOf(
  suite('unit', 'unit', 'src/**/*.test.ts', 'src/**')
  + suite('docs-unit', 'unit', 'docs/**/*.test.ts', 'docs/**')
  + suite('hooks', 'integration', 'hooks/**/*.test.sh', 'hooks/**')
  + suite('e2e', 'playwright', 'e2e/**/*.spec.ts', 'ui/**')
  + suite('types', 'typecheck', 'types/**/*.test.ts', 'tsconfig.json'),
)

function levelPolicy(level: TestLevel, catalog: TestCatalog | undefined = CATALOG): StepTestPolicyIR {
  const policy = resolveStepTestPolicy({ test: level }, catalog)
  if (policy === undefined) throw new Error('policy')
  return policy
}

function legacyPolicy(raw: Parameters<typeof compileStepTestPolicy>[0]): StepTestPolicyIR {
  const policy = compileStepTestPolicy(raw, 'test')
  if (policy === undefined) throw new Error('policy')
  return policy
}

const PLAN: TestPlan = emptyTestPlan('demo')

function shape(items: ReturnType<typeof stageRunSet>['items']): Array<[string, string, string]> {
  return items.map((item) => [item.suite.id, item.scope, item.reason])
}

describe('stageRunSet —— 档位 changed', () => {
  it('跑改动只跑被碰到的套件：改了 src/a.ts → 只有 unit（范围 changed），docs-unit 不跑', () => {
    const set = stageRunSet({ policy: levelPolicy('changed'), catalog: CATALOG, plan: PLAN, changedFiles: ['src/a.ts'] })
    expect(shape(set.items)).toEqual([['unit', 'changed', 'run']])
    expect(set.missingClasses).toEqual([])
  })

  it('touched 类（缺省 static）被碰到才跑，原因是 if-registered：改了 tsconfig.json → types', () => {
    const set = stageRunSet({ policy: levelPolicy('changed'), catalog: CATALOG, plan: PLAN, changedFiles: ['tsconfig.json'] })
    expect(shape(set.items)).toEqual([['types', 'changed', 'if-registered']])
  })

  it('只改 README.md → 运行集为空（零运行即满足）', () => {
    const set = stageRunSet({ policy: levelPolicy('changed'), catalog: CATALOG, plan: PLAN, changedFiles: ['README.md'] })
    expect(set.items).toEqual([])
    expect(set.missingClasses).toEqual([])
  })

  it('改动只在测试文件上：测试文件匹配套件的 files glob，也算碰到', () => {
    const set = stageRunSet({ policy: levelPolicy('changed'), catalog: CATALOG, plan: PLAN, changedFiles: ['docs/x.test.ts'] })
    expect(shape(set.items)).toEqual([['docs-unit', 'changed', 'run']])
  })

  it('控制目录里的改动不算碰到（先 withoutControlPaths）', () => {
    const broad = catalogOf(suite('unit', 'unit', '**/*.test.ts', '**'))
    const set = stageRunSet({
      policy: levelPolicy('changed', broad), catalog: broad, plan: PLAN,
      changedFiles: ['openspec/changes/c/notes.md', '.tenon/tests/catalog.yaml', '.pipeline/x'],
    })
    expect(set.items).toEqual([])
  })

  it('touched 类没被碰到的不跑；required 类没被碰到的也不跑', () => {
    const set = stageRunSet({ policy: levelPolicy('changed'), catalog: CATALOG, plan: PLAN, changedFiles: ['ui/page.tsx'] })
    expect(set.items).toEqual([])
  })

  it('结果按目录顺序，一个套件只出现一次', () => {
    const set = stageRunSet({
      policy: levelPolicy('changed'), catalog: CATALOG, plan: PLAN, changedFiles: ['tsconfig.json', 'docs/a.md', 'src/b.ts', 'src/c.ts', 'docs/d.md'],
    })
    expect(set.items.map((item) => item.suite.id)).toEqual(['unit', 'docs-unit', 'types'])
  })

  it('改动路径与认领同一口径：./ 前缀与反斜杠写法和 src/a.ts 的运行集相同', () => {
    const policy = levelPolicy('changed')
    const expected = shape(stageRunSet({ policy, catalog: CATALOG, plan: PLAN, changedFiles: ['src/a.ts'] }).items)
    expect(expected).toEqual([['unit', 'changed', 'run']])
    for (const path of ['./src/a.ts', 'src\\a.ts', '.\\src\\a.ts']) {
      expect(shape(stageRunSet({ policy, catalog: CATALOG, plan: PLAN, changedFiles: [path] }).items)).toEqual(expected)
    }
    expect(shape(stageRunSet({ policy, catalog: CATALOG, plan: PLAN, changedFiles: ['./tsconfig.json'] }).items)).toEqual([['types', 'changed', 'if-registered']])
  })

  it('控制目录判定也在归一之后：./openspec/…、.\\.tenon\\… 不算碰到', () => {
    const broad = catalogOf(suite('unit', 'unit', '**/*.test.ts', '**'))
    const set = stageRunSet({
      policy: levelPolicy('changed', broad), catalog: broad, plan: PLAN,
      changedFiles: ['./openspec/changes/c/notes.md', '.\\.tenon\\tests\\catalog.yaml'],
    })
    expect(set.items).toEqual([])
  })
})

describe('stageRunSet —— 档位 full', () => {
  it('必需类的全部套件全量跑；hooks（集成类）只在改了 hooks/gate.sh 时加入', () => {
    const untouched = stageRunSet({ policy: levelPolicy('full'), catalog: CATALOG, plan: PLAN, changedFiles: ['README.md'] })
    expect(shape(untouched.items)).toEqual([['unit', 'full', 'run'], ['docs-unit', 'full', 'run']])
    const touched = stageRunSet({ policy: levelPolicy('full'), catalog: CATALOG, plan: PLAN, changedFiles: ['hooks/gate.sh'] })
    expect(shape(touched.items)).toEqual([['unit', 'full', 'run'], ['docs-unit', 'full', 'run'], ['hooks', 'full', 'if-registered']])
  })

  it('touched 类被碰到的套件全量跑：改了 ui/ → e2e 全量', () => {
    const set = stageRunSet({ policy: levelPolicy('full'), catalog: CATALOG, plan: PLAN, changedFiles: ['ui/page.tsx'] })
    expect(shape(set.items)).toEqual([['unit', 'full', 'run'], ['docs-unit', 'full', 'run'], ['e2e', 'full', 'if-registered']])
  })

  it('目录 levels 把 integration 提为必需类：不用碰到也全量跑', () => {
    const catalog = catalogOf(
      suite('unit', 'unit', 'src/**/*.test.ts', 'src/**') + suite('hooks', 'integration', 'hooks/**/*.test.sh', 'hooks/**'),
      'levels:\n  full: { required: [unit, integration] }\n',
    )
    const set = stageRunSet({ policy: levelPolicy('full', catalog), catalog, plan: PLAN, changedFiles: ['README.md'] })
    expect(shape(set.items)).toEqual([['unit', 'full', 'run'], ['hooks', 'full', 'run']])
  })
})

describe('stageRunSet —— 档位 plan', () => {
  it('不运行套件，但 required 类缺失照样报', () => {
    const set = stageRunSet({ policy: levelPolicy('plan'), catalog: CATALOG, plan: PLAN, changedFiles: ['src/a.ts'] })
    expect(set.items).toEqual([])
    const noUnit = catalogOf(suite('hooks', 'integration', 'h/**', 'h/**'))
    expect(stageRunSet({ policy: levelPolicy('plan', noUnit), catalog: noUnit, plan: PLAN, changedFiles: [] }).missingClasses).toEqual(['unit'])
  })
})

describe('stageRunSet —— 计划里显式登记的套件', () => {
  const planned: TestPlan = {
    ...PLAN,
    suites: [{ suite: 'e2e', scope: 'grep', pattern: 'login' }, { suite: 'docs-unit', scope: 'files', files: ['docs/a.test.ts'] }, { suite: 'gone', scope: 'full' }],
  }

  it('changed 档：追加为 reason run，范围、pattern、files 沿用计划；目录里已不存在的套件忽略', () => {
    const set = stageRunSet({ policy: levelPolicy('changed'), catalog: CATALOG, plan: planned, changedFiles: ['src/a.ts'] })
    expect(set.items.map((item) => [item.suite.id, item.scope, item.reason, item.pattern, item.files])).toEqual([
      ['unit', 'changed', 'run', undefined, undefined],
      ['docs-unit', 'files', 'run', undefined, ['docs/a.test.ts']],
      ['e2e', 'grep', 'run', 'login', undefined],
    ])
  })

  it('计划登记的范围压过档位推出的范围（被碰到的套件也一样）', () => {
    const plan: TestPlan = { ...PLAN, suites: [{ suite: 'unit', scope: 'full' }] }
    const set = stageRunSet({ policy: levelPolicy('changed'), catalog: CATALOG, plan, changedFiles: ['src/a.ts'] })
    expect(shape(set.items).find(([id]) => id === 'unit')).toEqual(['unit', 'full', 'run'])
  })

  it('full 档一律全量，计划登记的 pattern / files 不再带', () => {
    const set = stageRunSet({ policy: levelPolicy('full'), catalog: CATALOG, plan: planned, changedFiles: [] })
    expect(shape(set.items)).toEqual([['unit', 'full', 'run'], ['docs-unit', 'full', 'run'], ['e2e', 'full', 'run']])
    for (const item of set.items) {
      expect(item.pattern).toBeUndefined()
      expect(item.files).toBeUndefined()
    }
  })

  it('plan 档不运行套件：计划里登记了也不进运行集', () => {
    expect(stageRunSet({ policy: levelPolicy('plan'), catalog: CATALOG, plan: planned, changedFiles: [] }).items).toEqual([])
  })
})

describe('stageRunSet —— 读不到改动列表（changedFiles 为 undefined）', () => {
  const planned: TestPlan = { ...PLAN, suites: [{ suite: 'e2e', scope: 'changed' }] }

  it('changed 档只返回计划里显式登记的套件', () => {
    const set = stageRunSet({ policy: levelPolicy('changed'), catalog: CATALOG, plan: planned, changedFiles: undefined })
    expect(shape(set.items)).toEqual([['e2e', 'changed', 'run']])
    expect(stageRunSet({ policy: levelPolicy('changed'), catalog: CATALOG, plan: PLAN, changedFiles: undefined }).items).toEqual([])
  })

  it('full 档在显式套件之外加上 required 类的套件（touched 类无从判断）', () => {
    const set = stageRunSet({ policy: levelPolicy('full'), catalog: CATALOG, plan: planned, changedFiles: undefined })
    expect(shape(set.items)).toEqual([['unit', 'full', 'run'], ['docs-unit', 'full', 'run'], ['e2e', 'full', 'run']])
  })

  it('missingClasses 与改动列表无关', () => {
    const noUnit = catalogOf(suite('hooks', 'integration', 'h/**', 'h/**'))
    expect(stageRunSet({ policy: levelPolicy('changed', noUnit), catalog: noUnit, plan: PLAN, changedFiles: undefined }).missingClasses).toEqual(['unit'])
  })
})

describe('stageRunSet —— missingClasses', () => {
  it('目录里没有 unit 类套件 → [unit]', () => {
    const catalog = catalogOf(suite('hooks', 'integration', 'h/**', 'h/**'))
    expect(stageRunSet({ policy: levelPolicy('changed', catalog), catalog, plan: PLAN, changedFiles: [] }).missingClasses).toEqual(['unit'])
  })

  it('kind: coverage 的套件满足 unit 类；kind: typecheck 满足 static 类', () => {
    const covered = catalogOf(suite('cov', 'coverage', 'src/**', 'src/**', ', coverage: { format: istanbul-summary, path: coverage/coverage-summary.json }'))
    expect(stageRunSet({ policy: levelPolicy('changed', covered), catalog: covered, plan: PLAN, changedFiles: [] }).missingClasses).toEqual([])
    const staticRequired = catalogOf(suite('types', 'typecheck', 't/**', 't/**'), 'levels:\n  changed: { required: [static] }\n')
    expect(stageRunSet({ policy: levelPolicy('changed', staticRequired), catalog: staticRequired, plan: PLAN, changedFiles: [] }).missingClasses).toEqual([])
  })

  it('已批准的项目级不适用声明满足该类（按类归类，旧种类名也算）；未批准的不满足', () => {
    const approved = catalogOf(suite('hooks', 'integration', 'h/**', 'h/**'), 'not_applicable:\n  - { kind: unit, reason: 没有单测, approved_by: r@x }\n')
    expect(stageRunSet({ policy: levelPolicy('changed', approved), catalog: approved, plan: PLAN, changedFiles: [] }).missingClasses).toEqual([])
    const pending = catalogOf(suite('hooks', 'integration', 'h/**', 'h/**'), 'not_applicable:\n  - { kind: unit, reason: 没有单测, approved_by: null }\n')
    expect(stageRunSet({ policy: levelPolicy('changed', pending), catalog: pending, plan: PLAN, changedFiles: [] }).missingClasses).toEqual(['unit'])
    const byOldKind = catalogOf(suite('hooks', 'integration', 'h/**', 'h/**'), 'levels:\n  full: { required: [unit, e2e] }\nnot_applicable:\n  - { kind: playwright, reason: 没有前端, approved_by: r@x }\n  - { kind: unit, reason: 没有单测, approved_by: r@x }\n')
    expect(stageRunSet({ policy: levelPolicy('full', byOldKind), catalog: byOldKind, plan: PLAN, changedFiles: [] }).missingClasses).toEqual([])
  })

  it('按 required 的顺序列出多个缺失的类', () => {
    const catalog = catalogOf(suite('hooks', 'integration', 'h/**', 'h/**'), 'levels:\n  full: { required: [e2e, unit, integration] }\n')
    expect(stageRunSet({ policy: levelPolicy('full', catalog), catalog, plan: PLAN, changedFiles: [] }).missingClasses).toEqual(['e2e', 'unit'])
  })
})

describe('stageRunSet —— 旧策略（level 缺席）', () => {
  const plan: TestPlan = { ...PLAN, suites: [{ suite: 'unit', scope: 'changed' }, { suite: 'e2e', scope: 'grep', pattern: 'login' }, { suite: 'types', scope: 'full' }] }

  it('计划套件按 policyRunReason 过滤；scope: changed 沿用计划登记的范围', () => {
    const policy = legacyPolicy({ run: ['unit'], run_if_registered: ['typecheck'], scope: 'changed' })
    const set = stageRunSet({ policy, catalog: CATALOG, plan, changedFiles: undefined })
    expect(set.items.map((item) => [item.suite.id, item.scope, item.reason])).toEqual([['unit', 'changed', 'run'], ['types', 'full', 'if-registered']])
    expect(set.missingClasses).toEqual([])
  })

  it('旧策略不受归类影响：run_if_registered: [typecheck] 只让 typecheck 套件参与，同属 static 类的 lint 套件登记了、被改动碰到了也不参与', () => {
    const catalog = catalogOf(suite('typecheck', 'typecheck', 'types/**/*.test.ts', 'types/**') + suite('lint', 'lint', 'lint/**/*.test.ts', 'lint/**'))
    const both: TestPlan = { ...PLAN, suites: [{ suite: 'typecheck', scope: 'full' }, { suite: 'lint', scope: 'full' }] }
    const policy = legacyPolicy({ run_if_registered: ['typecheck'], scope: 'changed' })
    expect(shape(stageRunSet({ policy, catalog, plan: both, changedFiles: undefined }).items)).toEqual([['typecheck', 'full', 'if-registered']])
    const claiming = legacyPolicy({ run_if_registered: ['typecheck'], scope: 'changed', files: 'registered' })
    expect(shape(stageRunSet({ policy: claiming, catalog, plan: both, changedFiles: ['lint/a.test.ts'] }).items)).toEqual([['typecheck', 'full', 'if-registered']])
    // 对照：同一目录按档位 changed 求运行集，lint 同属 static 类，被碰到就进运行集。
    const byLevel = stageRunSet({ policy: levelPolicy('changed', catalog), catalog, plan: PLAN, changedFiles: ['lint/a.test.ts'] })
    expect(shape(byLevel.items)).toEqual([['lint', 'changed', 'if-registered']])
  })

  it('scope: full 时一律全量，不带 pattern / files', () => {
    const policy = legacyPolicy({ run: ['unit', 'playwright'], scope: 'full' })
    const set = stageRunSet({ policy, catalog: CATALOG, plan, changedFiles: undefined })
    expect(set.items.map((item) => [item.suite.id, item.scope, item.reason, item.pattern])).toEqual([
      ['unit', 'full', 'run', undefined], ['e2e', 'full', 'run', undefined],
    ])
  })

  it('run 要求 regression 且 scope: full 时 unit 套件顶上（必跑）', () => {
    const policy = legacyPolicy({ run: ['regression'], scope: 'full' })
    const set = stageRunSet({ policy, catalog: CATALOG, plan, changedFiles: undefined })
    expect(shape(set.items)).toEqual([['unit', 'full', 'run']])
  })

  it('files: registered：认领文件所属、种类在 run ∪ run_if_registered 里且不在计划中的套件追加（changed 范围）', () => {
    const policy = legacyPolicy({ run: ['unit'], run_if_registered: ['integration'], scope: 'changed', files: 'registered' })
    const set = stageRunSet({
      policy, catalog: CATALOG, plan: { ...PLAN, suites: [{ suite: 'unit', scope: 'changed' }] },
      changedFiles: ['docs/a.test.ts', 'hooks/x.test.sh', 'e2e/a.spec.ts', 'src/a.test.ts'],
    })
    // e2e（playwright）不在 run / run_if_registered 里 → 不追加；unit 已在计划里 → 不重复。
    expect(shape(set.items)).toEqual([['unit', 'changed', 'run'], ['docs-unit', 'changed', 'run'], ['hooks', 'changed', 'if-registered']])
  })

  it('files: registered 且 scope: full：认领追加的套件按全量', () => {
    const policy = legacyPolicy({ run: ['unit'], scope: 'full', files: 'registered' })
    const set = stageRunSet({ policy, catalog: CATALOG, plan: PLAN, changedFiles: ['docs/a.test.ts'] })
    expect(shape(set.items)).toEqual([['docs-unit', 'full', 'run']])
  })

  it('files: any 不认领；读不到改动列表时也不认领', () => {
    const any = legacyPolicy({ run: ['unit'], scope: 'changed' })
    expect(stageRunSet({ policy: any, catalog: CATALOG, plan: PLAN, changedFiles: ['docs/a.test.ts'] }).items).toEqual([])
    const registered = legacyPolicy({ run: ['unit'], scope: 'changed', files: 'registered' })
    expect(stageRunSet({ policy: registered, catalog: CATALOG, plan: PLAN, changedFiles: undefined }).items).toEqual([])
  })

  it('控制目录里的测试类改动不认领', () => {
    const policy = legacyPolicy({ run: ['unit'], scope: 'changed', files: 'registered' })
    const broad = catalogOf(suite('unit', 'unit', '**/*.test.ts', '**'))
    expect(stageRunSet({ policy, catalog: broad, plan: PLAN, changedFiles: ['openspec/changes/c/a.test.ts'] }).items).toEqual([])
  })
})

describe('suitesWithoutCovers —— 没写 covers、只改源码碰不到的套件', () => {
  /** 不写 covers 的套件：只有改到它 files 匹配的文件才算被碰到。 */
  const bare = (id: string, kind: string, files: string): string =>
    `  - { id: ${id}, kind: ${kind}, ${SHAPE[kind] ?? `runner: vitest, report: { format: junit, path: test-results/${id}.xml }`}, command: run, files: ["${files}"] }\n`

  const UNIT_ONLY = catalogOf(bare('unit', 'unit', 'test/**/*.test.js'))

  function missing(catalog: TestCatalog, policy: StepTestPolicyIR, changedFiles: readonly string[] | undefined, plan: TestPlan = PLAN): readonly string[] {
    const runSet = stageRunSet({ policy, catalog, plan, changedFiles })
    return suitesWithoutCovers({ policy, catalog, changedFiles, runSet })
  }

  it('changed 档：unit 没写 covers，只改 src/a.js → 它不在运行集里，点名 unit', () => {
    expect(stageRunSet({ policy: levelPolicy('changed', UNIT_ONLY), catalog: UNIT_ONLY, plan: PLAN, changedFiles: ['src/a.js'] }).items).toEqual([])
    expect(missing(UNIT_ONLY, levelPolicy('changed', UNIT_ONLY), ['src/a.js'])).toEqual(['unit'])
  })

  it('只改 README.md（不是源码文件）→ 不提示', () => {
    expect(missing(UNIT_ONLY, levelPolicy('changed', UNIT_ONLY), ['README.md'])).toEqual([])
  })

  it('改了 unit 的测试文件 → 它被碰到、进了运行集 → 不提示；源码与测试文件一起改也不提示', () => {
    const policy = levelPolicy('changed', UNIT_ONLY)
    expect(missing(UNIT_ONLY, policy, ['test/a.test.js'])).toEqual([])
    expect(missing(UNIT_ONLY, policy, ['test/a.test.js', 'src/a.js'])).toEqual([])
  })

  it('只改测试文件（扩展名是源码、但像测试）不算源码改动 → 其他没写 covers 的套件不提示', () => {
    const two = catalogOf(bare('unit', 'unit', 'test/**/*.test.js') + bare('unit-b', 'unit', 'other/**/*.test.js'))
    expect(missing(two, levelPolicy('changed', two), ['test/a.test.js'])).toEqual([])
  })

  it('写了 covers 的套件被源码改动碰到，运行集里有它 → 不提示', () => {
    const covered = catalogOf(suite('unit', 'unit', 'test/**/*.test.js', 'src/**'))
    expect(missing(covered, levelPolicy('changed', covered), ['src/a.js'])).toEqual([])
  })

  it('covers 写了但源码改动没碰到它 → 也不提示（提示只管没写 covers 的）', () => {
    const covered = catalogOf(suite('unit', 'unit', 'test/**/*.test.js', 'lib/**'))
    expect(missing(covered, levelPolicy('changed', covered), ['src/a.js'])).toEqual([])
  })

  it('full 档：required 类的 unit 总在运行集里不报；touched 类的 e2e 没写 covers → 报 e2e', () => {
    const catalog = catalogOf(bare('unit', 'unit', 'test/**/*.test.js') + bare('e2e', 'playwright', 'e2e/**/*.spec.ts'))
    expect(missing(catalog, levelPolicy('full', catalog), ['src/a.js'])).toEqual(['e2e'])
  })

  it('不在档位 required / touched 类里的套件不报：changed 档的 touched 只有 static', () => {
    const catalog = catalogOf(bare('unit', 'unit', 'test/**/*.test.js') + bare('e2e', 'playwright', 'e2e/**/*.spec.ts') + bare('types', 'typecheck', 'types/**'))
    expect(missing(catalog, levelPolicy('changed', catalog), ['src/a.js'])).toEqual(['unit', 'types'])
  })

  it('计划里显式登记的套件已在运行集里 → 不报；其余按目录顺序', () => {
    const catalog = catalogOf(bare('unit', 'unit', 'test/**/*.test.js') + bare('unit-b', 'unit', 'other/**/*.test.js'))
    const plan: TestPlan = { ...PLAN, suites: [{ suite: 'unit-b', scope: 'full' }] }
    expect(missing(catalog, levelPolicy('changed', catalog), ['src/a.js'], plan)).toEqual(['unit'])
  })

  it('旧策略（level 缺席）、plan 档、读不到改动列表（changedFiles 为 undefined）→ 都不提示', () => {
    expect(missing(UNIT_ONLY, legacyPolicy({ run: ['unit'], scope: 'changed' }), ['src/a.js'])).toEqual([])
    expect(missing(UNIT_ONLY, levelPolicy('plan', UNIT_ONLY), ['src/a.js'])).toEqual([])
    expect(missing(UNIT_ONLY, levelPolicy('changed', UNIT_ONLY), undefined)).toEqual([])
  })

  it('控制目录里的源码文件不算源码改动：openspec/x.ts → 不提示', () => {
    expect(missing(UNIT_ONLY, levelPolicy('changed', UNIT_ONLY), ['openspec/x.ts', '.tenon/y.ts', '.pipeline/z.py'])).toEqual([])
  })

  it('非源码扩展名（yaml、json、md、没有扩展名）不算源码改动', () => {
    expect(missing(UNIT_ONLY, levelPolicy('changed', UNIT_ONLY), ['config/a.yaml', 'package.json', 'docs/a.md', 'Makefile'])).toEqual([])
  })

  it('改动路径与认领同一口径：./ 前缀与反斜杠写法的结果和 src/a.js 相同，控制目录也在归一之后判定', () => {
    const policy = levelPolicy('changed', UNIT_ONLY)
    for (const path of ['src/a.js', './src/a.js', 'src\\a.js']) expect(missing(UNIT_ONLY, policy, [path])).toEqual(['unit'])
    for (const path of ['./openspec/x.ts', '.\\.tenon\\y.ts', 'openspec\\z.ts']) expect(missing(UNIT_ONLY, policy, [path])).toEqual([])
  })

  describe('suitesWithoutCoversNotice —— 求值与 tenon test run --stage 共用的提示', () => {
    it('点名套件、说明给它们写上 covers 后源码改动才会碰到；fix 是 tenon test catalog set 的 --cover-glob', () => {
      const policy = levelPolicy('changed', UNIT_ONLY)
      const runSet = stageRunSet({ policy, catalog: UNIT_ONLY, plan: PLAN, changedFiles: ['src/a.js'] })
      const notice = suitesWithoutCoversNotice({ policy, catalog: UNIT_ONLY, changedFiles: ['src/a.js'], runSet })
      expect(notice).toEqual({
        code: 'suites-without-covers',
        message: '套件 unit 没写 covers：只改源码碰不到它们，本步没有运行；需要源码改动触发时，在 .tenon/tests/catalog.yaml 给它们写上 covers',
        fix: 'tenon test catalog set unit --cover-glob "<glob>"',
      })
    })

    it('多个套件用顿号连接，fix 取第一个；没有要提示的套件时返回 undefined', () => {
      const two = catalogOf(bare('unit', 'unit', 'test/**/*.test.js') + bare('types', 'typecheck', 'types/**'))
      const policy = levelPolicy('changed', two)
      const runSet = stageRunSet({ policy, catalog: two, plan: PLAN, changedFiles: ['src/a.js'] })
      const notice = suitesWithoutCoversNotice({ policy, catalog: two, changedFiles: ['src/a.js'], runSet })
      expect(notice?.message).toContain('套件 unit、types 没写 covers')
      expect(notice?.fix).toBe('tenon test catalog set unit --cover-glob "<glob>"')
      expect(suitesWithoutCoversNotice({ policy, catalog: two, changedFiles: ['README.md'], runSet })).toBeUndefined()
    })
  })
})

describe('touches', () => {
  it('匹配套件 files 或 covers 的任一 glob；控制目录先剔除', () => {
    const unit = CATALOG.suites[0]
    if (unit === undefined) throw new Error('suite')
    expect(touches(unit, ['src/a.ts'])).toBe(true)
    expect(touches(unit, ['src/a.test.ts'])).toBe(true)
    expect(touches(unit, ['docs/a.md'])).toBe(false)
    expect(touches(unit, ['openspec/changes/c/src/a.ts'])).toBe(false)
    expect(touches(unit, [])).toBe(false)
  })

  it('路径先按认领的口径归一：./ 前缀与反斜杠写法等同于仓库相对的正斜杠写法', () => {
    const unit = CATALOG.suites[0]
    if (unit === undefined) throw new Error('suite')
    expect(touches(unit, ['./src/a.ts'])).toBe(true)
    expect(touches(unit, ['src\\a.ts'])).toBe(true)
    expect(touches(unit, ['./openspec/changes/c/src/a.ts'])).toBe(false)
  })
})
