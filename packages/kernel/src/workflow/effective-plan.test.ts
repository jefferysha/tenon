import { describe, expect, it } from 'vitest'
import {
  compileEffectiveWorkflowPlan,
  documentGovernanceFingerprint,
  DocumentGovernanceBindingError,
  effectiveWorkflowPlanFromSnapshot,
  effectiveWorkflowPlanBinding,
  resolveBoundEffectiveWorkflowPlan,
  workflowPlanSnapshot,
} from './effective-plan.js'
import { builtinTrack } from '../tracks/builtins.js'
import { legacyDefaultWorkflow } from './test-support.js'

function preVerifyConvergenceWorkflow() {
  const current = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow()).workflow
  const {
    decomposition: _decomposition,
    interaction: _interaction,
    reviewBudget: _reviewBudget,
    // Historical bytes predate the openspec key and YAML-declared document contracts.
    openspec: _openspec,
    documentContract: _documentContract,
    ...legacy
  } = current
  return {
    ...legacy,
    steps: legacy.steps.map((step) => {
      // Historical bytes also predate step tests (2026-09 per-step test evidence).
      const { reviewLanes: _reviewLanes, tests: _tests, ...legacyStep } = step
      return {
        ...legacyStep,
        // The last step was labelled 归档 before the 完结 wording.
        label: step.id === 'archive' ? '归档' : step.label,
        // This fixture intentionally models the pre-issue#43 frozen snapshot, whose
        // default Workflow steps had no Workflow-owned phase Skills and whose ship/archive
        // steps declared no inputs/outputs (pr_url / archived were added in 2026-09).
        skills: [],
        inputs: step.id === 'ship' || step.id === 'archive' ? [] : step.inputs,
        outputs: step.id === 'ship' || step.id === 'archive' ? [] : step.outputs,
        guards: step.id === 'build'
          ? step.guards.filter((guard) =>
              !(guard.type === 'field-equals' && guard.field === 'pre_verify_review_result'))
          : step.guards,
        transitions: step.transitions.map((transition) => ({
          ...transition,
          actions: transition.actions.filter((action) =>
            action.type !== 'reset-pre-verify-review'
              && !(step.id === 'verify'
                && transition.event === 'verify-fail'
                && action.type === 'mark-verification-failed')),
        })),
      }
    }),
  }
}

describe('compileEffectiveWorkflowPlan', () => {
  it('compiles the pre-matrix default through the shared immutable plan surface (manifest-overlay)', () => {
    const plan = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow(), builtinTrack('backend'))
    expect(plan.executionModel).toBe('phase-manifest')
    expect(plan.projection.steps.map((step) => step.id)).toEqual([
      'open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive',
    ])
    expect(plan.documentPolicy?.id).toBe('openspec-v1')
    expect(plan.skillPolicy).toBe('manifest-overlay')
    expect(plan.capabilities).toMatchObject({
      execution: { model: 'phase-manifest' },
      skills: {
        source: 'manifest-overlay',
        trackOverlay: { matrix: true, profile: 'backend' },
      },
      documents: { profile: 'legacy-full', governed: true },
      review: { steps: ['explore', 'spec', 'verify'] },
      automation: { eligible: true, autoEnqueueOnSpecComplete: false },
      track: { id: 'backend', coverageProfile: 'backend' },
    })
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
    }, builtinTrack('frontend'))
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

  it('writes self-contained v3 snapshots with their frozen document policy and workflow policies', () => {
    const plan = compileEffectiveWorkflowPlan('v3-policy', {
      name: 'v3-policy',
      interaction: { version: 'v1', mode: 'recommended-defaults' },
      steps: [{ id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    const snapshot = workflowPlanSnapshot(plan)

    expect(snapshot.version).toBe(3)
    if (snapshot.version !== 3) throw new Error('expected v3 workflow snapshot')
    expect(snapshot.documentPolicy).toEqual(plan.documentPolicy ?? null)
    expect(snapshot.decomposition).toEqual(plan.decomposition)
    expect(snapshot.interaction).toEqual(plan.interaction)
    expect(effectiveWorkflowPlanFromSnapshot(snapshot).workflowFingerprint)
      .toBe(plan.workflowFingerprint)
  })

  it('free is an explicit neutral overlay and never removes workflow-owned policy', () => {
    const plan = compileEffectiveWorkflowPlan('default', undefined, builtinTrack('free'))

    expect(plan.projection.steps).toHaveLength(7)
    expect(plan.documentPolicy?.id).toBe('openspec-v1')
    expect(plan.capabilities.track).toEqual({
      id: 'free',
      coverageProfile: 'none',
      routingEnabled: false,
    })
    expect(plan.capabilities.skills.trackOverlay).toEqual({ matrix: false, profile: 'free' })
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
