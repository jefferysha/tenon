import { describe, expect, it, vi } from 'vitest'
import type { FieldName, PipelineState } from '../types.js'
import type { TransitionRecordStore } from '../state/transition-record-store.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import type { StepDef } from './types.js'
import { readStepRounds, roundsExhausted } from './step-rounds-read.js'

const step = (id: string, gate: StepDef['gate'], transitions: StepDef['transitions'], maxRounds?: number): StepDef => ({
  id, label: id, gate, skills: [], inputs: [], outputs: [], guards: [], transitions,
  ...(maxRounds === undefined ? {} : { maxRounds }),
})

const PLAN = compileEffectiveWorkflowPlan('rounds-read', {
  name: 'rounds-read',
  steps: [
    step('build', null, [{ event: 'build-done', to: 'verify' }]),
    step('verify', 'review', [{ event: 'verify-pass', to: 'done' }, { event: 'verify-fail', to: 'build' }], 2),
    step('done', null, []),
  ],
})

const stateOf = (fields: Partial<Record<FieldName, string>>, withChain = false): PipelineState => ({
  fields: { phase: 'verify', ...fields },
  opaqueTail: '',
  ...(withChain ? { runMetadata: { runId: 'run-1', transitionSequence: 3, transitionHead: 'rec-3' } } : {}),
}) as unknown as PipelineState

const record = (sequence: number, to: string, runId = 'run-1') => ({
  schemaVersion: 1 as const, id: `rec-${sequence}`, runId, sequence, workflowId: 'rounds-read', event: `to-${to}`, from: 'x', to,
  effects: [], observedAt: '2026-10-09T00:00:00Z',
})

describe('readStepRounds', () => {
  it('canonical 链上进入 verify 的次数就是当前轮次；任务字段 max_rounds 覆盖上限', async () => {
    const readChain = vi.fn(async () => [record(1, 'verify'), record(2, 'build'), record(3, 'verify')])
    const recordStore = { readChain } as unknown as TransitionRecordStore
    expect(await readStepRounds({ recordStore }, '/dir', stateOf({}, true), PLAN, 'verify'))
      .toEqual({ current: 2, max: 2, source: 'workflow' })
    expect(readChain).toHaveBeenCalledWith('/dir', 3, 'rec-3', 'run-1')
    expect(await readStepRounds({ recordStore }, '/dir', stateOf({ max_rounds: '5' }, true), PLAN, 'verify'))
      .toEqual({ current: 2, max: 5, source: 'task' })
  })

  it('没有链的旧任务退回读历史里的转换行（跳过损坏行与兼容投影行）', async () => {
    const rows = [
      JSON.stringify({ kind: 'transition', to: 'verify' }),
      'not json',
      JSON.stringify({ kind: 'transition', to: 'build' }),
      JSON.stringify({ kind: 'transition', to: 'verify', transitionRecordId: 'rec-9' }),
      JSON.stringify({ kind: 'transition', to: 'verify' }),
      JSON.stringify({ kind: 'set', field: 'phase', to: 'verify' }),
    ].join('\n')
    expect(await readStepRounds({ readHistoryRaw: async () => rows }, '/dir', stateOf({}), PLAN, 'verify'))
      .toEqual({ current: 2, max: 2, source: 'workflow' })
  })

  it('不受约束的步骤返回 null，且不去读转换记录', async () => {
    const readChain = vi.fn(async () => [])
    const recordStore = { readChain } as unknown as TransitionRecordStore
    expect(await readStepRounds({ recordStore }, '/dir', stateOf({ phase: 'build' }, true), PLAN, 'build')).toBeNull()
    expect(readChain).not.toHaveBeenCalled()
  })

  it('什么读取能力都没有、记录缺失：任务此刻就在这一步，至少是第 1 轮', async () => {
    expect(await readStepRounds({}, '/dir', stateOf({}), PLAN, 'verify')).toEqual({ current: 1, max: 2, source: 'workflow' })
  })

  it('状态里有转换记录链头、调用方却没传 recordStore：抛错（失败关闭），不走 JSONL 回退算出偏小的轮次', async () => {
    // JSONL 里若只有 1 次进入 verify，回退读法会把当前轮次算成 1（而链上其实是第 2 次）：那会放过已用完的上限。
    const rows = JSON.stringify({ kind: 'transition', to: 'verify' })
    const readHistoryRaw = vi.fn(async () => rows)
    await expect(readStepRounds({ readHistoryRaw }, '/dir', stateOf({}, true), PLAN, 'verify'))
      .rejects.toThrow('缺少转换记录读取依赖')
    expect(readHistoryRaw).not.toHaveBeenCalled()
    await expect(readStepRounds({}, '/dir', stateOf({}, true), PLAN, 'verify')).rejects.toThrow(/recordStore/u)
  })

  it('有链头、recordStore 也装配了，但读链本身失败（如磁盘 I/O 错误）：原样抛出，不退回读 JSONL 算出偏小的轮次', async () => {
    const failure = new Error('EIO: i/o error')
    const readChain = vi.fn(async () => { throw failure })
    const recordStore = { readChain } as unknown as TransitionRecordStore
    const readHistoryRaw = vi.fn(async () => JSON.stringify({ kind: 'transition', to: 'verify' }))
    await expect(readStepRounds({ recordStore, readHistoryRaw }, '/dir', stateOf({}, true), PLAN, 'verify')).rejects.toBe(failure)
    expect(readHistoryRaw).not.toHaveBeenCalled()
  })

  it('有链头且传了 recordStore：照旧读链；没有链头：照旧退回 JSONL', async () => {
    const readChain = vi.fn(async () => [record(1, 'verify'), record(2, 'build'), record(3, 'verify')])
    const recordStore = { readChain } as unknown as TransitionRecordStore
    const rows = JSON.stringify({ kind: 'transition', to: 'verify' })
    expect(await readStepRounds({ recordStore, readHistoryRaw: async () => rows }, '/dir', stateOf({}, true), PLAN, 'verify'))
      .toEqual({ current: 2, max: 2, source: 'workflow' })
    expect(await readStepRounds({ recordStore, readHistoryRaw: async () => rows }, '/dir', stateOf({}), PLAN, 'verify'))
      .toEqual({ current: 1, max: 2, source: 'workflow' })
    expect(readChain).toHaveBeenCalledTimes(1)
  })

  it('不受约束的步骤即使有链头、没有 recordStore 也不抛（本来就不去读转换记录）', async () => {
    expect(await readStepRounds({}, '/dir', stateOf({ phase: 'build' }, true), PLAN, 'build')).toBeNull()
  })
})

describe('roundsExhausted', () => {
  it('当前轮次 >= 上限算用完；没有 rounds（不受约束）永远不算', () => {
    expect(roundsExhausted({ current: 1, max: 2 })).toBe(false)
    expect(roundsExhausted({ current: 2, max: 2 })).toBe(true)
    expect(roundsExhausted({ current: 3, max: 2 })).toBe(true)
    expect(roundsExhausted(null)).toBe(false)
    expect(roundsExhausted(undefined)).toBe(false)
  })
})
