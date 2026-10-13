import { describe, expect, test } from 'vitest'
import {
  attributeSkill,
  handoffInputs,
  isDocumentPath,
  isInputRead,
  matchesOutputPattern,
  staticPatternDirectory,
  validateOutputPattern,
} from './step-outputs-model.js'
import type { StepOutputLedger } from '../state/step-output-ledger.js'

describe('attributeSkill', () => {
  const loads = [
    { skill: 'tenon', at: '2026-10-12T00:00:00Z' },
    { skill: 'brainstorming', at: '2026-10-12T00:01:00Z' },
    { skill: 'domain-modeling', at: '2026-10-12T00:05:00Z' },
  ]
  test('取修改时间之前最后加载的技能，编排技能 tenon 不算', () => {
    expect(attributeSkill(Date.parse('2026-10-12T00:03:00Z'), loads)).toBe('brainstorming')
    expect(attributeSkill(Date.parse('2026-10-12T00:06:00Z'), loads)).toBe('domain-modeling')
    expect(attributeSkill(Date.parse('2026-10-12T00:00:30Z'), loads)).toBeNull()
  })
  test('按秒比较：同一秒内写出的文件归给这一秒加载的技能', () => {
    expect(attributeSkill(Date.parse('2026-10-12T00:05:00.700Z'), loads)).toBe('domain-modeling')
  })
  test('带命名空间的编排技能也不算；没有加载记录或时间无法解析时记未知', () => {
    expect(attributeSkill(Date.parse('2026-10-12T00:06:00Z'), [{ skill: 'tenon:tenon', at: '2026-10-12T00:01:00Z' }])).toBeNull()
    expect(attributeSkill(Date.parse('2026-10-12T00:06:00Z'), [])).toBeNull()
    expect(attributeSkill(Date.parse('2026-10-12T00:06:00Z'), [{ skill: 'x', at: 'not-a-time' }])).toBeNull()
  })
  test('文件修改时间读不到（NaN）时不猜来源', () => {
    expect(attributeSkill(Number.NaN, loads)).toBeNull()
  })
  test('同一秒加载了两个技能时取靠后的那个', () => {
    const sameSecond = [
      { skill: 'first', at: '2026-10-12T00:01:00Z' },
      { skill: 'second', at: '2026-10-12T00:01:00Z' },
    ]
    expect(attributeSkill(Date.parse('2026-10-12T00:02:00Z'), sameSecond)).toBe('second')
  })
})

describe('isDocumentPath', () => {
  test.each([['a/b.md', true], ['x.MDX', true], ['y.markdown', true], ['z.ts', false], ['test-plan.yaml', false]])('%s', (p, v) => {
    expect(isDocumentPath(p)).toBe(v)
  })
})

const visit = (sequence: number, step: string, outputs: StepOutputLedger['visits'][number]['outputs'], runId = 'r') => ({
  run_id: runId, sequence, step, entered_at: '2026-10-12T00:00:00Z', checkpoint: null,
  exit: { event: 'e', to: 'next', at: '2026-10-12T00:00:00Z', observation: 'observed' as const }, outputs, reads: [],
})

describe('handoffInputs', () => {
  const ledger: StepOutputLedger = {
    version: 1,
    visits: [
      visit(0, 'open', [{ path: 'openspec/changes/c/proposal.md', change: 'added', sha256: 'p0', skill: 'openspec-propose' }]),
      visit(1, 'explore', [
        { path: 'docs/superpowers/specs/c-design.md', change: 'added', sha256: 'd1', skill: 'brainstorming' },
        { path: 'src/a.ts', change: 'modified', sha256: 'a1', skill: null },
        { path: 'old.md', change: 'deleted', sha256: null, skill: null },
      ]),
    ],
  }
  test('只取直接上游、只取文档、不取删除', () => {
    expect(handoffInputs(ledger, 'r', 2)).toEqual([
      { path: 'docs/superpowers/specs/c-design.md', sha256: 'd1', fromStep: 'explore', skill: 'brainstorming' },
    ])
  })
  test('第一次访问没有输入', () => {
    expect(handoffInputs(ledger, 'r', 0)).toEqual([])
  })
  test('更早的访问不交接：第三次访问只看第二次的产出，不再带上第一次的提案', () => {
    expect(handoffInputs(ledger, 'r', 2).map((input) => input.path)).not.toContain('openspec/changes/c/proposal.md')
  })
  test('别的 run 的访问不算上游', () => {
    expect(handoffInputs(ledger, 'other-run', 2)).toEqual([])
  })
  test('上游没有记录时没有输入', () => {
    expect(handoffInputs(ledger, 'r', 9)).toEqual([])
  })
})

describe('isInputRead', () => {
  const input = { path: 'a.md', sha256: 'up', fromStep: 'explore', skill: null }
  test('回执等于上游摘要或当前摘要都算读过', () => {
    expect(isInputRead(input, [{ path: 'a.md', sha256: 'up', read_at: 't' }], 'changed')).toBe(true)
    expect(isInputRead(input, [{ path: 'a.md', sha256: 'cur', read_at: 't' }], 'cur')).toBe(true)
    expect(isInputRead(input, [{ path: 'a.md', sha256: 'old', read_at: 't' }], 'cur')).toBe(false)
    expect(isInputRead(input, [], 'up')).toBe(false)
  })
  test('别的文件的回执不算；文件已不存在（当前摘要为空）时只认上游摘要', () => {
    expect(isInputRead(input, [{ path: 'b.md', sha256: 'up', read_at: 't' }], 'up')).toBe(false)
    expect(isInputRead(input, [{ path: 'a.md', sha256: 'up', read_at: 't' }], null)).toBe(true)
    expect(isInputRead(input, [{ path: 'a.md', sha256: 'old', read_at: 't' }], null)).toBe(false)
  })
})

describe('output patterns', () => {
  test('占位与通配', () => {
    expect(matchesOutputPattern('openspec/changes/{change}/proposal.md', 'c', 'openspec/changes/c/proposal.md')).toBe(true)
    expect(matchesOutputPattern('docs/superpowers/specs/*.md', 'c', 'docs/superpowers/specs/x-design.md')).toBe(true)
    expect(matchesOutputPattern('docs/superpowers/specs/*.md', 'c', 'docs/superpowers/specs/sub/x.md')).toBe(false)
    expect(matchesOutputPattern('openspec/changes/{change}/specs/*/spec.md', 'c', 'openspec/changes/c/specs/cap/spec.md')).toBe(true)
    expect(matchesOutputPattern('specs/**/spec.md', 'c', 'specs/001-a/spec.md')).toBe(true)
    expect(matchesOutputPattern('specs/**/spec.md', 'c', 'specs/spec.md')).toBe(true)
    expect(matchesOutputPattern('docs/r?.md', 'c', 'docs/r1.md')).toBe(true)
  })
  test('通配符不跨目录，问号只匹配一个字符，不带通配符的模式要全等', () => {
    expect(matchesOutputPattern('docs/r?.md', 'c', 'docs/r12.md')).toBe(false)
    expect(matchesOutputPattern('docs/r?.md', 'c', 'docs/r/.md')).toBe(false)
    expect(matchesOutputPattern('*.md', 'c', 'docs/a.md')).toBe(false)
    expect(matchesOutputPattern('DESIGN.md', 'c', 'DESIGN.md')).toBe(true)
    expect(matchesOutputPattern('DESIGN.md', 'c', 'docs/DESIGN.md')).toBe(false)
    expect(matchesOutputPattern('docs/*-design.md', 'c', 'docs/x-design.md')).toBe(true)
    expect(matchesOutputPattern('docs/*-design.md', 'c', 'docs/x-design.md.bak')).toBe(false)
  })
  test('双星可以在开头、结尾，也可以匹配多层', () => {
    expect(matchesOutputPattern('**/spec.md', 'c', 'spec.md')).toBe(true)
    expect(matchesOutputPattern('**/spec.md', 'c', 'a/b/spec.md')).toBe(true)
    expect(matchesOutputPattern('docs/**', 'c', 'docs/a/b.md')).toBe(true)
    expect(matchesOutputPattern('docs/**', 'c', 'other/a.md')).toBe(false)
  })
  test('任务名里的通配符字符按字面匹配，不会变成通配', () => {
    expect(matchesOutputPattern('docs/{change}.md', 'a*b', 'docs/a*b.md')).toBe(true)
    expect(matchesOutputPattern('docs/{change}.md', 'a*b', 'docs/axyb.md')).toBe(false)
    expect(matchesOutputPattern('docs/{change}.md', 'a.b', 'docs/aXb.md')).toBe(false)
  })
  test('病态模式也在有限时间内返回（不做回溯匹配）', () => {
    const pattern = 'a/**/**/**/**/**/**/**/**/**/**/**/**/**/**/**/b'
    const path = `a/${'x/'.repeat(300)}c`
    const started = Date.now()
    expect(matchesOutputPattern(pattern, 'c', path)).toBe(false)
    expect(matchesOutputPattern('*a*a*a*a*a*a*a*a*a*b', 'c', 'a'.repeat(200))).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  test('非法模式', () => {
    expect(validateOutputPattern('')).not.toBeNull()
    expect(validateOutputPattern('/etc/passwd')).not.toBeNull()
    expect(validateOutputPattern('docs/../x.md')).not.toBeNull()
    expect(validateOutputPattern('docs/{name}.md')).not.toBeNull()
    expect(validateOutputPattern('docs/{change}-design.md')).toBeNull()
  })
  test('非法模式：盘符、反斜杠、空段与当前目录段、控制字符、段内双星', () => {
    expect(validateOutputPattern('C:/x.md')).not.toBeNull()
    expect(validateOutputPattern('docs\\x.md')).not.toBeNull()
    expect(validateOutputPattern('docs//x.md')).not.toBeNull()
    expect(validateOutputPattern('docs/./x.md')).not.toBeNull()
    expect(validateOutputPattern('docs/x\n.md')).not.toBeNull()
    expect(validateOutputPattern('docs/**.md')).not.toBeNull()
    expect(validateOutputPattern('docs/**/x.md')).toBeNull()
  })
})

describe('staticPatternDirectory', () => {
  test('取模式里第一个带通配符的段之前的目录；没有通配符时是整条路径', () => {
    expect(staticPatternDirectory('docs/superpowers/specs/*.md', 'c')).toEqual({ directory: 'docs/superpowers/specs', exact: false })
    expect(staticPatternDirectory('specs/**/spec.md', 'c')).toEqual({ directory: 'specs', exact: false })
    expect(staticPatternDirectory('openspec/changes/{change}/specs/*/spec.md', 'c')).toEqual({ directory: 'openspec/changes/c/specs', exact: false })
    expect(staticPatternDirectory('DESIGN.md', 'c')).toEqual({ directory: 'DESIGN.md', exact: true })
    expect(staticPatternDirectory('*.md', 'c')).toEqual({ directory: '', exact: false })
  })
})
