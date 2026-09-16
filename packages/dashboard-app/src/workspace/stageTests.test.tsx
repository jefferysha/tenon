import { describe, expect, it } from 'vitest'
import type { ChangeSnapshot, TestStepSnapshot } from '../types'
import { stageTestCount, stageTestRows, testStatusWord } from './stageTests'

const RUN = {
  runId: '20260915T101530Z-ab12cd',
  user: 'a-at-x.io',
  actor: { id: 'a@x.io', name: 'A' },
  result: 'pass' as const,
  exitCode: 0,
  durationMs: 12_300,
  finishedAt: '2026-09-15T10:15:30Z',
  reasons: [],
}

function change(tests?: TestStepSnapshot[]): ChangeSnapshot {
  return {
    name: 'demo', path: '/demo', phase: 'build', phase_status: 'in_progress', track: 'backend',
    preset: 'full', archived: 'false', updated_at: '2026-09-15T10:00:00Z', fields: {},
    owner: null, creator: null, workflowPlanFingerprint: 'a'.repeat(64),
    workflowRules: {
      executionModel: 'step-graph', steps: ['build'], transitions: {}, gateByStep: { build: null },
      labelByStep: { build: '实现' }, outputsByStep: { build: [] },
    },
    workflowExecution: { readinessByTransition: {} },
    ...(tests === undefined ? {} : { tests }),
  }
}

describe('stageTestRows', () => {
  it('取当前步骤的行；名称用 label，缺 label 用 id；没有投影时为空', () => {
    const rows = stageTestRows(change([{
      stepId: 'build',
      items: [
        { id: 'unit', label: '单测', direction: 'unit', required: true, status: 'passed', run: RUN },
        { id: 'bad', direction: 'unit', required: false, status: 'missing' },
      ],
    }]), 'build')
    expect(rows.map((row) => [row.id, row.name, row.status, row.required]))
      .toEqual([['unit', '单测', 'passed', true], ['bad', 'bad', 'missing', false]])
    expect(rows[0]?.durationMs).toBe(12_300)
    expect(rows[0]?.actorName).toBe('A')
    expect(rows[1]?.run).toBeUndefined()

    expect(stageTestRows(change(), 'build')).toEqual([])
    expect(stageTestRows(change([{ stepId: 'verify', items: [] }]), 'build')).toEqual([])
  })

  it('计数是 通过/总数；状态词走 i18n key', () => {
    const rows = stageTestRows(change([{
      stepId: 'build',
      items: [
        { id: 'a', direction: 'unit', required: true, status: 'passed', run: RUN },
        { id: 'b', direction: 'unit', required: true, status: 'failed' },
        { id: 'c', direction: 'unit', required: true, status: 'stale' },
      ],
    }]), 'build')
    expect(stageTestCount(rows)).toBe('1/3')
    expect(testStatusWord('running', (key) => key)).toBe('workspace.test_status_running')
  })
})
