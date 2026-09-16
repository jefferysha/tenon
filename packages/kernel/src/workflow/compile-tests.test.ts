import { describe, expect, test } from 'vitest'
import { compileWorkflow } from './compile.js'
import type { StepTestDef, WorkflowDef } from './types.js'

function withTests(tests: readonly Partial<StepTestDef>[]): WorkflowDef {
  return {
    name: 'tested',
    steps: [{
      id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [],
      tests: tests as readonly StepTestDef[],
      guards: [], transitions: [],
    }],
  }
}

function compiledTests(tests: readonly Partial<StepTestDef>[]): unknown {
  return compileWorkflow(withTests(tests)).steps[0]?.tests
}

function rejects(tests: readonly Partial<StepTestDef>[], message: string): void {
  expect(() => compileWorkflow(withTests(tests))).toThrow(message)
}

const MINIMAL: Partial<StepTestDef> = { id: 'unit', direction: 'unit', command: 'npm test' }

describe('compileStepTests', () => {
  test('补齐默认值，键序固定 id/direction/command/cwd 开头', () => {
    const compiled = compiledTests([MINIMAL])
    expect(compiled).toEqual([{
      id: 'unit', direction: 'unit', command: 'npm test', cwd: '.',
      timeout_s: 900, required: true, keep_runs: 5,
      pass: { exit_code: 0, metrics: [] }, inputs: [], outputs: [],
    }])
    expect(Object.keys((compiled as readonly object[])[0] ?? {}).slice(0, 4))
      .toEqual(['id', 'direction', 'command', 'cwd'])
    expect(JSON.stringify(compiled)).toContain('"id":"unit","direction":"unit","command":"npm test"')
  })

  test('无测试的工作流编译后不出现 tests 键；空数组同归一', () => {
    const plain = compileWorkflow({
      name: 'plain',
      steps: [{ id: 'a', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    expect(Object.prototype.hasOwnProperty.call(plain.steps[0] ?? {}, 'tests')).toBe(false)
    expect(compiledTests([])).toBeUndefined()
  })

  test('指标与输出的默认值：better lower、输出 kind other、required false', () => {
    const compiled = compiledTests([{
      ...MINIMAL,
      metrics_path: 'test-results/bench.json',
      pass: { metrics: [{ name: 'p95_ms', max: 250 }] },
      outputs: [{ path: 'coverage/lcov.info' }],
    }])
    expect(compiled).toMatchObject([{
      pass: { exit_code: 0, metrics: [{ name: 'p95_ms', max: 250, better: 'lower' }] },
      outputs: [{ path: 'coverage/lcov.info', kind: 'other', required: false }],
    }])
  })

  test('闭集键、字符集、命令、路径、范围、指标与输入逐条 fail-loud', () => {
    rejects([{ ...MINIMAL, retries: 3 } as Partial<StepTestDef>], "附加键 'retries'")
    rejects([{ ...MINIMAL, id: 'unit test' }], "测试 id 'unit test' 含非法字符")
    rejects([{ ...MINIMAL, direction: 'unit/x' }], "测试 direction 'unit/x' 含非法字符")
    rejects([{ ...MINIMAL, command: '' }], '必须是 1–2000 字节的单行命令')
    rejects([{ ...MINIMAL, command: 'a\nb' }], '必须是 1–2000 字节的单行命令')
    rejects([{ ...MINIMAL, command: 'x'.repeat(2001) }], '必须是 1–2000 字节的单行命令')
    rejects([{ ...MINIMAL, cwd: '/abs' }], "路径 '/abs' 必须是仓库内相对路径")
    rejects([{ ...MINIMAL, cwd: '../up' }], "路径 '../up' 必须是仓库内相对路径")
    rejects([{ ...MINIMAL, timeout_s: 0 }], 'timeout_s 超出范围 1–14400')
    rejects([{ ...MINIMAL, keep_runs: 51 }], 'keep_runs 超出范围 1–50')
    rejects([{ ...MINIMAL, pass: { exit_code: 256 } }], 'exit_code 超出范围 0–255')
    rejects([{ ...MINIMAL, pass: { metrics: [{ name: 'p95' }] } }], "指标 'p95' 至少需要 max、min 或 max_regression_pct")
    rejects([{ ...MINIMAL, inputs: [{ kind: 'document', ref: 'nope' }] }], "输入文档类型 'nope' 不存在")
    rejects([{ ...MINIMAL, inputs: [{ kind: 'env', name: '1BAD' }] }], "输入 '1BAD' 非法")
    rejects([{ ...MINIMAL, inputs: [{ kind: 'service', name: 'db', url: 'localhost' }] }], "输入 'localhost' 非法")
    rejects([{ ...MINIMAL, scope: 'partial' } as Partial<StepTestDef>], 'scope 只支持 full | known')
    rejects([MINIMAL, MINIMAL], "测试 id 'unit' 在步骤内重复")
  })

  test('输出只接受排除目录段下的路径', () => {
    expect(compiledTests([{ ...MINIMAL, outputs: [{ path: 'frontend/test-results/x.xml' }] }])).toBeDefined()
    expect(compiledTests([{ ...MINIMAL, outputs: [{ path: 'playwright-report' }] }])).toBeDefined()
    rejects(
      [{ ...MINIMAL, outputs: [{ path: 'frontend/reports/x.xml' }] }],
      "输出 'frontend/reports/x.xml' 必须位于 test-results/、playwright-report/、coverage/ 目录下",
    )
    rejects([{ ...MINIMAL, metrics_path: 'bench.json' }], "输出 'bench.json' 必须位于")
  })
})
