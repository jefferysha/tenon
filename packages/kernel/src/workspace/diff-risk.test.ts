import { describe, expect, test } from 'vitest'
import type { PathChange } from './changed-files.js'
import { assessDiffRisk, isCodePath, isTestPath, touchedPathClasses } from './diff-risk.js'

const change = (path: string, status: PathChange['status'] = 'modified'): PathChange => ({ path, status })

describe('isCodePath / isTestPath', () => {
  test('代码类路径：排除状态目录、文档与测试输出', () => {
    expect(isCodePath('src/add.js')).toBe(true)
    expect(isCodePath('package.json')).toBe(true)
    expect(isCodePath('README.md')).toBe(false)
    expect(isCodePath('docs/usage/x.ts')).toBe(false)
    expect(isCodePath('openspec/changes/c/.pipeline.yaml')).toBe(false)
    expect(isCodePath('.claude/agents/tenon-code-review.md')).toBe(false)
    expect(isCodePath('test-results/junit.xml')).toBe(false)
  })

  test('测试文件：命名约定与 test/ tests/ __tests__/ 目录', () => {
    for (const path of ['src/a.test.ts', 'src/a.spec.js', 'test_a.py', 'a_test.go', 'test/add.js', 'pkg/__tests__/x.js', 'e2e/a.ts']) {
      expect(isTestPath(path), path).toBe(true)
    }
    for (const path of ['src/add.js', 'src/attest.js', 'src/latest/x.js']) expect(isTestPath(path), path).toBe(false)
  })
})

describe('assessDiffRisk', () => {
  test('3 文件缺陷：只有 files_changed，其余全 0', () => {
    expect(assessDiffRisk([change('src/add.js'), change('src/calc.js'), change('test/add.test.js')], 0)).toEqual({
      files_changed: 3, contract_files: 0, auth_files: 0, dependency_files: 0, migration_files: 0,
      deleted_tests: 0, protected_test_files: 0,
    })
  })

  test('按类计数；Tenon 自己的状态与文档不计入', () => {
    const metrics = assessDiffRisk([
      change('src/auth/login.js'),
      change('package.json'),
      change('package-lock.json'),
      change('api/openapi.yaml', 'added'),
      change('db/migrations/001.sql', 'added'),
      change('openspec/changes/c/.pipeline.yaml'),
      change('docs/notes.md'),
    ], 2)
    expect(metrics).toEqual({
      files_changed: 5, contract_files: 1, auth_files: 1, dependency_files: 2, migration_files: 1,
      deleted_tests: 0, protected_test_files: 2,
    })
  })

  test('删除的测试文件单独计数；删除普通源码不算', () => {
    const metrics = assessDiffRisk([change('test/add.test.js', 'deleted'), change('src/old.js', 'deleted')], 0)
    expect(metrics.deleted_tests).toBe(1)
    expect(metrics.files_changed).toBe(2)
  })
})

describe('touchedPathClasses', () => {
  test('改动命中的路径类集合', () => {
    expect([...touchedPathClasses([change('src/add.js'), change('src/auth/login.js'), change('docs/auth.md')])]).toEqual(['auth'])
    expect(touchedPathClasses([change('src/add.js')]).size).toBe(0)
  })
})
