import { describe, expect, it } from 'vitest'
import { parseTestDirection, serializeTestCatalog, parseTestCatalog, type CatalogSuite } from '@tenon/kernel'
import { buildService, buildSuite, parseMetric } from './test-catalog-edit.js'

const DIRECTION = (text: string) => parseTestDirection(text)

function roundTrips(suite: CatalogSuite): boolean {
  const text = serializeTestCatalog({ schema: 'tenon-test-catalog/v1', profiles_env: [], suites: [suite], services: [] })
  return parseTestCatalog(text).ok
}

describe('parseMetric', () => {
  it('key=value 串；better 缺省 lower；未知键、缺 name、非数字都给出原因', () => {
    expect(parseMetric('name=p95_ms,better=lower,max_regression_pct=10,max=250,unit=ms')).toEqual({
      name: 'p95_ms', better: 'lower', unit: 'ms', max_regression_pct: 10, max: 250,
    })
    expect(parseMetric('name=rps,better=higher,min=100')).toEqual({ name: 'rps', better: 'higher', min: 100 })
    expect(parseMetric('name=x')).toEqual({ name: 'x', better: 'lower' })
    expect(parseMetric('better=lower')).toContain('缺 name')
    expect(parseMetric('name=x,speed=3')).toContain("不认识的键 'speed'")
    expect(parseMetric('name=x,max=fast')).toContain('不是数字')
    expect(parseMetric('name=x,better=sideways')).toContain('lower 或 higher')
    expect(parseMetric('nonsense')).toContain('key=value')
  })
})

describe('buildSuite', () => {
  it('add：runner 从命令推断，reporter 预设补齐 select / report / artifacts', () => {
    const suite = buildSuite('unit', undefined, { kind: 'unit', command: 'npx vitest run' }, undefined)
    expect(typeof suite).toBe('object')
    if (typeof suite === 'string') return
    expect(suite).toMatchObject({ runner: 'vitest', cwd: '.', timeout_s: 900, report: { format: 'vitest-json', path: 'test-results/vitest.json' } })
    expect(roundTrips(suite)).toBe(true)
  })

  it('add：缺 kind / command / 报告要求时说明缺什么；闭集外的值被拒', () => {
    expect(buildSuite('x', undefined, { command: 'a' }, undefined)).toContain('--kind')
    expect(buildSuite('x', undefined, { kind: 'unit' }, undefined)).toContain('--command')
    expect(buildSuite('x', undefined, { kind: 'unit', command: 'my-tool' }, undefined)).toContain('--report-format')
    expect(buildSuite('x', undefined, { kind: 'bogus', command: 'a' }, undefined)).toContain('不在闭集内')
    expect(buildSuite('x', undefined, { kind: 'unit', command: 'a', runner: 'bogus' }, undefined)).toContain('--runner')
    expect(buildSuite('x', undefined, { kind: 'unit', command: 'a', reportFormat: 'bogus' }, undefined)).toContain('--report-format')
    expect(buildSuite('x', undefined, { kind: 'unit', command: 'a', reportFormat: 'junit', coverageFormat: 'lcov' }, undefined)).toContain('一起给')
    expect(buildSuite('x', undefined, { kind: 'unit', command: 'a', reportFormat: 'junit', retries: '-1' }, undefined)).toContain('--retries')
  })

  it('typecheck / lint 这类可以只看退出码', () => {
    const suite = buildSuite('types', undefined, { kind: 'typecheck', command: 'npm run typecheck' }, undefined)
    expect(suite).toMatchObject({ report: { format: 'exit-code' } })
  })

  it('benchmark 套件带 runs / warmup / metrics', () => {
    const suite = buildSuite('bench', undefined, {
      kind: 'benchmark', runner: 'custom', command: 'node bench.mjs', reportFormat: 'benchmark-json', reportPath: 'test-results/b.json',
      runs: '5', warmup: '1', metric: ['name=p95_ms,better=lower,max=250'],
    }, undefined)
    expect(suite).toMatchObject({ benchmark: { runs: 5, warmup: 1, metrics: [{ name: 'p95_ms', max: 250 }] } })
    if (typeof suite !== 'string') expect(roundTrips(suite)).toBe(true)
  })

  it('--from 方向模板：裸调用换成 runner 的推荐调用，自定义命令原样保留并要求报告', () => {
    const bare = buildSuite('e2e', undefined, {}, DIRECTION('id: playwright\ncommand: npx playwright test\nlabel: Playwright\ntimeout_s: 1800\n'))
    expect(bare).toMatchObject({ kind: 'playwright', runner: 'playwright', timeout_s: 1800, report: { format: 'playwright-json' }, artifacts: ['playwright-report', 'test-results'] })
    expect(typeof bare === 'object' && (bare as CatalogSuite).command).toContain('PLAYWRIGHT_JSON_OUTPUT_NAME')
    // `npm test` 推不出 runner；指定 --runner vitest 后它就是裸调用，换成推荐调用。
    const unknown = buildSuite('unit', undefined, {}, DIRECTION('id: unit\ncommand: npm test\nlabel: 单测\n'))
    expect(unknown).toContain('--report-format')
    const custom = buildSuite('unit', undefined, { runner: 'vitest' }, DIRECTION('id: unit\ncommand: npm test\nlabel: 单测\n'))
    expect(custom).toMatchObject({ kind: 'unit', runner: 'vitest', report: { format: 'vitest-json' } })
    const exotic = buildSuite('smoke', undefined, {}, DIRECTION('id: regression\ncommand: ./run-checks.sh\nlabel: 回归\n'))
    expect(exotic).toContain('--report-format')
  })

  it('set：只替换给出的字段，列表字段整份替换', () => {
    const base = buildSuite('unit', undefined, { kind: 'unit', command: 'npx vitest run', fileGlob: ['src/**/*.test.ts'], uses: ['web'] }, undefined)
    if (typeof base === 'string') throw new Error(base)
    const changed = buildSuite('unit', base, { retries: '2', fileGlob: ['lib/**/*.test.ts'] }, undefined)
    expect(changed).toMatchObject({ retries: 2, files: ['lib/**/*.test.ts'], services: ['web'], command: 'npx vitest run', runner: 'vitest' })
  })
})

describe('buildService', () => {
  it('需要 start 与三选一的就绪探测；set 时沿用旧值', () => {
    expect(buildService('web', undefined, { readyUrl: 'http://x' })).toContain('--start')
    expect(buildService('web', undefined, { start: 'npm run dev' })).toContain('就绪探测')
    expect(buildService('web', undefined, { start: 'npm run dev', readyUrl: 'http://x/', readyPort: '80' })).toContain('只能选一个')
    const service = buildService('web', undefined, { start: 'npm run dev', readyPort: '5173', readyTimeout: '20' })
    expect(service).toEqual({ id: 'web', start: 'npm run dev', cwd: '.', ready: { port: 5173, timeout_s: 20 }, stop: 'SIGTERM', env: [] })
    if (typeof service === 'string') return
    expect(buildService('web', service, { readyLog: 'ready in' })).toMatchObject({ ready: { log: 'ready in', timeout_s: 20 }, start: 'npm run dev' })
    expect(buildService('web', service, { stop: 'SIGHUP' })).toContain('SIGTERM')
  })
})
