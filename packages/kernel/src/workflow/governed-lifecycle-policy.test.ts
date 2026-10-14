import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { emptyFields } from '../state/parse.js'
import { compileWorkflow } from './compile.js'
import { effectiveWorkflowPlanFromIr } from './effective-plan.js'
import { effectiveLifecyclePolicy, governedLifecyclePolicy } from './governed-lifecycle-policy.js'
import { compiledDefault, legacyContractDefaultIr } from './test-support.js'
import { readinessByTransition } from './transition-readiness.js'
import type { WorkflowDef } from './types.js'

const roots: string[] = []

/** 走 OpenSpec 生命周期且冻结计划带旧文档契约（升级前创建的任务）。 */
const CONTRACT = { governed: true, contract: true } as const
/** 走 OpenSpec 生命周期，没有文档契约（新任务的观察模式）。 */
const OBSERVED = { governed: true, contract: false } as const
const UNGOVERNED = { governed: false, contract: false } as const

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
    expect(governedLifecyclePolicy(CONTRACT, 'spec', 'build')?.actions)
      .toEqual([{ type: 'reset-pre-verify-review' }])
    expect(governedLifecyclePolicy(CONTRACT, 'build', 'spec')?.actions)
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
      const guards = governedLifecyclePolicy(CONTRACT, from, to)?.guards ?? []
      for (const guard of guards) {
        expect(guard.type, `${from}→${to}`).not.toBe('full-direct-override')
        if ('field' in guard) expect(retired.has(guard.field), `${from}→${to} ${guard.type}:${guard.field}`).toBe(false)
      }
    }
  })

  test('固定政策仍要求实现前评审通过并冻结 build_sha；验证通过要求报告存在、build 后未改动并记验证通过', () => {
    expect(governedLifecyclePolicy(CONTRACT, 'build', 'verify')).toEqual({
      guards: [{ type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' }],
      actions: [{ type: 'freeze-build-sha' }],
    })
    expect(governedLifecyclePolicy(CONTRACT, 'verify', 'ship')).toEqual({
      guards: [
        { type: 'file-exists', path: { kind: 'field', field: 'verification_report' } },
        { type: 'build-head-unchanged', field: 'build_sha' },
      ],
      actions: [{ type: 'mark-verification-passed' }],
    })
    expect(governedLifecyclePolicy(UNGOVERNED, 'build', 'verify')).toBeUndefined()
  })

  test('没有文档契约（观察模式）时不再注入引用文档字段的 file-exists，其余固定政策照旧', () => {
    // spec>build 只剩重置实现前评审：plan 字段在新任务里没有人登记，必须产出由 YAML 里的 required-output 声明。
    expect(governedLifecyclePolicy(OBSERVED, 'spec', 'build')).toEqual({ guards: [], actions: [{ type: 'reset-pre-verify-review' }] })
    expect(governedLifecyclePolicy(OBSERVED, 'verify', 'ship')).toEqual({
      guards: [{ type: 'build-head-unchanged', field: 'build_sha' }],
      actions: [{ type: 'mark-verification-passed' }],
    })
    // 实现前评审、冻结 build 修订、验证标记、主规格迁移仍按 governed 注入。
    expect(governedLifecyclePolicy(OBSERVED, 'build', 'verify')).toEqual(governedLifecyclePolicy(CONTRACT, 'build', 'verify'))
    expect(governedLifecyclePolicy(OBSERVED, 'build', 'spec')).toEqual(governedLifecyclePolicy(CONTRACT, 'build', 'spec'))
    expect(governedLifecyclePolicy(OBSERVED, 'verify', 'build')).toEqual(governedLifecyclePolicy(CONTRACT, 'verify', 'build'))
    expect(governedLifecyclePolicy(OBSERVED, 'ship', 'archive')).toEqual({ guards: [{ type: 'spec-migration-applied' }], actions: [] })
    // 契约模式与改前一致。
    expect(governedLifecyclePolicy(CONTRACT, 'spec', 'build')?.guards).toEqual([
      { type: 'file-exists', path: { kind: 'field', field: 'plan' }, when: expect.anything() },
    ])
  })

  test('内建 default 的观察模式：fixed 政策不往出边里塞 file-exists plan / verification_report', () => {
    const ir = compiledDefault()
    for (const id of ['pm', 'frontend', 'backend']) {
      const steps = ir.tracks?.[id]?.steps ?? []
      for (const step of steps) {
        for (const edge of step.transitions) {
          const guards = effectiveLifecyclePolicy(OBSERVED, step, edge, steps.find((candidate) => candidate.id === edge.to)).guards
          const fieldFiles = guards.filter((guard) => guard.type === 'file-exists')
            .map((guard) => (guard.type === 'file-exists' && guard.path.kind === 'field' ? guard.path.field : ''))
          expect(fieldFiles.filter((field) => field === 'plan' || field === 'verification_report'), `${id}.${step.id}.${edge.event}`).toEqual([])
        }
      }
    }
  })

  test('升级前的 default（契约模式）：YAML 写明的离开条件与固定政策去重，每条出边的守卫都不重复', () => {
    const ir = legacyContractDefaultIr()
    for (const id of ['pm', 'frontend', 'backend']) {
      const steps = ir.tracks?.[id]?.steps ?? []
      for (const step of steps) {
        for (const edge of step.transitions) {
          const guards = effectiveLifecyclePolicy(CONTRACT, step, edge, steps.find((candidate) => candidate.id === edge.to)).guards
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

    expect(effectiveLifecyclePolicy(UNGOVERNED, assure, success, ir.steps.find((step) => step.id === 'ship'))).toEqual({
      rollback: false,
      guards: [
        { type: 'build-head-unchanged', field: 'build_sha' },
        { type: 'field-equals', field: 'branch_status', value: 'handled' },
      ],
      actions: [{ type: 'reset-pre-verify-review' }],
    })
    expect(effectiveLifecyclePolicy(UNGOVERNED, assure, rollback, ir.steps.find((step) => step.id === 'implement'))).toEqual({
      rollback: true,
      guards: [
        { type: 'field-equals', field: 'branch_status', value: 'handled' },
        { type: 'field-nonempty', field: 'verification_report' },
      ],
      actions: [{ type: 'mark-verification-failed' }],
    })
  })
})
