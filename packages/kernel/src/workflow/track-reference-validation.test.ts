import { describe, expect, it } from 'vitest'
import { templateWorkflowDefinition } from './template-workflows.js'
import { validateWorkflowTrackReferences } from './track-reference-validation.js'
import type { StepDef, WorkflowDef } from './types.js'

const END: StepDef = { id: 'archive', label: 'Archive', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }

function buildStep(refs: { readonly guard: readonly string[]; readonly edge: readonly string[]; readonly artifact: readonly string[] }): StepDef {
  return {
    id: 'build', label: 'Build', gate: null, skills: [], inputs: [],
    outputs: [{ field: 'plan', type: 'file_path' }],
    artifacts: [{
      field: 'plan', type: 'file_path', producerPolicy: 'effective-step-skills',
      requiredWhen: { kind: 'track-in', values: refs.artifact },
    }],
    guards: [{ type: 'full-direct-override', when: { kind: 'track-not-in', values: refs.guard } }],
    transitions: [{
      event: 'done', to: 'archive',
      guards: [{ type: 'field-nonempty', field: 'plan', when: { kind: 'track-in', values: refs.edge } }],
      actions: [],
    }],
  }
}

/** 三条轨道：前端、后端、产品；谓词写在前端分支里，引用同一工作流的分支。 */
function workflow(refs: Parameters<typeof buildStep>[0], track = 'frontend'): WorkflowDef {
  const plain = { steps: [{ ...END, id: 'build', label: 'Build' }] }
  return {
    name: 'custom',
    steps: [],
    tracks: {
      frontend: track === 'frontend' ? { steps: [buildStep(refs), END] } : plain,
      backend: track === 'backend' ? { steps: [buildStep(refs), END] } : plain,
      pm: plain,
    },
  }
}

describe('validateWorkflowTrackReferences', () => {
  it('step guard、edge guard、artifact required_when 引用的轨道都是本工作流的分支 → []', () => {
    expect(validateWorkflowTrackReferences(workflow({ guard: ['pm'], edge: ['backend'], artifact: ['frontend', 'pm'] }))).toEqual([])
  })

  it('收集所有未知轨道，保留可定位路径（含分支 id）；track-not-in 也必须引用真实分支', () => {
    const errors = validateWorkflowTrackReferences(workflow({ guard: ['chat'], edge: ['mobile'], artifact: ['frontend', 'free'] }))
    expect(errors).toEqual([
      "workflow.tracks.frontend.steps[0].guards[0].when.values[0]: 未知 track 'chat'",
      "workflow.tracks.frontend.steps[0].transitions[0].guards[0].when.values[0]: 未知 track 'mobile'",
      "workflow.tracks.frontend.steps[0].artifacts[0].requiredWhen.values[1]: 未知 track 'free'",
    ])
  })

  it('每条分支都查；同一路径重复引用同一未知值仍逐位置报告，避免隐藏坏输入', () => {
    const errors = validateWorkflowTrackReferences(workflow({ guard: ['ghost', 'ghost'], edge: ['backend'], artifact: ['backend'] }, 'backend'))
    expect(errors).toEqual([
      "workflow.tracks.backend.steps[0].guards[0].when.values[0]: 未知 track 'ghost'",
      "workflow.tracks.backend.steps[0].guards[0].when.values[1]: 未知 track 'ghost'",
    ])
  })

  it('随插件发布的模板工作流（default 的四条轨道、design-system）保存时不报', () => {
    for (const name of ['default', 'design-system']) {
      const definition = templateWorkflowDefinition(name)
      expect(definition, name).toBeDefined()
      expect(validateWorkflowTrackReferences(definition as WorkflowDef), name).toEqual([])
    }
  })

  it('平铺工作流没有轨道可引用：谓词无从核对，不报', () => {
    const flat: WorkflowDef = { name: 'flat', steps: [buildStep({ guard: ['pm'], edge: ['backend'], artifact: ['nowhere'] }), END] }
    expect(validateWorkflowTrackReferences(flat)).toEqual([])
  })
})
