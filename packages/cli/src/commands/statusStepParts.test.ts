import { describe, expect, test } from 'vitest'
import type { DocumentEvidenceItem, DocumentGovernancePolicy, StepIR } from '@tenon/kernel'
import { mockState } from '../test-support.js'
import { stepDocuments, stepFields } from './statusStepParts.js'

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

  /**
   * D4（acceptance run）：`build_sha` 是 build 出口的 `freeze-build-sha` 副作用冻结的 build:v1
   * token（绑定本仓与本工作树），Verify 的 barrier 再按那次转换的 effect 复核出处。把它当成
   * 运行器要填的槽，`next` 就会在写任何代码、跑任何测试之前发一条没有枚举、没有推荐值、也没有
   * 任何命令能正确执行的 set-field——真机实测里运行器照做在空树上填了一个裸修订值，白跑一趟
   * verify-fail → build → verify。
   */
  test('build_sha 标成 transition：由 build 出口冻结，不由运行器填', () => {
    const fields = stepFields(
      mockState({ phase: 'build', build_sha: 'null' }),
      step({ id: 'build', outputs: [{ field: 'build_sha', type: 'string' }] }),
    )
    expect(fields[0]).toMatchObject({ field: 'build_sha', writer: 'transition' })
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

/**
 * 真机实测的 P0（acceptance run）：phase=spec、delta-spec 还没登记时，`tenon status <change>
 * --json` 打 `WARN: step 投影不可用: document kind 'delta-spec' 路径缺少 'capability'` 并且
 * **整块 step 都不输出**——数据驱动的执行者在 spec 相位一无所得。根因是 documentPath 把
 * documentPathForKind 的 fail-loud 直接抛进投影，而 delta-spec 的 `{capability}` 要作者拍板
 * （`tenon document scaffold <change> delta-spec --capability <x>`），此刻本来就定不下来。
 */
describe('stepDocuments —— 路径还定不下来的文档不许带走整块投影', () => {
  const policy = {
    id: 'openspec-v1',
    steps: ['spec'],
    outputsByStep: { spec: [{ kind: 'delta-spec', producerCandidates: ['openspec-propose'] }] },
    mutableByStep: {},
    readsByStep: {},
    requiresByStep: {},
  } as unknown as DocumentGovernancePolicy

  test('未登记的 delta-spec：path 为 null、path_template 指出缺的变量，不抛', () => {
    const documents = stepDocuments('demo', policy, 'spec', [])
    expect(documents.records).toEqual([{
      kind: 'delta-spec',
      path: null,
      path_template: 'openspec/changes/{change}/specs/{capability}/spec.md',
      producers: ['openspec-propose'],
      status: 'missing',
    }])
  })

  test('已登记后仍回实际路径', () => {
    const documents = stepDocuments('demo', policy, 'spec', [
      { kind: 'delta-spec', status: 'recorded', paths: ['openspec/changes/demo/specs/routing/spec.md'] },
    ] as unknown as DocumentEvidenceItem[])
    expect(documents.records[0]?.path).toBe('openspec/changes/demo/specs/routing/spec.md')
  })
})


/**
 * D1（acceptance run）：输入文档被改后状态是 stale，重新登记时 `tenon document record` 只认
 * **当前步**合法的 producer。读清单从前一律投影空 producers，于是投影对「怎么解开」一个字都说
 * 不出；运行器只能拿当初写它的那个 producer 去试，撞上「producer 'openspec-propose' 不合法
 * （当前 explore 允许: tenon）」。
 */
describe('stepDocuments —— 读清单的 producers 来自当前步的契约', () => {
  const policy = {
    id: 'openspec-v1',
    steps: ['open', 'explore', 'build'],
    outputsByStep: {
      open: [{ kind: 'proposal', producerCandidates: ['openspec-propose'] }],
      explore: [],
      build: [],
    },
    mutableByStep: {
      open: [],
      explore: [{ kind: 'proposal', producerCandidates: ['tenon'] }],
      build: [],
    },
    readsByStep: { open: [], explore: ['proposal'], build: ['proposal'] },
    requiresByStep: {},
  } as unknown as DocumentGovernancePolicy

  const stale = [
    { kind: 'proposal', status: 'stale', reason: 'changed', paths: ['openspec/changes/demo/proposal.md'] },
  ] as unknown as DocumentEvidenceItem[]

  test('explore 读到的 proposal 报 explore 接受的 producer，不是 open 的那个', () => {
    expect(stepDocuments('demo', policy, 'explore', stale).reads).toEqual([{
      kind: 'proposal',
      path: 'openspec/changes/demo/proposal.md',
      path_template: 'openspec/changes/{change}/proposal.md',
      producers: ['tenon'],
      status: 'stale',
    }])
  })

  test('当前步不能重新登记它时如实报空 producers', () => {
    expect(stepDocuments('demo', policy, 'build', stale).reads[0]?.producers).toEqual([])
  })
})

/**
 * 真机实测的 P0（acceptance run）：frontend 的 ship 步声明 `{ kind: design-md, role: update,
 * producers: [hue] }`，`tenon document record` 成功、`document status` 打 [PASS]，`status --json`
 * 的 `documents.updates` 却一直是 `missing`，`next` 因此永远重发同一条 scaffold-document。
 * 证据面此前不评估 update 槽位，投影拿不到条目就按 missing 兜底。
 */
describe('stepDocuments —— update 槽位读证据面的判定，不按缺省兜底', () => {
  const policy = {
    id: 'openspec-v1',
    steps: ['ship'],
    outputsByStep: { ship: [] },
    mutableByStep: { ship: [{ kind: 'design-md', producerCandidates: ['hue'] }] },
    readsByStep: {},
    requiresByStep: {},
  } as unknown as DocumentGovernancePolicy

  test('证据面说 recorded 时 updates 就是 recorded', () => {
    const documents = stepDocuments('demo', policy, 'ship', [
      { kind: 'design-md', status: 'recorded', paths: ['DESIGN.md'] },
    ] as unknown as DocumentEvidenceItem[])
    expect(documents.updates).toEqual([{
      kind: 'design-md',
      path: 'DESIGN.md',
      path_template: 'DESIGN.md',
      producers: ['hue'],
      status: 'recorded',
    }])
  })
})
