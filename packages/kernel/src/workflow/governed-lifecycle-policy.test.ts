import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { emptyFields } from '../state/parse.js'
import { compileWorkflow } from './compile.js'
import { effectiveWorkflowPlanFromIr } from './effective-plan.js'
import { effectiveLifecyclePolicy, governedLifecyclePolicy } from './governed-lifecycle-policy.js'
import { readinessByTransition } from './transition-readiness.js'
import type { WorkflowDef } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function governedWorkflow(): WorkflowDef {
  return {
    name: 'governed',
    openspec: true,
    steps: [
      {
        id: 'spec', label: 'Spec', gate: null, skills: [], inputs: [], outputs: [], guards: [],
        transitions: [{ event: 'start-build', to: 'build' }],
      },
      {
        id: 'build', label: 'Build', gate: null, skills: [], inputs: [],
        outputs: [{ field: 'build_sha', type: 'string' }], guards: [],
        transitions: [
          { event: 'complete', to: 'verify' },
          { event: 'revise', to: 'spec' },
        ],
      },
      {
        id: 'verify', label: 'Verify', gate: 'review', skills: [],
        inputs: [{ field: 'build_sha', type: 'string' }], outputs: [],
        guards: [{ type: 'build-head-unchanged', field: 'build_sha' }],
        transitions: [
          { event: 'accept', to: 'ship' },
          // Governed rollback is inherited even when a custom YAML omits the action.
          { event: 'reject', to: 'build' },
        ],
      },
      {
        id: 'ship', label: 'Ship', gate: null, skills: [], inputs: [], outputs: [], guards: [],
        transitions: [],
      },
    ],
  }
}

describe('governed custom lifecycle 单一政策', () => {
  test('spec/build 回环都重置旧 pre-Verify pass', () => {
    expect(governedLifecyclePolicy(true, 'spec', 'build')?.actions)
      .toEqual([{ type: 'reset-pre-verify-review' }])
    expect(governedLifecyclePolicy(true, 'build', 'spec')?.actions)
      .toEqual([{ type: 'reset-pre-verify-review' }])
  })

  test('readiness 与真实 transition 同样合并 pre-Verify gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-governed-readiness-'))
    roots.push(root)
    const fields = emptyFields()
    Object.assign(fields, {
      phase: 'build',
      track: 'backend',
      build_mode: 'direct',
      isolation: 'in-place',
      direct_override: 'true',
      pre_verify_review_result: 'pending',
    })
    const plan = effectiveWorkflowPlanFromIr(
      'governed',
      compileWorkflow(governedWorkflow()),
    )

    expect((await readinessByTransition(plan, {
      fields,
      opaqueTail: '',
    }, { changeDirAbs: root })).build?.complete).toEqual({
      ready: false,
      blockers: [{
        kind: 'guard-failed',
        guardType: 'field-equals',
        field: 'pre_verify_review_result',
        actual: 'pending',
        expected: ['pass'],
      }],
    })
  })

  test('governed custom rollback 未声明 action 仍不注入 revision guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-governed-rollback-readiness-'))
    roots.push(root)
    const fields = emptyFields()
    Object.assign(fields, {
      phase: 'verify',
      track: 'backend',
      isolation: 'in-place',
      build_sha: 'malformed-legacy-value',
      review_gate_phase: 'verify',
      review_gate_status: 'approved',
      review_gate_event: 'reject',
    })
    const plan = effectiveWorkflowPlanFromIr(
      'governed',
      compileWorkflow(governedWorkflow()),
    )

    let assessorCalls = 0
    const readiness = await readinessByTransition(plan, {
      fields,
      opaqueTail: '',
    }, {
      changeDirAbs: root,
      assessBuildRevision: async () => {
        assessorCalls += 1
        return { trusted: false, blocker: { kind: 'verify-build-revision-untrusted', code: 'verify-build-revision-untrusted', reason: 'revision-stale', remediation: 'return-to-build-and-capture-current-revision' } }
      },
    })

    expect(readiness.verify?.reject).toEqual({ ready: true, blockers: [] })
    expect(assessorCalls).toBe(1)
    expect(readiness.verify?.accept?.ready).toBe(false)
    expect(readiness.verify?.accept?.blockers).toContainEqual(
      expect.objectContaining({ code: 'verify-build-revision-untrusted' }),
    )
  })

  test('effective edge policy removes explicit revision guards only on rollback and deduplicates success', () => {
    const workflow: WorkflowDef = {
      name: 'edge-aware',
      steps: [
        {
          id: 'assure', label: 'Assure', gate: 'review', skills: [],
          inputs: [{ field: 'build_sha', type: 'string' }], outputs: [],
          guards: [
            { type: 'build-head-unchanged', field: 'build_sha' },
            { type: 'field-equals', field: 'branch_status', value: 'handled' },
          ],
          transitions: [
            {
              event: 'pass', to: 'ship',
              guards: [{ type: 'build-head-unchanged', field: 'build_sha' }],
              actions: [
                { type: 'reset-pre-verify-review' },
                { type: 'reset-pre-verify-review' },
              ],
            },
            {
              event: 'rollback', to: 'implement',
              guards: [
                { type: 'build-head-unchanged', field: 'build_sha' },
                { type: 'field-nonempty', field: 'verification_report' },
              ],
              actions: [{ type: 'mark-verification-failed' }],
            },
          ],
        },
        { id: 'implement', label: 'Implement', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        { id: 'ship', label: 'Ship', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }
    const ir = compileWorkflow(workflow)
    const assure = ir.steps.find((step) => step.id === 'assure')!
    const success = assure.transitions.find((edge) => edge.event === 'pass')!
    const rollback = assure.transitions.find((edge) => edge.event === 'rollback')!

    expect(effectiveLifecyclePolicy(false, assure, success, ir.steps.find((step) => step.id === 'ship'))).toEqual({
      rollback: false,
      guards: [
        { type: 'build-head-unchanged', field: 'build_sha' },
        { type: 'field-equals', field: 'branch_status', value: 'handled' },
      ],
      actions: [{ type: 'reset-pre-verify-review' }],
    })
    expect(effectiveLifecyclePolicy(false, assure, rollback, ir.steps.find((step) => step.id === 'implement'))).toEqual({
      rollback: true,
      guards: [
        { type: 'field-equals', field: 'branch_status', value: 'handled' },
        { type: 'field-nonempty', field: 'verification_report' },
      ],
      actions: [{ type: 'mark-verification-failed' }],
    })
  })
})
