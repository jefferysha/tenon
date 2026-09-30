import { describe, expect, it } from 'vitest'
import type { FlowStage } from '../api/workflowOrchestrationClient'
import { entryNodeId, layoutOrchestration, stageNodeId } from './orchestrationLayout'
import { edgeStates, holdTarget } from './orchestrationSignal'

const entry = (id: string, wave: number, status: 'done' | 'running' | 'waiting' | 'failed', dependsOn: string[] = []) =>
  ({ kind: 'skill' as const, id, label: id, wave, dependsOn, required: true, source: 'declared' as const, status })

const STAGES: FlowStage[] = [
  { id: 'open', label: '立项', gate: 'auto', entries: [entry('a', 0, 'done')] },
  { id: 'spec', label: '规格', gate: 'review', entries: [entry('b', 0, 'done'), entry('c', 1, 'running', ['b'])] },
  { id: 'build', label: '实现', gate: 'auto', entries: [entry('d', 0, 'waiting')] },
]

describe('edgeStates · 线三态', () => {
  const layout = layoutOrchestration(STAGES, 'overview')

  it('没有运行状态（工作流定义）一律 todo', () => {
    expect(new Set(edgeStates(layout, { withStatus: false, current: null }).values())).toEqual(new Set(['todo']))
  })

  it('已走过的阶段与已完成的条目 = done，正接入运行节点的一段 = live，还没到的 = todo', () => {
    const states = edgeStates(layout, { withStatus: true, current: 'spec' })
    const skill = (stage: string, id: string) => entryNodeId(stage, { kind: 'skill', id })
    expect(states.get(`start->${stageNodeId('open')}`)).toBe('done')
    expect(states.get(`${stageNodeId('open')}->${stageNodeId('spec')}`)).toBe('done')
    // 当前阶段之后的主线还没走到。
    expect(states.get(`${stageNodeId('spec')}->${stageNodeId('build')}`)).toBe('todo')
    expect(states.get(`${stageNodeId('build')}->end`)).toBe('todo')
    expect(states.get(`${stageNodeId('open')}->${skill('open', 'a')}`)).toBe('done')
    expect(states.get(`${skill('spec', 'b')}->${skill('spec', 'c')}`)).toBe('live')
    expect(states.get(`${stageNodeId('build')}->${skill('build', 'd')}`)).toBe('todo')
  })

  it('最后一个阶段全部完成 = 通向终点的主线也是 done', () => {
    const finished: FlowStage[] = [{ id: 'only', label: '唯一', gate: null, entries: [entry('x', 0, 'done')] }]
    const one = layoutOrchestration(finished, 'overview')
    expect(edgeStates(one, { withStatus: true, current: 'only' }).get(`${stageNodeId('only')}->end`)).toBe('done')
    const unfinished: FlowStage[] = [{ id: 'only', label: '唯一', gate: null, entries: [entry('x', 0, 'running')] }]
    expect(edgeStates(layoutOrchestration(unfinished, 'overview'), { withStatus: true, current: 'only' }).get(`${stageNodeId('only')}->end`)).toBe('todo')
  })

  it('阶段画布：还没有条目开始运行时，起点的线不是 done；汇合点的入边看源是否完成', () => {
    const idle: FlowStage = { id: 's', label: 's', gate: null, entries: [entry('a', 0, 'waiting'), entry('b', 0, 'waiting')] }
    const layout2 = layoutOrchestration([idle], 'stage')
    expect(new Set(edgeStates(layout2, { withStatus: true, current: null }).values())).toEqual(new Set(['todo']))
    const started: FlowStage = { id: 's', label: 's', gate: null, entries: [entry('a', 0, 'done'), entry('b', 0, 'done')] }
    const done = edgeStates(layoutOrchestration([started], 'stage'), { withStatus: true, current: null })
    expect(new Set(done.values())).toEqual(new Set(['done']))
  })
})

describe('holdTarget · 评审门把信号拦在哪', () => {
  const layout = layoutOrchestration(STAGES, 'overview')

  it('总览：停在被拦阶段之后的下一个标题前；最后一阶段 = 终点', () => {
    expect(holdTarget(layout, 'overview', 'spec')).toBe(stageNodeId('build'))
    expect(holdTarget(layout, 'overview', 'build')).toBe('end')
  })

  it('阶段画布只有一个阶段：被拦时停在终点前', () => {
    expect(holdTarget(layoutOrchestration([STAGES[1]!], 'stage'), 'stage', 'spec')).toBe('end')
  })

  it('没有被拦的阶段 / 总览里找不到这个阶段 = null', () => {
    expect(holdTarget(layout, 'overview', null)).toBeNull()
    expect(holdTarget(layout, 'overview', 'nope')).toBeNull()
  })
})
