import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { parseTestDirection, serializeTestDirection, testFromDirection } from './direction.js'

const TEMPLATES = fileURLToPath(new URL('../../../../templates/test-directions', import.meta.url))

describe('测试方向文件', () => {
  test('内建方向逐个解析成功、id 等于文件名主干、序列化往返保真', async () => {
    const names = (await readdir(TEMPLATES)).filter((name) => name.endsWith('.yaml')).sort()
    expect(names).toEqual([
      'benchmark.yaml', 'code-size.yaml', 'e2e.yaml', 'integration.yaml', 'playwright.yaml',
      'regression.yaml', 'typecheck.yaml', 'unit.yaml',
    ])
    for (const name of names) {
      const content = await readFile(join(TEMPLATES, name), 'utf8')
      const direction = parseTestDirection(content)
      expect(direction.id).toBe(basename(name, '.yaml'))
      expect(direction.label).not.toBe('')
      expect(parseTestDirection(serializeTestDirection(direction))).toEqual(direction)
    }
  })

  test('基准方向带指标文件与必需输出；code-size 带指标阈值', async () => {
    const benchmark = parseTestDirection(await readFile(join(TEMPLATES, 'benchmark.yaml'), 'utf8'))
    expect(benchmark.metrics_path).toBe('test-results/benchmark.json')
    expect(benchmark.outputs).toEqual([{ path: 'test-results/benchmark.json', kind: 'metrics', required: true }])
    const codeSize = parseTestDirection(await readFile(join(TEMPLATES, 'code-size.yaml'), 'utf8'))
    expect(codeSize.pass?.metrics).toEqual([{ name: 'lines_added', max: 2000 }])
  })

  test('testFromDirection 抄进步骤、必需为真、id 冲突追加后缀', () => {
    const direction = parseTestDirection('id: unit\ncommand: npm test\nlabel: 单测\ntimeout_s: 900\n')
    expect(testFromDirection(direction, new Set())).toEqual({
      id: 'unit', direction: 'unit', command: 'npm test', label: '单测', timeout_s: 900, required: true,
    })
    expect(testFromDirection(direction, new Set(['unit'])).id).toBe('unit-2')
    expect(testFromDirection(direction, new Set(['unit', 'unit-2'])).id).toBe('unit-3')
  })

  test('缺 id / 缺 label / 缺 command / 越界值 / 步骤专属键 fail-loud', () => {
    expect(() => parseTestDirection('command: npm test\nlabel: x\n')).toThrow('必须恰好有一行顶层 id')
    expect(() => parseTestDirection('id: unit\ncommand: npm test\n')).toThrow("方向 'unit' 缺 label")
    expect(() => parseTestDirection('id: unit\nlabel: x\n')).toThrow("测试 'unit' 缺 command")
    expect(() => parseTestDirection('id: unit\nlabel: x\ncommand: npm test\nrequired: true\n'))
      .toThrow('不接受 required / keep_runs')
    expect(() => parseTestDirection('id: unit\nlabel: x\ncommand: npm test\ntimeout_s: 0\n'))
      .toThrow('timeout_s 超出范围 1–14400')
    expect(() => parseTestDirection('id: unit\nlabel: x\ncommand: npm test\noutputs:\n  - path: reports/x.xml\n'))
      .toThrow('必须位于 test-results/、playwright-report/、coverage/ 目录下')
  })
})
