import { describe, expect, it } from 'vitest'
import { compileWorkflow } from './compile.js'
import { compileEffectiveWorkflowPlan, effectiveWorkflowPlanFromIr } from './effective-plan.js'
import { stepRequiredOutputs } from './required-outputs.js'
import type { StepDef, WorkflowDef, WorkflowGuardConfig } from './types.js'

/** 真 default 的某条轨道的计划（必须产出写在 default.yaml 里）。 */
const defaultPlan = (track: string) => compileEffectiveWorkflowPlan('default', undefined, { track })

const bare = (id: string, over: Partial<StepDef> = {}): StepDef =>
  ({ id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...over })

/** 手写一条三步工作流：步骤自己、前进边、回退边、放弃边上都可以挂 required-output。 */
function customPlan(extra: {
  readonly stepGuards?: readonly WorkflowGuardConfig[]
  readonly forwardGuards?: readonly WorkflowGuardConfig[]
  readonly backGuards?: readonly WorkflowGuardConfig[]
  readonly abandonGuards?: readonly WorkflowGuardConfig[]
}) {
  const definition: WorkflowDef = {
    name: 'custom',
    steps: [
      bare('draft', {
        guards: extra.stepGuards ?? [],
        transitions: [
          { event: 'draft-done', to: 'review', guards: extra.forwardGuards ?? [] },
          { event: 'scope-expanded', to: 'escalated', guards: extra.abandonGuards ?? [], actions: [{ type: 'archive-run' }] },
        ],
      }),
      bare('review', { transitions: [{ event: 'review-fail', to: 'draft', guards: extra.backGuards ?? [] }] }),
      bare('escalated'),
    ],
  }
  return effectiveWorkflowPlanFromIr('custom', compileWorkflow(definition))
}

const out = (path: string, when?: { kind: 'track-in' | 'track-not-in'; values: string[] }): WorkflowGuardConfig =>
  ({ type: 'required-output', path, ...(when === undefined ? {} : { when }) })

describe('stepRequiredOutputs（内建 default 的必须产出）', () => {
  it('后端轨道逐步取出：立项 / 调研 / 规格（delta spec 在前、计划在后）/ 验证报告（在 verify-pass 边上）', () => {
    const plan = defaultPlan('backend')
    expect(stepRequiredOutputs(plan, 'open', 'backend')).toEqual(['openspec/changes/{change}/proposal.md'])
    expect(stepRequiredOutputs(plan, 'explore', 'backend')).toEqual(['docs/superpowers/specs/*.md'])
    expect(stepRequiredOutputs(plan, 'spec', 'backend')).toEqual([
      'openspec/changes/{change}/specs/*/spec.md',
      'docs/superpowers/plans/*.md',
    ])
    expect(stepRequiredOutputs(plan, 'verify', 'backend')).toEqual(['docs/superpowers/reports/{change}-verify.md'])
  })

  it('没有声明必须产出的步骤得到空表', () => {
    const plan = defaultPlan('backend')
    expect(stepRequiredOutputs(plan, 'build', 'backend')).toEqual([])
    expect(stepRequiredOutputs(plan, 'ship', 'backend')).toEqual([])
  })

  it('产品轨道的规格步只有 delta spec，没有计划', () => {
    expect(stepRequiredOutputs(defaultPlan('pm'), 'spec', 'pm')).toEqual(['openspec/changes/{change}/specs/*/spec.md'])
  })

  it('轻量轨道不声明任何必须产出', () => {
    const plan = defaultPlan('lite')
    for (const step of plan.workflow.steps) expect(stepRequiredOutputs(plan, step.id, 'lite'), step.id).toEqual([])
  })

  it('步骤不存在 → 空表，而不是抛', () => {
    expect(stepRequiredOutputs(defaultPlan('backend'), 'nope', 'backend')).toEqual([])
  })
})

describe('stepRequiredOutputs（取法）', () => {
  it('步骤自己的守卫在前、前进边的守卫在后；同一个模式只留第一次', () => {
    const plan = customPlan({
      stepGuards: [out('a/*.md'), out('b/*.md')],
      forwardGuards: [out('b/*.md'), out('c/*.md')],
    })
    expect(stepRequiredOutputs(plan, 'draft', 'backend')).toEqual(['a/*.md', 'b/*.md', 'c/*.md'])
  })

  it('回退边上的守卫也算（它们同样是这一步的离开条件）', () => {
    const plan = customPlan({ backGuards: [out('review/report.md')] })
    expect(stepRequiredOutputs(plan, 'review', 'backend')).toEqual(['review/report.md'])
  })

  it('放弃边上的守卫不算：任务要被放弃了，没写完的产出不该拦它', () => {
    const plan = customPlan({ abandonGuards: [out('never/*.md')], forwardGuards: [out('kept/*.md')] })
    expect(stepRequiredOutputs(plan, 'draft', 'backend')).toEqual(['kept/*.md'])
  })

  it('带 when 的守卫按轨道过滤：命中才算', () => {
    const plan = customPlan({
      stepGuards: [
        out('only-backend/*.md', { kind: 'track-in', values: ['backend'] }),
        out('not-pm/*.md', { kind: 'track-not-in', values: ['pm'] }),
        out('always/*.md'),
      ],
    })
    expect(stepRequiredOutputs(plan, 'draft', 'backend')).toEqual(['only-backend/*.md', 'not-pm/*.md', 'always/*.md'])
    expect(stepRequiredOutputs(plan, 'draft', 'pm')).toEqual(['always/*.md'])
    expect(stepRequiredOutputs(plan, 'draft', 'frontend')).toEqual(['not-pm/*.md', 'always/*.md'])
  })

  it('其余类型的守卫不会混进来', () => {
    const plan = customPlan({ stepGuards: [{ type: 'tasks-through-step' }, out('x/*.md')] })
    expect(stepRequiredOutputs(plan, 'draft', 'backend')).toEqual(['x/*.md'])
  })
})
