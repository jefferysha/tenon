import { parseTestCatalog, type TestCatalog } from '@tenon/kernel'
import { describe, expect, test } from 'vitest'
import { changedTestCandidates, claimOrphans } from './claim-orphans.js'

function catalogOf(...suites: readonly string[]): TestCatalog {
  const parsed = parseTestCatalog(`schema: tenon-test-catalog/v1\nsuites:\n${suites.join('\n')}\n`)
  if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.line}: ${issue.message}`).join('\n'))
  return parsed.catalog
}

const suite = (id: string, kind: string, runner: string, extra: readonly string[] = []): string => [
  `  - id: ${id}`, `    kind: ${kind}`, `    runner: ${runner}`, '    command: npm test', ...extra,
  ...(kind === 'typecheck' || kind === 'lint' ? ['    report:', '      format: exit-code'] : kind === 'benchmark'
    ? ['    report:', '      format: benchmark-json', `      path: test-results/${id}.json`, '    benchmark:', '      metrics:', '        - name: ms', '          max: 100']
    : ['    report:', '      format: junit', `      path: test-results/${id}.xml`]),
].join('\n')

const files = (suiteCatalog: TestCatalog, id: string): readonly string[] => suiteCatalog.suites.find((item) => item.id === id)?.files ?? []

describe('claimOrphans：精确路径', () => {
  test('只把该文件的精确路径追加进套件 files，不生成目录通配，原有 glob 不变', () => {
    const catalog = catalogOf(suite('unit', 'unit', 'vitest', ['    files:', '      - packages/*/src/**/*.test.ts']))
    const result = claimOrphans(catalog, ['tools/x.test.mjs'])
    expect(result.claims).toEqual([{ path: 'tools/x.test.mjs', suite: 'unit', file: 'tools/x.test.mjs' }])
    expect(files(result.catalog, 'unit')).toEqual(['packages/*/src/**/*.test.ts', 'tools/x.test.mjs'])
    expect(result.unresolved).toEqual([])
  })

  test('同一目录下的两个孤儿各追加各的路径，互不顺带认领', () => {
    const catalog = catalogOf(suite('unit', 'unit', 'vitest', ['    files:', '      - src/**/*.test.ts']))
    const result = claimOrphans(catalog, ['test/b.test.js', 'test/a.test.js', 'test/a.test.js'])
    expect(files(result.catalog, 'unit')).toEqual(['src/**/*.test.ts', 'test/a.test.js', 'test/b.test.js'])
    expect(result.claims.map((claim) => claim.path)).toEqual(['test/a.test.js', 'test/b.test.js'])
  })

  test('路径相对套件 cwd：只有 cwd 是路径前缀的套件是候选，cwd 越具体越优先', () => {
    const catalog = catalogOf(
      suite('root-unit', 'unit', 'vitest', ['    files:', '      - src/**/*.test.ts']),
      suite('site-unit', 'unit', 'node-test', ['    cwd: docs-site', '    files:', '      - scripts/*.node-test.mjs']),
    )
    const result = claimOrphans(catalog, ['docs-site/scripts/deep/a.test.mjs', 'tools/b.test.mjs'])
    expect(result.claims).toEqual([
      { path: 'docs-site/scripts/deep/a.test.mjs', suite: 'site-unit', file: 'scripts/deep/a.test.mjs' },
      { path: 'tools/b.test.mjs', suite: 'root-unit', file: 'tools/b.test.mjs' },
    ])
    expect(files(result.catalog, 'site-unit')).toEqual(['scripts/*.node-test.mjs', 'scripts/deep/a.test.mjs'])
    expect(files(result.catalog, 'root-unit')).toEqual(['src/**/*.test.ts', 'tools/b.test.mjs'])
  })

  test('原本就有套件认领的文件不动；重复运行幂等（目录原样返回）', () => {
    const catalog = catalogOf(suite('unit', 'unit', 'vitest', ['    files:', '      - src/**/*.test.ts']))
    const owned = claimOrphans(catalog, ['src/a.test.ts'])
    expect(owned.catalog).toBe(catalog)
    expect(owned.claims).toEqual([])
    const first = claimOrphans(catalog, ['tools/x.test.mjs'])
    const second = claimOrphans(first.catalog, ['tools/x.test.mjs'])
    expect(second.catalog).toBe(first.catalog)
    expect(second.claims).toEqual([])
  })

  test('e2e/ 下的文件找浏览器类套件，基准脚本找基准套件，其余找 unit / integration / regression', () => {
    const catalog = catalogOf(
      suite('unit', 'unit', 'vitest', ['    files:', '      - src/**/*.test.ts']),
      suite('pw', 'playwright', 'playwright', ['    files:', '      - e2e/*.spec.ts']),
      suite('bench', 'benchmark', 'custom', ['    files:', '      - bench/a.bench.mjs']),
    )
    const result = claimOrphans(catalog, ['e2e/dash/new.spec.ts', 'bench/b.bench.mjs', 'tools/x.test.mjs'])
    expect(result.claims.map((claim) => [claim.path, claim.suite])).toEqual([
      ['bench/b.bench.mjs', 'bench'], ['e2e/dash/new.spec.ts', 'pw'], ['tools/x.test.mjs', 'unit'],
    ])
  })

  test('没有合适套件的文件进 unresolved，目录不为它改动', () => {
    const catalog = catalogOf(suite('lint', 'lint', 'custom'))
    const result = claimOrphans(catalog, ['tools/x.test.mjs'])
    expect(result.unresolved).toEqual(['tools/x.test.mjs'])
    expect(result.claims).toEqual([])
    expect(result.catalog).toBe(catalog)
  })

  test('文件名本身含 * 或 ?：写进 files 的「精确路径」其实是通配符，会顺带认领别的文件，所以进 unresolved，目录不变', () => {
    const catalog = catalogOf(suite('unit', 'unit', 'vitest', ['    files:', '      - src/**/*.test.ts']))
    const result = claimOrphans(catalog, ['tools/a*b.test.ts', 'tools/a?.test.ts'])
    expect(result.unresolved).toEqual(['tools/a*b.test.ts', 'tools/a?.test.ts'])
    expect(result.claims).toEqual([])
    expect(result.catalog).toBe(catalog)
    expect(files(result.catalog, 'unit')).toEqual(['src/**/*.test.ts'])
  })

  test('其余 glob 元字符（[ ] { } ! 与反斜杠）同样一律进 unresolved，不论追加后该套件能不能认出它', () => {
    const catalog = catalogOf(suite('unit', 'unit', 'vitest', ['    files:', '      - src/**/*.test.ts']))
    const orphans = ['tools/{x,y}.test.ts', 'tools/!z.test.ts', 'tools/q\\w.test.ts', 'tools/[ab].test.ts', 'tools/c].test.ts']
    const result = claimOrphans(catalog, orphans)
    expect([...result.unresolved].sort()).toEqual([...orphans].sort())
    expect(result.claims).toEqual([])
    expect(result.catalog).toBe(catalog)
  })

  test('路径含 glob 元字符、精确写不出来：宁可放进 unresolved，也不追加一条认不出它的项', () => {
    const catalog = catalogOf(suite('unit', 'unit', 'vitest', ['    files:', '      - src/**/*.test.ts']))
    const result = claimOrphans(catalog, ['app/[id]/page.test.ts'])
    expect(result.unresolved).toEqual(['app/[id]/page.test.ts'])
    expect(result.catalog).toBe(catalog)
  })
})

describe('changedTestCandidates：只从本任务改动里挑像测试的文件', () => {
  test('去掉控制目录与非源码扩展名，只留像测试的源码文件，排序去重', () => {
    expect(changedTestCandidates([
      'tools/x.test.mjs', 'tools/x.test.mjs', 'src/a.ts', 'README.md',
      'openspec/changes/archive/a/r.spec.report', 'openspec/changes/demo/notes.spec.md', '.tenon/tests/x.test.json',
      'fixtures/data.spec.json', 'e2e/fixtures/seed.json', 'e2e/dash/b.spec.ts', 'test_py.py',
    ])).toEqual(['e2e/dash/b.spec.ts', 'test_py.py', 'tools/x.test.mjs'])
  })

  test('没有改动就没有候选', () => {
    expect(changedTestCandidates([])).toEqual([])
  })
})
