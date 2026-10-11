import { describe, expect, it } from 'vitest'
import {
  compileEffectiveWorkflowPlan,
  documentGovernanceFingerprint,
  DocumentGovernanceBindingError,
  effectiveWorkflowPlanFromIr,
  effectiveWorkflowPlanFromSnapshot,
  effectiveWorkflowPlanBinding,
  planAutomationPolicy,
  requireRunPlan,
  resolveBoundEffectiveWorkflowPlan,
  workflowPlanSnapshot,
} from './effective-plan.js'
import type { EffectiveWorkflowPlan } from './effective-plan.js'
import { compileDefaultWorkflow } from './compile.js'
import { UnknownTrackError } from './resolve-track.js'
import { initRunInTemp } from '../state/test-support.js'
import {
  branchWith, compiledDesignSystem, defaultIr, legacyDefaultWorkflow, requiredSkillsFor, targetDefaultWorkflow,
} from './test-support.js'
import type { WorkflowPlanSnapshotV4 } from './workflow-plan-snapshot-types.js'

/** 默认 `default` 的某条轨道的计划（目标形态的夹具，不读模板文件）。 */
function defaultPlan(track: string): EffectiveWorkflowPlan {
  return effectiveWorkflowPlanFromIr('default', defaultIr(), { track })
}

/**
 * 升级前创建的 `default` 任务冻结下来的 v4 快照：phase-manifest、manifest-overlay 技能策略。
 * 字节固定（指纹 3389023…）：改动指纹配方会让它恢复失败。
 */
function legacyV4Snapshot(): WorkflowPlanSnapshotV4 {
  const decomposition = {
    version: 'v1', mode: 'off', target: 'work-items', strategy: 'balanced', max_items: 16, max_depth: 2, auto_when: [], ask_when: [],
  } as const
  const interaction = { version: 'v1', mode: 'interactive' } as const
  const step = (id: string, label: string, transitions: WorkflowPlanSnapshotV4['workflow']['steps'][number]['transitions']) => ({
    id, label, gate: 'auto' as const, skills: [], inputs: [], outputs: [], guards: [], artifacts: [], transitions,
  })
  return {
    version: 4,
    workflowId: 'default',
    executionModel: 'phase-manifest',
    workflow: {
      name: 'default',
      decomposition,
      interaction,
      openspec: true,
      steps: [
        step('open', '立项', [{ event: 'open-complete', to: 'explore', guards: [], actions: [] }]),
        step('explore', '调研', []),
      ],
    },
    documentPolicy: {
      id: 'openspec-v1',
      steps: ['open', 'explore'],
      outputsByStep: { open: [], explore: [] },
      mutableByStep: { open: [], explore: [] },
      readsByStep: { open: [], explore: [] },
    },
    decomposition,
    interaction,
    workflowFingerprint: '3389023785e17bc3851ea0c7b0b11bd0e0452f7f8a5e3cfca5240dd517749ac7',
  }
}

function preVerifyConvergenceWorkflow() {
  const current = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow()).workflow
  const {
    decomposition: _decomposition,
    interaction: _interaction,
    // Historical bytes predate the openspec key and YAML-declared document contracts.
    openspec: _openspec,
    documentContract: _documentContract,
    ...legacy
  } = current
  return {
    ...legacy,
    steps: legacy.steps.map((step) => {
      // Historical bytes also predate step tests (2026-09 per-step test evidence), step test policies and step prompts
      // (the frontend branch gained them with DESIGN.md) and the verification-round limit (max_rounds).
      const {
        tests: _tests, test_policy: _testPolicy, prompt: _prompt, agents: _agents, maxRounds: _maxRounds, ...legacyStep
      } = step
      return {
        ...legacyStep,
        // The last step was labelled 归档 before the 完结 wording.
        label: step.id === 'archive' ? '归档' : step.label,
        // Historical bytes predate the two-kind gate: `gate: null` was recorded as null (no output guards).
        gate: step.gate === 'auto' ? null : step.gate,
        // This fixture intentionally models the pre-issue#43 frozen snapshot, whose
        // default Workflow steps had no Workflow-owned phase Skills and whose ship/archive
        // steps declared no inputs/outputs (pr_url / archived were added in 2026-09).
        skills: [],
        inputs: step.id === 'ship' || step.id === 'archive' ? [] : step.inputs,
        outputs: step.id === 'ship' || step.id === 'archive' ? [] : step.outputs,
        // Historical bytes carry only the two guards the 2026-07 default declared; every leave condition and
        // action that default.yaml gained when it became the executable source (设计 §1b) post-dates them.
        guards: step.guards.filter((guard) => guard.type === 'tasks-at-least' || guard.type === 'spec-migration-applied'),
        transitions: step.transitions.map((transition) => ({
          ...transition,
          guards: [],
          actions: [],
        })),
      }
    }),
  }
}

describe('compileEffectiveWorkflowPlan', () => {
  it('compiles the pre-matrix default through the shared immutable plan surface (manifest-overlay)', () => {
    const plan = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow(), { track: 'backend', executionModel: 'phase-manifest' })
    expect(plan.executionModel).toBe('phase-manifest')
    expect(plan.projection.steps.map((step) => step.id)).toEqual([
      'open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive',
    ])
    expect(plan.documentPolicy?.id).toBe('openspec-v1')
    expect(plan.skillPolicy).toBe('manifest-overlay')
    expect(plan.capabilities).toMatchObject({
      execution: { model: 'phase-manifest' },
      skills: { source: 'manifest-overlay' },
      documents: { profile: 'legacy-full', governed: true },
      review: { steps: ['explore', 'spec', 'verify'] },
      automation: { eligible: true, autoEnqueueOnSpecComplete: false },
      track: { id: 'backend', coverageProfile: 'backend' },
    })
    expect(plan.capabilities.skills).not.toHaveProperty('trackOverlay')
    const documentPolicy = plan.documentPolicy
    if (documentPolicy === undefined) throw new Error('expected default document policy')
    expect(effectiveWorkflowPlanBinding(plan)).toEqual({
      documentProfile: 'legacy-full',
      documentGovernanceFingerprint: documentGovernanceFingerprint(documentPolicy),
      workflowPlanFingerprint: plan.workflowFingerprint,
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.capabilities.skills.steps)).toBe(true)
    expect(Object.isFrozen(plan.workflow.steps)).toBe(true)
  })

  it('keeps pre-identity-migration v1 default snapshots executable', () => {
    const legacyWorkflow = preVerifyConvergenceWorkflow()
    const restored = effectiveWorkflowPlanFromSnapshot({
      version: 1,
      workflowId: 'default',
      executionModel: 'phase-manifest',
      workflow: legacyWorkflow,
      workflowFingerprint: 'c9a829b12b12138522532a9127efb8b93a551b1f28922a53dc174ad13e35b7dd',
    }, 'frontend')
    const roundTripped = effectiveWorkflowPlanFromSnapshot(JSON.parse(JSON.stringify({
      version: 1,
      workflowId: 'default',
      executionModel: 'phase-manifest',
      workflow: legacyWorkflow,
      workflowFingerprint: 'c9a829b12b12138522532a9127efb8b93a551b1f28922a53dc174ad13e35b7dd',
    })))

    expect(restored.workflowFingerprint)
      .toBe('c9a829b12b12138522532a9127efb8b93a551b1f28922a53dc174ad13e35b7dd')
    expect(restored.documentPolicy?.mutableByStep.verify?.[0]?.producerCandidates)
      .toContain('pipeline-verify')
    expect(roundTripped.workflowFingerprint).toBe(restored.workflowFingerprint)
  })

  it('writes self-contained v4 snapshots with their frozen document policy and workflow policies', () => {
    const plan = compileEffectiveWorkflowPlan('v4-policy', {
      name: 'v4-policy',
      interaction: { version: 'v1', mode: 'recommended-defaults' },
      steps: [{ id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    const snapshot = workflowPlanSnapshot(plan)

    expect(snapshot.version).toBe(4)
    if (snapshot.version !== 4) throw new Error('expected v4 workflow snapshot')
    expect(snapshot.documentPolicy).toEqual(plan.documentPolicy ?? null)
    expect(snapshot.decomposition).toEqual(plan.decomposition)
    expect(snapshot.interaction).toEqual(plan.interaction)
    expect(effectiveWorkflowPlanFromSnapshot(snapshot).workflowFingerprint)
      .toBe(plan.workflowFingerprint)
  })

  it('a frozen legacy free-track plan keeps the workflow-owned policy and gets no coverage or automation', () => {
    const plan = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow(), { track: 'free', executionModel: 'phase-manifest' })

    expect(plan.projection.steps).toHaveLength(7)
    expect(plan.documentPolicy?.id).toBe('openspec-v1')
    expect(plan.capabilities.track).toEqual({
      id: 'free',
      coverageProfile: 'none',
      routingEnabled: false,
    })
    expect(plan.capabilities.automation).toEqual({
      eligible: false,
      autoEnqueueOnSpecComplete: false,
    })
  })

  it('keeps a three-step declarative contract three steps wide', () => {
    const plan = compileEffectiveWorkflowPlan('compact', {
      name: 'compact',
      openspec: true,
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
        reads: [{ step: 'implement', kinds: ['proposal'] }],
      },
      steps: [
        {
          id: 'shape', label: 'Shape', gate: null, skills: [{ id: 'writer' }],
          inputs: [], outputs: [], guards: [], transitions: [{ event: 'go', to: 'implement' }],
        },
        {
          id: 'implement', label: 'Implement', gate: null, skills: [],
          inputs: [], outputs: [], guards: [], transitions: [{ event: 'prove', to: 'verify' }],
        },
        {
          id: 'verify', label: 'Verify', gate: 'review', skills: [],
          inputs: [], outputs: [], guards: [], transitions: [],
        },
      ],
    })
    expect(plan.executionModel).toBe('step-graph')
    expect(plan.projection.steps.map((step) => step.id)).toEqual(['shape', 'implement', 'verify'])
    expect(plan.documentPolicy?.id).toBe('document-v1')
  })

  it('bound document governance cannot be removed or replaced by a mutable workflow definition', () => {
    const original = compileEffectiveWorkflowPlan('compact', {
      name: 'compact',
      openspec: true,
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
        reads: [{ step: 'implement', kinds: ['proposal'] }],
      },
      steps: [
        {
          id: 'shape', label: 'Shape', gate: null, skills: [{ id: 'writer' }],
          inputs: [], outputs: [], guards: [], transitions: [{ event: 'go', to: 'implement' }],
        },
        {
          id: 'implement', label: 'Implement', gate: null, skills: [],
          inputs: [], outputs: [], guards: [], transitions: [],
        },
      ],
    })
    const policy = original.documentPolicy
    if (!policy) throw new Error('expected governed plan')
    const binding = {
      documentProfile: 'document-v1' as const,
      documentGovernanceFingerprint: documentGovernanceFingerprint(policy),
    }

    expect(() => resolveBoundEffectiveWorkflowPlan('compact', binding, () => null))
      .toThrow(DocumentGovernanceBindingError)

    const ungoverned = compileEffectiveWorkflowPlan('compact', {
      name: 'compact',
      steps: original.workflow.steps,
    })
    expect(() => resolveBoundEffectiveWorkflowPlan('compact', binding, () => ungoverned.workflow))
      .toThrow(/document governance.*不可降级/)

    const changed = compileEffectiveWorkflowPlan('compact', {
      name: 'compact',
      openspec: true,
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'tasks', ownerStep: 'shape', producers: ['writer'] }],
        reads: [{ step: 'implement', kinds: ['tasks'] }],
      },
      steps: original.workflow.steps,
    })
    expect(() => resolveBoundEffectiveWorkflowPlan('compact', binding, () => changed.workflow))
      .toThrow(/fingerprint/)
  })

  it('a bound workflow plan rejects graph, skill, or review drift even when documents are unchanged', () => {
    const definition = {
      name: 'compact',
      openspec: true,
      documentContract: {
        version: 'v1' as const,
        slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
        reads: [],
      },
      steps: [
        {
          id: 'shape', label: 'Shape', gate: null, skills: [{ id: 'writer' }],
          inputs: [], outputs: [], guards: [], transitions: [{ event: 'go', to: 'done' }],
        },
        {
          id: 'done', label: 'Done', gate: null, skills: [],
          inputs: [], outputs: [], guards: [], transitions: [],
        },
      ],
    }
    const original = compileEffectiveWorkflowPlan('compact', definition)
    const binding = effectiveWorkflowPlanBinding(original)
    const drifted = compileEffectiveWorkflowPlan('compact', {
      ...definition,
      steps: definition.steps.map((step) => step.id === 'shape'
        ? { ...step, gate: 'review' as const, skills: [{ id: 'writer' }, { id: 'other-writer' }] }
        : step),
    })

    expect(drifted.documentPolicy).toEqual(original.documentPolicy)
    expect(() => resolveBoundEffectiveWorkflowPlan(
      'compact',
      binding,
      () => drifted.workflow,
    )).toThrow(/workflow plan fingerprint/)

    const pinned = resolveBoundEffectiveWorkflowPlan(
      'compact',
      binding,
      () => drifted.workflow,
      undefined,
      workflowPlanSnapshot(original),
    )
    expect(pinned?.workflowFingerprint).toBe(original.workflowFingerprint)
    expect(pinned?.capabilities.review.steps).toEqual([])
  })

  it('profile-only old runs retain compatibility but still cannot downgrade to ungoverned', () => {
    const governed = compileEffectiveWorkflowPlan('compact', {
      name: 'compact',
      openspec: true,
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
        reads: [],
      },
      steps: [{
        id: 'shape', label: 'Shape', gate: null, skills: [{ id: 'writer' }],
        inputs: [], outputs: [], guards: [], transitions: [],
      }],
    })
    expect(resolveBoundEffectiveWorkflowPlan(
      'compact',
      { documentProfile: 'document-v1' },
      () => governed.workflow,
    )?.documentPolicy?.id).toBe('document-v1')
    expect(() => resolveBoundEffectiveWorkflowPlan(
      'compact',
      { documentProfile: 'document-v1' },
      () => compileEffectiveWorkflowPlan('compact', { name: 'compact', steps: governed.workflow.steps }).workflow,
    )).toThrow(/不可降级/)
  })

  it('步骤测试项：无测试的工作流指纹不变，声明测试后指纹改变，v3 快照往返保留测试', () => {
    const base = {
      name: 'tested',
      steps: [{ id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    } as const
    const plain = compileEffectiveWorkflowPlan('tested', base)
    expect(plain.workflowFingerprint).toBe(compileEffectiveWorkflowPlan('tested', { ...base, steps: [{ ...base.steps[0], tests: [] }] }).workflowFingerprint)

    const tested = compileEffectiveWorkflowPlan('tested', {
      ...base,
      steps: [{ ...base.steps[0], tests: [{ id: 'unit', direction: 'unit', command: 'npm test' }] }],
    })
    expect(tested.workflowFingerprint).not.toBe(plain.workflowFingerprint)
    expect(tested.workflow.steps[0]?.tests).toHaveLength(1)

    const snapshot = workflowPlanSnapshot(tested)
    const restored = effectiveWorkflowPlanFromSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(restored.workflowFingerprint).toBe(tested.workflowFingerprint)
    expect(restored.workflow.steps[0]?.tests).toEqual(tested.workflow.steps[0]?.tests)
  })
})

describe('生效计划只认分支', () => {
  it('default 的 lite 分支不受文档治理，后端分支受治理', () => {
    const lite = defaultPlan('lite')
    expect(lite.capabilities.documents.governed).toBe(false)
    expect(lite.documentPolicy).toBeUndefined()
    expect(lite.workflow.openspec).toBeUndefined()
    const backend = defaultPlan('backend')
    expect(backend.capabilities.documents).toMatchObject({ governed: true, profile: 'legacy-full' })
    expect(backend.workflow.openspec).toBe(true)
  })

  it('分支自己写的 spec 优先，没写的继承工作流顶层 openspec', () => {
    const plan = (over: Parameters<typeof branchWith>[0], top: { openspec?: true } = {}) =>
      compileEffectiveWorkflowPlan('demo', { ...branchWith(over), ...top }, { track: 'main' })
    expect(plan({ spec: 'openspec' }).capabilities.documents.governed).toBe(true)
    expect(plan({ spec: 'none' }, { openspec: true }).capabilities.documents.governed).toBe(false)
    expect(plan({}, { openspec: true }).capabilities.documents.governed).toBe(true)
    expect(plan({}).capabilities.documents.governed).toBe(false)
  })

  it('新计划一律 step-graph，包括 default', () => {
    expect(defaultPlan('backend').capabilities.execution.model).toBe('step-graph')
    expect(defaultPlan('backend').executionModel).toBe('step-graph')
    expect(defaultPlan('backend').skillPolicy).toBe('step-declared')
    expect(compileEffectiveWorkflowPlan('default', targetDefaultWorkflow(), { track: 'pm' }).executionModel).toBe('step-graph')
    expect(effectiveWorkflowPlanFromIr('design-system', compiledDesignSystem()).executionModel).toBe('step-graph')
  })

  it('旧快照恢复保留 phase-manifest 且指纹仍校验', () => {
    const snapshot = legacyV4Snapshot()
    const restored = effectiveWorkflowPlanFromSnapshot(snapshot, 'backend')
    expect(restored.capabilities.execution.model).toBe('phase-manifest')
    expect(restored.skillPolicy).toBe('manifest-overlay')
    expect(restored.workflowFingerprint).toBe(snapshot.workflowFingerprint)
    expect(workflowPlanSnapshot(restored)).toEqual(snapshot)
    expect(() => effectiveWorkflowPlanFromSnapshot({
      ...snapshot,
      workflow: { ...snapshot.workflow, steps: snapshot.workflow.steps.slice(1) },
    }, 'backend')).toThrow(DocumentGovernanceBindingError)
  })

  it('旧快照记着的轨道不在冻结定义里时不报错（平铺的旧 default 记着 chat / free）', () => {
    for (const track of ['chat', 'free', 'standard']) {
      expect(effectiveWorkflowPlanFromSnapshot(legacyV4Snapshot(), track).capabilities.track.id).toBe(track)
    }
  })

  it('旧引擎计划的自动化与 coverage 取旧表，分支自己声明了 automation 的以声明为准', () => {
    const legacy = (track: string, definition = legacyDefaultWorkflow()) =>
      compileEffectiveWorkflowPlan('default', definition, { track, executionModel: 'phase-manifest' })
    expect(legacy('pm').capabilities.automation).toEqual({ eligible: true, autoEnqueueOnSpecComplete: true })
    expect(legacy('pm').capabilities.track.coverageProfile).toBe('pm')
    expect(legacy('backend').capabilities.automation).toEqual({ eligible: true, autoEnqueueOnSpecComplete: false })
    // lite 分支声明了 `eligible: false`：旧表对没登记的轨道缺省可进 AFK，声明优先。
    expect(legacy('lite', targetDefaultWorkflow()).capabilities.automation).toEqual({ eligible: false, autoEnqueueOnSpecComplete: false })
  })

  it('步骤技能只来自 YAML，不叠加矩阵', () => {
    const plan = defaultPlan('backend')
    expect(requiredSkillsFor(plan, 'explore')).toEqual(['openspec-explore', 'brainstorming', 'grilling', 'domain-modeling', 'codebase-design'])
    expect(plan.capabilities.skills).not.toHaveProperty('trackOverlay')
  })

  it('automation 取分支声明；没声明的分支保守为不可进入 AFK', () => {
    expect(defaultPlan('pm').capabilities.automation).toEqual({ eligible: true, autoEnqueueOnSpecComplete: true })
    expect(defaultPlan('backend').capabilities.automation).toEqual({ eligible: true, autoEnqueueOnSpecComplete: false })
    expect(defaultPlan('lite').capabilities.automation).toEqual({ eligible: false, autoEnqueueOnSpecComplete: false })
    const undeclared = compileEffectiveWorkflowPlan('demo', branchWith(), { track: 'main' })
    expect(undeclared.capabilities.automation).toEqual({ eligible: false, autoEnqueueOnSpecComplete: false })
  })

  it('default 也只认分支自己的 automation 声明：没声明的分支（含名叫 pm / frontend / backend 的）不可进入 AFK', () => {
    // 过渡措施（default.yaml 还没写 automation 时沿用登记表的旧值）随 default.yaml 写入 automation 一起删除。
    const base = targetDefaultWorkflow()
    const tracks = base.tracks ?? {}
    const strip = ({ automation: _automation, ...rest }: NonNullable<typeof base.tracks>[string]) => rest
    const undeclared = {
      ...base,
      tracks: { pm: strip(tracks.pm!), frontend: strip(tracks.frontend!), backend: strip(tracks.backend!), devops: strip(tracks.backend!) },
    }
    const automationOf = (track: string) =>
      effectiveWorkflowPlanFromIr('default', compileDefaultWorkflow(undeclared), { track }).capabilities.automation
    for (const track of ['pm', 'frontend', 'backend', 'devops']) {
      expect(automationOf(track), track).toEqual({ eligible: false, autoEnqueueOnSpecComplete: false })
    }
  })

  it('轨道能力只带 id、旧表 coverage 与是否参与路由', () => {
    expect(defaultPlan('backend').capabilities.track).toEqual({ id: 'backend', coverageProfile: 'none', routingEnabled: true })
    expect(defaultPlan('pm').capabilities.track).toEqual({ id: 'pm', coverageProfile: 'none', routingEnabled: true })
    // 没写 route 的分支不参与自动路由。
    expect(compileEffectiveWorkflowPlan('demo', branchWith(), { track: 'main' }).capabilities.track)
      .toEqual({ id: 'main', coverageProfile: 'none', routingEnabled: false })
  })

  it('有分支的工作流不指定轨道或轨道不存在 → UnknownTrackError，不取第一条', () => {
    expect(() => effectiveWorkflowPlanFromIr('default', defaultIr())).toThrow(UnknownTrackError)
    expect(() => defaultPlan('chat')).toThrow(UnknownTrackError)
    let caught: unknown
    try { defaultPlan('free') } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(UnknownTrackError)
    expect((caught as UnknownTrackError).available).toEqual(['lite', 'pm', 'frontend', 'backend'])
  })

  it('平铺工作流只有一条隐式分支：任务记着的轨道不参与选择', () => {
    const named = effectiveWorkflowPlanFromIr('design-system', compiledDesignSystem(), { track: 'design-system' })
    const legacyTrack = effectiveWorkflowPlanFromIr('design-system', compiledDesignSystem(), { track: 'free' })
    expect(legacyTrack.workflowFingerprint).toBe(named.workflowFingerprint)
    expect(legacyTrack.capabilities.track.id).toBe('free')
    expect(effectiveWorkflowPlanFromIr('design-system', compiledDesignSystem()).capabilities.track.id).toBeNull()
  })

  it('executionModel 选项只改执行模型，不改工作流内容', () => {
    const graph = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow())
    const legacy = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow(), { executionModel: 'phase-manifest' })
    expect(legacy.workflow).toEqual(graph.workflow)
    expect(legacy.workflowFingerprint).not.toBe(graph.workflowFingerprint)
  })

  describe('requireRunPlan · 已存在任务的授权用计划', () => {
    const neverLoad = (): never => { throw new Error('有快照时不得回读现行定义') }
    const loadDefault = (name: string) => (name === 'default' ? defaultIr() : null)

    it('快照优先：旧引擎快照里的轨道按旧表判定，不回读现行定义', () => {
      const policyOf = (track: string) => planAutomationPolicy(requireRunPlan('default', track, legacyV4Snapshot(), neverLoad))
      expect(policyOf('pm')).toEqual({ automationEligible: true, autoEnqueueOnSpecComplete: true })
      expect(policyOf('backend')).toEqual({ automationEligible: true, autoEnqueueOnSpecComplete: false })
      expect(policyOf('standard')).toEqual({ automationEligible: false, autoEnqueueOnSpecComplete: false })
    })

    it('没有快照才读现行定义，策略位取分支声明', () => {
      expect(planAutomationPolicy(requireRunPlan('default', 'pm', undefined, loadDefault)))
        .toEqual({ automationEligible: true, autoEnqueueOnSpecComplete: true })
      expect(planAutomationPolicy(requireRunPlan('default', 'lite', undefined, loadDefault)))
        .toEqual({ automationEligible: false, autoEnqueueOnSpecComplete: false })
    })

    it('轨道不存在 → UnknownTrackError，工作流不存在 / 快照身份不一致 → 抛错，都不放行', () => {
      expect(() => requireRunPlan('default', 'chat', undefined, loadDefault)).toThrow(UnknownTrackError)
      expect(() => requireRunPlan('default', '', undefined, loadDefault)).toThrow(UnknownTrackError)
      expect(() => requireRunPlan('gone', 'alpha', undefined, () => null)).toThrow(/未找到/)
      expect(() => requireRunPlan('other', 'backend', legacyV4Snapshot(), neverLoad)).toThrow(DocumentGovernanceBindingError)
    })
  })

  it('lite 任务初始化不铺 proposal、不写文档台账；受治理的分支两者都有', async () => {
    const lite = await initRunInTemp({ workflow: 'default', track: 'lite' })
    const backend = await initRunInTemp({ workflow: 'default', track: 'backend' })
    try {
      expect(lite.files).not.toContain('proposal.md')
      expect(lite.files).not.toContain('.pipeline-documents.json')
      expect(backend.files).toContain('proposal.md')
      expect(backend.files).toContain('.pipeline-documents.json')
    } finally {
      await lite.cleanup()
      await backend.cleanup()
    }
  })
})
