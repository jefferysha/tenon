import { describe, expect, test, vi } from 'vitest'
import {
  compileEffectiveWorkflowPlan,
  createEffectiveSkillResolver,
  type EffectiveSkillResolver,
  type LoopEntry,
  type WorkflowDef,
  type WorkflowIR,
} from '@tenon/kernel'
import {
  buildLoopStarterWiringReport,
  type LoopStarterWiringDeps,
} from './loop-starter-wiring.js'
import { SkillContentNotFoundError } from '@tenon/automation'
import type { SkillBundleWiringResult } from './loop-admission-view.js'

function loop(overrides: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: 'ci-loop',
    name: 'CI loop',
    kind: 'orchestrator',
    goal: 'Keep CI green with minimal reviewed fixes',
    cadence: '1h',
    risk: 'medium',
    runner: 'codex',
    change_prefix: 'ci-',
    phases: ['build'],
    human_gates: ['verify'],
    state: '.superpowers/loops/progress.md',
    design_doc: 'docs/loops/ci.md',
    status: 'paused',
    budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip' },
    kill_criteria: ['no-change-3'],
    autonomy_level: 'L1',
    allowlist: [],
    denylist: [],
    template_id: 'ci-sweeper',
    template_version: 1,
    workflow_id: 'default',
    skill_bundle_id: 'backend',
    ...overrides,
  }
}

const EMPTY_RESOLVER: EffectiveSkillResolver = {
  resolveDefault: () => [],
  resolveCustom: () => [],
}
const DEFAULT_CAPABILITY = compileEffectiveWorkflowPlan('default').capabilities.skills

function workflowIr(name: string, stepIds: readonly string[]): WorkflowIR {
  return {
    name,
    steps: stepIds.map((id) => ({
      id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], artifacts: [], transitions: [],
    })),
  }
}

function deps(
  evaluateSkillBundleWiring: NonNullable<LoopStarterWiringDeps['evaluateSkillBundleWiring']>,
  overrides: Partial<LoopStarterWiringDeps> = {},
): LoopStarterWiringDeps {
  return {
    repoRoot: '/repo',
    skillBundleWiring: {
      resolver: EMPTY_RESOLVER,
      locator: { locate: async (skillId) => ({ skillId, contentDir: `/skills/${skillId}` }) },
      isSkillProfileKnown: () => true,
    },
    evaluateSkillBundleWiring,
    ...overrides,
  }
}

describe('buildLoopStarterWiringReport', () => {
  test('default starter：paused 即使全部 wiring ready 也不可 runnable；evaluator 结果原样传播', async () => {
    const entry = loop()
    const skillResult: SkillBundleWiringResult = Object.freeze({
      status: 'ready', bundleId: 'backend', reason: null,
    })
    const evaluate = vi.fn(async () => skillResult)

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate))

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.status).toBe('ready')
    expect(report.wiring.skillBundle).toBe(skillResult)
    expect(report.runnable).toBe(false)
    expect(entry.status).toBe('paused')
    expect(evaluate).toHaveBeenCalledWith(
      entry,
      expect.objectContaining({ resolver: EMPTY_RESOLVER }),
      [{ kind: 'default', stepId: 'build', capability: DEFAULT_CAPABILITY }],
    )
  })

  test('default starter：active + binding/workflow/skill 全 ready 才 runnable=true', async () => {
    const entry = loop({ status: 'active' })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate))

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.status).toBe('ready')
    expect(report.runnable).toBe(true)
  })

  test('default starter：retired 即使全部 wiring ready 也不可 runnable', async () => {
    const entry = loop({ status: 'retired' })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate))

    expect(report.wiring.status).toBe('ready')
    expect(report.runnable).toBe(false)
  })

  test('default workflow 把目标 loop 的 phases 按原顺序交给 default skill 解析计划', async () => {
    const entry = loop({ status: 'active', phases: ['open', 'build', 'verify'] })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate))

    expect(report.wiring.workflow).toEqual({ status: 'ready', workflowId: 'default', reason: null })
    expect(evaluate).toHaveBeenCalledWith(
      entry,
      expect.objectContaining({ resolver: EMPTY_RESOLVER }),
      [
        { kind: 'default', stepId: 'open', capability: DEFAULT_CAPABILITY },
        { kind: 'default', stepId: 'build', capability: DEFAULT_CAPABILITY },
        { kind: 'default', stepId: 'verify', capability: DEFAULT_CAPABILITY },
      ],
    )
    expect(report.runnable).toBe(true)
  })

  test('default workflow 只认 kernel PHASES：非法 phase → workflow invalid，且不调用项目 workflow loader', async () => {
    const entry = loop({ status: 'active', phases: ['build', 'not-a-runtime-phase'] })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))
    const load = vi.fn(() => null)

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate, {
      loadWorkflow: load,
    }))

    expect(report.wiring.status).toBe('invalid')
    expect(report.wiring.workflow.reason).toMatch(/not-a-runtime-phase.*default/i)
    expect(report.runnable).toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(evaluate).not.toHaveBeenCalled()
  })

  test('default static admission 缺 step Skill 内容 → skill bundle invalid，不降级成 profile-only 空/部分快照', async () => {
    const entry = loop({ status: 'active', phases: ['build'] })
    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], {
      repoRoot: '/repo',
      skillBundleWiring: {
        resolver: createEffectiveSkillResolver({
          mandatorySkills: { build: { _all: ['test-driven-development'] } } as never,
          recommendedSkills: {},
        }),
        isSkillProfileKnown: () => true,
        locator: {
          locate: async () => {
            throw new SkillContentNotFoundError('test-driven-development missing')
          },
        },
      },
    })

    expect(report.wiring.skillBundle).toMatchObject({ status: 'invalid' })
    expect(report.wiring.reason).toMatch(/phase "build".*test-driven-development|test-driven-development/i)
    expect(report.runnable).toBe(false)
  })

  test('runner 不在 kernel LOOP_RUNNERS 闭集 → binding invalid，绝不降级到 Claude', async () => {
    const entry = loop({ status: 'active', runner: 'codxe' })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate))

    expect(report.binding.status).toBe('invalid')
    expect(report.wiring.reason).toMatch(/runner.*codxe.*claude-code.*codex/i)
    expect(report.runnable).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
  })

  test('custom workflow 文件缺失：binding 仍有效，wiring invalid 且不可运行', async () => {
    const entry = loop({ workflow_id: 'release-train' })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate, {
      loadWorkflow: () => null,
    }))

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.status).toBe('invalid')
    expect(report.wiring.workflow).toMatchObject({ status: 'invalid', workflowId: 'release-train' })
    expect(report.wiring.workflow.reason).toMatch(/release-train.*(?:不存在|缺失)/i)
    expect(report.runnable).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
    expect(entry.status).toBe('paused')
  })

  test('custom workflow 编译失败：错误收进 typed wiring invalid，不调用 skill evaluator', async () => {
    const entry = loop({ workflow_id: 'release-train' })
    const definition = { name: 'release-train', steps: [] } satisfies WorkflowDef
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate, {
      loadWorkflow: () => definition,
      compileWorkflow: () => { throw new Error('compile exploded at steps[0]') },
    }))

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.status).toBe('invalid')
    expect(report.wiring.workflow).toMatchObject({ status: 'invalid', workflowId: 'release-train' })
    expect(report.wiring.reason).toMatch(/compile exploded/)
    expect(report.runnable).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
  })

  test('loadWorkflow 在真实 load/validate 阶段抛出编译错误：binding 不被误判，wiring invalid', async () => {
    const entry = loop({ workflow_id: 'release-train' })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate, {
      loadWorkflow: () => { throw new Error('ERROR: workflow release-train 校验失败: compileWorkflow') },
    }))

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.status).toBe('invalid')
    expect(report.wiring.workflow).toMatchObject({ status: 'invalid', workflowId: 'release-train' })
    expect(report.wiring.reason).toMatch(/校验失败.*compileWorkflow/i)
    expect(report.runnable).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
  })

  test('custom workflow 编译成功但 loop phase 无法 resolve：wiring invalid', async () => {
    const entry = loop({ workflow_id: 'release-train', phases: ['build', 'verify'] })
    const definition = { name: 'release-train', steps: [] } satisfies WorkflowDef
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate, {
      loadWorkflow: () => definition,
      compileWorkflow: () => workflowIr('release-train', ['build']),
      customWorkflowRuntimeWired: true,
    }))

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.status).toBe('invalid')
    expect(report.wiring.workflow.reason).toMatch(/verify.*(?:step|阶段|声明)/i)
    expect(report.runnable).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
  })

  test('custom workflow 结构有效但生产 runtime coordinate 未接线：aggregate unwired', async () => {
    const entry = loop({ workflow_id: 'release-train', phases: ['build'] })
    const definition = { name: 'release-train', steps: [] } satisfies WorkflowDef
    const skillResult: SkillBundleWiringResult = {
      status: 'ready', bundleId: 'backend', reason: null,
    }
    const evaluate = vi.fn(async () => skillResult)

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate, {
      loadWorkflow: () => definition,
      compileWorkflow: () => workflowIr('release-train', ['build']),
      customWorkflowRuntimeWired: false,
    }))

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.workflow.status).toBe('ready')
    expect(report.wiring.customWorkflowRuntime.status).toBe('unwired')
    expect(report.wiring.status).toBe('unwired')
    expect(report.wiring.skillBundle).toBe(skillResult)
    expect(report.runnable).toBe(false)
    expect(entry.status).toBe('paused')
  })

  test('目标 loop 的 change_prefix 与另一 loop 完全重复：binding ambiguous/invalid', async () => {
    const entry = loop()
    const duplicate = loop({
      id: 'daily-loop',
      template_id: 'daily-triage',
      change_prefix: 'ci-',
    })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport(
      'ci-sweeper',
      [entry, duplicate],
      deps(evaluate),
    )

    expect(report.binding.status).toBe('invalid')
    if (report.binding.status === 'invalid') {
      expect(report.binding.reason).toMatch(/change_prefix.*ci-.*daily-loop.*(?:歧义|重复)/i)
    }
    expect(report.wiring.status).toBe('invalid')
    expect(report.runnable).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
  })

  test('workflow_id 未持久化：template binding 有效但 workflow wiring=unwired，不拿推荐值冒充已接线', async () => {
    const entry = loop({ workflow_id: undefined })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate))

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.status).toBe('unwired')
    expect(report.wiring.workflow).toMatchObject({ status: 'unwired', workflowId: null })
    expect(report.wiring.reason).toMatch(/workflow_id.*未接线/i)
    expect(report.runnable).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
    expect(entry.workflow_id).toBeUndefined()
    expect(entry.status).toBe('paused')
  })

  test('未知 template：binding invalid，且后续 workflow/skill 均不探测', async () => {
    const entry = loop({
      id: 'mystery-loop',
      template_id: 'unknown-template',
    })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))
    const load = vi.fn(() => null)

    const report = await buildLoopStarterWiringReport(
      'unknown-template',
      [entry],
      deps(evaluate, { loadWorkflow: load }),
    )

    expect(report.binding.status).toBe('invalid')
    if (report.binding.status === 'invalid') {
      expect(report.binding.reason).toMatch(/unknown-template/)
    }
    expect(report.wiring.status).toBe('invalid')
    expect(report.runnable).toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(evaluate).not.toHaveBeenCalled()
    expect(entry.status).toBe('paused')
  })

  test('未知 starter 即使 registry 尚无 binding，也先由 H3 catalog 明确判 unknown template', async () => {
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('unknown-template', [], deps(evaluate))

    expect(report.binding.status).toBe('invalid')
    if (report.binding.status === 'invalid') {
      expect(report.binding.reason).toMatch(/unknown id.*unknown-template/i)
    }
    expect(report.runnable).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
  })

  test('template_id 存在但 template_version 缺失：版本化 binding 不完整，不能吃 H3 默认版本冒充 valid', async () => {
    const entry = loop({ template_version: undefined })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate))

    expect(report.binding.status).toBe('invalid')
    if (report.binding.status === 'invalid') {
      expect(report.binding.reason).toMatch(/template_version.*(?:缺失|未绑定|版本)/i)
    }
    expect(report.runnable).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
  })

  test('change_prefix 嵌套不算歧义：更长前缀可与短前缀并存', async () => {
    const entry = loop({ change_prefix: 'ci-deep-', status: 'active' })
    const parent = loop({
      id: 'daily-loop',
      template_id: 'daily-triage',
      change_prefix: 'ci-',
    })
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport(
      'ci-sweeper',
      [parent, entry],
      deps(evaluate),
    )

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.status).toBe('ready')
    expect(report.runnable).toBe(true)
    expect(evaluate).toHaveBeenCalledOnce()
  })

  test.each([
    { status: 'unwired', bundleId: null, reason: 'evaluator says bundle is absent' },
    { status: 'invalid', bundleId: 'backend', reason: 'evaluator says profile is broken' },
  ] satisfies SkillBundleWiringResult[])(
    'skill evaluator 的 $status 结果对象与字段原样传播，runnable=false',
    async (skillResult) => {
      const entry = loop()
      const evaluate = vi.fn(async () => skillResult)

      const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate))

      expect(report.binding.status).toBe('valid')
      expect(report.wiring.status).toBe(skillResult.status)
      expect(report.wiring.reason).toBe(skillResult.reason)
      expect(report.wiring.skillBundle).toBe(skillResult)
      expect(report.runnable).toBe(false)
      expect(entry.status).toBe('paused')
    },
  )

  test('skill evaluator 意外抛错只使 wiring invalid，不污染已经有效的 template binding', async () => {
    const entry = loop()
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => {
      throw new Error('locator access denied')
    })

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate))

    expect(report.binding.status).toBe('valid')
    expect(report.wiring.status).toBe('invalid')
    expect(report.wiring.reason).toMatch(/locator access denied/)
    expect(report.wiring.skillBundle).toBeNull()
    expect(report.runnable).toBe(false)
    expect(entry.status).toBe('paused')
  })

  test('custom workflow runtime coordinate 显式已接线且 active/其余依赖 ready：runnable=true', async () => {
    const entry = loop({ workflow_id: 'release-train', phases: ['build'], runner: 'codex', status: 'active' })
    const definition = { name: 'release-train', steps: [] } satisfies WorkflowDef
    const evaluate = vi.fn(async (): Promise<SkillBundleWiringResult> => ({
      status: 'ready', bundleId: 'backend', reason: null,
    }))

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], deps(evaluate, {
      loadWorkflow: () => definition,
      compileWorkflow: () => workflowIr('release-train', ['build']),
      customWorkflowRuntimeWired: true,
    }))

    expect(report.wiring).toMatchObject({
      status: 'ready',
      workflow: { status: 'ready', workflowId: 'release-train' },
      customWorkflowRuntime: { status: 'ready' },
    })
    expect(report.runnable).toBe(true)
    expect(entry.runner).toBe('codex')
    expect(entry.status).toBe('active')
  })

  test('H11 r5：custom step 的 skill 缺失但同名 default phase skill 可用 → pre-claim wiring 必须 invalid', async () => {
    const entry = loop({
      workflow_id: 'release-train', phases: ['build'], runner: 'codex', status: 'active',
      skill_bundle_id: '_all',
    })
    const definition = { name: 'release-train', steps: [] } satisfies WorkflowDef
    const customStep = {
      id: 'build', label: 'Custom build', gate: null,
      skills: [{ id: 'custom-only-skill' }],
      inputs: [], outputs: [], guards: [], artifacts: [], transitions: [],
    } as const
    const resolver: EffectiveSkillResolver = {
      resolveDefault: () => [{ token: 'default-installed-skill', alternatives: ['default-installed-skill'] }],
      resolveCustom: (step) => step.skills.map(({ id }) => ({ token: id, alternatives: [id] })),
    }

    const report = await buildLoopStarterWiringReport('ci-sweeper', [entry], {
      repoRoot: '/repo',
      skillBundleWiring: {
        resolver,
        locator: {
          locate: async (skillId) => {
            if (skillId === 'default-installed-skill') return { skillId, contentDir: `/skills/${skillId}` }
            throw new SkillContentNotFoundError(`missing ${skillId}`)
          },
        },
      },
      loadWorkflow: () => definition,
      compileWorkflow: () => ({ name: 'release-train', steps: [customStep] }),
      customWorkflowRuntimeWired: true,
    })

    expect(report.wiring.status).toBe('invalid')
    expect(report.wiring.reason).toMatch(/custom-only-skill/)
    expect(report.runnable).toBe(false)
  })
})
