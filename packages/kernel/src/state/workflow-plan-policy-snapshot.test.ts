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
})
