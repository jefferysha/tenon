import { describe, expect, it } from 'vitest'
import { compileWorkflow } from './compile.js'
import type { WorkflowDef } from './types.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { compileEffectiveWorkflowPlan, effectiveWorkflowPlanFromIr } from './effective-plan.js'
import { parseWorkflow } from './parse.js'
import { UnknownTrackError } from './resolve-track.js'
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
        guards: []
        transitions:
          - event: change-complete
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
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
        guards: []
        transitions:
          - event: design-complete
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
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
    const mobile = compileEffectiveWorkflowPlan('demo', def, { track: 'mobile' })
    expect(mobile.workflow.steps.map((step) => step.id)).toEqual(['design', 'done'])
    expect(mobile.workflow).not.toHaveProperty('tracks')
    expect(mobile.capabilities.skills.steps[0]).toMatchObject({ stepId: 'design', requiredSkillIds: ['frontend-design', 'browser-qa'] })
    const backend = compileEffectiveWorkflowPlan('demo', def, { track: 'backend' })
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
    // 带 document_contract 的定义已被 validate 拒绝（只剩旧契约计划的重建与夹具用）：这里不经校验，直接由编译产物建计划。
    const legacyPlan = (workflow: WorkflowDef, track: string): ReturnType<typeof compileEffectiveWorkflowPlan> =>
      effectiveWorkflowPlanFromIr('demo', compileWorkflow(workflow), { track })
    const mobile = legacyPlan(def, 'mobile')
    const backend = legacyPlan(def, 'backend')
    expect(mobile.documentPolicy?.outputsByStep).toEqual({ design: [{ kind: 'design-md', producerCandidates: ['frontend-design'] }], done: [] })
    expect(backend.documentPolicy?.outputsByStep).toEqual({ change: [{ kind: 'proposal', producerCandidates: ['simple-task'] }], done: [] })
    expect(mobile.workflow.documentContract?.slots[0]?.kind).toBe('design-md')
    expect(backend.workflowFingerprint).not.toBe(mobile.workflowFingerprint)
    const twin = { ...def, tracks: { backend: def.tracks!.backend!, mobile: def.tracks!.backend! } }
    const twinMobile = legacyPlan(twin, 'mobile')
    const twinBackend = legacyPlan(twin, 'backend')
    expect(twinMobile.documentPolicy).toEqual(twinBackend.documentPolicy)
    expect(twinMobile.workflowFingerprint).toBe(twinBackend.workflowFingerprint)
    expect(compileEffectiveWorkflowPlan('demo', parseWorkflow(BRANCHED), { track: 'backend' }).documentPolicy).toBeUndefined()
  })

  it('每条分支各自校验；错误带 tracks.<id> 前缀', () => {
    const def = parseWorkflow(BRANCHED.replace('            to: done\n      - id: done', '            to: nowhere\n      - id: done'))
    const errors = validateWorkflow(def)
    expect(errors.some((error) => error.startsWith('tracks.backend: ') && error.includes('nowhere'))).toBe(true)
  })

  it('计划只读工作流自己的分支（不查登记表）：分支没有写 automation → 不可进 AFK；轨道不存在 → UnknownTrackError', () => {
    const def = parseWorkflow(BRANCHED)
    const mobile = compileEffectiveWorkflowPlan('demo', def, { track: 'mobile' })
    expect(mobile.capabilities.track).toEqual({ id: 'mobile', coverageProfile: 'none', routingEnabled: false })
    expect(mobile.capabilities.automation).toEqual({ eligible: false, autoEnqueueOnSpecComplete: false })
    // 与分支 id 同名的内建轨道（backend）也只认工作流自己的分支，不沿用内建登记的策略。
    expect(compileEffectiveWorkflowPlan('demo', def, { track: 'backend' }).capabilities.automation)
      .toEqual({ eligible: false, autoEnqueueOnSpecComplete: false })
    expect(() => compileEffectiveWorkflowPlan('demo', def, { track: 'nope' })).toThrow(UnknownTrackError)
  })

  it('分支声明了 automation 时进入计划', () => {
    const base = parseWorkflow(BRANCHED)
    const mobile = base.tracks!.mobile!
    const def: WorkflowDef = {
      ...base,
      tracks: { ...base.tracks, mobile: { ...mobile, automation: { eligible: true, enqueueAfterSpec: true } } },
    }
    expect(compileEffectiveWorkflowPlan('demo', def, { track: 'mobile' }).capabilities.automation)
      .toEqual({ eligible: true, autoEnqueueOnSpecComplete: true })
  })
})

describe('门禁 · review / auto / null', () => {
  it('gate: auto 编译成每条出边上的输出齐全守卫（只对仍带 outputs 的旧定义；新定义没有 outputs，自动门禁不推导守卫）', () => {
    const legacy = parseWorkflow(BRANCHED)
    const backend = legacy.tracks!.backend!
    const withOutputs: WorkflowDef = {
      ...legacy,
      tracks: {
        ...legacy.tracks,
        backend: { ...backend, steps: backend.steps.map((step) => step.id === 'change' ? { ...step, outputs: [{ field: 'design_doc', type: 'file_path' as const }] } : step) },
      },
    }
    const ir = compileWorkflow(withOutputs)
    expect(ir.tracks?.backend?.steps[0]!.transitions[0]!.guards).toEqual([{ type: 'field-nonempty', field: 'design_doc' }])
    expect(ir.tracks?.mobile?.steps[0]!.transitions[0]!.guards).toEqual([])
    expect(compileWorkflow(legacy).tracks?.backend?.steps[0]!.transitions[0]!.guards).toEqual([])
  })

  it("gate: confirm 已移除 → 解析与编译都报错并给出替代", () => {
    expect(() => parseWorkflow(BRANCHED.replace('gate: auto', 'gate: confirm'))).toThrow(/confirm.*review.*auto/u)
    const parsed = parseWorkflow(BRANCHED)
    expect(() => compileWorkflow({ ...parsed, tracks: { ...parsed.tracks, backend: { ...parsed.tracks!.backend!, steps: [{ ...parsed.tracks!.backend!.steps[0]!, gate: 'confirm' as never }] } } })).toThrow(/confirm/u)
  })
})

describe('default 分支', () => {
  it('内建 default 没有顶层 steps，含 lite / pm / frontend / backend 四条分支且整份过存储校验；没有分支的 track（含已退役的 chat / free）被拒', () => {
    const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    expect(def.steps).toEqual([])
    for (const retired of ['simple', 'chat', 'free']) {
      expect(() => compileEffectiveWorkflowPlan('default', def, { track: retired })).toThrow(new RegExp(`没有轨道 '${retired}'`, 'u'))
    }
    expect(Object.keys(def.tracks ?? {})).toEqual(['lite', 'pm', 'frontend', 'backend'])
    // 有分支的工作流不指定轨道就算不出计划：不再取第一条分支（lite 排在最前，更不能被误选）。
    expect(() => compileEffectiveWorkflowPlan('default', def)).toThrow(/有多条轨道.*lite, pm, frontend, backend/u)
    expect(validateWorkflowForStorage('default', def)).toEqual([])
  })

  it('backend 分支的 explore 技能 = 驱动 + 该轨矩阵技能', () => {
    const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    const backend = compileEffectiveWorkflowPlan('default', def, { track: 'backend' })
    expect(backend.capabilities.skills.steps.find((step) => step.stepId === 'explore')?.requiredSkillIds).toEqual([
      'openspec-explore', 'brainstorming', 'grilling', 'domain-modeling', 'codebase-design',
    ])
    const pm = compileEffectiveWorkflowPlan('default', def, { track: 'pm' })
    // pm 的 verify 只声明走查与验证四件；架构词汇（codebase-design）是 backend explore 的事。
    expect(pm.capabilities.skills.steps.find((step) => step.stepId === 'verify')?.requiredSkillIds)
      .toEqual(['browser-qa', 'web-design-guidelines', 'design-taste-frontend', 'verification-before-completion'])
    expect(backend.capabilities.skills.steps.find((step) => step.stepId === 'explore')?.requiredSkillIds)
      .not.toContain('improve-codebase-architecture')
  })

  /**
   * build 的通过结论（pre_verify_review_result=pass）由 CLI 按本步声明的就绪证据核对；真机里
   * free / pm / chat 的 build 什么都不声明，模型直接 set pass 自批。每条分支的 build 都必须声明
   * 至少一项可核对的必需证据：frontend / backend 是策略要求运行的 unit 套件（测试目录里的），
   * pm 是语言无关的 spec-consistency 评审者，lite 是改动风险探针加 unit 套件。
   */
  it('每条分支的 build 都声明必需的就绪证据（测试或评审者）', () => {
    const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    const evidence = Object.keys(def.tracks ?? {}).map((track) => {
      const build = selectTrackBranch(def, track).steps.find((step) => step.id === 'build')
      return [
        track,
        (build?.tests ?? []).filter((test) => test.required !== false).map((test) => test.id),
        (build?.agents?.reviewers ?? []).filter((reviewer) => reviewer.required).map((reviewer) => reviewer.agent),
        build?.test_policy?.run ?? [],
      ]
    })
    expect(evidence).toEqual([
      ['lite', ['diff-risk'], [], ['unit']],
      ['pm', [], ['spec-consistency'], []],
      ['frontend', [], [], ['unit']],
      ['backend', [], [], ['unit']],
    ])
    for (const [track, tests, reviewers, run] of evidence) {
      expect((tests as string[]).length + (reviewers as string[]).length + (run as string[]).length, `${String(track)} 的 build 没有任何就绪证据`).toBeGreaterThan(0)
    }
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
