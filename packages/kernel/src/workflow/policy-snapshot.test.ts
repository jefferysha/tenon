import { describe, expect, it } from 'vitest'
import { legacyDefaultWorkflow } from './test-support.js'
import { LEGACY_DOCUMENT_GOVERNANCE_POLICY } from './migrations/openspec-v1-document-policy.js'
import { builtinTrack } from '../tracks/builtins.js'
import {
  compileEffectiveWorkflowPlan,
  DocumentGovernanceBindingError,
  effectiveWorkflowPlanFromSnapshot,
  workflowPlanSnapshot,
} from './effective-plan.js'
import { DEFAULT_WORKFLOW_DECOMPOSITION_POLICY } from './policy.js'

describe('workflow policy snapshot v4', () => {
  it('freezes default policies in the self-contained V4 projection', () => {
    const plan = compileEffectiveWorkflowPlan('default')
    const snapshot = workflowPlanSnapshot(plan)

    expect(snapshot.version).toBe(4)
    if (snapshot.version !== 4) throw new Error('expected v4 snapshot')
    expect(snapshot).not.toHaveProperty('reviewBudget')
    expect(snapshot.decomposition).toEqual(DEFAULT_WORKFLOW_DECOMPOSITION_POLICY)
    expect(snapshot.interaction).toEqual({ version: 'v1', mode: 'interactive' })
    expect(effectiveWorkflowPlanFromSnapshot(snapshot).workflow.decomposition)
      .toEqual(DEFAULT_WORKFLOW_DECOMPOSITION_POLICY)
    expect(effectiveWorkflowPlanFromSnapshot(snapshot).workflowFingerprint)
      .toBe(snapshot.workflowFingerprint)
  })

  it('keeps a custom workflow with default policies self-contained in V4', () => {
    const snapshot = workflowPlanSnapshot(compileEffectiveWorkflowPlan('custom-default-policy', {
      name: 'custom-default-policy',
      steps: [{
        id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [],
      }],
    }))

    expect(snapshot.version).toBe(4)
    if (snapshot.version !== 4) throw new Error('expected v4 snapshot')
    expect(snapshot.decomposition).toEqual(DEFAULT_WORKFLOW_DECOMPOSITION_POLICY)
    expect(snapshot.interaction).toEqual({ version: 'v1', mode: 'interactive' })
  })

  it('freezes step agents in V4', () => {
    const plan = compileEffectiveWorkflowPlan('step-agents', {
      name: 'step-agents',
      steps: [{
        id: 'verify', label: 'Verify', gate: 'review',
        skills: [{ id: 'test-driven-development' }],
        agents: {
          executors: [],
          reviewers: [{ agent: 'security', required: true, block_at: 'medium' }],
        },
        inputs: [], outputs: [], guards: [], transitions: [],
      }],
    })
    const snapshot = workflowPlanSnapshot(plan)
    if (snapshot.version !== 4) throw new Error('expected v4 snapshot')

    expect(snapshot.workflow.steps[0]?.agents?.reviewers)
      .toEqual([{ agent: 'security', required: true, block_at: 'medium' }])
    expect(effectiveWorkflowPlanFromSnapshot(snapshot).capabilities.agents.steps)
      .toEqual([{
        stepId: 'verify',
        executors: [],
        reviewers: [{ agent: 'security', required: true, blockAt: 'medium', dependsOn: [], readsTests: [] }],
      }])
  })

  it('changes the workflow fingerprint for policy changes but not Track overlay changes', () => {
    const base = compileEffectiveWorkflowPlan('policy-fingerprint', {
      name: 'policy-fingerprint',
      steps: [{
        id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [],
      }],
    })
    const changed = compileEffectiveWorkflowPlan('policy-fingerprint', {
      name: 'policy-fingerprint',
      interaction: { version: 'v1', mode: 'recommended-defaults' },
      steps: [{
        id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [],
      }],
    })
    const trackChanged = compileEffectiveWorkflowPlan('policy-fingerprint', {
      name: 'policy-fingerprint',
      steps: [{
        id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [],
      }],
    }, builtinTrack('backend'))

    expect(changed.workflowFingerprint).not.toBe(base.workflowFingerprint)
    expect(trackChanged.workflowFingerprint).toBe(base.workflowFingerprint)
  })

  it('rejects V4 policy tampering even when only the redundant frozen policy field changes', () => {
    const snapshot = workflowPlanSnapshot(compileEffectiveWorkflowPlan('policy-v4', {
      name: 'policy-v4',
      interaction: { version: 'v1', mode: 'afk' },
      steps: [{ id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    }))
    if (snapshot.version !== 4) throw new Error('expected v4 snapshot')

    expect(() => effectiveWorkflowPlanFromSnapshot({
      ...snapshot,
      interaction: { version: 'v1', mode: 'recommended-defaults' },
    })).toThrow(DocumentGovernanceBindingError)
  })

  it('validates historical V2 with its old hash before projecting safe defaults without rehashing', () => {
    const current = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow())
    const {
      decomposition: _decomposition,
      interaction: _interaction,
      // Historical bytes predate the openspec key and YAML-declared document contracts.
      openspec: _openspec,
      documentContract: _documentContract,
      ...currentWithoutPolicies
    } = current.workflow
    const legacyWorkflow = {
      ...currentWithoutPolicies,
      // Historical V2 bytes predate issue #43; default phase Skills were not persisted.
      // Historical bytes also predate step tests (2026-09 per-step test evidence) and step prompts
      // (the frontend branch gained them with DESIGN.md).
      steps: currentWithoutPolicies.steps.map(({ tests: _tests, prompt: _prompt, agents: _agents, ...step }) => ({
        ...step,
        label: step.id === 'archive' ? '归档' : step.label,
        skills: [],
        // Historical bytes also predate the 2026-09 ship/archive inputs/outputs (pr_url / archived).
        inputs: step.id === 'ship' || step.id === 'archive' ? [] : step.inputs,
        outputs: step.id === 'ship' || step.id === 'archive' ? [] : step.outputs,
      })),
    }
    const restored = effectiveWorkflowPlanFromSnapshot({
      version: 2,
      workflowId: 'default',
      executionModel: 'phase-manifest',
      workflow: legacyWorkflow,
      // 历史字节里的文档表就是迁移表本身（前端分支后来才加 design-md 槽位）。
      documentPolicy: LEGACY_DOCUMENT_GOVERNANCE_POLICY,
      workflowFingerprint: 'e0a5f815ec73ffe72c082ed7ca4b2f92ede3623d6d2ccdbe8bde97ceb678e35f',
    })

    expect(restored.workflowFingerprint)
      .toBe('e0a5f815ec73ffe72c082ed7ca4b2f92ede3623d6d2ccdbe8bde97ceb678e35f')
    expect(restored.workflow.decomposition.mode).toBe('off')
    expect(restored.workflow.interaction.mode).toBe('interactive')

    const persistedAgain = workflowPlanSnapshot(restored)
    expect(persistedAgain.version).toBe(2)
    const restoredAgain = effectiveWorkflowPlanFromSnapshot(persistedAgain)
    expect(restoredAgain.workflowFingerprint).toBe(restored.workflowFingerprint)
    expect(restoredAgain.workflow.decomposition.mode).toBe('off')
  })
})
