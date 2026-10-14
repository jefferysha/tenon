import { describe, expect, it } from 'vitest'
import { compileEffectiveWorkflowPlan, workflowPlanSnapshot, type WorkflowDef } from '@tenon/kernel'
import { frozenProjectLayer, type FrozenRunRef } from './frozen-project-layer.js'

const step = { id: 'build', label: 'Build', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }

/** backend 声明可进 AFK，lite 没写 automation。 */
const DEFINITION: WorkflowDef = {
  name: 'demo',
  steps: [],
  tracks: {
    backend: { steps: [step], automation: { eligible: true, enqueueAfterSpec: true } },
    lite: { steps: [step] },
  },
}
const PLAN = compileEffectiveWorkflowPlan('demo', DEFINITION, { track: 'backend' })

const run = (over: Partial<FrozenRunRef> = {}): FrozenRunRef => ({
  workflowId: PLAN.id,
  workflowPlanFingerprint: PLAN.workflowFingerprint,
  workflowPlanSnapshot: workflowPlanSnapshot(PLAN),
  ...over,
})

describe('frozenProjectLayer · 项目层只读冻结计划里所选分支的 automation', () => {
  it('分支声明 eligible → 放行 enter-afk，并给出授权所依据的分支与计划修订', () => {
    expect(frozenProjectLayer(run(), 'backend')).toEqual({
      layer: { status: 'valid', grants: ['enter-afk'] },
      authority: { trackId: 'backend', revision: PLAN.workflowFingerprint.slice(0, 16) },
    })
  })

  it('分支没写 automation → 失败关闭：层有效但没有授权，也没有授权依据', () => {
    expect(frozenProjectLayer(run(), 'lite')).toEqual({ layer: { status: 'valid', grants: [] } })
  })

  it.each([
    ['任务没记轨道', undefined],
    ['任务轨道为空串', ''],
    ['冻结定义里没有该轨道', 'ghost'],
  ])('%s → malformed', (_label, trackId) => {
    expect(frozenProjectLayer(run(), trackId)).toEqual({ layer: { status: 'malformed', grants: [] } })
  })

  it('WorkflowRun 没带冻结快照 → missing（不回落到现行工作流定义）', () => {
    expect(frozenProjectLayer(run({ workflowPlanSnapshot: undefined }), 'backend'))
      .toEqual({ layer: { status: 'missing', grants: [] } })
  })

  it.each([
    ['计划指纹与 Run 绑定的不符', { workflowPlanFingerprint: 'f'.repeat(64) }],
    ['工作流 id 与 Run 绑定的不符', { workflowId: 'other' }],
  ] as const)('%s → fingerprint-mismatch', (_label, over) => {
    expect(frozenProjectLayer(run(over), 'backend'))
      .toEqual({ layer: { status: 'fingerprint-mismatch', grants: [] } })
  })

  it('被篡改的快照内容（指纹对不上）→ malformed，不放行', () => {
    const snapshot = workflowPlanSnapshot(PLAN)
    const forged = {
      ...snapshot,
      workflow: { ...snapshot.workflow, tracks: { ...snapshot.workflow.tracks, lite: {
        ...snapshot.workflow.tracks?.lite, automation: { eligible: true, enqueueAfterSpec: false },
      } } },
    } as typeof snapshot

    expect(frozenProjectLayer(run({ workflowPlanSnapshot: forged }), 'lite'))
      .toEqual({ layer: { status: 'malformed', grants: [] } })
  })

  describe('升级前创建、快照记着旧执行模型的在途 default 任务', () => {
    const legacy = (track: string): FrozenRunRef => {
      const plan = compileEffectiveWorkflowPlan('default', undefined, { track, executionModel: 'phase-manifest' })
      return {
        workflowId: plan.id,
        workflowPlanFingerprint: plan.workflowFingerprint,
        workflowPlanSnapshot: workflowPlanSnapshot(plan),
      }
    }

    it('按旧表给的策略位判定：backend 仍可进 AFK', () => {
      expect(frozenProjectLayer(legacy('backend'), 'backend').layer).toEqual({ status: 'valid', grants: ['enter-afk'] })
    })
  })
})
