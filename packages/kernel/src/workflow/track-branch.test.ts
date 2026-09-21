import { describe, expect, it } from 'vitest'
import { builtinTrack } from '../tracks/builtins.js'
import { tmpdir } from 'node:os'
import { loadTrackRegistry } from '../tracks/registry.js'
import { resolveTrackForBranch } from '../tracks/branch-track.js'
import { compileWorkflow } from './compile.js'
import { defaultArtifactsForStep } from './default-artifacts.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import { selectTrackBranch, validateWorkflow, validateWorkflowForStorage, workflowBranches } from './validate.js'

const BRANCHED = `name: demo
tracks:
  backend:
    label: 后端
    steps:
      - id: change
        label: 改动
        gate: auto
        skills:
          - id: simple-task
        inputs: []
        outputs:
          - field: design_doc
            type: file_path
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
  mobile:
    label: 移动端
    steps:
      - id: design
        label: 设计
        gate: review
        skills:
          - id: frontend-design
          - id: browser-qa
            depends_on: [frontend-design]
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: design-complete
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

describe('track 分支 · 解析 / 序列化 / 选择', () => {
  it('tracks 块往返：分支 label 与独立 steps 都保留', () => {
    const def = parseWorkflow(BRANCHED)
    expect(Object.keys(def.tracks ?? {})).toEqual(['backend', 'mobile'])
    expect(def.tracks?.mobile?.label).toBe('移动端')
    expect(def.tracks?.mobile?.steps.map((step) => step.id)).toEqual(['design', 'done'])
    expect(def.steps).toEqual([])
    expect(serializeWorkflow(def)).toBe(BRANCHED)
  })

  it('workflowBranches 只列 track；selectTrackBranch 命中用分支、无轨道语境取第一条、没有分支抛错；steps 与 tracks 并存被拒', () => {
    const def = parseWorkflow(BRANCHED)
    expect(workflowBranches(def).map((branch) => branch.track)).toEqual(['backend', 'mobile'])
    expect(selectTrackBranch(def, 'mobile').steps.map((step) => step.id)).toEqual(['design', 'done'])
    expect(selectTrackBranch(def, undefined).steps.map((step) => step.id)).toEqual(['change', 'done'])
    expect(() => selectTrackBranch(def, 'web')).toThrow(/没有轨道 'web' 的分支/u)
    expect(selectTrackBranch(def, 'mobile')).not.toHaveProperty('tracks')
    const both = { ...def, steps: def.tracks!.backend!.steps }
    expect(validateWorkflow(both).some((error) => error.includes('不得再声明顶层 steps'))).toBe(true)
  })

  it('有效计划按 change 的 track 选分支：workflow 是分支 IR、definition 是完整定义；指纹属于整份定义（各分支相同）', () => {
    const def = parseWorkflow(BRANCHED)
    const mobile = compileEffectiveWorkflowPlan('demo', def, resolveTrackForBranch(loadTrackRegistry(tmpdir(), { workflowExists: () => true, skillProfiles: new Set() }), 'mobile', def))
    expect(mobile.workflow.steps.map((step) => step.id)).toEqual(['design', 'done'])
    expect(mobile.workflow).not.toHaveProperty('tracks')
    expect(mobile.capabilities.skills.steps[0]).toMatchObject({ stepId: 'design', requiredSkillIds: ['frontend-design', 'browser-qa'] })
    const backend = compileEffectiveWorkflowPlan('demo', def, builtinTrack('backend'))
    expect(backend.workflow.steps.map((step) => step.id)).toEqual(['change', 'done'])
    expect(backend.workflowFingerprint).toBe(mobile.workflowFingerprint)
    expect(Object.keys(mobile.definition?.tracks ?? {})).toEqual(['backend', 'mobile'])
  })

  it('分支文档契约：selectTrackBranch / 有效计划按 track 取各自契约；契约相同的分支共享指纹，不同则各自不同', () => {
    const contract = (kind: string, owner: string, producer: string) => [
      '    document_contract:',
      '      version: v1',
      '      slots:',
      `        - kind: ${kind}`,
      `          owner_step: ${owner}`,
      `          producers: [${producer}]`,
      '      reads: []',
    ].join('\n')
    const def = parseWorkflow(BRANCHED
      .replace('name: demo\n', 'name: demo\nopenspec: true\n')
      .replace('    label: 后端\n', `    label: 后端\n${contract('proposal', 'change', 'simple-task')}\n`)
      .replace('    label: 移动端\n', `    label: 移动端\n${contract('design-md', 'design', 'frontend-design')}\n`))
    expect(selectTrackBranch(def, 'mobile').documentContract?.slots[0]?.kind).toBe('design-md')
    expect(selectTrackBranch(def, undefined).documentContract?.slots[0]?.kind).toBe('proposal')
    const registry = loadTrackRegistry(tmpdir(), { workflowExists: () => true, skillProfiles: new Set() })
    const mobile = compileEffectiveWorkflowPlan('demo', def, resolveTrackForBranch(registry, 'mobile', def))
    const backend = compileEffectiveWorkflowPlan('demo', def, builtinTrack('backend'))
    expect(mobile.documentPolicy?.outputsByStep).toEqual({ design: [{ kind: 'design-md', producerCandidates: ['frontend-design'] }], done: [] })
    expect(backend.documentPolicy?.outputsByStep).toEqual({ change: [{ kind: 'proposal', producerCandidates: ['simple-task'] }], done: [] })
    expect(mobile.workflow.documentContract?.slots[0]?.kind).toBe('design-md')
    expect(backend.workflowFingerprint).not.toBe(mobile.workflowFingerprint)
    const twin = { ...def, tracks: { backend: def.tracks!.backend!, mobile: def.tracks!.backend! } }
    const twinMobile = compileEffectiveWorkflowPlan('demo', twin, resolveTrackForBranch(registry, 'mobile', twin))
    const twinBackend = compileEffectiveWorkflowPlan('demo', twin, builtinTrack('backend'))
    expect(twinMobile.documentPolicy).toEqual(twinBackend.documentPolicy)
    expect(twinMobile.workflowFingerprint).toBe(twinBackend.workflowFingerprint)
    expect(compileEffectiveWorkflowPlan('demo', parseWorkflow(BRANCHED), builtinTrack('backend')).documentPolicy).toBeUndefined()
  })

  it('每条分支各自校验；错误带 tracks.<id> 前缀', () => {
    const def = parseWorkflow(BRANCHED.replace('            to: done\n      - id: done', '            to: nowhere\n      - id: done'))
    const errors = validateWorkflow(def)
    expect(errors.some((error) => error.startsWith('tracks.backend: ') && error.includes('nowhere'))).toBe(true)
  })

  it('registry 未登记的分支 track 合成缺省定义；既无登记也无分支 → undefined', () => {
    const def = parseWorkflow(BRANCHED)
    const registry = loadTrackRegistry(tmpdir(), { workflowExists: () => true, skillProfiles: new Set() })
    const synthesized = resolveTrackForBranch(registry, 'mobile', def)
    expect(synthesized).toMatchObject({ id: 'mobile', label: '移动端', builtin: false, workflow: { default: 'demo', allowed: ['demo'] } })
    expect(synthesized?.policyProfile.skills).toEqual({ matrix: false, profile: '_all' })
    expect(resolveTrackForBranch(registry, 'backend', def)).toBe(registry.byId.get('backend'))
    expect(resolveTrackForBranch(registry, 'nope', def)).toBeUndefined()
  })
})

describe('门禁 · review / auto / null', () => {
  it('gate: auto 编译成每条出边上的输出齐全守卫', () => {
    const ir = compileWorkflow(parseWorkflow(BRANCHED))
    expect(ir.tracks?.backend?.steps[0]!.transitions[0]!.guards).toEqual([{ type: 'field-nonempty', field: 'design_doc' }])
    expect(ir.tracks?.mobile?.steps[0]!.transitions[0]!.guards).toEqual([])
  })

  it("gate: confirm 已移除 → 解析与编译都报错并给出替代", () => {
    expect(() => parseWorkflow(BRANCHED.replace('gate: auto', 'gate: confirm'))).toThrow(/confirm.*review.*auto/u)
    const parsed = parseWorkflow(BRANCHED)
    expect(() => compileWorkflow({ ...parsed, tracks: { ...parsed.tracks, backend: { ...parsed.tracks!.backend!, steps: [{ ...parsed.tracks!.backend!.steps[0]!, gate: 'confirm' as never }] } } })).toThrow(/confirm/u)
  })
})

describe('default 分支', () => {
  it('内建 default 没有顶层 steps，含 chat / pm / frontend / backend / free 五条分支且每条都过 default 骨架校验；没有分支的 track 被拒', () => {
    const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    expect(def.steps).toEqual([])
    expect(() => compileEffectiveWorkflowPlan('default', def, builtinTrack('simple'))).toThrow(/没有轨道 'simple' 的分支/u)
    expect(Object.keys(def.tracks ?? {})).toEqual(['chat', 'pm', 'frontend', 'backend', 'free'])
    // 无轨道语境取第一条分支 = chat（只有驱动技能的基础流）。
    expect(compileEffectiveWorkflowPlan('default', def).capabilities.skills.steps.find((step) => step.stepId === 'build')?.requiredSkillIds).toEqual(['test-driven-development'])
    expect(validateWorkflowForStorage('default', def)).toEqual([])
  })

  it('backend 分支的 explore 技能 = 驱动 + 该轨矩阵技能；pm 分支 spec 不要求 plan artifact', () => {
    const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    const backend = compileEffectiveWorkflowPlan('default', def, builtinTrack('backend'))
    expect(backend.capabilities.skills.steps.find((step) => step.stepId === 'explore')?.requiredSkillIds).toEqual([
      'openspec-explore', 'brainstorming', 'grill-with-docs', 'improve-codebase-architecture',
    ])
    const pm = compileEffectiveWorkflowPlan('default', def, builtinTrack('pm'))
    expect(pm.capabilities.skills.steps.find((step) => step.stepId === 'verify')?.requiredSkillIds).toContain('handoff')
    expect(backend.capabilities.skills.steps.find((step) => step.stepId === 'verify')?.requiredSkillIds).not.toContain('handoff')
    // default 运行时 artifact 走生成表：pm 分支的 spec 没有 plan artifact，其余分支有。
    expect(defaultArtifactsForStep('spec', 'pm')).toEqual([])
    expect(defaultArtifactsForStep('spec', 'backend').map((artifact) => artifact.field)).toEqual(['plan'])
  })

  it('测试 id 在分支内唯一；不同分支可以重名', () => {
    const test = { id: 'unit', direction: 'unit', command: 'npm test' } as const
    const step = (id: string, to: string, tests?: readonly typeof test[]) => ({
      id, label: id, gate: null as null, skills: [], inputs: [], outputs: [],
      ...(tests === undefined ? {} : { tests }),
      guards: [], transitions: to === '' ? [] : [{ event: 'go', to }],
    })
    const duplicate = validateWorkflow({
      name: 'dup',
      steps: [],
      tracks: { backend: { steps: [step('build', 'verify', [test]), step('verify', '', [test])] } },
    })
    expect(duplicate).toContain("tracks.backend: 测试 id 'unit' 在分支内重复（step 'build' 与 'verify'）")

    expect(validateWorkflow({
      name: 'shared',
      steps: [],
      tracks: {
        backend: { steps: [step('build', '', [test])] },
        mobile: { steps: [step('build', '', [test])] },
      },
    })).toEqual([])
  })
})
