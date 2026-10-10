import { describe, expect, test } from 'vitest'
import {
  compileEffectiveWorkflowPlan,
  type EffectiveWorkflowPlan,
  type FieldName,
  type PipelineState,
  type StepDef,
  type TransitionRecord,
  type TransitionRecordStore,
} from '@tenon/kernel'
import { mockState } from '../test-support.js'
import { stepRounds } from './statusStepRounds.js'

const RUN = 'run-1'
const DIR = '/repo/openspec/changes/demo'

const step = (id: string, gate: StepDef['gate'], transitions: StepDef['transitions'], maxRounds?: number): StepDef => ({
  id, label: id, gate, skills: [], inputs: [], outputs: [], guards: [], transitions,
  ...(maxRounds === undefined ? {} : { maxRounds }),
})

function planWith(maxRounds?: number): EffectiveWorkflowPlan {
  return compileEffectiveWorkflowPlan('rounds-demo', {
    name: 'rounds-demo',
    steps: [
      step('spec', 'review', [{ event: 'spec-complete', to: 'build' }]),
      step('build', null, [
        { event: 'build-complete', to: 'verify' },
        { event: 'requirements-changed', to: 'spec' },
      ]),
      step('verify', 'review', [
        { event: 'verify-pass', to: 'ship' },
        { event: 'verify-fail', to: 'build' },
      ], maxRounds),
      step('ship', null, []),
    ],
  })
}

/** 一串转换记录：每个 `to` 一条，序号从 1 起。 */
function chainOf(targets: readonly string[], runId = RUN): TransitionRecord[] {
  return targets.map((to, index) => ({
    schemaVersion: 1,
    id: `rec-${index + 1}`,
    runId,
    sequence: index + 1,
    workflowId: 'rounds-demo',
    event: `to-${to}`,
    from: 'x',
    to,
    effects: [],
    observedAt: '2026-10-09T00:00:00Z',
  }))
}

interface ChainCall { readonly dir: string; readonly sequence: number; readonly head: string; readonly runId: string }

function recordStoreOf(records: readonly TransitionRecord[], calls: ChainCall[] = []): TransitionRecordStore {
  return {
    write: async () => {},
    read: async () => undefined,
    readChain: async (dir, sequence, head, runId) => {
      calls.push({ dir, sequence, head, runId })
      return [...records]
    },
  }
}

function stateAt(
  phase: string,
  records: readonly TransitionRecord[],
  fields: Partial<Record<FieldName, string>> = {},
): PipelineState {
  const state = mockState({ phase, ...fields })
  const last = records.at(-1)
  return last === undefined
    ? state
    : { ...state, runMetadata: { runId: RUN, transitionSequence: last.sequence, transitionHead: last.id } }
}

describe('stepRounds —— status --json 步骤块的 rounds', () => {
  test('评审门 + 回退边的步骤：第一次进入是第 1 轮，上限取工作流声明，来源 workflow', async () => {
    const records = chainOf(['build', 'verify'])
    const rounds = await stepRounds({ recordStore: recordStoreOf(records) }, DIR, stateAt('verify', records), planWith(3), 'verify')
    expect(rounds).toEqual({ current: 1, max: 3, source: 'workflow' })
  })

  test('没声明 maxRounds 的受约束步骤按内置默认 2，来源 default', async () => {
    const records = chainOf(['build', 'verify'])
    const rounds = await stepRounds({ recordStore: recordStoreOf(records) }, DIR, stateAt('verify', records), planWith(), 'verify')
    expect(rounds).toEqual({ current: 1, max: 2, source: 'default' })
  })

  test('verify-fail 回到实现、再 build-complete 进入验证：第 2 轮', async () => {
    const records = chainOf(['build', 'verify', 'build', 'verify'])
    const rounds = await stepRounds({ recordStore: recordStoreOf(records) }, DIR, stateAt('verify', records), planWith(2), 'verify')
    expect(rounds).toEqual({ current: 2, max: 2, source: 'workflow' })
  })

  test('经 requirements-changed 回到规格后再走到 verify：重新计数，第 1 轮', async () => {
    const records = chainOf(['build', 'verify', 'build', 'verify', 'spec', 'build', 'verify'])
    const rounds = await stepRounds({ recordStore: recordStoreOf(records) }, DIR, stateAt('verify', records), planWith(2), 'verify')
    expect(rounds?.current).toBe(1)
  })

  test('任务字段 max_rounds 覆盖：来源 task，调低、调高都生效', async () => {
    const records = chainOf(['build', 'verify', 'build', 'verify'])
    const low = await stepRounds({ recordStore: recordStoreOf(records) }, DIR, stateAt('verify', records, { max_rounds: '1' }), planWith(2), 'verify')
    expect(low).toEqual({ current: 2, max: 1, source: 'task' })
    const high = await stepRounds({ recordStore: recordStoreOf(records) }, DIR, stateAt('verify', records, { max_rounds: '3' }), planWith(2), 'verify')
    expect(high).toEqual({ current: 2, max: 3, source: 'task' })
  })

  test('任务字段里的脏值被忽略：沿用工作流的上限', async () => {
    const records = chainOf(['build', 'verify'])
    const rounds = await stepRounds({ recordStore: recordStoreOf(records) }, DIR, stateAt('verify', records, { max_rounds: '99' }), planWith(2), 'verify')
    expect(rounds).toEqual({ current: 1, max: 2, source: 'workflow' })
  })

  test('不受约束的步骤（没有评审门的 build、没有回退边的评审门步骤）为 null，且不去读转换链', async () => {
    const calls: ChainCall[] = []
    const records = chainOf(['build'])
    const deps = { recordStore: recordStoreOf(records, calls) }
    expect(await stepRounds(deps, DIR, stateAt('build', records), planWith(2), 'build')).toBeNull()
    expect(await stepRounds(deps, DIR, stateAt('spec', records), planWith(2), 'spec')).toBeNull()
    expect(await stepRounds(deps, DIR, stateAt('ship', records), planWith(2), 'ship')).toBeNull()
    expect(await stepRounds(deps, DIR, stateAt('ghost', records), planWith(2), 'ghost')).toBeNull()
    expect(calls).toEqual([])
  })

  test('以 state.runMetadata 的 runId / 序号 / 链头读 canonical 转换链', async () => {
    const calls: ChainCall[] = []
    const records = chainOf(['build', 'verify'])
    await stepRounds({ recordStore: recordStoreOf(records, calls) }, DIR, stateAt('verify', records), planWith(2), 'verify')
    expect(calls).toEqual([{ dir: DIR, sequence: 2, head: 'rec-2', runId: RUN }])
  })

  test('另一个 run 的转换记录不计入当前轮次', async () => {
    const records = [...chainOf(['build', 'verify', 'build', 'verify'], 'old-run'), ...chainOf(['build', 'verify'], RUN)]
    const rounds = await stepRounds({ recordStore: recordStoreOf(records) }, DIR, stateAt('verify', records), planWith(2), 'verify')
    expect(rounds?.current).toBe(1)
  })

  test('没有任何转换记录但任务就在这一步：至少是第 1 轮', async () => {
    const rounds = await stepRounds({ recordStore: recordStoreOf([]) }, DIR, stateAt('verify', []), planWith(2), 'verify')
    expect(rounds).toEqual({ current: 1, max: 2, source: 'workflow' })
  })

  test('有 canonical 链时不读 .pipeline-history.jsonl', async () => {
    let historyReads = 0
    const records = chainOf(['build', 'verify'])
    const deps = {
      recordStore: recordStoreOf(records),
      readHistoryRaw: async () => { historyReads += 1; return '' },
    }
    await stepRounds(deps, DIR, stateAt('verify', records), planWith(2), 'verify')
    expect(historyReads).toBe(0)
  })
})

describe('stepRounds —— 没有转换记录链的旧任务退回读 .pipeline-history.jsonl', () => {
  const row = (to: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ts: '2026-07-01T00:00:00Z', kind: 'transition', from: 'x', to, raw: `to-${to}`, ...extra })

  const legacy = (lines: readonly string[]) => ({ readHistoryRaw: async () => `${lines.join('\n')}\n` })

  test('按 transition 行计数；非转换行、损坏行、缺 to 的行都跳过', async () => {
    const lines = [
      row('build'), row('verify'),
      JSON.stringify({ ts: 't', kind: 'set', field: 'plan', to: 'verify' }),
      '{ not json',
      JSON.stringify({ ts: 't', kind: 'transition', from: 'verify' }),
      row('build'), row('verify'),
    ]
    const rounds = await stepRounds(legacy(lines), DIR, stateAt('verify', []), planWith(2), 'verify')
    expect(rounds).toEqual({ current: 2, max: 2, source: 'workflow' })
  })

  test('回到规格后重新计数', async () => {
    const lines = [row('build'), row('verify'), row('build'), row('verify'), row('spec'), row('build'), row('verify')]
    const rounds = await stepRounds(legacy(lines), DIR, stateAt('verify', []), planWith(2), 'verify')
    expect(rounds?.current).toBe(1)
  })

  test('有 runMetadata 但还没有链头（run 刚建、没有转换）时，只认没有 transitionRecordId 的历史行', async () => {
    const lines = [
      row('build'), row('verify'),
      // 兼容投影行属于某条 canonical 记录，那条链不在当前 run 里，不能算进来。
      row('build', { transitionRecordId: 'rec-9' }), row('verify', { transitionRecordId: 'rec-10' }),
    ]
    const state = { ...stateAt('verify', []), runMetadata: { runId: RUN, transitionSequence: 0 } }
    const rounds = await stepRounds(legacy(lines), DIR, state, planWith(2), 'verify')
    expect(rounds?.current).toBe(1)
  })

  test('状态有链头、环境却没装配 recordStore：抛错（失败关闭），不退回历史行算出偏小的轮次', async () => {
    const records = chainOf(['build', 'verify'])
    await expect(stepRounds(legacy([row('build'), row('verify')]), DIR, stateAt('verify', records), planWith(2), 'verify'))
      .rejects.toThrow('缺少转换记录读取依赖')
  })

  test('历史文件也读不到：第 1 轮', async () => {
    const rounds = await stepRounds({}, DIR, stateAt('verify', []), planWith(2), 'verify')
    expect(rounds).toEqual({ current: 1, max: 2, source: 'workflow' })
  })
})
