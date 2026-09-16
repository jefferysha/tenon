import { describe, expect, it } from 'vitest'
import { lineDiff } from './lineDiff'

describe('lineDiff', () => {
  it('相同内容全部是 eq；空输入为空', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual([{ op: 'eq', text: 'a' }, { op: 'eq', text: 'b' }])
    expect(lineDiff('', '')).toEqual([])
  })

  it('新建文件全部是 add，删除文件全部是 del', () => {
    expect(lineDiff('', 'x\ny\n')).toEqual([{ op: 'add', text: 'x' }, { op: 'add', text: 'y' }])
    expect(lineDiff('x\n', '')).toEqual([{ op: 'del', text: 'x' }])
  })

  it('保留公共前后缀，中间段按 LCS 给出删除与新增', () => {
    expect(lineDiff('# 规则\n- 一\n- 二\n- 三\n<!-- end -->\n', '# 规则\n- 一\n- 二点五\n- 三\n- 四\n<!-- end -->\n')).toEqual([
      { op: 'eq', text: '# 规则' },
      { op: 'eq', text: '- 一' },
      { op: 'del', text: '- 二' },
      { op: 'add', text: '- 二点五' },
      { op: 'eq', text: '- 三' },
      { op: 'add', text: '- 四' },
      { op: 'eq', text: '<!-- end -->' },
    ])
  })

  it('CRLF 与 LF 视为同一行', () => {
    expect(lineDiff('a\r\nb\r\n', 'a\nb\n').every((entry) => entry.op === 'eq')).toBe(true)
  })

  it('中间段超过 4000 × 4000 行时退化为整段删除 + 整段新增', () => {
    const before = Array.from({ length: 4001 }, (_, index) => `old ${index}`).join('\n')
    const after = Array.from({ length: 4001 }, (_, index) => `new ${index}`).join('\n')
    const rows = lineDiff(before, after)
    expect(rows).toHaveLength(8002)
    expect(rows.slice(0, 4001).every((entry) => entry.op === 'del')).toBe(true)
    expect(rows.slice(4001).every((entry) => entry.op === 'add')).toBe(true)
  })
})
