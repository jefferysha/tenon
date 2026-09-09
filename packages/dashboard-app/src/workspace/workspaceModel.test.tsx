import { describe, expect, it } from 'vitest'
import type { ProgressRules } from '../model/progressModel'
import { DEFAULT_WORKFLOW_RULES, makeChange } from '../testkit'
import type { ChangeSnapshot } from '../types'
import { toFlatRow, type Tr } from './taskRows'
import {
  chipProduced,
  nextStepLabel,
  producedCount,
  railStages,
  stageExecution,
  taskFilterMatch,
} from './workspaceModel'

const rules: ProgressRules = DEFAULT_WORKFLOW_RULES
/** 词典桩：无变量返回键名；有变量把变量拼进去，便于断言插值。 */
const t: Tr = (key, vars) => vars
  ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})`
  : key

function flat(change: ChangeSnapshot, state: 'gate' | 'failed' | 'running' | 'queued' | 'agent') {
  return toFlatRow({ root: '/repo', change, state }, rules, 'default')
}

describe('taskFilterMatch（中列状态页签口径）', () => {
  it('需要你 = gate + failed；进行中 = running；等待中 = queued + agent', () => {
    const change = makeChange('c', 'build')
    expect(taskFilterMatch(flat(change, 'gate'), 'need')).toBe(true)
    expect(taskFilterMatch(flat(change, 'failed'), 'need')).toBe(true)
    expect(taskFilterMatch(flat(change, 'running'), 'need')).toBe(false)
    expect(taskFilterMatch(flat(change, 'running'), 'running')).toBe(true)
    expect(taskFilterMatch(flat(change, 'queued'), 'waiting')).toBe(true)
    expect(taskFilterMatch(flat(change, 'agent'), 'waiting')).toBe(true)
    expect(taskFilterMatch(flat(change, 'gate'), 'waiting')).toBe(false)
    expect(taskFilterMatch(flat(change, 'agent'), 'all')).toBe(true)
  })
})

describe('stageExecution（逐 stage 执行状态）', () => {
  it('无 server 投影时按 phase 索引推：之前 done / 当前 current / 之后 pending，gate 取 gateByStep', () => {
    const stages = stageExecution(makeChange('c', 'build'), rules, 'running', t)
    expect(stages.map((stage) => `${stage.step}:${stage.status}`)).toEqual([
      'open:done', 'explore:done', 'spec:done', 'build:current', 'verify:pending', 'ship:pending', 'archive:pending',
    ])
    expect(stages.find((stage) => stage.step === 'explore')?.gate).toBe('review')
    expect(stages.find((stage) => stage.step === 'build')?.gate).toBeNull()
    // phase-manifest 工作流的阶段名走 phases.* 词典，不用 labelByStep。
    expect(stages[3]?.label).toBe('phases.build')
  })

  it('failed 只落在当前阶段', () => {
    const stages = stageExecution(makeChange('c', 'verify'), rules, 'failed', t)
    expect(stages.filter((stage) => stage.status === 'failed').map((stage) => stage.step)).toEqual(['verify'])
    expect(stages.find((stage) => stage.step === 'build')?.status).toBe('done')
  })

  it('todo.stages 的投影优先于 phase 索引，tasks 原样透传', () => {
    const change = makeChange('c', 'build', {
      todo: {
        hasTaskSource: true,
        stages: [
          { id: 'spec', label: '规格', status: 'current', tasks: [{ text: '写 PRD', completed: true }, { text: '评审', completed: false }] },
          { id: 'build', label: '实现', status: 'pending', tasks: [] },
        ],
      },
    })
    const stages = stageExecution(change, rules, 'running', t)
    expect(stages.find((stage) => stage.step === 'spec')?.status).toBe('current')
    expect(stages.find((stage) => stage.step === 'build')?.status).toBe('pending')
    expect(stages.find((stage) => stage.step === 'spec')?.tasks).toHaveLength(2)
    // 未被投影覆盖的阶段仍按索引推。
    expect(stages.find((stage) => stage.step === 'open')?.status).toBe('done')
  })

  it('rules 缺失 → 空列表（右列显示 stages_unknown 空态）', () => {
    expect(stageExecution(makeChange('c', 'build'), undefined, 'running', t)).toEqual([])
  })
})

describe('railStages（阶段轨只画主流程段）', () => {
  it('有其他阶段时去掉 archive；只剩 archive 时保留', () => {
    const stages = stageExecution(makeChange('c', 'build'), rules, 'running', t)
    expect(railStages(stages).map((stage) => stage.step)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship'])
    const onlyArchive = stages.filter((stage) => stage.step === 'archive')
    expect(railStages(onlyArchive).map((stage) => stage.step)).toEqual(['archive'])
  })
})

describe('nextStepLabel（「下一步 · …」文案）', () => {
  it('取首个前进边的目标阶段名；回退边不算', () => {
    // build 的出边：build-complete → verify（前进）、requirements-changed → spec（回退）。
    expect(nextStepLabel(makeChange('c', 'build'), rules, t)).toBe('navigation.next_step(step=phases.verify)')
  })

  it('无前进边（archive）或 rules 缺失 → no_next_step', () => {
    expect(nextStepLabel(makeChange('c', 'archive'), rules, t)).toBe('navigation.no_next_step')
    expect(nextStepLabel(makeChange('c', 'build'), undefined, t)).toBe('navigation.no_next_step')
  })
})

describe('producedCount / chipProduced（任务卡「N 个文件」）', () => {
  it('未设的三轨判定字段没有 unset 标记但值为空，不算已产出：新建 change 是 0 个文件', () => {
    expect(producedCount(makeChange('c', 'open'), rules)).toBe(0)
    expect(chipProduced({ key: 'unit_result', value: '', tone: 'pending' })).toBe(false)
    expect(chipProduced({ key: 'design_doc', value: '', tone: 'pending', unset: true })).toBe(false)
    expect(chipProduced({ key: 'design_doc', value: 'docs/design.md', tone: 'neutral' })).toBe(true)
  })

  it('按阶段产出字段计数：design_doc + plan = 2', () => {
    const change = makeChange('c', 'build', { fields: { design_doc: 'docs/design.md', plan: 'docs/plan.md' } })
    expect(producedCount(change, rules)).toBe(2)
  })

  it('documents 契约受管时以其 items 为准，missing 不计', () => {
    const change = makeChange('c', 'build', {
      documents: {
        governed: true,
        blockers: [],
        items: [
          { kind: 'prd', status: 'recorded', requiredRead: true, paths: ['prd.md'], producers: ['spec'] },
          { kind: 'design', status: 'stale', requiredRead: true, paths: ['design.md'], producers: ['spec'] },
          { kind: 'plan', status: 'missing', requiredRead: false, paths: [], producers: [] },
        ],
      },
    })
    expect(producedCount(change, rules)).toBe(2)
    expect(producedCount(change, undefined)).toBe(2)
  })

  it('rules 缺失且无 documents 契约 → 0', () => {
    expect(producedCount(makeChange('c', 'build'), undefined)).toBe(0)
  })
})
