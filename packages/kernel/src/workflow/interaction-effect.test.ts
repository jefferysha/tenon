import { describe, expect, it } from 'vitest'
import { classifyInteractionWorkflowIdentity } from './interaction-effect.js'

describe('classifyInteractionWorkflowIdentity · 轨道种类', () => {
  const kindOf = (track: string): string => classifyInteractionWorkflowIdentity({ workflow: 'default', track, step: 'build' }).trackKind

  it('default 内建的四条轨道（含轻量 lite）都是 built-in', () => {
    for (const track of ['lite', 'pm', 'frontend', 'backend']) expect(kindOf(track), track).toBe('built-in')
  })

  it('升级前在途任务记着的退役轨道仍按 built-in 归类；free 单独一类；其余是 custom', () => {
    for (const track of ['chat', 'simple', 'standard']) expect(kindOf(track), track).toBe('built-in')
    expect(kindOf('free')).toBe('free')
    expect(kindOf('designer-mobile')).toBe('custom')
  })

  it('阶段：七阶段之外（lite 的 done / escalated）归为 custom', () => {
    const stage = (step: string): string => classifyInteractionWorkflowIdentity({ workflow: 'default', track: 'lite', step }).pipelineStage
    expect(stage('build')).toBe('build')
    expect(stage('done')).toBe('custom')
    expect(stage('escalated')).toBe('custom')
  })
})
