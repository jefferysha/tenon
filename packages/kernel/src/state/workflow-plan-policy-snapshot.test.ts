import { describe, expect, it } from 'vitest'
import { compileEffectiveWorkflowPlan, workflowPlanSnapshot } from '../workflow/effective-plan.js'
import { parseWorkflowPlanSnapshot, workflowPlanSnapshotContent } from './workflow-plan-snapshot.js'

describe('workflow plan policy snapshot codec', () => {
  it('parses the self-contained V4 sidecar for default policies', () => {
    const snapshot = workflowPlanSnapshot(compileEffectiveWorkflowPlan('default'))
    const envelope = parseWorkflowPlanSnapshot(workflowPlanSnapshotContent('run-1', snapshot))

    expect(envelope.plan.version).toBe(4)
    if (envelope.plan.version !== 4) throw new Error('expected v4')
    expect(envelope.plan.decomposition).toBeDefined()
    expect(envelope.plan.interaction).toBeDefined()
  })

  it('rejects unknown V4 sidecar fields', () => {
    const snapshot = workflowPlanSnapshot(compileEffectiveWorkflowPlan('nondefault-policy', {
      name: 'nondefault-policy',
      interaction: { version: 'v1', mode: 'recommended-defaults' },
      steps: [{ id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    }))
    expect(() => parseWorkflowPlanSnapshot(JSON.stringify({
      version: 1,
      run_id: 'run-1',
      plan: { ...snapshot, surprise: true },
    }))).toThrow(/形状非法/)
  })

  it('a plan that already verified is not rebuilt (also under another run id), but different content with the same claimed fingerprint still fails', () => {
    const snapshot = workflowPlanSnapshot(compileEffectiveWorkflowPlan('memo-policy', {
      name: 'memo-policy',
      steps: [{ id: 'one', label: 'One', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    }))
    const text = workflowPlanSnapshotContent('run-verified', snapshot)
    expect(parseWorkflowPlanSnapshot(text).plan.workflowFingerprint).toBe(snapshot.workflowFingerprint)
    expect(parseWorkflowPlanSnapshot(text).plan.workflowFingerprint).toBe(snapshot.workflowFingerprint)
    expect(parseWorkflowPlanSnapshot(workflowPlanSnapshotContent('run-other', snapshot)).run_id).toBe('run-other')
    // Same claimed fingerprint, different content: the remembered plan must not vouch for it.
    const first = snapshot.workflow.steps[0]
    if (first === undefined) throw new Error('the custom workflow has one step')
    const forged = { ...snapshot, workflow: { ...snapshot.workflow, steps: [{ ...first, label: 'One (edited)' }] } }
    expect(() => parseWorkflowPlanSnapshot(workflowPlanSnapshotContent('run-verified', forged))).toThrow(/不一致/)
    expect(() => parseWorkflowPlanSnapshot(workflowPlanSnapshotContent('run-verified', forged))).toThrow(/不一致/)
  })
})
