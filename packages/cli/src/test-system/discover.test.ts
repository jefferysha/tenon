import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatCatalogIssues, parseTestCatalog, serializeTestCatalog } from '@tenon/kernel'
import { discoverTests } from './discover.js'
import { usesModuleLevelBench } from './discover-bench.js'
import { emptyCatalog } from './project-files.js'

let repo = ''
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-discover-')) })
afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

async function put(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), text, 'utf8')
  }
}

async function ids(): Promise<string[]> {
  return (await discoverTests(repo)).suites.map((item) => item.suite.id)
}

describe('discoverTests', () => {
  it('空项目：没有建议，提示手工登记', async () => {
    const result = await discoverTests(repo)
    expect(result.suites).toEqual([])
    expect(result.notes.join('\n')).toContain('tenon test catalog add')
  })

  it('vitest + Playwright + tsc + lint：每个建议的套件都能通过目录校验（写出再解析）', async () => {
    await put({
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', bench: 'node bench.mjs' }, devDependencies: { vitest: '3', typescript: '5' } }),
      'vitest.config.ts': "export default { test: { include: ['src/**/*.test.ts', 'lib/**/*.test.ts'] } }",
      'playwright.config.ts': "export default { testDir: './e2e', projects: [{ name: 'chromium' }, { name: 'webkit' }] }",
    })
    const result = await discoverTests(repo)
    expect(result.suites.map((item) => item.suite.id).sort()).toEqual(['e2e', 'lint', 'typecheck', 'unit'])
    const unit = result.suites.find((item) => item.suite.id === 'unit')?.suite
    expect(unit).toMatchObject({ runner: 'vitest', files: ['src/**/*.test.ts', 'lib/**/*.test.ts'], report: { format: 'vitest-json' } })
    expect(unit?.command).toContain('--outputFile.json=test-results/vitest.json')
    const e2e = result.suites.find((item) => item.suite.id === 'e2e')?.suite
    expect(e2e).toMatchObject({ kind: 'playwright', browsers: ['chromium', 'webkit'], files: ['e2e/**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'] })
    expect(e2e?.command).toContain('PLAYWRIGHT_HTML_OPEN=never')
    expect(result.notes.join('\n')).toContain('基准脚本')
    expect(result.notes.join('\n')).toContain('tenon test catalog add bench --kind benchmark --runner custom --command "npm run bench"')
    const text = serializeTestCatalog({ ...emptyCatalog(), suites: result.suites.map((item) => item.suite) })
    const parsed = parseTestCatalog(text)
    expect(parsed.ok, parsed.ok ? '' : formatCatalogIssues(parsed.issues).join('\n')).toBe(true)
  })

  it('vitest 工程里的 *.bench.* → 基准套件，指标取自 bench() 的名字；建议能通过目录校验', async () => {
    await put({
      'package.json': JSON.stringify({ scripts: { bench: 'vitest bench' }, devDependencies: { vitest: '3' } }),
      'vitest.config.ts': 'export default {}',
      'bench/sort.bench.ts': "import { bench, describe } from 'vitest'\ndescribe('sorting', () => {\n  bench('native sort', () => {})\n  bench(\"custom sort\", () => {})\n  bench(`dyn ${1}`, () => {})\n})\n",
      'node_modules/x/dep.bench.ts': "bench('ignored', () => {})",
    })
    const result = await discoverTests(repo)
    const bench = result.suites.find((item) => item.suite.id === 'bench')?.suite
    expect(bench).toMatchObject({
      kind: 'benchmark', runner: 'vitest-bench', report: { format: 'benchmark-json', path: 'test-results/bench.json' },
      benchmark: { runs: 1, warmup: 0 },
    })
    expect(bench?.command).toBe('npx vitest bench --run --outputJson=test-results/bench.json')
    expect(bench?.benchmark?.metrics.map((metric) => [metric.name, metric.better, metric.max_regression_pct])).toEqual([
      ['native_sort.mean_ms', 'lower', 10], ['custom_sort.mean_ms', 'lower', 10],
    ])
    expect(result.notes.join('\n')).not.toContain('基准脚本')
    const text = serializeTestCatalog({ ...emptyCatalog(), suites: result.suites.map((item) => item.suite) })
    const parsed = parseTestCatalog(text)
    expect(parsed.ok, parsed.ok ? '' : formatCatalogIssues(parsed.issues).join('\n')).toBe(true)
  })

  it('bench 文件里读不出名字（动态拼的）不猜指标，给提示', async () => {
    await put({
      'package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
      'a.bench.ts': "for (const n of [1, 2]) bench(`n${n}`, () => {})",
    })
    const result = await discoverTests(repo)
    expect(result.suites.some((item) => item.suite.kind === 'benchmark')).toBe(false)
    expect(result.notes.join('\n')).toContain('读不出 bench')
  })

  describe('vitest bench 命令随 vitest 主版本', () => {
    const OUTPUT_JSON = 'npx vitest bench --run --outputJson=test-results/bench.json'
    const JSON_REPORTER = 'npx vitest bench --run --reporter=default --reporter=json --outputFile.json=test-results/bench.json'
    const BENCH = { 'bench/sort.bench.ts': "test('sorts', async ({ bench }) => {\n  await bench('native sort', () => {}).run()\n})\n" }

    async function benchSuite(): Promise<{ command: string | undefined; notes: string; suite: Awaited<ReturnType<typeof discoverTests>>['suites'][number]['suite'] | undefined }> {
      const result = await discoverTests(repo)
      const suite = result.suites.find((item) => item.suite.kind === 'benchmark')?.suite
      return { command: suite?.command, notes: result.notes.join('\n'), suite }
    }

    it('装了 vitest 5：用 json reporter，没有 --outputJson；报告路径与格式不变，指标名取自 bench(名字)', async () => {
      await put({
        'package.json': JSON.stringify({ devDependencies: { vitest: '^5.0.3' } }),
        'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', version: '5.0.3' }),
        ...BENCH,
      })
      const { command, suite, notes } = await benchSuite()
      expect(command).toBe(JSON_REPORTER)
      expect(command).not.toContain('--outputJson')
      expect(suite).toMatchObject({
        runner: 'vitest-bench', report: { format: 'benchmark-json', path: 'test-results/bench.json' }, benchmark: { runs: 1, warmup: 0 },
      })
      expect(suite?.benchmark?.metrics.map((metric) => metric.name)).toEqual(['native_sort.mean_ms'])
      expect(notes).not.toContain('读不出 vitest 主版本')
      const parsed = parseTestCatalog(serializeTestCatalog({ ...emptyCatalog(), suites: suite === undefined ? [] : [suite] }))
      expect(parsed.ok, parsed.ok ? '' : formatCatalogIssues(parsed.issues).join('\n')).toBe(true)
    })

    it('没装、只在 package.json 声明了 ^5：同样按 vitest 5', async () => {
      await put({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^5.0.3' } }), ...BENCH })
      expect((await benchSuite()).command).toBe(JSON_REPORTER)
    })

    it('vitest 3 与 4（装了的或声明的）：命令保持 --outputJson 不变', async () => {
      for (const [declared, version] of [['3', '3.2.7'], ['^4.1.0', '4.1.11']] as const) {
        await put({ 'package.json': JSON.stringify({ devDependencies: { vitest: declared } }), ...BENCH })
        expect((await benchSuite()).command, `declared ${declared}`).toBe(OUTPUT_JSON)
        await put({ 'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', version }) })
        expect((await benchSuite()).command, `installed ${version}`).toBe(OUTPUT_JSON)
        await rm(join(repo, 'node_modules'), { recursive: true, force: true })
      }
    })

    it('装的版本压过声明：声明 ^4 实际装了 5 → 按 5；声明 ^5 实际装了 4 → 按 4', async () => {
      await put({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^4.1.0' } }), 'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', version: '5.0.3' }), ...BENCH })
      expect((await benchSuite()).command).toBe(JSON_REPORTER)
      await put({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^5.0.0' } }), 'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', version: '4.1.11' }) })
      expect((await benchSuite()).command).toBe(OUTPUT_JSON)
    })

    it('只有 vitest.config、既没装也没声明（读不出版本）：不生成基准套件，提示两种版本的手工登记命令', async () => {
      await put({ 'vitest.config.ts': 'export default {}', ...BENCH })
      const { suite, notes } = await benchSuite()
      expect(suite).toBeUndefined()
      expect(notes).toContain('读不出 vitest 主版本')
      expect(notes).toContain(`--command "${OUTPUT_JSON}"`)
      expect(notes).toContain(`--command "${JSON_REPORTER}"`)
      expect(notes).toContain('--metric name=native_sort.mean_ms')
      expect(notes).toContain('tenon test catalog add bench --kind benchmark --runner vitest-bench')
      expect((await discoverTests(repo)).suites.map((item) => item.suite.id)).toEqual(['unit'])
    })

    it.each(['latest', 'workspace:*', 'catalog:', '>=3'])('声明的是 %s（落不到唯一主版本）且没装：同样不猜', async (range) => {
      await put({ 'package.json': JSON.stringify({ devDependencies: { vitest: range } }), ...BENCH })
      const { suite, notes } = await benchSuite()
      expect(suite).toBeUndefined()
      expect(notes).toContain('读不出 vitest 主版本')
    })

    it('monorepo 子包：提示里带 --cwd 与目录前缀的 id；依赖提升到根时按根里装的版本', async () => {
      await put({
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'packages/lib/package.json': JSON.stringify({ name: 'lib' }),
        'packages/lib/vitest.config.ts': 'export default {}',
        'packages/lib/bench/a.bench.ts': BENCH['bench/sort.bench.ts'],
      })
      const unknown = await benchSuite()
      expect(unknown.suite).toBeUndefined()
      expect(unknown.notes).toContain('packages/lib/ 下有 bench 文件但读不出 vitest 主版本')
      expect(unknown.notes).toContain('tenon test catalog add lib-bench --kind benchmark --runner vitest-bench')
      expect(unknown.notes).toContain('--cwd packages/lib')
      await put({ 'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', version: '5.0.3' }) })
      const hoisted = await benchSuite()
      expect(hoisted.command).toBe(JSON_REPORTER)
      expect(hoisted.suite).toMatchObject({ id: 'lib-bench', cwd: 'packages/lib' })
    })

    describe('vitest ≥5 工程里还在用 vitest ≤4 的模块级 bench()：不生成必红的套件', () => {
      const V5 = { 'package.json': JSON.stringify({ devDependencies: { vitest: '^5.0.3' } }), 'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', version: '5.0.3' }) }
      const LEGACY_SINGLE = "import { bench } from 'vitest'\nbench('native sort', () => {})\n"
      const LEGACY_MULTI = "import {\n  describe,\n  bench,\n} from \"vitest\"\ndescribe('sorting', () => {\n  bench('custom sort', () => {})\n})\n"

      it('单行导入（import { bench } from \'vitest\'）：不建议套件，提示点名文件和 fixture 写法', async () => {
        await put({ ...V5, 'bench/sort.bench.ts': LEGACY_SINGLE })
        const { suite, notes } = await benchSuite()
        expect(suite).toBeUndefined()
        expect(notes).toContain('bench/sort.bench.ts')
        expect(notes).toContain('vitest ≤4 的模块级 bench()')
        expect(notes).toContain('bench is not a function')
        expect(notes).toContain("test('…', async ({ bench }) => { await bench('名字', fn).run() })")
        expect(notes).not.toContain('读不出 vitest 主版本')
      })

      it('多行导入（import {\\n describe,\\n bench,\\n} from "vitest"，双引号）同样识别', async () => {
        await put({ ...V5, 'bench/sort.bench.ts': LEGACY_MULTI })
        const { suite, notes } = await benchSuite()
        expect(suite).toBeUndefined()
        expect(notes).toContain('bench/sort.bench.ts')
      })

      it('两种写法并存：整套件不建议，提示只点名旧写法的那几个文件，新写法的不点名', async () => {
        await put({
          ...V5,
          'bench/old-a.bench.ts': LEGACY_SINGLE,
          'bench/old-b.bench.ts': LEGACY_MULTI,
          'bench/new.bench.ts': "import { test } from 'vitest'\ntest('t', async ({ bench }) => { await bench('fresh', () => {}).run() })\n",
        })
        const { suite, notes } = await benchSuite()
        expect(suite).toBeUndefined()
        expect(notes).toContain('bench/old-a.bench.ts')
        expect(notes).toContain('bench/old-b.bench.ts')
        expect(notes).not.toContain('bench/new.bench.ts')
      })

      it('旧写法的文件超过 3 个：只列前 3 个并给总数', async () => {
        await put({ ...V5, ...Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((name) => [`bench/${name}.bench.ts`, LEGACY_SINGLE])) })
        const { notes } = await benchSuite()
        expect(notes).toContain('bench/a.bench.ts、bench/b.bench.ts、bench/c.bench.ts 等 5 个')
        expect(notes).not.toContain('bench/d.bench.ts')
      })

      it('新写法（fixture）：照常建议套件，没有旧写法提示', async () => {
        await put({ ...V5, ...BENCH })
        const { suite, notes } = await benchSuite()
        expect(suite?.command).toBe(JSON_REPORTER)
        expect(notes).not.toContain('bench is not a function')
      })

      it('同样的旧写法在 vitest 3 / 4 上是对的：照常建议 --outputJson 套件', async () => {
        for (const major of ['3.2.7', '4.1.11']) {
          await put({
            'package.json': JSON.stringify({ devDependencies: { vitest: '*' } }),
            'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', version: major }),
            'bench/sort.bench.ts': LEGACY_SINGLE,
          })
          const { command, notes } = await benchSuite()
          expect(command, major).toBe(OUTPUT_JSON)
          expect(notes, major).not.toContain('bench is not a function')
        }
      })

      it('点名文件带子包目录前缀', async () => {
        await put({
          'package.json': JSON.stringify({ workspaces: ['packages/*'], devDependencies: { vitest: '^5.0.0' } }),
          'packages/lib/package.json': JSON.stringify({ name: 'lib' }),
          'packages/lib/vitest.config.ts': 'export default {}',
          'packages/lib/bench/a.bench.ts': LEGACY_SINGLE,
        })
        const { suite, notes } = await benchSuite()
        expect(suite).toBeUndefined()
        expect(notes).toContain('packages/lib/ 下的 bench 文件还在用 vitest ≤4 的模块级 bench()')
        expect(notes).toContain('packages/lib/bench/a.bench.ts')
      })
    })
  })

  describe('usesModuleLevelBench：只认从 vitest 导入 bench', () => {
    it.each([
      ["import { bench } from 'vitest'", true],
      ['import { bench } from "vitest"', true],
      ["import { describe, bench } from 'vitest'", true],
      ["import { bench, describe } from 'vitest';", true],
      ["import {\n  describe,\n  bench,\n} from 'vitest'", true],
      ["import { bench as b } from 'vitest'", true],
      ["import { describe, bench, type BenchOptions } from 'vitest'", true],
      ["  import { bench } from 'vitest'", true],
      ["const { bench } = require('vitest')", true],
      ["const { describe, bench } = require(\"vitest\")", true],
      ["import { test } from 'vitest'\ntest('t', async ({ bench }) => { await bench('x', () => {}).run() })", false],
      ["import type { bench } from 'vitest'", false],
      ["// import { bench } from 'vitest'\nimport { test } from 'vitest'", false],
      ["import { bench } from 'tinybench'", false],
      ["import { benchmark } from 'vitest'", false],
      ["import { describe } from 'vitest'\nconst bench = (name: string) => name", false],
      ['', false],
    ])('%j → %s', (text, legacy) => { expect(usesModuleLevelBench(text)).toBe(legacy) })
  })

  it('Playwright 自带 webServer：给提示，不重复启动', async () => {
    await put({ 'playwright.config.ts': "export default { webServer: { command: 'npm run dev', url: 'http://localhost:5173' } }" })
    const result = await discoverTests(repo)
    expect(result.notes.join('\n')).toContain('webServer')
  })

  it('monorepo：子包各自识别，id 带目录前缀；纯工作区根不产出套件', async () => {
    await put({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/web/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
      'packages/web/vitest.config.ts': 'export default {}',
      'packages/api/package.json': JSON.stringify({ devDependencies: { jest: '29' } }),
    })
    expect((await ids()).sort()).toEqual(['api-unit', 'web-unit'])
    const web = (await discoverTests(repo)).suites.find((item) => item.suite.id === 'web-unit')?.suite
    expect(web?.cwd).toBe('packages/web')
  })

  it('jest / mocha / node:test / pytest / go 各识别一个；cargo 与 cypress 只给提示', async () => {
    await put({
      'jest/package.json': JSON.stringify({ devDependencies: { jest: '29' } }),
      'mocha/package.json': JSON.stringify({ devDependencies: { mocha: '10' } }),
      'nodetest/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'py/pytest.ini': '[pytest]\n',
      'go/go.mod': 'module example.com/x\n',
      'rs/Cargo.toml': '[package]\nname = "x"\n',
      'cy/package.json': '{}',
      'cy/cypress.config.ts': 'export default {}',
    })
    const result = await discoverTests(repo)
    expect(result.suites.map((item) => [item.suite.id, item.suite.runner, item.suite.report.format]).sort()).toEqual([
      ['go-go-test', 'go', 'go-json'], ['jest-unit', 'jest', 'jest-json'], ['mocha-unit', 'mocha', 'junit'],
      ['nodetest-unit', 'node-test', 'junit'], ['py-pytest', 'pytest', 'junit'],
    ])
    expect(result.notes.join('\n')).toContain('cargo-nextest')
    expect(result.notes.join('\n')).toContain('Cypress')
    const text = serializeTestCatalog({ ...emptyCatalog(), suites: result.suites.map((item) => item.suite) })
    expect(parseTestCatalog(text).ok).toBe(true)
  })

  it('node:test：预设命令读 TENON_NODE_TEST_REPORTER（tenon test run 提供带 file 的 reporter），变量为空退回内置 junit；写出再解析不变', async () => {
    await put({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const suite = (await discoverTests(repo)).suites.find((item) => item.suite.runner === 'node-test')?.suite
    const reporter = '--test-reporter="${TENON_NODE_TEST_REPORTER:-junit}" --test-reporter-destination=test-results/junit.xml'
    expect(suite?.command).toBe(`node --test ${reporter}`)
    expect(suite?.select?.files).toBe(`node --test ${reporter} {files}`)
    expect(suite?.report).toEqual({ format: 'junit', path: 'test-results/junit.xml' })
    const text = serializeTestCatalog({ ...emptyCatalog(), suites: suite === undefined ? [] : [suite] })
    const parsed = parseTestCatalog(text)
    expect(parsed.ok && parsed.catalog.suites[0]?.command).toBe(`node --test ${reporter}`)
    expect(parsed.ok && parsed.catalog.suites[0]?.select?.files).toBe(`node --test ${reporter} {files}`)
  })

  it('npm test 跑的是认不出的工具：不猜套件，提示怎么登记；默认占位脚本与已识别的工程不提示', async () => {
    await put({ 'package.json': JSON.stringify({ scripts: { test: 'tap' } }) })
    const unknown = await discoverTests(repo)
    expect(unknown.suites).toEqual([])
    expect(unknown.notes.join('\n')).toContain('test 脚本（tap）不是能识别的测试工具')
    expect(unknown.notes.join('\n')).toContain('tenon test catalog not-applicable unit')
    await put({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })
    expect((await discoverTests(repo)).notes.join('\n')).not.toContain('不是能识别的测试工具')
    await put({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    expect((await discoverTests(repo)).notes.join('\n')).not.toContain('不是能识别的测试工具')
  })

  it('跳过 node_modules / dist / .tenon 等目录；同 id 冲突自动加序号', async () => {
    await put({
      'node_modules/pkg/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
      'dist/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
      'a/x/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
      'b/x/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
    })
    expect((await ids()).sort()).toEqual(['x-unit', 'x-unit-2'])
  })
})
