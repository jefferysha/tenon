import { describe, expect, it } from 'vitest'
import { builtinTrack, type BuiltinTrackId } from '../tracks/builtins.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { parseWorkflow } from './parse.js'
import { RETIRED_SKILL_IDS, retiredSkillReferences } from './retired-skills.js'

function planFor(source: string, track?: BuiltinTrackId) {
  return compileEffectiveWorkflowPlan(
    'demo',
    parseWorkflow(source),
    track === undefined ? undefined : builtinTrack(track),
  )
}

const BRANCHED = `name: demo
tracks:
  backend:
    label: 后端
    steps:
      - id: change
        label: 改动
        gate: auto
        skills:
          - id: tenon-build
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: change-complete
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
  frontend:
    label: 前端
    steps:
      - id: change
        label: 改动
        gate: auto
        skills:
          - id: tenon:tenon-verify
          - id: brainstorming
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: change-complete
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

const CLEAN = `name: clean
steps:
  - id: change
    label: 改动
    gate: auto
    skills:
      - id: test-driven-development
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: change-complete
        to: done
  - id: done
    label: 完成
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

describe('retiredSkillReferences', () => {
  it('每个已删除技能都在闭集里', () => {
    expect(RETIRED_SKILL_IDS).toEqual([
      'tenon-open', 'tenon-explore', 'tenon-spec', 'tenon-build', 'tenon-verify', 'tenon-ship',
      'tenon-archive', 'simple-task', 'learn-record', 'tenon-researcher',
    ])
  })

  it('扫全部 track 分支，不只是选中的那条', () => {
    expect(retiredSkillReferences(planFor(BRANCHED, 'backend'))).toEqual(['tenon-build', 'tenon-verify'])
  })

  it('归一 tenon: 命名空间', () => {
    expect(retiredSkillReferences(planFor(BRANCHED, 'frontend'))).toContain('tenon-verify')
  })

  it('无关技能不误报', () => {
    expect(retiredSkillReferences(planFor(CLEAN))).toEqual([])
  })

  it('冻结快照（只有选中分支、无 definition）同样能认出来', () => {
    const plan = planFor(BRANCHED, 'backend')
    const frozen = { ...plan, definition: undefined }
    expect(retiredSkillReferences(frozen)).toEqual(['tenon-build'])
  })
})
