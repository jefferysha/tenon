import { describe, expect, it } from 'vitest'
import {
  catalogDigest, catalogSuitesDigest, formatCatalogIssues, parseTestCatalog, serializeTestCatalog, suiteFileGlobs,
} from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import { DESIGN_CATALOG } from './test-support.js'


function ok(text: string): TestCatalog {
  const result = parseTestCatalog(text)
  if (!result.ok) throw new Error(formatCatalogIssues(result.issues).join('\n'))
  return result.catalog
}

function issues(text: string): string[] {
  const result = parseTestCatalog(text)
  if (result.ok) throw new Error('expected catalog issues')
  return [...formatCatalogIssues(result.issues)]
}

function suite(body: string): string {
  return `schema: tenon-test-catalog/v1\nsuites:\n  - id: s1\n${body.split('\n').map((line) => `    ${line}`).join('\n')}\n`
}

describe('parseTestCatalog', () => {
  it('解析设计样例：补齐默认值，服务与基准都在', () => {
    const catalog = ok(DESIGN_CATALOG)
    expect(catalog.profiles_env).toEqual(['CI'])
    expect(catalog.suites.map((item) => item.id)).toEqual(['web-unit', 'web-e2e', 'api-bench', 'types'])
    const unit = catalog.suites[0]
    expect(unit?.select?.grep).toContain('{pattern}')
    expect(unit?.coverage).toEqual({ format: 'istanbul-summary', path: 'coverage/coverage-summary.json' })
    expect(catalog.suites[1]).toMatchObject({ cwd: '.', timeout_s: 900, retries: 2, parallel: false, browsers: ['chromium', 'webkit'] })
    expect(catalog.suites[2]?.benchmark?.metrics[1]).toEqual({ name: 'rps', unit: 'req/s', better: 'higher', max_regression_pct: 5 })
    expect(catalog.suites[3]?.report).toEqual({ format: 'exit-code' })
    expect(catalog.services[0]?.ready).toEqual({ url: 'http://127.0.0.1:5178/', timeout_s: 60 })
    if (unit === undefined) throw new Error('missing unit suite')
    expect(suiteFileGlobs(unit)).toEqual(['packages/dashboard-app/src/**/*.test.{ts,tsx}'])
  })

  it('规范化写出可读回同一份目录', () => {
    const catalog = ok(DESIGN_CATALOG)
    const text = serializeTestCatalog(catalog)
    expect(ok(text)).toEqual(catalog)
    expect(serializeTestCatalog(ok(text))).toBe(text)
  })

  it('每条错误带 catalog.yaml:<行>，且一次列全', () => {
    const found = issues([
      'schema: tenon-test-catalog/v1',
      'suites:',
      '  - id: Bad_Id',
      '    kind: unit',
      '    runner: vitest',
      '    command: x',
      '  - id: ok',
      '    kind: nope',
      '    runner: vitest',
      '    command: x',
    ].join('\n'))
    expect(found).toEqual(expect.arrayContaining([
      expect.stringMatching(/^catalog\.yaml:3: 套件 id 'Bad_Id' 非法/),
      expect.stringMatching(/^catalog\.yaml:8: 套件 'ok' 的 kind 'nope' 不在闭集/),
    ]))
  })

  it.each([
    ['schema 不对', 'schema: other/v1\nsuites: []\n', /schema 必须是 tenon-test-catalog\/v1/],
    ['顶层未知键', 'schema: tenon-test-catalog/v1\nextra: 1\n', /不认识键 'extra'/],
    ['顶层不是映射', '- a\n', /目录 必须是映射/],
    ['YAML 语法错误', 'schema: [x\n', /未闭合/],
    ['缺 kind', suite('runner: vitest\ncommand: x'), /缺 kind/],
    ['缺 runner', suite('kind: unit\ncommand: x'), /缺 runner/],
    ['缺 command', suite('kind: unit\nruner: vitest'), /command 缺失/],
    ['多行命令', suite('kind: typecheck\nrunner: tsc\ncommand: "a\\nb"'), /单行/],
    ['套件未知键', suite('kind: typecheck\nrunner: tsc\ncommand: x\nfoo: 1'), /不认识键 'foo'/],
    ['未知 runner', suite('kind: unit\nrunner: ava\ncommand: x'), /runner 'ava' 不在闭集/],
    ['unit 不能只看退出码', suite('kind: unit\nrunner: custom\ncommand: x\nreport: { format: exit-code }'), /必须有可解析的报告/],
    ['runner 不产出该格式', suite('kind: unit\nrunner: vitest\ncommand: x\nreport: { format: tap, path: test-results/a.tap }'), /不产出报告格式 'tap'/],
    ['playwright 种类必须用 playwright runner', suite('kind: playwright\nrunner: vitest\ncommand: x\nreport: { format: junit, path: test-results/a.xml }'), /runner 'vitest'|必须用 runner 'playwright'/],
    ['browser 种类不能是 playwright runner', suite('kind: browser\nrunner: playwright\ncommand: x\nreport: { format: junit, path: test-results/a.xml }'), /不能承载种类 'browser'/],
    ['基准缺 benchmark 段', suite('kind: benchmark\nrunner: custom\ncommand: x\nreport: { format: benchmark-json, path: test-results/b.json }'), /必须有 benchmark 段/],
    ['非基准不能写 benchmark 段', suite('kind: unit\nrunner: vitest\ncommand: x\nreport: { format: junit, path: test-results/a.xml }\nbenchmark: { runs: 1, metrics: [] }'), /不能声明 benchmark 段/],
    ['基准格式用于非基准', suite('kind: custom\nrunner: custom\ncommand: x\nreport: { format: benchmark-json, path: test-results/b.json }'), /只用于 benchmark/],
    ['基准种类的报告格式不对', suite('kind: benchmark\nrunner: custom\ncommand: x\nreport: { format: junit, path: test-results/b.xml }\nbenchmark:\n  metrics:\n    - { name: t, max: 1 }'), /基准套件的报告格式/],
    ['lighthouse 格式只给 benchmark/a11y', suite('kind: custom\nrunner: custom\ncommand: x\nreport: { format: lighthouse-json, path: test-results/l.json }'), /只用于 benchmark 或 a11y/],
    ['指标没有阈值', suite('kind: benchmark\nrunner: custom\ncommand: x\nreport: { format: benchmark-json, path: test-results/b.json }\nbenchmark:\n  metrics:\n    - { name: t }'), /至少需要 max_regression_pct/],
    ['指标重复', suite('kind: benchmark\nrunner: custom\ncommand: x\nreport: { format: benchmark-json, path: test-results/b.json }\nbenchmark:\n  metrics:\n    - { name: t, max: 1 }\n    - { name: t, max: 2 }'), /重复声明指标/],
    ['指标为空', suite('kind: benchmark\nrunner: custom\ncommand: x\nreport: { format: benchmark-json, path: test-results/b.json }\nbenchmark:\n  metrics: []'), /至少声明一个指标/],
    ['指标方向非法', suite('kind: benchmark\nrunner: custom\ncommand: x\nreport: { format: benchmark-json, path: test-results/b.json }\nbenchmark:\n  metrics:\n    - { name: t, max: 1, better: up }'), /better/],
    ['报告缺路径', suite('kind: unit\nrunner: vitest\ncommand: x'), /report\.path 缺失/],
    ['exit-code 不写路径', suite('kind: typecheck\nrunner: tsc\ncommand: x\nreport: { format: exit-code, path: test-results/x }'), /不要写 path/],
    ['报告不在测试输出目录', suite('kind: unit\nrunner: vitest\ncommand: x\nreport: { format: junit, path: reports/a.xml }'), /必须位于 test-results/],
    ['报告路径越界', suite('kind: unit\nrunner: vitest\ncommand: x\nreport: { format: junit, path: ../test-results/a.xml }'), /仓库内相对路径/],
    ['报告格式未知', suite('kind: unit\nrunner: vitest\ncommand: x\nreport: { format: xml, path: test-results/a.xml }'), /report\.format 'xml' 不在闭集/],
    ['产物越界', suite('kind: typecheck\nrunner: tsc\ncommand: x\nartifacts: [/tmp/test-results]'), /仓库内相对路径/],
    ['cwd 越界', suite('kind: typecheck\nrunner: tsc\ncommand: x\ncwd: ../other'), /cwd '\.\.\/other' 必须是仓库内相对路径/],
    ['files glob 越界', suite('kind: typecheck\nrunner: tsc\ncommand: x\nfiles: ["../**/*.ts"]'), /仓库内相对 glob/],
    ['select 缺占位符', suite('kind: typecheck\nrunner: tsc\ncommand: x\nselect: { files: "npx tsc" }'), /\{files\} 占位符/],
    ['select 缺 grep 占位符', suite('kind: typecheck\nrunner: tsc\ncommand: x\nselect: { grep: "npx tsc" }'), /\{pattern\} 占位符/],
    ['select 为空', suite('kind: typecheck\nrunner: tsc\ncommand: x\nselect: {}'), /至少需要 files 或 grep/],
    ['覆盖率格式未知', suite('kind: typecheck\nrunner: tsc\ncommand: x\ncoverage: { format: clover, path: coverage/c.xml }'), /coverage\.format 'clover' 不在闭集/],
    ['覆盖率缺格式', suite('kind: typecheck\nrunner: tsc\ncommand: x\ncoverage: { path: coverage/c.xml }'), /coverage\.format 缺失/],
    ['env 名非法', suite('kind: typecheck\nrunner: tsc\ncommand: x\nenv: [1BAD]'), /环境变量名/],
    ['tags 非法', suite('kind: typecheck\nrunner: tsc\ncommand: x\ntags: [Web]'), /小写 token/],
    ['browsers 只给 Playwright', suite('kind: typecheck\nrunner: tsc\ncommand: x\nbrowsers: [chromium]'), /只用于 Playwright/],
    ['timeout 越界', suite('kind: typecheck\nrunner: tsc\ncommand: x\ntimeout_s: 0'), /timeout_s 必须是 1–14400/],
    ['retries 越界', suite('kind: typecheck\nrunner: tsc\ncommand: x\nretries: 11'), /retries 必须是 0–10/],
    ['parallel 非布尔', suite('kind: typecheck\nrunner: tsc\ncommand: x\nparallel: yes'), /parallel 必须是 true 或 false/],
    ['重复列出', suite('kind: typecheck\nrunner: tsc\ncommand: x\ntags: [a, a]'), /重复列出 'a'/],
    ['引用不存在的服务', suite('kind: typecheck\nrunner: tsc\ncommand: x\nservices: [db]'), /服务 'db' 不存在/],
    ['套件 id 重复', 'schema: tenon-test-catalog/v1\nsuites:\n  - { id: a, kind: typecheck, runner: tsc, command: x }\n  - { id: a, kind: typecheck, runner: tsc, command: y }\n', /套件 id 'a' 重复/],
    ['服务 ready 必须恰好一种', 'schema: tenon-test-catalog/v1\nservices:\n  - id: web\n    start: npm run dev\n    ready: { url: "http://x/", port: 1 }\n', /恰好声明 url、port、log 之一/],
    ['服务 ready 缺失', 'schema: tenon-test-catalog/v1\nservices:\n  - id: web\n    start: npm run dev\n', /ready 缺失/],
    ['服务 url 非 http', 'schema: tenon-test-catalog/v1\nservices:\n  - id: web\n    start: x\n    ready: { url: "ftp://x" }\n', /http\(s\)/],
    ['服务端口越界', 'schema: tenon-test-catalog/v1\nservices:\n  - id: web\n    start: x\n    ready: { port: 70000 }\n', /port 必须是 1–65535/],
    ['服务停止信号未知', 'schema: tenon-test-catalog/v1\nservices:\n  - id: web\n    start: x\n    ready: { log: ready }\n    stop: SIGHUP\n', /stop 'SIGHUP' 不在闭集/],
    ['服务 cwd 越界', 'schema: tenon-test-catalog/v1\nservices:\n  - id: web\n    start: x\n    cwd: /abs\n    ready: { log: ready }\n', /仓库内相对路径/],
    ['服务 id 重复', 'schema: tenon-test-catalog/v1\nservices:\n  - { id: web, start: x, ready: { log: a } }\n  - { id: web, start: y, ready: { log: b } }\n', /服务 id 'web' 重复/],
    ['服务未知键', 'schema: tenon-test-catalog/v1\nservices:\n  - { id: web, start: x, ready: { log: a }, host: y }\n', /不认识键 'host'/],
  ])('%s → 拒绝', (_name, text, pattern) => {
    expect(issues(text).join('\n')).toMatch(pattern)
  })
})

describe('目录摘要', () => {
  it('整份摘要随任一字段变化；键序无关', () => {
    const catalog = ok(DESIGN_CATALOG)
    expect(catalogDigest(catalog)).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(catalogDigest(ok(serializeTestCatalog(catalog)))).toBe(catalogDigest(catalog))
    const changed = ok(DESIGN_CATALOG.replace('timeout_s: 900', 'timeout_s: 901'))
    expect(catalogDigest(changed)).not.toBe(catalogDigest(catalog))
  })

  it('套件摘要只看相关套件及其服务', () => {
    const catalog = ok(DESIGN_CATALOG)
    const base = catalogSuitesDigest(catalog, ['api-bench'])
    const otherChanged = ok(DESIGN_CATALOG.replace('retries: 2', 'retries: 1'))
    expect(catalogSuitesDigest(otherChanged, ['api-bench'])).toBe(base)
    const serviceChanged = ok(DESIGN_CATALOG.replace('timeout_s: 60', 'timeout_s: 61'))
    expect(catalogSuitesDigest(serviceChanged, ['web-e2e'])).not.toBe(catalogSuitesDigest(catalog, ['web-e2e']))
    expect(catalogSuitesDigest(catalog, ['api-bench', 'api-bench'])).toBe(base)
    expect(catalogSuitesDigest(catalog, ['gone'])).not.toBe(catalogSuitesDigest(catalog, []))
  })
})
