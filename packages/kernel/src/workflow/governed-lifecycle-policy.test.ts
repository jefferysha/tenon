import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { emptyFields } from '../state/parse.js'
import { compileWorkflow } from './compile.js'
import { effectiveWorkflowPlanFromIr } from './effective-plan.js'
import { effectiveLifecyclePolicy, governedLifecyclePolicy } from './governed-lifecycle-policy.js'
import { compiledDefault } from './test-support.js'
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

  test('受治理的固定政策不再继承已退役的规则（build_mode / isolation / direct_override / branch_status）', () => {
    const retired = new Set(['build_mode', 'isolation', 'direct_override', 'branch_status'])
    for (const [from, to] of [['spec', 'build'], ['build', 'verify'], ['verify', 'ship'], ['verify', 'build'], ['ship', 'archive']] as const) {
      const guards = governedLifecyclePolicy(true, from, to)?.guards ?? []
      for (const guard of guards) {
        expect(guard.type, `${from}→${to}`).not.toBe('full-direct-override')
        if ('field' in guard) expect(retired.has(guard.field), `${from}→${to} ${guard.type}:${guard.field}`).toBe(false)
      }
    }
  })

  test('固定政策仍要求实现前评审通过并冻结 build_sha；验证通过要求报告存在、build 后未改动并记验证通过', () => {
    expect(governedLifecyclePolicy(true, 'build', 'verify')).toEqual({
      guards: [{ type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' }],
      actions: [{ type: 'freeze-build-sha' }],
    })
    expect(governedLifecyclePolicy(true, 'verify', 'ship')).toEqual({
      guards: [
        { type: 'file-exists', path: { kind: 'field', field: 'verification_report' } },
        { type: 'build-head-unchanged', field: 'build_sha' },
      ],
      actions: [{ type: 'mark-verification-passed' }],
    })
    expect(governedLifecyclePolicy(false, 'build', 'verify')).toBeUndefined()
  })

  test('内建 default 的受治理分支：YAML 写明的离开条件与固定政策去重，每条出边的守卫都不重复', () => {
    const ir = compiledDefault()
    for (const id of ['pm', 'frontend', 'backend']) {
      const steps = ir.tracks?.[id]?.steps ?? []
      for (const step of steps) {
        for (const edge of step.transitions) {
          const guards = effectiveLifecyclePolicy(true, step, edge, steps.find((candidate) => candidate.id === edge.to)).guards
          const keys = guards.map((guard) => JSON.stringify(guard))
          expect(new Set(keys).size, `${id}.${step.id}.${edge.event}: ${keys.join(' | ')}`).toBe(keys.length)
        }
      }
    }
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
