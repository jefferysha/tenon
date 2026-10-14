import { describe, expect, test } from 'vitest'
import { fillPurpose, proposalPurpose } from './specPurpose.js'

describe('proposalPurpose', () => {
  const why = '现行文档机制在工作流里预先写死每一步的输入、输出文档，并规定「哪个技能必须交哪份文档」，与技能的实际行为脱节：'
  const proposal = (capabilityLine: string): string =>
    `# 提案\n\n## Why\n\n${why}\n\n- 第一条\n\n## Capabilities\n\n### New Capabilities\n\n- \`cap\`：${capabilityLine}\n`

  test('点名 capability 的说明够长：只用它', () => {
    const line = '运行时观察步骤产出与来源技能、直接上游交接、读取回执、按路径的必须产出守卫，并把直接上游的文档交给下一步且必须读完。'
    expect(line.length).toBeGreaterThanOrEqual(50)
    expect(proposalPurpose(proposal(line), 'cap')).toBe(line)
  })

  test('说明短于严格校验的 50 字符下限：补上 Why 第一段，结尾冒号收成句号', () => {
    const line = '运行时观察步骤产出与来源技能、直接上游交接、读取回执、按路径的必须产出守卫。'
    const purpose = proposalPurpose(proposal(line), 'cap')
    expect(purpose).toBe(`${line}\n\n${why.slice(0, -1)}。`)
    expect((purpose ?? '').length).toBeGreaterThanOrEqual(50)
  })

  test('没有点名该 capability：用 Why 第一段；没有 proposal：undefined', () => {
    expect(proposalPurpose(proposal('短说明'), 'other')).toBe(why)
    expect(proposalPurpose(null, 'cap')).toBeUndefined()
  })
})

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
