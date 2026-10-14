/**
 * 目录 `levels` 档位定义：缺省、合并、解码（闭集 + 行号）、规范化写出。
 */
import { describe, expect, it } from 'vitest'
import { catalogDigest, catalogSuitesDigest, formatCatalogIssues, parseTestCatalog, serializeTestCatalog } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import { DEFAULT_LEVELS, LEVEL_NAMES, resolveLevel, type CatalogLevels } from './levels.js'
import { withoutNotApplicable, withNotApplicable } from './catalog-na.js'

const HEAD = 'schema: tenon-test-catalog/v1\n'
const SUITE = '  - { id: unit, kind: unit, runner: vitest, command: npx vitest run, report: { format: vitest-json, path: test-results/v.json } }\n'

function ok(text: string): TestCatalog {
  const result = parseTestCatalog(text)
  if (!result.ok) throw new Error(formatCatalogIssues(result.issues).join('\n'))
  return result.catalog
}

function issues(text: string): string {
  const result = parseTestCatalog(text)
  if (result.ok) throw new Error('expected catalog issues')
  return formatCatalogIssues(result.issues).join('\n')
}

function withLevels(body: string): string {
  return `${HEAD}levels:\n${body}suites:\n${SUITE}`
}

describe('内建缺省', () => {
  it('三档的缺省值', () => {
    expect([...LEVEL_NAMES]).toEqual(['plan', 'changed', 'full'])
    expect(DEFAULT_LEVELS.plan).toEqual({
      name: 'plan', required: ['unit'], touched: [], scenarios: 'off', require_baseline: false, source: 'default',
    })
    expect(DEFAULT_LEVELS.changed).toEqual({
      name: 'changed', required: ['unit'], touched: ['static'], scenarios: 'off', require_baseline: false, source: 'default',
    })
    expect(DEFAULT_LEVELS.full).toEqual({
      name: 'full', required: ['unit'], touched: ['integration', 'e2e', 'static', 'benchmark'],
      scenarios: 'off', require_baseline: false, source: 'default',
    })
  })

  it('缺省不设覆盖率与不稳定用例门槛（键都不存在）', () => {
    for (const name of LEVEL_NAMES) {
      expect(Object.hasOwn(DEFAULT_LEVELS[name], 'coverage'), name).toBe(false)
      expect(Object.hasOwn(DEFAULT_LEVELS[name], 'flaky'), name).toBe(false)
    }
  })

  it('缺省是冻结的共享常量，调用方改不动', () => {
    expect(Object.isFrozen(DEFAULT_LEVELS)).toBe(true)
    for (const name of LEVEL_NAMES) {
      expect(Object.isFrozen(DEFAULT_LEVELS[name]), name).toBe(true)
      expect(Object.isFrozen(DEFAULT_LEVELS[name].required), name).toBe(true)
      expect(Object.isFrozen(DEFAULT_LEVELS[name].touched), name).toBe(true)
    }
  })
})

describe('resolveLevel', () => {
  it('目录没有 levels → 缺省，source: default', () => {
    const catalog = ok(`${HEAD}suites:\n${SUITE}`)
    for (const name of LEVEL_NAMES) expect(resolveLevel(name, catalog)).toEqual(DEFAULT_LEVELS[name])
    expect(resolveLevel('full', catalog).source).toBe('default')
  })

  it('目录为 undefined → 缺省', () => {
    expect(resolveLevel('changed', undefined)).toEqual(DEFAULT_LEVELS.changed)
  })

  it('levels.full.coverage.lines: 80 只覆盖该键，required / touched 仍是缺省，source: catalog', () => {
    const catalog = ok(withLevels('  full:\n    coverage: { lines: 80 }\n'))
    expect(resolveLevel('full', catalog)).toEqual({ ...DEFAULT_LEVELS.full, coverage: { lines: 80 }, source: 'catalog' })
  })

  it('写了一档，不影响另外两档', () => {
    const catalog = ok(withLevels('  full:\n    scenarios: required\n'))
    expect(resolveLevel('full', catalog).scenarios).toBe('required')
    expect(resolveLevel('changed', catalog)).toEqual(DEFAULT_LEVELS.changed)
    expect(resolveLevel('plan', catalog)).toEqual(DEFAULT_LEVELS.plan)
  })

  it('写了与缺省相同的值也算目录声明（source: catalog）', () => {
    const catalog = ok(withLevels('  changed:\n    required: [unit]\n'))
    expect(resolveLevel('changed', catalog)).toEqual({ ...DEFAULT_LEVELS.changed, source: 'catalog' })
  })

  it('显式空列表是有效声明：touched: [] 去掉缺省的 static，required: [] 不要求任何类', () => {
    const catalog = ok(withLevels('  changed:\n    touched: []\n    required: []\n'))
    expect(resolveLevel('changed', catalog)).toMatchObject({ required: [], touched: [], source: 'catalog' })
  })

  it('各键合并：required / touched / scenarios / flaky / require_baseline', () => {
    const catalog = ok(withLevels([
      '  full:',
      '    required: [unit, integration]',
      '    touched: [e2e]',
      '    scenarios: passing',
      '    flaky: { max: 2, fail_on_new: true }',
      '    require_baseline: true',
      '    coverage: { lines: 80, changed_lines: 90 }',
      '',
    ].join('\n')))
    expect(resolveLevel('full', catalog)).toEqual({
      name: 'full', required: ['unit', 'integration'], touched: ['e2e'], scenarios: 'passing',
      flaky: { max: 2, fail_on_new: true }, require_baseline: true, coverage: { lines: 80, changed_lines: 90 }, source: 'catalog',
    })
  })

  it('flaky 省略 fail_on_new 时为 false', () => {
    const catalog = ok(withLevels('  full:\n    flaky: { max: 3 }\n'))
    expect(resolveLevel('full', catalog).flaky).toEqual({ max: 3, fail_on_new: false })
  })

  it('plan 档恒不跑被碰到的类：touched 为 []，即使程序化构造的目录写了它', () => {
    const levels: CatalogLevels = { plan: { touched: ['static'], required: ['unit', 'static'] } }
    const catalog: TestCatalog = { schema: 'tenon-test-catalog/v1', profiles_env: [], suites: [], services: [], levels }
    expect(resolveLevel('plan', catalog)).toMatchObject({ required: ['unit', 'static'], touched: [], source: 'catalog' })
  })

  it('程序化构造的空档位不算目录声明（source: default）', () => {
    const catalog: TestCatalog = { schema: 'tenon-test-catalog/v1', profiles_env: [], suites: [], services: [], levels: { full: {} } }
    expect(resolveLevel('full', catalog)).toEqual(DEFAULT_LEVELS.full)
  })

  it('不修改目录，也不改缺省', () => {
    const catalog = ok(withLevels('  full:\n    coverage: { lines: 80 }\n'))
    const before = JSON.stringify(catalog)
    resolveLevel('full', catalog)
    expect(JSON.stringify(catalog)).toBe(before)
    expect(DEFAULT_LEVELS.full.source).toBe('default')
    expect(Object.hasOwn(DEFAULT_LEVELS.full, 'coverage')).toBe(false)
  })
})

describe('levels 解码', () => {
  it('完整写法逐键读入', () => {
    const catalog = ok(withLevels([
      '  plan:',
      '    required: [unit, static]',
      '    scenarios: required',
      '  changed:',
      '    required: [unit]',
      '    touched: [static, integration]',
      '  full:',
      '    required: [unit]',
      '    touched: [integration, e2e, static, benchmark]',
      '    coverage:',
      '      lines: 80',
      '      branches: 70',
      '      functions: 60',
      '      statements: 50',
      '      changed_lines: 100',
      '    flaky:',
      '      max: 1',
      '      fail_on_new: true',
      '    require_baseline: true',
      '',
    ].join('\n')))
    expect(catalog.levels).toEqual({
      plan: { required: ['unit', 'static'], scenarios: 'required' },
      changed: { required: ['unit'], touched: ['static', 'integration'] },
      full: {
        required: ['unit'], touched: ['integration', 'e2e', 'static', 'benchmark'],
        coverage: { lines: 80, branches: 70, functions: 60, statements: 50, changed_lines: 100 },
        flaky: { max: 1, fail_on_new: true }, require_baseline: true,
      },
    })
  })

  it('空的 levels / 空的档位归一为没写：对象、写出文本与摘要都与没写完全一致', () => {
    const plain = ok(`${HEAD}suites:\n${SUITE}`)
    for (const body of ['levels: {}\n', 'levels:\n  full: {}\n', 'levels:\n  plan: {}\n  changed: {}\n  full: {}\n']) {
      const catalog = ok(`${HEAD}${body}suites:\n${SUITE}`)
      expect(catalog, body).toEqual(plain)
      expect(Object.hasOwn(catalog, 'levels'), body).toBe(false)
      expect(catalogDigest(catalog), body).toBe(catalogDigest(plain))
      expect(serializeTestCatalog(catalog), body).toBe(serializeTestCatalog(plain))
    }
  })

  it.each([
    ['档位下的未知键', withLevels('  changed:\n    scope: full\n'), /^catalog\.yaml:4: .*levels\.changed 不认识键 'scope'/],
    ['plan 档不接受 touched', withLevels('  plan:\n    touched: [static]\n'), /^catalog\.yaml:4: .*levels\.plan 不认识键 'touched'/],
    ['plan 档不接受 coverage', withLevels('  plan:\n    coverage: { lines: 80 }\n'), /^catalog\.yaml:4: .*levels\.plan 不认识键 'coverage'/],
    ['plan 档不接受 flaky', withLevels('  plan:\n    flaky: { max: 1 }\n'), /^catalog\.yaml:4: .*levels\.plan 不认识键 'flaky'/],
    ['plan 档不接受 require_baseline', withLevels('  plan:\n    require_baseline: true\n'), /^catalog\.yaml:4: .*levels\.plan 不认识键 'require_baseline'/],
    ['未知测试类', withLevels('  full:\n    required: [foo]\n'), /^catalog\.yaml:4: .*levels\.full\.required 的一项 'foo' 不在闭集（unit\/integration\/e2e\/static\/benchmark\/custom）/],
    ['旧种类名不是类', withLevels('  full:\n    touched: [typecheck]\n'), /^catalog\.yaml:4: .*'typecheck' 不在闭集/],
    ['未知档名', withLevels('  quick: {}\n'), /^catalog\.yaml:3: .*levels 不认识键 'quick'（可用：plan\/changed\/full）/],
    ['覆盖率超出范围', withLevels('  full:\n    coverage: { lines: 120 }\n'), /^catalog\.yaml:4: .*levels\.full\.coverage\.lines 必须是 0–100/],
    ['覆盖率为负', withLevels('  full:\n    coverage: { lines: -1 }\n'), /^catalog\.yaml:4: .*coverage\.lines 必须是 0–100/],
    ['覆盖率未知指标', withLevels('  full:\n    coverage: { mutation: 10 }\n'), /^catalog\.yaml:4: .*levels\.full\.coverage 不认识键 'mutation'/],
    ['覆盖率为空', withLevels('  full:\n    coverage: {}\n'), /^catalog\.yaml:4: .*levels\.full\.coverage 至少声明/],
    ['scenarios 不在闭集', withLevels('  full:\n    scenarios: sometimes\n'), /^catalog\.yaml:4: .*levels\.full\.scenarios 'sometimes' 不在闭集（off\/required\/passing）/],
    ['flaky 缺 max', withLevels('  full:\n    flaky: { fail_on_new: true }\n'), /^catalog\.yaml:4: .*levels\.full\.flaky\.max 缺失/],
    ['flaky.max 越界', withLevels('  full:\n    flaky: { max: 1001 }\n'), /^catalog\.yaml:4: .*flaky\.max 必须是 0–1000 的整数/],
    ['flaky 未知键', withLevels('  full:\n    flaky: { max: 1, retries: 2 }\n'), /^catalog\.yaml:4: .*levels\.full\.flaky 不认识键 'retries'/],
    ['require_baseline 非布尔', withLevels('  full:\n    require_baseline: maybe\n'), /^catalog\.yaml:4: .*require_baseline 必须是 true 或 false/],
    ['类重复', withLevels('  full:\n    required: [unit, unit]\n'), /^catalog\.yaml:4: .*levels\.full\.required 重复列出 'unit'/],
    ['levels 不是映射', `${HEAD}levels: 3\nsuites:\n${SUITE}`, /^catalog\.yaml:2: .*levels 必须是映射/],
    ['档位不是映射', withLevels('  full: 3\n'), /^catalog\.yaml:3: .*levels\.full 必须是映射/],
    ['required 不是列表', withLevels('  full:\n    required: unit\n'), /^catalog\.yaml:4: .*levels\.full\.required 必须是列表/],
  ])('%s → 拒绝并报出行号', (_name, text, pattern) => {
    expect(issues(text)).toMatch(pattern)
  })

  it('一次列全多处错误', () => {
    const found = issues(withLevels('  plan:\n    touched: [static]\n  full:\n    coverage: { lines: 120 }\n    required: [foo]\n'))
    expect(found).toMatch(/catalog\.yaml:4: /)
    expect(found).toMatch(/catalog\.yaml:6: /)
    expect(found).toMatch(/catalog\.yaml:7: /)
  })

  it('levels 里的错误不影响套件的校验结果（套件错误照常报）', () => {
    const text = `${HEAD}levels:\n  full:\n    required: [foo]\nsuites:\n  - { id: Bad_Id, kind: unit, runner: vitest, command: x }\n`
    const found = issues(text)
    expect(found).toMatch(/levels\.full\.required/)
    expect(found).toMatch(/套件 id 'Bad_Id' 非法/)
  })
})

describe('levels 写出', () => {
  it('没声明时不写 levels 键', () => {
    expect(serializeTestCatalog(ok(`${HEAD}suites:\n${SUITE}`))).not.toContain('levels')
  })

  it('写出再读回同一份目录；再写出字节相同', () => {
    const catalog = ok(withLevels([
      '  full:',
      '    flaky: { max: 2, fail_on_new: false }',
      '    coverage: { branches: 70, lines: 80 }',
      '    required: [unit]',
      '  plan:',
      '    scenarios: passing',
      '',
    ].join('\n')))
    const text = serializeTestCatalog(catalog)
    expect(ok(text)).toEqual(catalog)
    expect(serializeTestCatalog(ok(text))).toBe(text)
  })

  it('档位与键按固定顺序写出（plan、changed、full；required、touched、scenarios、coverage、flaky、require_baseline）', () => {
    const catalog = ok(withLevels([
      '  full:',
      '    require_baseline: true',
      '    flaky: { max: 1 }',
      '    coverage: { lines: 80 }',
      '    scenarios: required',
      '    touched: [e2e]',
      '    required: [unit]',
      '  plan:',
      '    scenarios: required',
      '',
    ].join('\n')))
    const text = serializeTestCatalog(catalog)
    expect(text).toContain([
      'levels:',
      '  plan:',
      '    scenarios: required',
      '  full:',
      '    required:',
      '      - unit',
      '    touched:',
      '      - e2e',
      '    scenarios: required',
      '    coverage:',
      '      lines: 80',
      '    flaky:',
      '      max: 1',
      '      fail_on_new: false',
      '    require_baseline: true',
      '',
    ].join('\n'))
  })

  it('levels 写在 suites 之前不影响读回；写出时排在最后（与注释保留写回的「新顶层键追加在末尾」一致）', () => {
    const catalog = ok(withLevels('  full:\n    scenarios: required\n'))
    const text = serializeTestCatalog(catalog)
    expect(text.indexOf('levels:')).toBeGreaterThan(text.indexOf('suites:'))
    expect(ok(text)).toEqual(catalog)
    const declared = withNotApplicable(catalog, 'typecheck', '纯 JS 项目')
    const full = serializeTestCatalog(declared)
    expect(full.indexOf('levels:')).toBeGreaterThan(full.indexOf('not_applicable:'))
  })

  it('显式空列表写成 []，读回仍是声明', () => {
    const catalog = ok(withLevels('  changed:\n    touched: []\n'))
    const text = serializeTestCatalog(catalog)
    expect(text).toContain('    touched: []')
    expect(ok(text).levels).toEqual({ changed: { touched: [] } })
  })
})

describe('levels 与目录摘要', () => {
  const plain = ok(`${HEAD}suites:\n${SUITE}`)

  it('写了 levels 摘要改变，改任一档位定义摘要再变', () => {
    const base = ok(withLevels('  full:\n    coverage: { lines: 80 }\n'))
    const changed = ok(withLevels('  full:\n    coverage: { lines: 81 }\n'))
    expect(catalogDigest(base)).not.toBe(catalogDigest(plain))
    expect(catalogDigest(changed)).not.toBe(catalogDigest(base))
  })

  it('书写顺序无关：同一份定义不同键序摘要相同', () => {
    const left = ok(withLevels('  plan:\n    scenarios: required\n  full:\n    scenarios: passing\n    required: [unit]\n'))
    const right = ok(withLevels('  full:\n    required: [unit]\n    scenarios: passing\n  plan:\n    scenarios: required\n'))
    expect(catalogDigest(left)).toBe(catalogDigest(right))
  })

  it('运行记录绑定的套件摘要同样随档位定义变化（改了档位定义，已有运行随之过期）', () => {
    const base = ok(withLevels('  full:\n    coverage: { lines: 80 }\n'))
    const changed = ok(withLevels('  full:\n    coverage: { lines: 81 }\n'))
    expect(catalogSuitesDigest(base, ['unit'])).not.toBe(catalogSuitesDigest(plain, ['unit']))
    expect(catalogSuitesDigest(changed, ['unit'])).not.toBe(catalogSuitesDigest(base, ['unit']))
  })

  it('没写 levels 时两种摘要都不带 levels 键（与引入 levels 之前逐字相同，见 catalog.test.ts 的快照）', () => {
    expect(catalogDigest(plain)).toBe(catalogDigest({ ...plain }))
    expect(JSON.stringify(plain)).not.toContain('levels')
  })
})

describe('其余目录改写保留 levels', () => {
  it('撤销最后一条不适用声明不丢档位定义', () => {
    const declared = withNotApplicable(ok(withLevels('  full:\n    coverage: { lines: 80 }\n')), 'typecheck', '纯 JS 项目')
    expect(declared.levels).toEqual({ full: { coverage: { lines: 80 } } })
    const { catalog, removed } = withoutNotApplicable(declared, 'typecheck')
    expect(removed).toBe(true)
    expect(catalog.not_applicable).toBeUndefined()
    expect(catalog.levels).toEqual({ full: { coverage: { lines: 80 } } })
  })
})
