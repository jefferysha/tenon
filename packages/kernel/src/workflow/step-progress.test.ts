import { describe, expect, test } from 'vitest'
import { DEFAULT_WORKFLOW_TODO_STAGES } from './todo-projection.js'
import { stepProgressLine } from './step-progress.js'

describe('stepProgressLine —— 终端一行步骤清单', () => {
  test('默认七步停在规格：之前 ✓、当前 ●、之后 ○', () => {
    expect(stepProgressLine(DEFAULT_WORKFLOW_TODO_STAGES, 'spec', false)).toBe(
      '立项 ✓ → 调研 ✓ → 规格 ● → 实现 ○ → 验证 ○ → 交付 ○ → 完结 ○',
    )
  })

  test('自定义三步工作流：标签取步骤 label', () => {
    const steps = [
      { id: 'shape', label: 'shape' },
      { id: 'implement', label: 'implement' },
      { id: 'verify', label: 'verify' },
    ]
    expect(stepProgressLine(steps, 'implement', false)).toBe('shape ✓ → implement ● → verify ○')
  })

  test('标签与 id 不同时用 label，不用 id', () => {
    const steps = [{ id: 'a', label: '起草' }, { id: 'b', label: '完成' }]
    expect(stepProgressLine(steps, 'a', false)).toBe('起草 ● → 完成 ○')
  })

  test('当前在第一步：没有 ✓；当前在最后一步：前面全 ✓', () => {
    const steps = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]
    expect(stepProgressLine(steps, 'a', false)).toBe('A ● → B ○ → C ○')
    expect(stepProgressLine(steps, 'c', false)).toBe('A ✓ → B ✓ → C ●')
  })

  test('已归档：全部 ✓，即使 current 仍指向某一步', () => {
    const steps = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    expect(stepProgressLine(steps, 'a', true)).toBe('A ✓ → B ✓')
    expect(stepProgressLine(steps, '', true)).toBe('A ✓ → B ✓')
  })

  test('current 不在步骤里：全部 ○', () => {
    const steps = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    expect(stepProgressLine(steps, 'unknown', false)).toBe('A ○ → B ○')
    expect(stepProgressLine(steps, '', false)).toBe('A ○ → B ○')
  })

  test('单步工作流', () => {
    expect(stepProgressLine([{ id: 'change', label: '修改' }], 'change', false)).toBe('修改 ●')
  })

  test('空步骤列表返回空串', () => {
    expect(stepProgressLine([], 'a', false)).toBe('')
  })
})
