/**
 * loop 的 phases 在「带 `tracks:` 的自定义工作流」里怎么解析：这类工作流顶层没有 steps，步骤在分支里。
 * loop 自己不选分支（真正跑的是任务所在轨道的分支），所以静态 wiring 只核对能进 AFK 的分支
 * （`automation.eligible: true`），绝不取「第一条分支」；其中每一条都必须声明 loop 的全部 phases，
 * 缺一条整个 loop 就不通过（不能因为别的分支齐全而放行）。
 */
import { describe, expect, test } from 'vitest'
import type { LoopEntry, StepDef, WorkflowDef } from '@tenon/kernel'
import type { SkillBundleWiringResolutionInput, SkillBundleWiringResult } from '../skills/wiring.js'
import {
  buildLoopStarterWiringReport,
  evaluateLoopExecutionWiring,
  type LoopStarterWiringDeps,
} from './wiring.js'

const ready: SkillBundleWiringResult = { status: 'ready', bundleId: '_all', reason: null }

function step(id: string, skills: readonly string[] = []): StepDef {
  return {
    id, label: id, gate: null, skills: skills.map((skill) => ({ id: skill })),
    inputs: [], outputs: [], guards: [], transitions: [],
  }
}

const AFK = { eligible: true, enqueueAfterSpec: false } as const

/** 第一条分支 lite 既没写 automation 也没有 verify；frontend / backend 都能进 AFK，同名步骤的技能不同。 */
const TRACKED: WorkflowDef = {
  name: 'release-train',
  steps: [],
  tracks: {
    lite: { steps: [step('build', ['lite-skill'])] },
    frontend: { steps: [step('build', ['frontend-skill']), step('verify')], automation: AFK },
    backend: { steps: [step('build', ['backend-skill']), step('verify')], automation: AFK },
  },
}

/** frontend 声明了 build + verify，同样能进 AFK 的 backend 只有 build：只要一条满足就 ready 是错的。 */
const PARTIAL_AFK: WorkflowDef = {
  name: 'release-train',
  steps: [],
  tracks: {
    frontend: { steps: [step('build', ['frontend-skill']), step('verify')], automation: AFK },
    backend: { steps: [step('build', ['backend-skill'])], automation: AFK },
  },
}

function loop(over: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: 'rt-loop', name: 'release train loop', kind: 'orchestrator', goal: 'keep the release train moving',
    cadence: '1h', risk: 'low', runner: 'codex', change_prefix: 'rt-', phases: ['build', 'verify'],
    human_gates: ['verify'], state: '.superpowers/loops/progress.md', design_doc: 'docs/loops/rt.md',
    status: 'active', budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip' },
    kill_criteria: ['no-change-3'], autonomy_level: 'L1', allowlist: [], denylist: [],
    workflow_id: 'release-train', skill_bundle_id: '_all',
    ...over,
  }
}

/** 一次 evaluate 调用里 custom 输入的 `步骤 id:技能` 序列，便于断言取到的是哪条分支的步骤。 */
function skillsSeen(inputs: readonly SkillBundleWiringResolutionInput[] | undefined): string[] {
  return (inputs ?? []).map((input) => input.kind === 'custom'
    ? `${input.step.id}:${input.step.skills.map((skill) => skill.id).join('+')}`
    : `${input.stepId}:default`)
}

/** 记录每次 skill wiring 求值拿到的步骤；`decide` 缺省一律 ready。 */
function recorder(decide: (seen: string[]) => SkillBundleWiringResult = () => ready) {
  const calls: string[][] = []
  const evaluate: NonNullable<LoopStarterWiringDeps['evaluateSkillBundleWiring']> = async (_loop, _deps, inputs) => {
    const seen = skillsSeen(inputs)
    calls.push(seen)
    return decide(seen)
  }
  return { calls, evaluate }
}

function deps(
  evaluate: NonNullable<LoopStarterWiringDeps['evaluateSkillBundleWiring']>,
  definition: WorkflowDef | null = TRACKED,
): LoopStarterWiringDeps {
  return {
    repoRoot: '/repo',
    skillBundleWiring: {
      resolver: { resolveDefault: () => [], resolveDefaultMandatory: () => [], resolveCustom: () => [] },
      locator: { locate: async (skillId) => ({ skillId, contentDir: `/skills/${skillId}` }) },
    },
    evaluateSkillBundleWiring: evaluate,
    loadWorkflow: () => definition,
  }
}

describe('evaluateLoopExecutionWiring · 带 tracks 的自定义工作流', () => {
  test('逐条核对能进 AFK 且声明了全部 phases 的分支，不取第一条（lite 既不能进 AFK 又缺 verify）', async () => {
    const { calls, evaluate } = recorder()

    const result = await evaluateLoopExecutionWiring(loop(), [loop()], deps(evaluate))

    expect(result).toMatchObject({ status: 'ready', loopId: 'rt-loop' })
    expect(calls).toEqual([
      ['build:frontend-skill', 'verify:'],
      ['build:backend-skill', 'verify:'],
    ])
  })

  test('任一可进 AFK 的分支 wiring 不通过 → 整个 loop 不通过，原因点名该轨道', async () => {
    const { evaluate } = recorder((seen) => seen.includes('build:backend-skill')
      ? { status: 'invalid', bundleId: '_all', reason: 'backend-skill 内容缺失' }
      : ready)

    const result = await evaluateLoopExecutionWiring(loop(), [loop()], deps(evaluate))

    expect(result).toMatchObject({
      status: 'invalid', dimension: 'skill-bundle',
      reason: expect.stringMatching(/backend.*backend-skill 内容缺失/u),
    })
  })

  test('没有任何分支能进 AFK → invalid，点名该工作流', async () => {
    const { calls, evaluate } = recorder()
    const noAutomation: WorkflowDef = {
      name: 'release-train', steps: [],
      tracks: { lite: { steps: [step('build'), step('verify')] } },
    }

    const result = await evaluateLoopExecutionWiring(loop(), [loop()], deps(evaluate, noAutomation))

    expect(result).toMatchObject({
      status: 'invalid', dimension: 'workflow',
      reason: expect.stringMatching(/release-train.*没有可进入 AFK 的轨道/u),
    })
    expect(calls).toEqual([])
  })

  test('phase 在所有能进 AFK 的分支里都没声明 → invalid，点名每条分支与该 phase', async () => {
    const { calls, evaluate } = recorder()

    const result = await evaluateLoopExecutionWiring(
      loop({ phases: ['build', 'ship'] }),
      [loop()],
      deps(evaluate),
    )

    expect(result).toMatchObject({
      status: 'invalid', dimension: 'workflow',
      reason: expect.stringMatching(/release-train.*'frontend'.*"ship".*'backend'.*"ship"/u),
    })
    expect(calls).toEqual([])
  })

  test('可进 AFK 的分支缺 loop 的某个 phase → 整个 loop invalid，不因另一条分支齐全而放行', async () => {
    const { calls, evaluate } = recorder()

    const result = await evaluateLoopExecutionWiring(loop(), [loop()], deps(evaluate, PARTIAL_AFK))

    expect(result).toMatchObject({
      status: 'invalid', dimension: 'workflow',
      reason: expect.stringMatching(/release-train.*'backend'.*"verify"/u),
    })
    expect(result).toMatchObject({ reason: expect.not.stringContaining("'frontend'") })
    expect(calls).toEqual([])
  })

  test('不能进 AFK 的分支缺 phase 不影响判定', async () => {
    const { calls, evaluate } = recorder()
    const lonelyLite: WorkflowDef = {
      name: 'release-train', steps: [],
      tracks: {
        lite: { steps: [step('build')] },
        frontend: { steps: [step('build', ['frontend-skill']), step('verify')], automation: AFK },
      },
    }

    const result = await evaluateLoopExecutionWiring(loop(), [loop()], deps(evaluate, lonelyLite))

    expect(result).toMatchObject({ status: 'ready' })
    expect(calls).toEqual([['build:frontend-skill', 'verify:']])
  })

  test('平铺工作流不受影响：只有自己的 steps，evaluate 调一次', async () => {
    const { calls, evaluate } = recorder()
    const flat: WorkflowDef = { name: 'release-train', steps: [step('build', ['flat-skill']), step('verify')] }

    const result = await evaluateLoopExecutionWiring(loop(), [loop()], deps(evaluate, flat))

    expect(result).toMatchObject({ status: 'ready' })
    expect(calls).toEqual([['build:flat-skill', 'verify:']])
  })
})

describe('evaluateLoopExecutionWiring · 工作流加载失败的文案', () => {
  const failingLoad = (): never => { throw new Error('YAML 第 3 行不合法') }

  test('default 是内建工作流：失败原因不叫 custom workflow，仍带出底层错误', async () => {
    const { calls, evaluate } = recorder()

    const result = await evaluateLoopExecutionWiring(
      loop({ workflow_id: 'default', phases: ['build'] }),
      [loop()],
      { ...deps(evaluate), loadWorkflow: failingLoad },
    )

    expect(result).toMatchObject({
      status: 'invalid', dimension: 'workflow',
      reason: expect.stringMatching(/内建 workflow "default".*YAML 第 3 行不合法/u),
    })
    expect(result).toMatchObject({ reason: expect.not.stringContaining('custom workflow') })
    expect(calls).toEqual([])
  })

  test('其余工作流仍按 custom workflow 报告', async () => {
    const { evaluate } = recorder()

    const result = await evaluateLoopExecutionWiring(
      loop(),
      [loop()],
      { ...deps(evaluate), loadWorkflow: failingLoad },
    )

    expect(result).toMatchObject({
      status: 'invalid', dimension: 'workflow',
      reason: expect.stringMatching(/custom workflow "release-train".*YAML 第 3 行不合法/u),
    })
  })
})

describe('buildLoopStarterWiringReport · 带 tracks 的自定义工作流', () => {
  const starterLoop = (over: Partial<LoopEntry> = {}): LoopEntry => loop({
    template_id: 'ci-sweeper', template_version: 1, status: 'paused', phases: ['build'], ...over,
  })

  test('starter 路径同样只看能进 AFK 的分支，且各调一次 evaluator', async () => {
    const { calls, evaluate } = recorder()

    const report = await buildLoopStarterWiringReport('ci-sweeper', [starterLoop()], deps(evaluate))

    expect(report.wiring.workflow).toEqual({ status: 'ready', workflowId: 'release-train', reason: null })
    expect(report.wiring.status).toBe('ready')
    expect(calls).toEqual([['build:frontend-skill'], ['build:backend-skill']])
  })

  test('starter 路径：phase 在能进 AFK 的分支里都没声明 → workflow invalid', async () => {
    const { calls, evaluate } = recorder()

    const report = await buildLoopStarterWiringReport(
      'ci-sweeper',
      [starterLoop({ phases: ['build', 'ship'] })],
      deps(evaluate),
    )

    expect(report.wiring.workflow).toMatchObject({ status: 'invalid', workflowId: 'release-train' })
    expect(report.wiring.workflow.reason).toMatch(/"ship"/u)
    expect(report.runnable).toBe(false)
    expect(calls).toEqual([])
  })

  test('starter 路径：可进 AFK 的分支缺某个 phase → workflow invalid，点名该分支', async () => {
    const { calls, evaluate } = recorder()

    const report = await buildLoopStarterWiringReport(
      'ci-sweeper',
      [starterLoop({ phases: ['build', 'verify'] })],
      deps(evaluate, PARTIAL_AFK),
    )

    expect(report.wiring.workflow).toMatchObject({ status: 'invalid', workflowId: 'release-train' })
    expect(report.wiring.workflow.reason).toMatch(/'backend'.*"verify"/u)
    expect(report.runnable).toBe(false)
    expect(calls).toEqual([])
  })

  test('starter 路径：没有任何分支能进 AFK → workflow invalid', async () => {
    const { calls, evaluate } = recorder()
    const noAutomation: WorkflowDef = {
      name: 'release-train', steps: [],
      tracks: { lite: { steps: [step('build')] } },
    }

    const report = await buildLoopStarterWiringReport('ci-sweeper', [starterLoop()], deps(evaluate, noAutomation))

    expect(report.wiring.workflow).toMatchObject({ status: 'invalid', workflowId: 'release-train' })
    expect(report.wiring.workflow.reason).toMatch(/没有可进入 AFK 的轨道/u)
    expect(calls).toEqual([])
  })
})
