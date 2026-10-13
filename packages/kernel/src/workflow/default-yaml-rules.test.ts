/**
 * `templates/workflows/default.yaml` 的内容验收（设计 §1、§1a、§1b、§2）：default 按 YAML 执行之后，
 * 离开条件、动作、路由与自动化设置都写在这份文件里，不再有按工作流名或阶段名写死的规则。
 * 读的是随插件发布的生成物（DEFAULT_WORKFLOW_SOURCE），它与 templates/workflows/default.yaml 逐字节一致
 * （generate-default-workflow.test.ts 守这一条）。
 */
import { describe, expect, it } from 'vitest'
import { compileDefaultWorkflow } from './compile.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { parseWorkflow } from './parse.js'
import type { StepDef, StepTransition, TrackBranchDef, WorkflowDef, WorkflowGuardConfig } from './types.js'
import { validateWorkflowForStorage } from './validate.js'

const HEAVY = ['pm', 'frontend', 'backend'] as const
const UNIVERSAL = ['tasks-through-step', 'not-afk-queued', 'dependencies-ended'] as const
const RETIRED_FIELDS = ['build_mode', 'isolation', 'direct_override', 'branch_status', 'verify_result']

const def: WorkflowDef = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)

function branch(id: string): TrackBranchDef {
  const found = def.tracks?.[id]
  if (found === undefined) throw new Error(`default 没有分支 ${id}`)
  return found
}

function step(id: string, stepId: string): StepDef {
  const found = branch(id).steps.find((candidate) => candidate.id === stepId)
  if (found === undefined) throw new Error(`default.${id} 没有步骤 ${stepId}`)
  return found
}

function edge(id: string, stepId: string, event: string): StepTransition {
  const found = step(id, stepId).transitions.find((candidate) => candidate.event === event)
  if (found === undefined) throw new Error(`default.${id}.${stepId} 没有出边 ${event}`)
  return found
}

const kinds = (guards: readonly WorkflowGuardConfig[] | undefined): string[] => (guards ?? []).map((guard) => guard.type)
const actionTypes = (transition: StepTransition): string[] => (transition.actions ?? []).map((action) => action.type)
const fieldOf = (guard: WorkflowGuardConfig | undefined): string | undefined =>
  guard === undefined ? undefined : 'field' in guard ? guard.field : 'path' in guard && typeof guard.path !== 'string' ? guard.path.field : undefined

/** 一步的某条出边实际要满足的离开条件：步骤自己的 guards 加这条边的 guards。 */
const exitGuards = (id: string, stepId: string, event: string): WorkflowGuardConfig[] =>
  [...step(id, stepId).guards, ...(edge(id, stepId, event).guards ?? [])]

describe('default.yaml 的轨道集合', () => {
  it('分支依次是 lite / pm / frontend / backend，没有 chat / free，也没有顶层 steps', () => {
    expect(Object.keys(def.tracks ?? {})).toEqual(['lite', 'pm', 'frontend', 'backend'])
    expect(def.steps).toEqual([])
    expect(def.openspec).toBe(true)
  })

  it('整份 default 通过存储校验与编译', () => {
    expect(validateWorkflowForStorage('default', def)).toEqual([])
    expect(() => compileDefaultWorkflow(def)).not.toThrow()
  })

  it.each(HEAVY)('%s 仍是七步，没有文档契约，规范继承顶层 openspec', (id) => {
    expect(branch(id).steps.map((s) => s.id)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    expect(branch(id).documentContract).toBeUndefined()
    expect(branch(id).spec).toBeUndefined()
  })
})

describe('文档机制：模板不预先规定每一步的输入输出文档（设计 §7）', () => {
  it('顶层与四条分支都没有 document_contract，所有步骤都没有 inputs / outputs / artifacts', () => {
    expect(def.documentContract).toBeUndefined()
    for (const id of Object.keys(def.tracks ?? {})) {
      expect(branch(id).documentContract, id).toBeUndefined()
      for (const s of branch(id).steps) {
        expect(s.inputs ?? [], `${id}.${s.id}.inputs`).toEqual([])
        expect(s.outputs ?? [], `${id}.${s.id}.outputs`).toEqual([])
        expect(s.artifacts ?? [], `${id}.${s.id}.artifacts`).toEqual([])
      }
    }
  })

  it('生成物原文里没有这些键的非空写法', () => {
    expect(DEFAULT_WORKFLOW_SOURCE).not.toMatch(/^\s*document_contract:/mu)
    expect(DEFAULT_WORKFLOW_SOURCE).not.toMatch(/^\s*(inputs|outputs|artifacts):\s*$/mu)
    expect(DEFAULT_WORKFLOW_SOURCE).not.toMatch(/nonempty-output/u)
  })

  // 每个步骤的 required-output 路径模式（按声明顺序）；lite 不加必须产出。
  const REQUIRED: Record<string, Record<string, readonly string[]>> = {
    pm: {
      open: ['openspec/changes/{change}/proposal.md'],
      explore: ['docs/superpowers/specs/*.md'],
      spec: ['openspec/changes/{change}/specs/*/spec.md'],
    },
    frontend: {
      open: ['openspec/changes/{change}/proposal.md'],
      explore: ['docs/superpowers/specs/*.md'],
      spec: ['openspec/changes/{change}/specs/*/spec.md', 'docs/superpowers/plans/*.md'],
    },
    backend: {
      open: ['openspec/changes/{change}/proposal.md'],
      explore: ['docs/superpowers/specs/*.md'],
      spec: ['openspec/changes/{change}/specs/*/spec.md', 'docs/superpowers/plans/*.md'],
    },
  }
  const requiredPaths = (guards: readonly WorkflowGuardConfig[]): string[] =>
    guards.flatMap((guard) => (guard.type === 'required-output' ? [guard.path] : []))

  it.each(HEAVY)('%s：立项 / 调研 / 规格步各自声明按路径的必须产出，其余步骤的步骤守卫不带必须产出', (id) => {
    for (const s of branch(id).steps) {
      expect(requiredPaths(s.guards), `${id}.${s.id}`).toEqual(REQUIRED[id]?.[s.id] ?? [])
    }
  })

  it.each(HEAVY)('%s：验证通过边的必须产出是验证报告，位置在 build-head-unchanged 之前', (id) => {
    const guards = edge(id, 'verify', 'verify-pass').guards ?? []
    expect(requiredPaths(guards)).toEqual(['docs/superpowers/reports/{change}-verify.md'])
    expect(kinds(guards)).toEqual(['required-output', 'build-head-unchanged', 'tasks-through-step'])
    expect(kinds(step(id, 'verify').guards)).toEqual([])
  })

  it('lite 轨道没有任何必须产出', () => {
    for (const s of branch('lite').steps) {
      expect(requiredPaths(s.guards), s.id).toEqual([])
      for (const t of s.transitions) expect(requiredPaths(t.guards ?? []), `${s.id}.${t.event}`).toEqual([])
    }
  })

  it.each(HEAVY)('%s：其余步骤守卫保持原样（只换掉文档相关的几条）', (id) => {
    const expected: Record<string, readonly string[]> = {
      open: ['required-output', 'tasks-through-step'],
      explore: ['required-output', 'tasks-through-step'],
      spec: id === 'pm'
        ? ['required-output', 'tasks-at-least', 'tasks-through-step']
        : ['required-output', 'required-output', 'tasks-at-least', 'tasks-through-step'],
      build: [],
      verify: [],
      ship: id === 'pm'
        ? ['file-exists', 'spec-migration-applied', 'tasks-through-step']
        : ['field-nonempty', 'spec-migration-applied', 'tasks-through-step'],
      archive: ['tasks-through-step'],
    }
    for (const s of branch(id).steps) expect(kinds(s.guards), `${id}.${s.id}`).toEqual(expected[s.id])
  })

  it('产品轨道交付步保留 file-exists prd_path（交付值，不是文档契约）', () => {
    const prd = step('pm', 'ship').guards.find((guard) => guard.type === 'file-exists')
    expect(prd).toMatchObject({ path: { field: 'prd_path' } })
  })

  it('前端交付步提示词不再要求登记 design-md', () => {
    const prompt = step('frontend', 'ship').prompt ?? ''
    expect(prompt).toContain('tenon design validate')
    expect(prompt).not.toMatch(/document record|design-md/u)
  })
})

describe('lite 轨道（设计 §2）', () => {
  it('spec: none、没有文档契约，五步，不可进 AFK', () => {
    const lite = branch('lite')
    expect(lite.label).toBe('轻量')
    expect(lite.spec).toBe('none')
    expect(lite.documentContract).toBeUndefined()
    expect(lite.steps.map((s) => s.id)).toEqual(['open', 'build', 'verify', 'done', 'escalated'])
    expect(lite.automation).toEqual({ eligible: false, enqueueAfterSpec: false })
  })

  it('参与自动路由：优先级 500，排除词含重型信号与产品调研词，不是兜底', () => {
    const route = branch('lite').route
    expect(route?.priority).toBe(500)
    expect(route?.fallback).toBe(false)
    expect(route?.keywords).toEqual(expect.arrayContaining(['修复', '修改', '调整', '新增', '重构', '错别字', 'typo', '文案', '注释']))
    expect(route?.exclude).toEqual(expect.arrayContaining([
      '架构', '跨模块', '迁移', 'migration', 'schema', '数据库', '鉴权', '认证', '权限', 'auth', '依赖升级', '发布', '部署', '全栈', '前后端',
      '调研', '竞品', 'PRD', '需求文档',
    ]))
  })

  it('实现步的改动风险探针阈值照搬 standard：文件数 ≤ 8，契约 / 鉴权 / 依赖 / 迁移 / 删测试 / 受保护测试配置为 0', () => {
    const probe = step('lite', 'build').tests?.find((test) => test.direction === 'diff-risk')
    expect(probe).toMatchObject({ id: 'diff-risk', command: 'tenon test diff-risk --json', required: true, timeout_s: 60 })
    expect(probe?.pass?.metrics).toEqual([
      { name: 'files_changed', max: 8 },
      { name: 'contract_files', max: 0 },
      { name: 'auth_files', max: 0 },
      { name: 'dependency_files', max: 0 },
      { name: 'migration_files', max: 0 },
      { name: 'deleted_tests', max: 0 },
      { name: 'protected_test_files', max: 0 },
    ])
  })

  it('验证步是唯一的评审门；code-review 与 security 必需、medium 阻断', () => {
    const gates = branch('lite').steps.filter((s) => s.gate !== null).map((s) => `${s.id}:${s.gate}`)
    expect(gates).toEqual(['verify:review'])
    expect(step('lite', 'verify').agents?.reviewers).toEqual([
      { agent: 'code-review', required: true, block_at: 'medium' },
      { agent: 'security', required: true, block_at: 'medium' },
    ])
  })

  it('三个步骤都有 scope-expanded 放弃边到 escalated 并结束本次运行；验证通过结束运行并记验证结果', () => {
    for (const stepId of ['open', 'build', 'verify']) {
      const abandon = edge('lite', stepId, 'scope-expanded')
      expect(abandon.to).toBe('escalated')
      expect(actionTypes(abandon)).toEqual(['archive-run'])
    }
    const pass = edge('lite', 'verify', 'verify-pass')
    expect(pass.to).toBe('done')
    expect(actionTypes(pass)).toEqual(['mark-verification-passed', 'archive-run'])
    expect(actionTypes(edge('lite', 'verify', 'verify-fail'))).toEqual(['mark-verification-failed'])
  })

  it('lite 不接重型轨道的离开条件（没有 tasks.md 台账，也不进 AFK）', () => {
    for (const s of branch('lite').steps) {
      expect(kinds(s.guards)).toEqual([])
      for (const t of s.transitions) expect(kinds(t.guards)).toEqual([])
    }
  })
})

describe('路由与自动化设置（沿用原登记表的值）', () => {
  it('pm 规格完成后自动入队；frontend / backend 只是可进 AFK；轻量不可进', () => {
    expect(branch('pm').automation).toEqual({ eligible: true, enqueueAfterSpec: true })
    expect(branch('frontend').automation).toEqual({ eligible: true, enqueueAfterSpec: false })
    expect(branch('backend').automation).toEqual({ eligible: true, enqueueAfterSpec: false })
    expect(branch('lite').automation).toEqual({ eligible: false, enqueueAfterSpec: false })
  })

  it('三个重型轨道都参与路由，优先级 frontend 300 > backend 200 > pm 100；只有 backend 是兜底', () => {
    expect(branch('pm').route).toMatchObject({ priority: 100, fallback: false })
    expect(branch('frontend').route).toMatchObject({ priority: 300, fallback: false })
    expect(branch('backend').route).toMatchObject({ priority: 200, fallback: true })
  })

  it('领域关键词沿用原路由表；编辑动词不在 backend 里（它们是 lite 的关键词）', () => {
    expect(branch('pm').route?.keywords).toEqual(expect.arrayContaining(['调研', '竞品', 'PRD', '需求', '产品']))
    expect(branch('frontend').route?.keywords).toEqual(expect.arrayContaining(['前端', 'UI', '页面', '组件', 'React', '登录页']))
    expect(branch('backend').route?.keywords).toEqual(expect.arrayContaining(['后端', 'API', '接口', '数据库', 'Postgres', 'schema']))
    expect(branch('backend').route?.keywords).not.toEqual(expect.arrayContaining(['修复']))
  })
})

describe.each(HEAVY)('%s：写死的离开条件与动作都在 YAML 里（设计 §1b）', (id) => {
  it('实现步 build-complete：实现前评审通过 + 三个通用离开条件，动作冻结 build_sha', () => {
    const forward = edge(id, 'build', 'build-complete')
    expect(forward.to).toBe('verify')
    expect(exitGuards(id, 'build', 'build-complete').map((g) => g.type)).toEqual(
      expect.arrayContaining(['field-equals', ...UNIVERSAL]),
    )
    const review = exitGuards(id, 'build', 'build-complete').find((g) => g.type === 'field-equals')
    expect(review).toMatchObject({ field: 'pre_verify_review_result', value: 'pass' })
    expect(actionTypes(forward)).toEqual(['freeze-build-sha'])
  })

  it('回退边 requirements-changed / verify-fail 不带任何离开条件（修问题的路一直开着）', () => {
    for (const [stepId, event] of [['build', 'requirements-changed'], ['verify', 'verify-fail']] as const) {
      const guards = exitGuards(id, stepId, event)
      expect(kinds(guards), `${id}.${stepId}.${event}`).toEqual([])
    }
    expect(actionTypes(edge(id, 'build', 'requirements-changed'))).toEqual(['reset-pre-verify-review'])
    expect(actionTypes(edge(id, 'verify', 'verify-fail'))).toEqual(['mark-verification-failed', 'reset-pre-verify-review'])
  })

  it('验证通过：本任务验证步产出了验证报告、build 后未改动、本阶段任务已勾选；动作记验证通过', () => {
    const guards = exitGuards(id, 'verify', 'verify-pass')
    expect(kinds(guards)).toEqual(expect.arrayContaining(['required-output', 'build-head-unchanged', 'tasks-through-step']))
    expect(guards.find((g) => g.type === 'required-output')).toMatchObject({ path: 'docs/superpowers/reports/{change}-verify.md' })
    expect(guards.find((g) => g.type === 'build-head-unchanged')).toMatchObject({ field: 'build_sha' })
    expect(actionTypes(edge(id, 'verify', 'verify-pass'))).toEqual(['mark-verification-passed'])
    expect(step(id, 'verify').maxRounds).toBe(2)
    expect(step(id, 'verify').gate).toBe('review')
  })

  it('调研出口要求本步产出设计文档；规格出口要求任务不少于 3 条，规格完成重置实现前评审', () => {
    expect(exitGuards(id, 'explore', 'explore-complete').find((g) => g.type === 'required-output')).toMatchObject({ path: 'docs/superpowers/specs/*.md' })
    expect(exitGuards(id, 'spec', 'spec-complete').find((g) => g.type === 'tasks-at-least')).toMatchObject({ n: 3 })
    expect(actionTypes(edge(id, 'spec', 'spec-complete'))).toEqual(['reset-pre-verify-review'])
  })

  it('交付出口要求主规格已迁移；archive 完结步要求任务都已勾选', () => {
    expect(kinds(exitGuards(id, 'ship', 'ship-complete'))).toContain('spec-migration-applied')
    expect(kinds(step(id, 'archive').guards)).toContain('tasks-through-step')
    expect(step(id, 'archive').transitions).toEqual([])
  })

  it('每个前进出边都带「本阶段任务已勾选」；回退边没有', () => {
    const steps = branch(id).steps
    steps.forEach((current, index) => {
      for (const transition of current.transitions) {
        const target = steps.findIndex((candidate) => candidate.id === transition.to)
        const guards = exitGuards(id, current.id, transition.event)
        if (target > index) expect(kinds(guards), `${current.id}.${transition.event}`).toContain('tasks-through-step')
        else expect(kinds(guards), `${current.id}.${transition.event}`).not.toContain('tasks-through-step')
      }
    })
    expect(kinds(step(id, 'archive').guards)).toContain('tasks-through-step')
  })

  it('已删除的规则不在 YAML 里：build_mode / isolation / direct_override / branch_status / verify_result 检查与 direct 覆盖', () => {
    const everyGuard = branch(id).steps.flatMap((s) => [...s.guards, ...s.transitions.flatMap((t) => t.guards ?? [])])
    for (const guard of everyGuard) {
      expect(RETIRED_FIELDS, `${guard.type}:${fieldOf(guard)}`).not.toContain(fieldOf(guard))
      expect(guard.type).not.toBe('full-direct-override')
    }
  })
})

describe('spec 出口的必须产出与交付值', () => {
  it('规格步都要求 delta spec；非产品轨道另要求计划文档，产品轨道没有计划要求（也不再靠 track_not_in 豁免）', () => {
    for (const id of HEAVY) {
      const guards = exitGuards(id, 'spec', 'spec-complete')
      expect(guards.some((g) => g.type === 'required-output' && g.path === 'openspec/changes/{change}/specs/*/spec.md'), id).toBe(true)
      const plan = guards.find((g) => g.type === 'required-output' && g.path === 'docs/superpowers/plans/*.md')
      expect(plan !== undefined, id).toBe(id !== 'pm')
      expect(guards.some((g) => g.type === 'file-exists'), id).toBe(false)
      expect(guards.some((g) => g.when !== undefined), id).toBe(false)
    }
  })

  it('交付步：frontend / backend 要 pr_url，产品要 prd_path 文件存在', () => {
    for (const id of ['frontend', 'backend']) {
      expect(exitGuards(id, 'ship', 'ship-complete').some((g) => g.type === 'field-nonempty' && g.field === 'pr_url'), id).toBe(true)
    }
    const pm = exitGuards('pm', 'ship', 'ship-complete').find((g) => g.type === 'file-exists')
    expect(pm).toMatchObject({ path: { field: 'prd_path' } })
    expect(exitGuards('pm', 'ship', 'ship-complete').some((g) => g.type === 'field-nonempty' && g.field === 'pr_url')).toBe(false)
  })
})
