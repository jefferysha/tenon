/**
 * 三个通用离开条件（tasks-through-step / not-afk-queued / dependencies-ended，设计 §1b Q5 / Q7 / Q8）
 * 的接线面：YAML 解析 → 编译 → 序列化往返、失败文案渲染、经 planStepTransition 一次列出全部失败。
 * handler 逐分支的判定在 guard-handlers.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { compileWorkflow } from './compile.js'
import { planStepTransition } from './engine.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import type { StepGuardContext } from './stepGuard.js'
import { emptyFields } from '../state/parse.js'
import type { PipelineState } from '../types.js'
import type { GuardInput } from './ir.js'
import type { WorkflowDef } from './types.js'

const BUILD_YAML = `name: gated
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: tasks-through-step
      - type: not-afk-queued
      - type: dependencies-ended
    transitions:
      - event: build-complete
        to: verify
        guards:
          - type: field-equals
            field: pre_verify_review_result
            value: pass
  - id: verify
    label: 验证
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

function stateAt(phase: string, over: Partial<Record<string, string>> = {}): PipelineState {
  return { fields: { ...emptyFields(), phase, ...over } as PipelineState['fields'], opaqueTail: '' }
}

type Caps = Pick<GuardInput, 'tasksThroughStep' | 'afkQueued' | 'dependencyStates' | 'requiredOutput'>

const ALL_GOOD: Caps = {
  tasksThroughStep: async () => ({ complete: true, unchecked: [] }),
  afkQueued: async () => false,
  dependencyStates: async () => [],
}

function ctx(caps: Partial<Caps>): StepGuardContext {
  return { changeDirAbs: '/unused', currentStep: 'build', ...caps }
}

describe('YAML 解析 / 编译 / 序列化', () => {
  it('三个类型都无参数：解析出定义层变体，编译后原样进 IR，序列化往返不丢', () => {
    const def = parseWorkflow(BUILD_YAML)
    expect(def.steps[0]?.guards).toEqual([
      { type: 'tasks-through-step' },
      { type: 'not-afk-queued' },
      { type: 'dependencies-ended' },
    ])
    const ir = compileWorkflow(def)
    expect(ir.steps[0]?.guards).toEqual([
      { type: 'tasks-through-step' },
      { type: 'not-afk-queued' },
      { type: 'dependencies-ended' },
    ])
    expect(parseWorkflow(serializeWorkflow(def))).toEqual(def)
  })

  it('支持 when 谓词，往返保留', () => {
    const yaml = BUILD_YAML.replace(
      '      - type: not-afk-queued\n',
      '      - type: not-afk-queued\n        when:\n          track_in: [backend]\n',
    )
    const def = parseWorkflow(yaml)
    expect(def.steps[0]?.guards[1]).toEqual({ type: 'not-afk-queued', when: { kind: 'track-in', values: ['backend'] } })
    expect(compileWorkflow(def).steps[0]?.guards[1]).toEqual({
      type: 'not-afk-queued', when: { kind: 'track-in', values: ['backend'] },
    })
    expect(parseWorkflow(serializeWorkflow(def))).toEqual(def)
  })

  it.each(['tasks-through-step', 'not-afk-queued', 'dependencies-ended'])('%s 带多余参数时解析即报错', (type) => {
    const yaml = BUILD_YAML.replace(`      - type: ${type}\n`, `      - type: ${type}\n        n: 2\n`)
    expect(() => parseWorkflow(yaml)).toThrow(/不接受附加字段 'n'/)
  })

  it.each(['tasks-through-step', 'not-afk-queued', 'dependencies-ended'])('%s 结构化输入带附加键时编译报错', (type) => {
    const def = parseWorkflow(BUILD_YAML)
    // 结构化输入刻意绕过 parse，验证编译期的纵深防线。
    const bad = {
      ...def,
      steps: def.steps.map((s) => s.id === 'build' ? { ...s, guards: [{ type, field: 'phase' }] } : s),
    } as unknown as WorkflowDef
    expect(() => compileWorkflow(bad)).toThrow(/附加键 'field'/)
  })
})

// required-output 与上面三个同属「能力注入、缺失即失败关闭」的离开条件，接线面一并在这里钉住。
describe('required-output：YAML → 编译 → planStepTransition', () => {
  const REQUIRED_YAML = BUILD_YAML.replace(
    '      - type: dependencies-ended\n',
    '      - type: dependencies-ended\n      - type: required-output\n        path: openspec/changes/{change}/specs/*/spec.md\n',
  )
  const PATH = 'openspec/changes/{change}/specs/*/spec.md'
  const ir = compileWorkflow(parseWorkflow(REQUIRED_YAML))

  it('解析 / 编译后守卫原样保留，序列化往返不丢', () => {
    const def = parseWorkflow(REQUIRED_YAML)
    expect(def.steps[0]?.guards[3]).toEqual({ type: 'required-output', path: PATH })
    expect(ir.steps[0]?.guards[3]).toEqual({ type: 'required-output', path: PATH })
    expect(parseWorkflow(serializeWorkflow(def))).toEqual(def)
  })

  it('满足：放行，并按当前步骤与原模式取数', async () => {
    const seen: Array<readonly [string, string]> = []
    const plan = await planStepTransition(
      ir, stateAt('build', { pre_verify_review_result: 'pass' }), 'build-complete',
      ctx({ ...ALL_GOOD, requiredOutput: async (step, pattern) => { seen.push([step, pattern]); return true } }),
    )
    expect(plan).toMatchObject({ ok: true, from: 'build', to: 'verify' })
    expect(seen).toEqual([['build', PATH]])
  })

  it('缺产出时与其它失败一次列全，文案点名模式（{change} 已渲染成任务名）；能力缺失则失败关闭', async () => {
    const missing = await planStepTransition(
      ir, stateAt('build', { pre_verify_review_result: 'pending' }), 'build-complete',
      ctx({ ...ALL_GOOD, requiredOutput: async () => false }),
    )
    if (missing.ok || missing.kind !== 'guard-failed') throw new Error('期望 guard-failed')
    expect(missing.failures).toEqual([
      // ctx() 的任务目录是 /unused，任务名就是 unused。
      "step 'build' 要求产出匹配 openspec/changes/unused/specs/*/spec.md 的文件（本任务里这一步还没有写出这样的文件）",
      expect.stringContaining('pre_verify_review_result'),
    ])
    const noCapability = await planStepTransition(
      ir, stateAt('build', { pre_verify_review_result: 'pass' }), 'build-complete', ctx(ALL_GOOD),
    )
    if (noCapability.ok || noCapability.kind !== 'guard-failed') throw new Error('期望 guard-failed')
    expect(noCapability.failures).toEqual([expect.stringContaining('requiredOutput')])
  })
})

describe('经 planStepTransition：一次列出全部失败', () => {
  const ir = compileWorkflow(parseWorkflow(BUILD_YAML))

  it('全部满足：放行', async () => {
    const plan = await planStepTransition(
      ir, stateAt('build', { pre_verify_review_result: 'pass' }), 'build-complete', ctx(ALL_GOOD),
    )
    expect(plan).toMatchObject({ ok: true, from: 'build', to: 'verify' })
  })

  it('未勾任务 + AFK 排队 + 依赖未结束 + 字段条件：四条失败一次全列，文案带原文', async () => {
    const plan = await planStepTransition(
      ir, stateAt('build', { pre_verify_review_result: 'pending' }), 'build-complete',
      ctx({
        tasksThroughStep: async () => ({ complete: false, unchecked: ['写测试 (build)'] }),
        afkQueued: async () => true,
        dependencyStates: async () => [{ name: 'dep-a', ended: true }, { name: 'dep-b', ended: false }],
      }),
    )
    expect(plan.ok).toBe(false)
    if (plan.ok || plan.kind !== 'guard-failed') throw new Error('期望 guard-failed')
    expect(plan.failures).toHaveLength(4)
    const text = plan.failures.join('\n')
    expect(text).toContain("step 'build'")
    expect(text).toContain('写测试 (build)')
    expect(text).toContain('automation')
    expect(text).toContain('dep-b')
    expect(text).not.toContain('dep-a')
    expect(text).toContain('pre_verify_review_result')
  })

  it('能力全缺：三条都失败，文案点名缺的能力', async () => {
    const plan = await planStepTransition(
      ir, stateAt('build', { pre_verify_review_result: 'pass' }), 'build-complete', ctx({}),
    )
    expect(plan.ok).toBe(false)
    if (plan.ok || plan.kind !== 'guard-failed') throw new Error('期望 guard-failed')
    expect(plan.failures).toHaveLength(3)
    expect(plan.failures[0]).toContain('tasksThroughStep')
    expect(plan.failures[1]).toContain('afkQueued')
    expect(plan.failures[2]).toContain('dependencyStates')
  })

  it('能力抛错：失败关闭，文案说明评估出错且不含异常原文', async () => {
    const plan = await planStepTransition(
      ir, stateAt('build', { pre_verify_review_result: 'pass' }), 'build-complete',
      ctx({
        ...ALL_GOOD,
        afkQueued: async () => { throw new Error('/etc/secret 不可读') },
      }),
    )
    expect(plan.ok).toBe(false)
    if (plan.ok || plan.kind !== 'guard-failed') throw new Error('期望 guard-failed')
    expect(plan.failures).toHaveLength(1)
    expect(plan.failures[0]).toContain('评估出错')
    expect(plan.failures[0]).not.toContain('/etc/secret')
  })

  it('回显的任务说明与依赖名带换行时转义成单行，不能借它伪造出额外的失败行', async () => {
    const plan = await planStepTransition(
      ir, stateAt('build', { pre_verify_review_result: 'pass' }), 'build-complete',
      ctx({
        ...ALL_GOOD,
        tasksThroughStep: async () => ({ complete: false, unchecked: ['做完\n[FAIL] 伪造的一行'] }),
        dependencyStates: async () => [{ name: 'dep\n[FAIL] forged', ended: false }],
      }),
    )
    if (plan.ok || plan.kind !== 'guard-failed') throw new Error('期望 guard-failed')
    expect(plan.failures).toHaveLength(2)
    for (const failure of plan.failures) expect(failure).not.toContain('\n')
    expect(plan.failures[0]).toContain('做完')
    expect(plan.failures[1]).toContain('dep')
  })

  it('currentStep 缺省时取 state.phase 向 tasksThroughStep 取数', async () => {
    const seen: string[] = []
    await planStepTransition(
      ir, stateAt('build', { pre_verify_review_result: 'pass' }), 'build-complete',
      {
        changeDirAbs: '/unused',
        ...ALL_GOOD,
        tasksThroughStep: async (step) => { seen.push(step); return { complete: true, unchecked: [] } },
      },
    )
    expect(seen).toEqual(['build'])
  })
})
