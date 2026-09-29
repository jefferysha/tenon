import { describe, expect, it } from 'vitest'
import { emitYaml, formatYamlScalar } from './yaml-emit.js'
import { YamlSubsetError, parseYamlSubset, type YamlNode } from './yaml-subset.js'

/** 节点树 → 普通值（便于断言）。 */
function plain(node: YamlNode): unknown {
  if (node.kind === 'scalar') return node.value
  if (node.kind === 'seq') return node.items.map(plain)
  return Object.fromEntries(node.entries.map((entry) => [entry.key, plain(entry.value)]))
}

function fails(text: string, line: number, message: RegExp): void {
  let caught: unknown
  try {
    parseYamlSubset(text)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(YamlSubsetError)
  expect((caught as YamlSubsetError).line).toBe(line)
  expect((caught as YamlSubsetError).message).toMatch(message)
}

describe('parseYamlSubset', () => {
  it('解析块式映射、序列、映射项、流式集合与标量类型', () => {
    const text = [
      '---',
      '# 注释',
      'schema: tenon-test-catalog/v1',
      'suites:',
      '  - id: web-unit   # 行尾注释',
      '    timeout_s: 900',
      '    ratio: 1.5',
      '    parallel: false',
      '    empty: null',
      "    files: [\"src/**/*.test.{ts,tsx}\", 'a''b']",
      '    report: { format: junit, path: test-results/x.xml, nested: { a: [1, 2] } }',
      '    url: http://127.0.0.1:5178/',
      '    list:',
      '    - one',
      '    - "two # not comment"',
      'services: []',
      'blank:',
    ].join('\n')
    expect(plain(parseYamlSubset(text))).toEqual({
      schema: 'tenon-test-catalog/v1',
      suites: [{
        id: 'web-unit',
        timeout_s: 900,
        ratio: 1.5,
        parallel: false,
        empty: null,
        files: ['src/**/*.test.{ts,tsx}', "a'b"],
        report: { format: 'junit', path: 'test-results/x.xml', nested: { a: [1, 2] } },
        url: 'http://127.0.0.1:5178/',
        list: ['one', 'two # not comment'],
      }],
      services: [],
      blank: null,
    })
  })

  it('节点带行号', () => {
    const root = parseYamlSubset('a: 1\nb:\n  - c: 2\n    d: 3\n')
    expect(root.kind).toBe('map')
    if (root.kind !== 'map') return
    const b = root.entries[1]
    expect(b?.line).toBe(2)
    const item = b?.value.kind === 'seq' ? b.value.items[0] : undefined
    expect(item?.kind === 'map' ? item.entries.map((entry) => entry.line) : []).toEqual([3, 4])
  })

  it('空文档是 null 标量', () => {
    expect(plain(parseYamlSubset('# only comment\n'))).toBeNull()
  })

  it('语法错误带行号', () => {
    fails('a: 1\n\tb: 2\n', 2, /tab/)
    fails('a: 1\na: 2\n', 2, /重复/)
    fails('a: [1, 2\n', 1, /未闭合/)
    fails('a: { b: 1\n', 1, /未闭合/)
    fails('a: |\n  x\n', 1, /多行块标量/)
    fails('a: &x 1\n', 1, /锚点/)
    fails('a: b: c\n', 1, /请加引号/)
    fails('a: "x\n', 1, /未闭合/)
    fails("a: 'x\n", 1, /未闭合/)
    fails('a: "x" y\n', 1, /多余内容/)
    fails('a: 1\n  b: 2\n', 2, /缩进/)
    fails('  a: 1\n', 1, /第 0 列/)
    fails('a:\n  - - x\n', 2, /嵌套/)
    fails('a: 1\n---\nb: 2\n', 2, /多文档/)
    fails('a: [x, , y]\n', 1, /空项/)
    fails('a: { b: [1], b: 2 }\n', 1, /重复/)
    fails('a: { b:1 }\n', 1, /冒号后/)
    fails('a: [x{y]\n', 1, /括号/)
    fails('a: "\\q"\n', 1, /非法转义/)
    fails('just text\nmore: 1\n', 1, /key: value/)
  })
})

describe('emitYaml', () => {
  it('写出的文本能被读回同一份数据，字符串按需加引号', () => {
    const value = {
      schema: 'tenon-test-plan/v1',
      change: 'add-login',
      numbers: [1, 2.5],
      flags: { yes: true, no: false, none: null },
      tricky: ['123', 'true', 'null', 'a: b', 'a #b', '- x', '2026-01-01', '', ' pad', 'e2e/a.spec.ts › 登录成功', '[x]', 'a,b'],
      items: [{ path: 'a.ts', suite: 'web' }, { path: 'b.ts' }],
      empty_list: [],
      empty_map: {},
      skipped: undefined,
    }
    const text = emitYaml(value)
    const { skipped: _skipped, ...expected } = value
    expect(plain(parseYamlSubset(text))).toEqual({ ...expected, empty_map: {} })
    expect(text).toContain('  - e2e/a.spec.ts › 登录成功\n')
    expect(text).toContain('  - "2026-01-01"\n')
    expect(emitYaml(value)).toBe(text)
  })

  it('非有限数字与非法键 fail-loud；序列直接嵌套序列不支持', () => {
    expect(() => formatYamlScalar(Number.NaN)).toThrow(/非有限/)
    expect(() => emitYaml({ 'bad key': 1 })).toThrow(/不能裸写/)
    expect(() => emitYaml({ a: [[1]] })).toThrow(/嵌套序列/)
  })
})
