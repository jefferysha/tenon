import { describe, expect, test } from 'vitest'
import type { StepTestIR } from '../workflow/ir.js'
import { renderTestsRegion, replaceTestsRegion, TESTS_REGION_END, TESTS_REGION_START, type TestsRegionItem } from './report.js'
import { TEST_RUN_SCHEMA, type TestRunRecordV1 } from './types.js'

const CANDIDATE = `workspace:sha256:${'ab12'}${'c'.repeat(60)}`
const ACTOR = { id: 'a@x.io', name: 'A', trust: 'declared' } as const

function test_(id: string): StepTestIR {
  return {
    id, direction: id, command: `npm run ${id}`, cwd: '.', label: id === 'unit' ? '单测' : undefined,
    timeout_s: 900, required: true, keep_runs: 5, pass: { exit_code: 0, metrics: [] }, inputs: [], outputs: [],
  } as StepTestIR
}

function run(id: string, overrides: Partial<TestRunRecordV1> = {}): TestRunRecordV1 {
  return {
    schema: TEST_RUN_SCHEMA, run_id: '20260915T101530Z-ab12cd', change: 'c', workflow_run_id: 'run-1',
    workflow: 'demo', workflow_fingerprint: 'b'.repeat(64), track: '', step: 'build',
    step_visit: { run_id: 'run-1', transition_sequence: 1 }, test_id: id, test_digest: `sha256:${'c'.repeat(64)}`,
    direction: id, command: `npm run ${id}`, cwd: '.', timeout_s: 900, required: true, actor: ACTOR,
    host: { kind: 'terminal', sandbox: null }, candidate_before: CANDIDATE, candidate: CANDIDATE,
    git_head: null, build_sha: null, started_at: '2026-09-15T10:15:18Z', finished_at: '2026-09-15T10:15:30Z',
    duration_ms: 12_300, exit_code: 0, signal: null, result: 'pass', reasons: [], inputs: [], outputs: [],
    metrics: [], log: { artifact: 'output.log', bytes_total: 1, bytes_kept: 1, truncated: false, digest: `sha256:${'f'.repeat(64)}` },
    ...overrides,
  }
}

const items: readonly TestsRegionItem[] = [
  { stepId: 'build', stepLabel: '实现', test: test_('unit'), status: 'passed', run: run('unit') },
  {
    stepId: 'verify', stepLabel: '验证', test: test_('e2e'), status: 'failed',
    run: run('e2e', { result: 'fail', exit_code: 1, reasons: [{ code: 'exit-code' }, { code: 'sandbox-denied' }] }),
  },
  { stepId: 'verify', stepLabel: '验证', test: test_('bench'), status: 'missing' },
]

describe('验证报告测试段', () => {
  test('中文表头、状态词、失败与命令小节', () => {
    const region = renderTestsRegion({ changeName: 'c', locale: 'zh-CN', items })
    expect(region.startsWith(`${TESTS_REGION_START} digest=sha256:`)).toBe(true)
    expect(region.endsWith(TESTS_REGION_END)).toBe(true)
    expect(region).toContain('| 阶段 | 测试 | 方向 | 状态 | 退出码 | 耗时 | 执行人 | 时间 | 候选 |')
    expect(region).toContain('| 实现 | 单测 `unit` | unit | 通过 | 0 | 12.3s | A | 2026-09-15T10:15:30Z |')
    expect(region).toContain('| 验证 | bench `bench` | bench | 未运行 | — | — | — | — | — |')
    expect(region).toContain('### 失败')
    expect(region).toContain('- `e2e`：exit-code, sandbox-denied — `.tenon/users/a-at-x.io/tests/c/20260915T101530Z-ab12cd.json`')
    expect(region).toContain('### 命令')
    expect(region).toContain('- `unit`：`npm run unit`（cwd `.`）')
  })

  test('英文表头', () => {
    const region = renderTestsRegion({ changeName: 'c', locale: 'en', items })
    expect(region).toContain('| Step | Test | Direction | Status | Exit | Duration | Actor | Time | Candidate |')
    expect(region).toContain('### Failures')
    expect(region).toContain('### Commands')
  })

  test('无标记时追加一节；替换幂等', () => {
    const region = renderTestsRegion({ changeName: 'c', locale: 'zh-CN', items })
    const appended = replaceTestsRegion('# 验证报告\n\n结论：通过\n', region, 'zh-CN')
    expect(appended).toContain('## 测试')
    expect(replaceTestsRegion(appended, region, 'zh-CN')).toBe(appended)

    const changed = renderTestsRegion({ changeName: 'c', locale: 'zh-CN', items: items.slice(0, 1) })
    const replaced = replaceTestsRegion(appended, changed, 'zh-CN')
    expect(replaced).not.toContain('`e2e`')
    expect(replaced.split(TESTS_REGION_START)).toHaveLength(2)
    expect(replaceTestsRegion(replaced, changed, 'zh-CN')).toBe(replaced)
  })
})
