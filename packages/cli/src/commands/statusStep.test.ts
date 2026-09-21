import { describe, expect, test } from 'vitest'
import { stepNextActions, type StepNextInput } from './statusStep.js'

function input(overrides: Partial<StepNextInput> = {}): StepNextInput {
  return {
    change: 'demo',
    loaded: true,
    skills: [],
    executors: [],
    reviewers: [],
    tests: [],
    documents: { reads: [], records: [], updates: [] },
    fields: [],
    review: { status: 'none', event: null },
    gate: null,
    mode: 'interactive',
    exits: [],
    specApplyPending: false,
    ownsDeltaSpec: false,
    ownsAppliedSpec: false,
    ...overrides,
  }
}

const doc = (kind: string, status: string, producers: readonly string[] = []) =>
  ({ kind, path: `openspec/changes/demo/${kind}.md`, producers, status })

const skill = (id: string, status: 'done' | 'ready' | 'waiting', wave: number) =>
  ({ id, depends_on: [], wave, status })

const agent = (name: string, role: 'executor' | 'reviewer', status: string, ready: boolean) => ({
  agent: name, role, required: true, block_at: 'high', reads_tests: [], wave: 0,
  wave_ready: ready, status: status as 'pending', run_id: null, blocking_findings: 0,
})

const test_ = (id: string, status: string, required = true) =>
  ({ id, direction: id, required, status, run_id: null })

const exit = (event: string, direction: 'forward' | 'back' | 'completion', ready: boolean) =>
  ({ event, to: 'next', direction, ready, blockers: ready ? [] : [{ source: 'guard' as const, code: 'guard-failed', message: 'x' }] })

const actions = (overrides: Partial<StepNextInput>) =>
  stepNextActions(input(overrides)).map((action) => action.action)

describe('step.next 顺序', () => {
  test('进入步骤先重新加载 tenon', () => {
    expect(actions({ loaded: false, skills: [skill('brainstorming', 'ready', 0)] })).toEqual(['load-tenon'])
  })

  test('读取声明的输入文档排在一切产出之前', () => {
    expect(actions({
      documents: { reads: [doc('plan', 'missing')], records: [doc('adr', 'missing')], updates: [] },
      skills: [skill('brainstorming', 'ready', 0)],
    })).toEqual(['read-documents'])
  })

  test('执行者先于本步技能', () => {
    expect(actions({
      executors: [agent('researcher', 'executor', 'pending', true)],
      skills: [skill('brainstorming', 'ready', 0)],
    })).toEqual(['run-agent'])
  })

  test('技能按波次下发，waiting 的不进本波', () => {
    expect(stepNextActions(input({
      skills: [skill('a', 'done', 0), skill('b', 'ready', 1), skill('c', 'waiting', 2)],
    }))).toEqual([{ action: 'load-skill', skill: 'b', wave: 1 }])
  })

  test('applied-spec 归本步时先应用规格，再登记', () => {
    expect(actions({
      ownsAppliedSpec: true,
      specApplyPending: true,
      documents: { reads: [], records: [doc('applied-spec', 'missing')], updates: [] },
    })).toEqual(['apply-spec'])
  })

  test('delta-spec 归本步时，登记完文档再彩排', () => {
    expect(actions({
      ownsDeltaSpec: true,
      specApplyPending: true,
      documents: { reads: [], records: [doc('delta-spec', 'missing')], updates: [] },
    })).toEqual(['scaffold-document'])
    expect(actions({
      ownsDeltaSpec: true,
      specApplyPending: true,
      documents: { reads: [], records: [doc('delta-spec', 'recorded')], updates: [] },
    })).toEqual(['validate-spec'])
  })

  test('已登记的文档过期时重新登记，不再铺骨架', () => {
    expect(actions({
      documents: { reads: [], records: [], updates: [doc('tasks', 'stale', ['tenon'])] },
    })).toEqual(['record-document'])
  })

  test('只跑必需测试；评审者排在测试之后', () => {
    expect(actions({
      tests: [test_('unit', 'not-run'), test_('code-size', 'not-run', false)],
      reviewers: [agent('security', 'reviewer', 'pending', true)],
    })).toEqual(['run-test'])
    expect(actions({
      tests: [test_('unit', 'passed')],
      reviewers: [agent('security', 'reviewer', 'pending', true)],
    })).toEqual(['run-agent'])
  })

  test('结果字段排在测试与评审者之后', () => {
    const outcome = {
      field: 'branch_status', kind: 'outcome' as const, status: 'missing' as const,
      value: null, allowed: ['handled'], recommended: 'handled',
    }
    expect(actions({ fields: [outcome], tests: [test_('unit', 'not-run')] })).toEqual(['run-test'])
    expect(stepNextActions(input({ fields: [outcome] }))).toEqual([
      { action: 'set-field', field: 'branch_status', allowed: ['handled'], recommended: 'handled' },
    ])
  })

  test('评审门：就绪 → 请求评审；pending → 等待；approved → 转换', () => {
    const exits = [exit('spec-complete', 'forward', true)]
    expect(actions({ gate: 'review', exits })).toEqual(['request-review'])
    expect(actions({ gate: 'review', exits, review: { status: 'pending', event: 'spec-complete' } }))
      .toEqual(['await-review'])
    expect(actions({ gate: 'review', exits, review: { status: 'approved', event: 'spec-complete' } }))
      .toEqual(['transition'])
  })

  test('自动门：唯一就绪前进边直接转换；完结边走 complete', () => {
    expect(actions({ exits: [exit('build-complete', 'forward', true)] })).toEqual(['transition'])
    expect(actions({ exits: [exit('archived', 'completion', true)] })).toEqual(['complete'])
  })

  test('必需评审者不通过且存在回退边 → 选择出口，不再重跑评审者', () => {
    expect(actions({
      reviewers: [agent('security', 'reviewer', 'fail', true)],
      exits: [exit('verify-pass', 'forward', false), exit('verify-fail', 'back', true)],
    })).toEqual(['choose-exit'])
  })

  test('失败的执行者直接重跑', () => {
    expect(actions({ executors: [agent('builder', 'executor', 'fail', true)] })).toEqual(['run-agent'])
  })

  test('多条前进边就绪 → 选择出口；都不就绪 → 修', () => {
    expect(actions({ exits: [exit('a', 'forward', true), exit('b', 'forward', true)] }))
      .toEqual(['choose-exit'])
    const fix = stepNextActions(input({ exits: [exit('a', 'forward', false)] }))
    expect(fix[0]?.action).toBe('fix')
    expect(fix[0]?.blockers).toHaveLength(1)
  })
})
