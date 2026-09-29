import { describe, expect, it } from 'vitest'
import { parseTestCatalog } from './catalog.js'
import { globToRegExp, isRepoRelativeGlob, isRepoRelativePath, matchesGlob, repoGlob } from './globs.js'
import { extractScenarios, extractTaskItems } from './openspec-trace.js'
import { emptyTestPlan } from './plan.js'
import { DESIGN_CATALOG } from './test-support.js'
import { normalizeRepoPath, suitesOwningFile, testFileRegistration } from './test-files.js'
import { looksLikeTestFile } from './vocabulary.js'

const DELTA = `## ADDED Requirements

### Requirement: 登录
#### Scenario: 登录成功跳转首页
- WHEN 用户登录
- THEN 跳转首页

#### Scenario: 密码错误提示
\`\`\`
#### Scenario: 代码块里的不算
\`\`\`

## MODIFIED Requirements
### Requirement: 会话
#### Scenario: 会话过期重新登录

## REMOVED Requirements
### Requirement: 旧版登录
#### Scenario: 旧版入口可用

#### Scenario: 登录成功跳转首页
`

describe('delta spec 场景提取', () => {
  it('按 capability 生成 covers；REMOVED 与代码块里的不算；重复标题只算一次', () => {
    const scenarios = extractScenarios('auth', DELTA)
    expect(scenarios.map((item) => [item.covers, item.requirement, item.section])).toEqual([
      ['spec:auth/登录成功跳转首页', '登录', 'added'],
      ['spec:auth/密码错误提示', '登录', 'added'],
      ['spec:auth/会话过期重新登录', '会话', 'modified'],
    ])
    expect(scenarios[0]?.line).toBe(4)
  })
})

describe('tasks.md 条目', () => {
  it('自带编号用编号；没有编号按「小节.序号」派生', () => {
    const items = extractTaskItems([
      '# Tasks', '', '## 1. Setup', '- [ ] 1.1 建目录', '- [x] 1.2. 写配置', '', '## Build', '- [x] 实现', '  - [ ] 子项',
      '```', '- [ ] 代码块里的不算', '```',
    ].join('\n'))
    expect(items.map((item) => [item.covers, item.text, item.done])).toEqual([
      ['task:1.1', '建目录', false],
      ['task:1.2', '写配置', true],
      ['task:2.1', '实现', true],
      ['task:2.2', '子项', false],
    ])
  })
})

describe('glob 匹配', () => {
  it.each([
    ['src/**/*.test.{ts,tsx}', 'src/a.test.ts', true],
    ['src/**/*.test.{ts,tsx}', 'src/x/y/a.test.tsx', true],
    ['src/**/*.test.{ts,tsx}', 'src/a.test.js', false],
    ['e2e/**', 'e2e/a/b.spec.ts', true],
    ['**/*.bench.*', 'bench/x.bench.mjs', true],
    ['**/*.bench.*', 'x.bench.ts', true],
    ['test_?.py', 'test_a.py', true],
    ['test_?.py', 'test_ab.py', false],
    ['[ab].ts', 'a.ts', true],
    ['[!ab].ts', 'a.ts', false],
    ['{a,{b,c}}.ts', 'c.ts', true],
    ['a\\*.ts', 'a*.ts', true],
    ['src/*.ts', 'src/x/a.ts', false],
  ])('%s ~ %s → %s', (glob, path, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected)
  })

  it('路径与 glob 留在仓库内', () => {
    expect(globToRegExp('a/**').source).toBe(globToRegExp('a/**').source)
    expect(repoGlob('.', 'a/*')).toBe('a/*')
    expect(repoGlob('pkg', 'a/*')).toBe('pkg/a/*')
    expect(isRepoRelativePath('.')).toBe(true)
    for (const bad of ['', '/abs', 'a/../b', 'a\\b', 'a//b', './a']) expect(isRepoRelativePath(bad)).toBe(false)
    expect(isRepoRelativeGlob('**/*.ts')).toBe(true)
    for (const bad of ['/abs/*', '../*', 'a/../*']) expect(isRepoRelativeGlob(bad)).toBe(false)
  })
})

describe('全量登记强制', () => {
  const result = parseTestCatalog(DESIGN_CATALOG)
  if (!result.ok) throw new Error('catalog')
  const catalog = result.catalog

  it('被套件认领却没登记 → 未登记；像测试却没人认领 → 孤儿；已登记与普通源码不报', () => {
    const plan = { ...emptyTestPlan('demo'), files: [{ path: 'e2e/login.spec.ts', suite: 'web-e2e' }] }
    const registration = testFileRegistration({
      catalog,
      plan,
      changedFiles: [
        './packages/dashboard-app/src/login/Login.test.tsx',
        'e2e/login.spec.ts',
        'e2e/logout.spec.ts',
        'packages/server/src/x.test.ts',
        'tools/test_helper.py',
        'packages/dashboard-app/src/login/Login.tsx',
        'packages/dashboard-app/src/login/Login.test.tsx',
      ],
    })
    expect(registration.unregistered).toEqual([
      { path: 'e2e/logout.spec.ts', suites: ['web-e2e'] },
      { path: 'packages/dashboard-app/src/login/Login.test.tsx', suites: ['web-unit'] },
    ])
    expect(registration.orphans).toEqual(['packages/server/src/x.test.ts', 'tools/test_helper.py'])
    expect(suitesOwningFile(catalog, 'README.md')).toEqual([])
    expect(normalizeRepoPath('.\\a\\b.ts')).toBe('a/b.ts')
  })

  it('测试文件判定模式', () => {
    for (const path of ['a.test.ts', 'x/a.spec.tsx', 'test_x.py', 'pkg/x_test.go', 'b.bench.mjs', 'e2e/helpers.ts']) {
      expect(looksLikeTestFile(path)).toBe(true)
    }
    for (const path of ['src/testing.ts', 'latest.ts', 'e2e.ts']) expect(looksLikeTestFile(path)).toBe(false)
  })
})
