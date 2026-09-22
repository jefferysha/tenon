import { describe, expect, test } from 'vitest'
import type { StepIR } from '@tenon/kernel'
import { mockState } from '../test-support.js'
import { stepFields } from './statusStepParts.js'

function step(over: Partial<StepIR> = {}): StepIR {
  return {
    id: 'build',
    label: '实现',
    gate: null,
    skills: [],
    inputs: [],
    outputs: [],
    artifacts: [],
    guards: [],
    transitions: [],
    ...over,
  } as StepIR
}

describe('stepFields —— 本步要填的槽', () => {
  test('声明的 output 与 step guard 字段都列出来', () => {
    const fields = stepFields(
      mockState({ build_sha: '' }),
      step({
        outputs: [{ field: 'build_sha', type: 'string' }],
        guards: [{ type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' }],
      }),
    )
    expect(fields.map((f) => f.field)).toEqual(['build_sha', 'pre_verify_review_result'])
  })

  /**
   * D12：default 轨真正卡住 build-complete 的 build_mode / isolation / direct_override 写在
   * flow/default-event-policy.ts 的事件政策表里，不在 step.guards 上。只读 step.guards 时它们
   * 一个都不出现在 step.fields，运行器只能从 `ERROR: build_mode 必须设置` 这行散文里猜字段名、
   * 猜枚举——枚举与推荐值 CLI 本来就有（STATIC_ENUMS / STATIC_RECOMMENDED）。
   */
  test('原生 guard 字段带着枚举与推荐值一起投影', () => {
    const fields = stepFields(
      mockState({ build_mode: '', isolation: '' }),
      step({ outputs: [{ field: 'build_sha', type: 'string' }] }),
      new Set(),
      [{ field: 'build_mode' }, { field: 'isolation' }],
    )
    const buildMode = fields.find((f) => f.field === 'build_mode')
    expect(buildMode).toMatchObject({
      kind: 'guard',
      writer: 'set',
      status: 'missing',
      allowed: ['direct', 'subagent-driven-development', 'parallel-team', 'prototype'],
      recommended: 'direct',
    })
    expect(fields.find((f) => f.field === 'isolation')).toMatchObject({
      allowed: ['branch', 'worktree', 'in-place'],
      recommended: 'in-place',
    })
  })

  /**
   * D12：`branch_status` 初值就是 `pending`，「有值」而非「缺值」。只按有没有值判定时它永远算
   * 已填，运行器收不到任何动作，只剩 `ERROR: verify-pass 要求 branch_status=handled` 那行散文。
   */
  test('有值但不是 guard 要的值 → 仍算待填，并列出被接受的值', () => {
    const fields = stepFields(
      mockState({ branch_status: 'pending' }),
      step({ id: 'verify' }),
      new Set(),
      [{ field: 'branch_status', required: ['handled'] }],
    )
    expect(fields[0]).toMatchObject({
      field: 'branch_status',
      status: 'missing',
      value: 'pending',
      required: ['handled'],
      recommended: 'handled',
    })
  })

  test('值已满足 guard 时不再算待填', () => {
    const fields = stepFields(
      mockState({ branch_status: 'handled' }),
      step({ id: 'verify' }),
      new Set(),
      [{ field: 'branch_status', required: ['handled'] }],
    )
    expect(fields[0]).toMatchObject({ status: 'set', value: 'handled' })
  })

  test('artifact 声明过的字段标成 artifact-register', () => {
    const fields = stepFields(
      mockState({ design_doc: 'null' }),
      step({ id: 'explore', outputs: [{ field: 'design_doc', type: 'file_path' }] }),
      new Set(['design_doc']),
    )
    expect(fields[0]).toMatchObject({ field: 'design_doc', writer: 'artifact-register', status: 'missing' })
  })

  /** D15：archived 由 archived 事件的副作用落值，投影不能把它标成运行器要 `tenon set` 的槽。 */
  test('转换管理的槽标成 transition，不标 set', () => {
    const fields = stepFields(
      mockState({ phase: 'archive', archived: '' }),
      step({ id: 'archive', outputs: [{ field: 'archived', type: 'boolean' }] }),
    )
    expect(fields[0]).toMatchObject({ field: 'archived', writer: 'transition' })
  })

  test('同一字段既是 output 又被原生 guard 点名时只出现一次', () => {
    const fields = stepFields(
      mockState({ verification_report: 'null' }),
      step({ id: 'verify', outputs: [{ field: 'verification_report', type: 'file_path' }] }),
      new Set(['verification_report']),
      [{ field: 'verification_report' }, { field: 'branch_status', required: ['handled'] }],
    )
    expect(fields.map((f) => f.field)).toEqual(['verification_report', 'branch_status'])
  })
})
