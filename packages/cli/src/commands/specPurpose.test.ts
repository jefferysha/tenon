import { describe, expect, test } from 'vitest'
import { fillPurpose } from './specPurpose.js'

const TBD = 'TBD - created by archiving change demo. Update Purpose after archive.'

describe('fillPurpose', () => {
  /** 真机（第三轮）：上游归档重排主规格时吃掉了空行，Purpose 段落紧贴 `## Requirements`。 */
  test('Purpose 段与下一个标题之间补回空行', () => {
    const upstream = `# cap Specification\n\n## Purpose\n${TBD}\n## Requirements\n### Requirement: X\n`
    expect(fillPurpose(upstream, 'Real purpose.'))
      .toBe('# cap Specification\n\n## Purpose\nReal purpose.\n\n## Requirements\n### Requirement: X\n')
  })

  test('已有空行、CRLF 与文件末尾的占位都不多加空行', () => {
    expect(fillPurpose(`## Purpose\n${TBD}\n\n## Requirements\n`, 'P.')).toBe('## Purpose\nP.\n\n## Requirements\n')
    expect(fillPurpose(`## Purpose\r\n${TBD}\r\n## Requirements\r\n`, 'P.'))
      .toBe('## Purpose\r\nP.\r\n\r\n## Requirements\r\n')
    expect(fillPurpose(`## Purpose\n${TBD}`, 'P.')).toBe('## Purpose\nP.')
  })

  test('没有占位原样返回；有占位但给不出 Purpose 返回 undefined', () => {
    expect(fillPurpose('## Purpose\nOwn.\n', 'P.')).toBe('## Purpose\nOwn.\n')
    expect(fillPurpose(`## Purpose\n${TBD}\n`, undefined)).toBeUndefined()
  })
})
