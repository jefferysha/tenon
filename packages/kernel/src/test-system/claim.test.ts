/**
 * 改动过的测试文件按套件 `files` glob 自动认领（M3）：控制目录与非源码扩展名先剔除，没人认领的像测试的文件是孤儿。
 */
import { describe, expect, it } from 'vitest'
import { parseTestCatalog } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import { claimChangedTestFiles, claimedByPath, claimedFilesOfSuite, orphansNotInPlan } from './claim.js'

function catalogOf(suites: string): TestCatalog {
  const result = parseTestCatalog(`schema: tenon-test-catalog/v1\nsuites:\n${suites}`)
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('\n'))
  return result.catalog
}

const SUITE = (id: string, kind: string, files: string, extra = ''): string =>
  `  - { id: ${id}, kind: ${kind}, runner: vitest, command: run, files: ["${files}"], report: { format: junit, path: test-results/${id}.xml }${extra} }\n`

const UNIT_ONLY = catalogOf(SUITE('unit', 'unit', 'src/**/*.test.ts'))

describe('claimChangedTestFiles', () => {
  it('控制目录与非源码扩展名不认领也不算孤儿；没人认领的像测试的文件是孤儿', () => {
    const result = claimChangedTestFiles([
      'src/a.test.ts',
      'openspec/changes/archive/x/a.spec.report',
      'fixtures/d.spec.json',
      'tools/x.test.mjs',
    ], UNIT_ONLY)
    expect([...result.claimed]).toEqual([['unit', ['src/a.test.ts']]])
    expect(result.orphans).toEqual(['tools/x.test.mjs'])
  })

  it('控制目录里的路径即使匹配套件 glob 也不认领', () => {
    const catalog = catalogOf(SUITE('all', 'unit', '**/*.test.ts'))
    const result = claimChangedTestFiles(['openspec/changes/c/notes.test.ts', '.tenon/tests/x.test.ts', '.pipeline/y.test.ts', 'src/z.test.ts'], catalog)
    expect([...result.claimed]).toEqual([['all', ['src/z.test.ts']]])
    expect(result.orphans).toEqual([])
  })

  it('一个文件被多个套件认领：每个套件都认领它', () => {
    const catalog = catalogOf(`${SUITE('unit', 'unit', 'src/**/*.test.ts')}${SUITE('cov', 'coverage', 'src/**/*.test.ts')}`)
    const result = claimChangedTestFiles(['src/a.test.ts'], catalog)
    expect([...result.claimed.entries()]).toEqual([['unit', ['src/a.test.ts']], ['cov', ['src/a.test.ts']]])
  })

  it('结果去重、排序，路径写法归一（反斜杠、./ 前缀）', () => {
    const result = claimChangedTestFiles(['./src/b.test.ts', 'src\\a.test.ts', 'src/b.test.ts'], UNIT_ONLY)
    expect(result.claimed.get('unit')).toEqual(['src/a.test.ts', 'src/b.test.ts'])
  })

  it('改动里没有测试文件：没有认领也没有孤儿；不像测试的未认领文件不是孤儿', () => {
    const result = claimChangedTestFiles(['README.md', 'src/a.ts'], UNIT_ONLY)
    expect(result.claimed.size).toBe(0)
    expect(result.orphans).toEqual([])
  })

  it('套件 cwd 不是仓库根时，files glob 按 cwd 换算成仓库相对路径', () => {
    const catalog = catalogOf(SUITE('web', 'unit', 'src/**/*.test.ts', ', cwd: packages/web'))
    const result = claimChangedTestFiles(['packages/web/src/a.test.ts', 'src/b.test.ts'], catalog)
    expect(result.claimed.get('web')).toEqual(['packages/web/src/a.test.ts'])
    expect(result.orphans).toEqual(['src/b.test.ts'])
  })
})

describe('claimedByPath / orphansNotInPlan', () => {
  it('claimedByPath：套件 → 文件 转成 文件 → 认领它的套件们（按路径排序）', () => {
    const catalog = catalogOf(`${SUITE('unit', 'unit', 'src/**/*.test.ts')}${SUITE('cov', 'coverage', 'src/**/*.test.ts')}${SUITE('e2e', 'unit', 'e2e/**/*.test.ts')}`)
    const claim = claimChangedTestFiles(['src/b.test.ts', 'e2e/x.test.ts', 'src/a.test.ts'], catalog)
    expect(claimedByPath(claim.claimed)).toEqual([
      { path: 'e2e/x.test.ts', suites: ['e2e'] },
      { path: 'src/a.test.ts', suites: ['unit', 'cov'] },
      { path: 'src/b.test.ts', suites: ['unit', 'cov'] },
    ])
  })

  it('orphansNotInPlan：计划里按 kind 登记的资源文件不是孤儿（路径写法归一后比对）', () => {
    const plan = { files: [{ path: './snap/a.test.ts', kind: 'visual' as const }] }
    expect(orphansNotInPlan(['snap/a.test.ts', 'tools/x.test.mjs'], plan)).toEqual(['tools/x.test.mjs'])
    expect(orphansNotInPlan(['tools/x.test.mjs'], undefined)).toEqual(['tools/x.test.mjs'])
  })
})

describe('claimedFilesOfSuite', () => {
  it('只取本套件 files glob 认领的改动文件（控制目录先剔除）', () => {
    const suite = UNIT_ONLY.suites[0]
    if (suite === undefined) throw new Error('suite')
    expect(claimedFilesOfSuite(['src/b.test.ts', 'src/a.test.ts', 'e2e/x.spec.ts', 'openspec/c/src/x.test.ts'], suite))
      .toEqual(['src/a.test.ts', 'src/b.test.ts'])
  })
})
