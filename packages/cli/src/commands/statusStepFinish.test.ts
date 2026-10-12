import { describe, expect, test } from 'vitest'
import { finishedStop } from './statusStepFinish.js'

describe('finishedStop —— 目录已移进 archive/ 之后的 stop，按任务结果换说法', () => {
  test('缺省与完结说「已完结」，已升级说「已升级」，已终止说「已终止」；动作码恒为 finished', () => {
    expect(finishedStop('demo')).toEqual([{ action: 'stop', code: 'finished', message: "任务 'demo' 已完结，没有要做的事了" }])
    expect(finishedStop('demo', 'finished')).toEqual(finishedStop('demo'))
    expect(finishedStop('demo', 'escalated')).toEqual([{ action: 'stop', code: 'finished', message: "任务 'demo' 已升级，没有要做的事了" }])
    expect(finishedStop('demo', 'terminated')).toEqual([{ action: 'stop', code: 'finished', message: "任务 'demo' 已终止，没有要做的事了" }])
  })
})
