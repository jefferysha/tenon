import { describe, expect, test } from 'vitest'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import type { StepTestDef, WorkflowDef } from './types.js'

function workflow(testsBlock: string): string {
  return [
    'name: tested',
    'steps:',
    '  - id: build',
    '    label: 实现',
    '    gate: null',
    '    skills: []',
    '    inputs: []',
    '    outputs: []',
    testsBlock,
    '    guards: []',
    '    transitions: []',
    '',
  ].join('\n')
}

function testsOf(yaml: string): readonly StepTestDef[] | undefined {
  return parseWorkflow(yaml).steps[0]?.tests
}

describe('parseStepTests', () => {
  test('完整测试项逐键解析成定义层形状', () => {
    const yaml = workflow([
      '    tests:',
      '      - id: unit',
      '        direction: unit',
      '        command: pnpm -C frontend test',
      '        cwd: .',
      '        label: 单测',
      '        timeout_s: 900',
      '        required: true',
      '        keep_runs: 5',
      '        scope: full',
      '        metrics_path: frontend/test-results/bench.json',
      '        pass:',
      '          exit_code: 0',
      '          metrics:',
      '            - name: p95_ms',
      '              max: 250',
      '              max_regression_pct: 10',
      '              better: lower',
      '        inputs:',
      '          - kind: document',
      '            ref: delta-spec',
      '          - kind: file',
      '            path: frontend/fixtures',
      '          - kind: env',
      '            name: DATABASE_URL',
      '          - kind: service',
      '            name: postgres',
      '            url: postgres://localhost:5432',
      '        outputs:',
      '          - path: frontend/test-results/junit.xml',
      '            kind: report',
      '            required: true',
    ].join('\n'))
    expect(testsOf(yaml)).toEqual([{
      id: 'unit',
      direction: 'unit',
      command: 'pnpm -C frontend test',
      cwd: '.',
      label: '单测',
      timeout_s: 900,
      required: true,
      keep_runs: 5,
      scope: 'full',
      metrics_path: 'frontend/test-results/bench.json',
      pass: { exit_code: 0, metrics: [{ name: 'p95_ms', max: 250, max_regression_pct: 10, better: 'lower' }] },
      inputs: [
        { kind: 'document', ref: 'delta-spec' },
        { kind: 'file', path: 'frontend/fixtures' },
        { kind: 'env', name: 'DATABASE_URL' },
        { kind: 'service', name: 'postgres', url: 'postgres://localhost:5432' },
      ],
      outputs: [{ path: 'frontend/test-results/junit.xml', kind: 'report', required: true }],
    }])
  })

  test('含冒号、井号与单引号的命令经单引号标量往返', () => {
    const command = "npm run test -- --grep: 'a # b'"
    const wf: WorkflowDef = {
      name: 'quoted',
      steps: [{
        id: 'build', label: '', gate: null, skills: [], inputs: [], outputs: [],
        tests: [{ id: 'unit', direction: 'unit', command }],
        guards: [], transitions: [],
      }],
    }
    const yaml = serializeWorkflow(wf)
    expect(yaml).toContain("command: 'npm run test -- --grep: ''a # b'''")
    expect(parseWorkflow(yaml)).toEqual(wf)
  })

  test('tests: [] 与缺省是两种保留状态', () => {
    expect(testsOf(workflow('    tests: []'))).toEqual([])
    expect(testsOf(workflow('    guards: []'))).toBeUndefined()
  })

  test('未知字段行 fail-loud', () => {
    const yaml = workflow([
      '    tests:',
      '      - id: unit',
      '        direction: unit',
      '        command: npm test',
      '        retries: 3',
    ].join('\n'))
    expect(() => parseWorkflow(yaml)).toThrow('出现未知字段行')
  })

  test('同一项重复键、缺 command、未知输入类型 fail-loud', () => {
    const duplicate = workflow([
      '    tests:',
      '      - id: unit',
      '        direction: unit',
      '        command: npm test',
      '        command: npm run other',
    ].join('\n'))
    expect(() => parseWorkflow(duplicate)).toThrow("测试 'unit' 重复声明 command")

    const missing = workflow(['    tests:', '      - id: unit', '        direction: unit'].join('\n'))
    expect(() => parseWorkflow(missing)).toThrow("测试 'unit' 缺 command")

    const badInput = workflow([
      '    tests:',
      '      - id: unit',
      '        direction: unit',
      '        command: npm test',
      '        inputs:',
      '          - kind: secret',
      '            name: TOKEN',
    ].join('\n'))
    expect(() => parseWorkflow(badInput)).toThrow("未知测试输入类型 'secret'")
  })

  test('非法数字与布尔字面量 fail-loud', () => {
    const badTimeout = workflow([
      '    tests:', '      - id: unit', '        direction: unit', '        command: npm test',
      '        timeout_s: soon',
    ].join('\n'))
    expect(() => parseWorkflow(badTimeout)).toThrow('必须是数字')

    const badRequired = workflow([
      '    tests:', '      - id: unit', '        direction: unit', '        command: npm test',
      '        required: yes',
    ].join('\n'))
    expect(() => parseWorkflow(badRequired)).toThrow('必须是 true 或 false')
  })
})
