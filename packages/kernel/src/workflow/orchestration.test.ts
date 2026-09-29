import { describe, expect, it } from 'vitest'
import type { SkillTable } from '../flow/manifest.js'
import { builtinTrack } from '../tracks/builtins.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { createEffectiveSkillResolver } from './effective-skill-resolver.js'
import { openspecInjectedSkills, orchestrate, type OrchestrationStage } from './orchestration.js'
import { buildOrchestration, manifestSkillOverlay } from './orchestration-plan.js'
import { parseWorkflow } from './parse.js'
import type { StepDef, WorkflowDef } from './types.js'

const defaultDef = (): WorkflowDef => parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
const stage = (stages: readonly OrchestrationStage[], id: string): OrchestrationStage => {
  const found = stages.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`missing stage ${id}`)
  return found
}
const skills = (item: OrchestrationStage) => item.entries.filter((entry) => entry.kind === 'skill')

function withExploreSkills(def: WorkflowDef, next: StepDef['skills']): WorkflowDef {
  const frontend = def.tracks?.frontend
  if (frontend === undefined) throw new Error('frontend branch missing')
  return {
    ...def,
    tracks: {
      ...def.tracks,
      frontend: { ...frontend, steps: frontend.steps.map((step) => step.id === 'explore' ? { ...step, skills: next } : step) },
    },
  }
}

describe('buildOrchestration · 技能顺序（R1）', () => {
  it('前端轨道 explore 的 4 个技能未声明依赖 → 串行 4 步', () => {
    const plan = compileEffectiveWorkflowPlan('default', defaultDef(), builtinTrack('frontend'))
    const explore = stage(buildOrchestration(plan).stages, 'explore')
    expect(skills(explore).map((entry) => [entry.id, entry.wave])).toEqual([
      ['openspec-explore', 0], ['brainstorming', 1], ['grilling', 2], ['domain-modeling', 3],
    ])
    expect(skills(explore).map((entry) => entry.dependsOn)).toEqual([[], ['openspec-explore'], ['brainstorming'], ['grilling']])
  })

  it('声明依赖后画成波次：同波并行、跨波串行', () => {
    const def = withExploreSkills(defaultDef(), [
      { id: 'openspec-explore' },
      { id: 'brainstorming', depends_on: ['openspec-explore'] },
      { id: 'grilling', depends_on: ['openspec-explore'] },
      { id: 'domain-modeling', depends_on: ['brainstorming', 'grilling'] },
    ])
    const plan = compileEffectiveWorkflowPlan('default', def, builtinTrack('frontend'))
    const explore = stage(buildOrchestration(plan).stages, 'explore')
    expect(skills(explore).map((entry) => [entry.id, entry.wave])).toEqual([
      ['openspec-explore', 0], ['brainstorming', 1], ['grilling', 1], ['domain-modeling', 2],
    ])
    expect(plan.capabilities.skills.steps.find((step) => step.stepId === 'explore')?.declared.map((ref) => ref.dependsOnDeclared))
      .toEqual([false, true, true, true])
  })
})

describe('buildOrchestration · 来源', () => {
  it('OpenSpec 注入：阶段没声明、文档契约要求登记产物的技能排在声明技能之后', () => {
    const plan = compileEffectiveWorkflowPlan('default', defaultDef(), builtinTrack('chat'))
    const orchestration = buildOrchestration(plan)
    expect(skills(stage(orchestration.stages, 'open'))).toEqual([
      { kind: 'skill', id: 'openspec-propose', label: 'openspec-propose', wave: 0, dependsOn: [], required: true, source: 'openspec' },
    ])
    expect(skills(stage(orchestration.stages, 'spec')).map((entry) => [entry.id, entry.source])).toEqual([
      ['openspec-propose', 'openspec'], ['writing-plans', 'openspec'],
    ])
  })

  it('已声明的产出者（含别名）不重复注入；只有 tenon 的槽不注入', () => {
    const slot = (producers: string[]) => ({ kind: 'document' as const, id: 'proposal', role: 'produce' as const, scope: 'change' as const, producers, consumers: [] })
    expect(openspecInjectedSkills([slot(['openspec-propose', 'opsx:propose'])], ['opsx:propose'])).toEqual([])
    expect(openspecInjectedSkills([slot(['tenon'])], [])).toEqual([])
    expect(openspecInjectedSkills([slot(['openspec-propose']), slot(['opsx:propose'])], [])).toEqual(['openspec-propose'])
  })

  it('manifest 叠加：矩阵技能里阶段没声明的，串行接在声明之后', () => {
    const manifest = {
      mandatorySkills: { explore: { frontend: ['openspec-explore', 'extra-skill'] } } as unknown as SkillTable,
      recommendedSkills: {} as unknown as SkillTable,
    }
    const resolver = createEffectiveSkillResolver(manifest)
    const plan = compileEffectiveWorkflowPlan('default', defaultDef(), builtinTrack('frontend'))
    expect(manifestSkillOverlay(plan, resolver)).toEqual({ explore: ['extra-skill'] })
    const explore = skills(stage(buildOrchestration(plan, resolver).stages, 'explore'))
    expect(explore.at(-1)).toMatchObject({ id: 'extra-skill', source: 'manifest', wave: 4, dependsOn: ['domain-modeling'] })
    expect(manifestSkillOverlay(plan, undefined)).toEqual({})
  })
})

describe('buildOrchestration · 阶段内顺序与流向', () => {
  it('前端 verify：技能串行 → 测试 → 评审者波次（architecture 等四个评审者）', () => {
    const plan = compileEffectiveWorkflowPlan('default', defaultDef(), builtinTrack('frontend'))
    const verify = stage(buildOrchestration(plan).stages, 'verify')
    expect(verify.gate).toBe('review')
    expect(verify.entries.map((entry) => [entry.kind, entry.id, entry.wave])).toEqual([
      ['skill', 'browser-qa', 0], ['skill', 'web-design-guidelines', 1], ['skill', 'design-taste-frontend', 2],
      ['skill', 'verification-before-completion', 3], ['skill', 'e2e-testing', 4],
      ['test', 'playwright', 5],
      ['reviewer', 'spec-consistency', 6], ['reviewer', 'frontend-quality', 6], ['reviewer', 'security', 6], ['reviewer', 'e2e', 6],
      ['reviewer', 'architecture', 7],
    ])
    const architecture = verify.entries.find((entry) => entry.id === 'architecture')
    expect(architecture).toMatchObject({ required: false, dependsOn: ['spec-consistency', 'frontend-quality', 'security', 'e2e'] })
    expect(verify.entries.find((entry) => entry.id === 'playwright')?.label).toBe('Playwright')
  })

  it('执行者在最前，与技能、测试、评审者按 runner 顺序排位次', () => {
    const def: WorkflowDef = {
      name: 'demo',
      steps: [{
        id: 'work',
        label: '工作',
        gate: 'auto',
        skills: [{ id: 'plan' }, { id: 'code' }],
        inputs: [],
        outputs: [],
        tests: [{ id: 'unit', direction: 'unit', command: 'npm test', required: false }],
        agents: {
          executors: [{ agent: 'builder' }, { agent: 'fixer', depends_on: ['builder'] }],
          reviewers: [{ agent: 'critic', required: true, block_at: 'high' }],
        },
        guards: [],
        transitions: [],
      }],
    }
    const work = stage(buildOrchestration(compileEffectiveWorkflowPlan('demo', def)).stages, 'work')
    expect(work.entries.map((entry) => [entry.kind, entry.id, entry.wave, entry.required])).toEqual([
      ['executor', 'builder', 0, true], ['executor', 'fixer', 1, true],
      ['skill', 'plan', 2, true], ['skill', 'code', 3, true],
      ['test', 'unit', 4, false],
      ['reviewer', 'critic', 5, true],
    ])
  })

  it('回流边 = 指向更早阶段的转移', () => {
    const plan = compileEffectiveWorkflowPlan('default', defaultDef(), builtinTrack('frontend'))
    expect(buildOrchestration(plan).returns).toEqual([
      { from: 'build', to: 'spec', event: 'requirements-changed' },
      { from: 'verify', to: 'build', event: 'verify-fail' },
    ])
  })

  it('文档流：产出阶段 → 读取它的阶段，带本阶段的产出技能', () => {
    const plan = compileEffectiveWorkflowPlan('default', defaultDef(), builtinTrack('frontend'))
    const flows = buildOrchestration(plan).flows
    expect(flows.find((flow) => flow.id === 'proposal' && flow.from === 'open')).toEqual({
      slot: 'document', id: 'proposal', from: 'open', producers: ['openspec-propose'],
      to: ['explore', 'spec', 'build', 'verify', 'ship', 'archive'],
    })
    expect(flows.find((flow) => flow.id === 'design_doc')).toEqual({
      slot: 'field', id: 'design_doc', from: 'explore', producers: [], to: ['spec', 'build'],
    })
  })

  it('orchestrate 直接吃草稿形状：阶段标签缺省用 id，空阶段没有条目', () => {
    const result = orchestrate({ steps: [{ id: 'solo', label: '', gate: null, skills: [], transitions: [] }] })
    expect(result).toEqual({ stages: [{ id: 'solo', label: 'solo', gate: null, entries: [] }], returns: [], flows: [] })
  })
})
