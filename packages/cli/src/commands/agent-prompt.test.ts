import { describe, expect, it } from 'vitest'
import type { FrozenAgent, TestRunRecordV1 } from '@tenon/kernel'
import { renderAgentPrompt } from './agent-prompt.js'

const frozen: FrozenAgent = {
  name: 'code-size',
  source: 'builtin',
  digest: `sha256:${'0'.repeat(64)}`,
  definition: {
    name: 'code-size',
    description: '代码规模评审',
    skills: ['a', 'b'],
    tools: ['Read', 'Grep'],
    model: 'sonnet',
    body: '\n# 正文\n\n方法\n',
  },
}

const testRun = (result: 'pass' | 'fail'): TestRunRecordV1 => ({
  outputs: [
    { path: 'reports/size.json', digest: null, present: true, artifact: null },
    { path: 'missing.json', digest: null, present: false, artifact: null },
  ],
  result,
  exit_code: result === 'pass' ? 0 : 3,
} as unknown as TestRunRecordV1)

describe('renderAgentPrompt', () => {
  it('评审者：头部固定行序，正文来自冻结定义，末尾给 tenon-result 形状', () => {
    const prompt = renderAgentPrompt({
      change: 'c',
      step: 'verify',
      role: 'reviewer',
      runId: '6f0c',
      candidate: `sha256:${'1'.repeat(64)}`,
      frozen,
      blockAt: 'medium',
      reportPath: 'openspec/changes/c/.pipeline-agent-reports/6f0c.md',
      stepPrompt: '按清单走',
      tests: [{ id: 'code-size', run: testRun('pass') }],
    })
    expect(prompt.split('\n').slice(0, 10)).toEqual([
      '<tenon-agent change="c" step="verify" role="reviewer" run="6f0c">',
      `候选：sha256:${'1'.repeat(64)}`,
      '技能：a, b',
      '工具：Read, Grep',
      '阻断：medium',
      '测试：',
      '- code-size 通过 exit=0 reports/size.json',
      '步骤说明：按清单走',
      '报告：openspec/changes/c/.pipeline-agent-reports/6f0c.md',
      '结束：tenon agent record c 6f0c',
    ])
    expect(prompt).toContain('# 正文')
    expect(prompt).toContain('"findings"')
    expect(prompt).not.toContain('"result"')
  })

  it('执行者：结果形状含 result；缺省字段整行不出现', () => {
    const prompt = renderAgentPrompt({
      change: 'c',
      step: 'build',
      role: 'executor',
      runId: 'r1',
      candidate: `sha256:${'2'.repeat(64)}`,
      frozen: { ...frozen, definition: { ...frozen.definition, skills: [], tools: [] } },
      reportPath: 'r.md',
      tests: [],
    })
    expect(prompt).not.toContain('技能：')
    expect(prompt).not.toContain('工具：')
    expect(prompt).not.toContain('阻断：')
    expect(prompt).not.toContain('测试：')
    expect(prompt).not.toContain('步骤说明：')
    expect(prompt).toContain('"result":"done|failed"')
  })

  it('未运行与未通过的测试各自成行', () => {
    const lines = renderAgentPrompt({
      change: 'c',
      step: 'verify',
      role: 'reviewer',
      runId: 'r1',
      candidate: `sha256:${'3'.repeat(64)}`,
      frozen,
      reportPath: 'r.md',
      tests: [{ id: 'a', run: undefined }, { id: 'b', run: testRun('fail') }],
    }).split('\n')
    expect(lines).toContain('- a 未运行')
    expect(lines).toContain('- b 未通过 exit=3 reports/size.json')
  })
})
