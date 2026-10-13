/**
 * cmdArtifactRegister 单测（G2 P5，mock store + 注入 EffectiveSkillResolver）——default 轨 declaration
 * 判定、producer 六类校验、锁内读校写、history best-effort、set/cas 回归。
 * custom 轨（loadWorkflow 真 fs）与 program 装配 / --producer 缺失 usage 在 artifact.integration.test.ts。
 */
import { describe, expect, test } from 'vitest'
import { compileDefaultWorkflow, effectiveWorkflowPlanFromIr, workflowPlanSnapshot } from '@tenon/kernel'
import type { FieldName, PipelineState, WorkflowDef } from '@tenon/kernel'
import { legacyContractDefaultPlan } from '@tenon/kernel/workflow/test-support'
import { cmdArtifactRegister } from './artifact.js'
import { cmdCas, cmdSet, cmdSetMany } from './fields.js'
import {
  legacyDefaultWorkflowDef, makeDeps, mockLegacyDefaultState, mockObservedDefaultState, mockState, spy,
} from '../test-support.js'

const CH = 'demo'
const P = 'openspec/changes/demo/design.md'

/** 升级前创建、冻结计划带旧文档契约（含 artifact 声明）的任务：契约模式。mockState 的 default 没有契约，是观察模式。 */
function contractState(fields: Partial<Record<FieldName, string | string[]>>): PipelineState {
  const plan = legacyContractDefaultPlan(typeof fields.track === 'string' ? fields.track : 'frontend')
  return {
    ...mockState(fields),
    runMetadata: {
      runId: 'mock-contract-run', transitionSequence: 0,
      workflowPlanFingerprint: plan.workflowFingerprint, workflowPlanSnapshot: workflowPlanSnapshot(plan),
    },
  }
}

describe('cmdArtifactRegister —— default 轨成功写入', () => {
  test('explore/frontend design_doc + producer openspec-explore（本步声明的技能）→ exit 0，锁内写字段', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    const code = await cmdArtifactRegister(deps, CH, 'design_doc', P, 'openspec-explore')
    expect(code).toBe(0)
    expect(deps.errLines).toEqual([])
    // 锁内读一次、写一次；写入 patch 精确 = design_doc→path（其余字段随 cur 原样）。
    expect(deps.store.withLock.calls.length).toBe(1)
    expect(deps.store.read.calls.length).toBe(1)
    expect(deps.store.write.calls.length).toBe(1)
    expect(deps.store.write.calls[0]![1].fields.design_doc).toBe(P)
    // history 记普通 set（不含 producer）
    expect(deps.historyEntries).toEqual([[expect.stringContaining(CH), { ts: expect.any(String), kind: 'set', field: 'design_doc', to: P }]])
  })

  test('本步声明技能的别名（opsx:propose ≡ openspec-propose）也成功', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'spec', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'plan', 'p/plan.md', 'opsx:propose')).toBe(0)
    expect(deps.store.write.calls[0]![1].fields.plan).toBe('p/plan.md')
  })

  test('spec/frontend plan + producer superpowers:writing-plans → exit 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'spec', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'plan', 'p/plan.md', 'superpowers:writing-plans')).toBe(0)
    expect(deps.store.write.calls[0]![1].fields.plan).toBe('p/plan.md')
  })

  test('spec/pm plan 属于 required_when 排除的 legacy artifact → register 拒绝', async () => {
    const deps = makeDeps({ state: mockLegacyDefaultState({ phase: 'spec', track: 'pm' }) })
    expect(await cmdArtifactRegister(deps, CH, 'plan', 'p/plan.md', 'superpowers:writing-plans')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain("track 'pm' 不适用")
  })

  test('verify/frontend verification_report + producer → exit 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'verify', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'verification_report', 'r.md', 'superpowers:verification-before-completion')).toBe(0)
    expect(deps.store.write.calls[0]![1].fields.verification_report).toBe('r.md')
  })

  test('verify/backend：producer 按步骤声明的技能校验（没有「矩阵关闭」这回事了），声明里的 producer（含别名）放行', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'verify', track: 'backend' }) })
    expect(await cmdArtifactRegister(
      deps,
      CH,
      'verification_report',
      'r.md',
      'superpowers:verification-before-completion',
    )).toBe(0)
    expect(deps.store.write.calls[0]![1].fields.verification_report).toBe('r.md')
  })
})

/**
 * 产出者策略（设计 §1b「artifact 产出策略统一为 effective-step-skills」）：新任务按 YAML 执行，技能就是本步声明的，
 * 策略名只有一种含义——default.yaml 沿用的 effective-phase-skills 是旧拼写，不会让登记被拒；
 * 快照记着旧执行模型的任务保持原策略（artifact 必须是 effective-phase-skills）。
 */
describe('cmdArtifactRegister —— 产出者策略', () => {
  const stateWith = (snapshot: ReturnType<typeof workflowPlanSnapshot>, fields: Partial<Record<FieldName, string | string[]>>): PipelineState => ({
    ...mockState(fields),
    runMetadata: {
      runId: 'mock-policy-run',
      transitionSequence: 0,
      workflowPlanFingerprint: snapshot.workflowFingerprint,
      workflowPlanSnapshot: snapshot,
    },
  })

  test('step-graph 的带契约 default 任务：artifact 声明里 effective-phase-skills（default 沿用的旧拼写）照常登记', async () => {
    // 当前模板已不声明 artifact（新任务是观察模式），带 artifact 声明的 step-graph 任务只剩升级前创建的：取自升级前的 default 原文。
    const plan = legacyContractDefaultPlan('backend', 'step-graph')
    const policies = new Set(plan.workflow.steps.flatMap((step) => step.artifacts.map((artifact) => artifact.producerPolicy)))
    // 前提：升级前的 default.yaml 用的是 effective-phase-skills，这条用例才有意义。
    expect(policies).toContain('effective-phase-skills')
    const state = stateWith(workflowPlanSnapshot(plan), { phase: 'explore', track: 'backend' })
    const deps = makeDeps({ state })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'brainstorming'), deps.errLines.join('\n')).toBe(0)
    expect(deps.store.write.calls[0]![1].fields.design_doc).toBe(P)
  })

  test('旧快照任务保持原策略：artifact 声明成 effective-step-skills 与旧引擎的技能来源不相容，拒绝登记', async () => {
    const def = legacyDefaultWorkflowDef()
    const mismatched: WorkflowDef = {
      ...def,
      steps: def.steps.map((step) => step.id !== 'explore' ? step : {
        ...step,
        artifacts: (step.artifacts ?? []).map((artifact) => ({ ...artifact, producerPolicy: 'effective-step-skills' as const })),
      }),
    }
    // 定义带已删除的 artifacts / document_contract：不经 validateWorkflow，直接按 default 的编译入口建计划。
    const plan = effectiveWorkflowPlanFromIr('default', compileDefaultWorkflow(mismatched), { executionModel: 'phase-manifest' })
    const deps = makeDeps({ state: stateWith(workflowPlanSnapshot(plan), { phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'openspec-explore')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain("producerPolicy 'effective-step-skills'")
    expect(deps.errLines.join('\n')).toContain('不相容（应 effective-phase-skills）')
  })

  test('旧快照任务（mockState 的 default 是升级前的在途任务）：artifact 声明成 effective-phase-skills 照常登记', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'openspec-explore'), deps.errLines.join('\n')).toBe(0)
  })
})

describe('cmdArtifactRegister —— declaration 判定拒绝（state 不变）', () => {
  test('未声明 field（explore 步 register branch，契约模式）→ exit 1，不写，说明这一步没声明它', async () => {
    const deps = makeDeps({ state: contractState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'branch', P, 'opsx:explore')).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
    expect(deps.errLines.join('\n')).toContain("step 'explore' 未声明 artifact 'branch'")
  })

  test('观察模式（新任务）：工作流不再声明 artifact → exit 1，改说产出由 Tenon 在离开步骤时自动记录，不写', async () => {
    const deps = makeDeps({ state: mockObservedDefaultState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'opsx:explore')).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
    expect(deps.errLines).toEqual(['ERROR: 本任务的产出由 Tenon 在离开步骤时自动记录，tenon artifact register 只服务升级前创建的任务'])
  })

  test('观察模式的拒绝文案走英文目录', async () => {
    const deps = Object.assign(makeDeps({ state: mockObservedDefaultState({ phase: 'explore', track: 'frontend' }) }), { locale: 'en' as const })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'opsx:explore')).toBe(1)
    expect(deps.errLines).toEqual([
      'ERROR: The outputs of this task are recorded automatically by Tenon when a step is left; tenon artifact register only serves tasks created before the upgrade',
    ])
  })

  test('spec/pm 的 plan 即使给出任意 producer 也因 required_when 排除而拒绝', async () => {
    const deps = makeDeps({ state: mockLegacyDefaultState({ phase: 'spec', track: 'pm' }) })
    expect(await cmdArtifactRegister(deps, CH, 'plan', 'p/plan.md', 'not-a-plan-producer')).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
    expect(deps.errLines.join('\n')).toContain("track 'pm' 不适用")
  })

  test('无 artifact 的 step（build 步）→ 未声明拒', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'build', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'build_sha', 'x', 'anything')).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
  })
})

describe('cmdArtifactRegister —— producer 校验（class 4/5/6）', () => {
  test('整个 a|b token 作 producer → exit 1（非具体 skill id），不写', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'opsx:explore|openspec-explore')).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
    expect(deps.errLines.join('\n')).toContain('备选 token')
  })

  test('producer 不在有效 skill 集 → exit 1，列出许可 producer，state 不变', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'bogus-skill')).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
    const err = deps.errLines.join('\n')
    expect(err).toContain('不在有效 skill 集')
    // 许可列表就是本步在工作流里声明的技能（声明序），不叠加 manifest 矩阵
    expect(err).toContain('openspec-explore brainstorming grilling domain-modeling')
  })

  test('本步声明的技能仍是 artifact producer 的最小有效集', async () => {
    // design_doc 无 requiredWhen 对 frontend 也适用；Workflow-owned step slot 不能因 matrix/profile 为空而消失。
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'whatever')).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
    expect(deps.errLines.join('\n')).toContain('允许: openspec-explore')
  })
})

describe('cmdArtifactRegister —— 参数/锁/异常口径', () => {
  test('change-name 非法 → exit 1，不进锁', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, '../evil', 'design_doc', P, 'opsx:explore')).toBe(1)
    expect(deps.store.withLock.calls.length).toBe(0)
  })

  test('空 path → exit 1，不进锁', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', '', 'opsx:explore')).toBe(1)
    expect(deps.store.withLock.calls.length).toBe(0)
  })

  test('空 producer → exit 1', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, '')).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
  })

  test('非 default 且 workflow 文件不存在 → exit 1（fail-loud），不写', async () => {
    const deps = makeDeps({ state: mockState({ phase: 's1', track: 'backend', workflow: 'ghost' }) })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'x')).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
    expect(deps.errLines.join('\n')).toContain('ghost')
  })

  test('store.write 抛异常 → exit 1（state 视为未变）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    deps.store.write = spy(async (_d: string, _s: PipelineState): Promise<void> => {
      throw new Error('disk full')
    })
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'openspec-explore')).toBe(1)
    expect(deps.errLines.join('\n')).toContain('disk full')
  })

  test('并发反向：校验依据是锁内 read 出来的 state（spec/pm required_when 排除）', async () => {
    // register 只在 withLock 内 read 一次 state，phase/track/workflow 全取自该锁内快照——
    // 本用例以 pm 轨 state 证明「锁内 state 决定 required_when 判定」（非任何锁外陈旧值）。
    const deps = makeDeps({ state: mockLegacyDefaultState({ phase: 'spec', track: 'pm' }) })
    expect(await cmdArtifactRegister(deps, CH, 'plan', 'p.md', 'not-a-plan-producer')).toBe(1)
    expect(deps.store.read.calls.length).toBe(1) // 锁内读一次
    expect(deps.store.withLock.calls.length).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
  })

  test('history 写入失败只 WARN、不回滚主写（write 已成功 → exit 0）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    deps.history = { append: async () => { throw new Error('hist boom') } }
    expect(await cmdArtifactRegister(deps, CH, 'design_doc', P, 'openspec-explore')).toBe(0)
    expect(deps.store.write.calls.length).toBe(1) // 主写成功、未回滚
    expect(deps.errLines.join('\n')).toContain('WARN')
  })
})

describe('P6 cutover：set/set-many/cas 对当前 artifact 字段拒写（改走 register）', () => {
  test('set design_doc（explore）→ 拒 exit 1，不写、指引 register', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdSet(deps, CH, 'design_doc', P)).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
    expect(deps.errLines.join('\n')).toContain('artifact register')
  })

  test('set-many 含 artifact 字段（spec/frontend：plan 命中）→ 整批拒 exit 1，不写', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'spec', track: 'frontend' }) })
    expect(await cmdSetMany(deps, CH, ['plan=p.md', 'verification_report=v.md'])).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
  })

  test('cas design_doc（explore）→ 拒 exit 1（artifact 拒优先于 CAS 语义），不写', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend', design_doc: '' }) })
    expect(await cmdCas(deps, CH, 'design_doc', '', P)).toBe(1)
    expect(deps.store.write.calls.length).toBe(0)
  })
})
