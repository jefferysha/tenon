import { describe, expect, it } from 'vitest'
import { compileWorkflow } from './compile.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import { validateWorkflow } from './validate.js'
import type { StepAgentsDef, WorkflowDef } from './types.js'

const BLOCK = `name: flow
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    tests:
      - id: unit
        direction: unit
        command: npm test
    agents:
      executors:
        - agent: builder
        - agent: builder-ui
          depends_on: [builder]
      reviewers:
        - agent: frontend-quality
          required: true
          block_at: high
        - agent: code-size
          required: true
          block_at: medium
          reads_tests: [unit]
        - agent: architecture
          required: false
          block_at: high
          depends_on: [frontend-quality, code-size]
    guards: []
    transitions:
      - event: done
        to: build
`

const INLINE = `name: flow
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    tests:
      - id: unit
        direction: unit
        command: npm test
    agents:
      executors:
        - { agent: builder }
        - { agent: builder-ui, depends_on: [builder] }
      reviewers:
        - { agent: frontend-quality, required: true, block_at: high }
        - { agent: code-size, required: true, block_at: medium, reads_tests: [unit] }
        - { agent: architecture, required: false, block_at: high, depends_on: [frontend-quality, code-size] }
    guards: []
    transitions:
      - event: done
        to: build
`

const step = (agents: string): string => `name: flow
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
${agents}    guards: []
    transitions:
      - event: done
        to: build
`

const agentsOf = (yaml: string): StepAgentsDef | undefined => parseWorkflow(yaml).steps[0]?.agents

describe('agents 块解析', () => {
  it('块形态与单行形态等价', () => {
    expect(agentsOf(INLINE)).toEqual(agentsOf(BLOCK))
  })

  it('required 缺省 true、block_at 缺省 high', () => {
    const agents = agentsOf(step('    agents:\n      reviewers:\n        - agent: security\n'))
    expect(agents?.reviewers[0]).toEqual({ agent: 'security', required: true, block_at: 'high' })
  })

  it('serialize → parse 深度相等，写出的永远是块形态', () => {
    const parsed = parseWorkflow(BLOCK)
    const written = serializeWorkflow(parsed)
    expect(written).toContain('    agents:\n      executors:\n        - agent: builder\n')
    expect(parseWorkflow(written)).toEqual(parsed)
    expect(serializeWorkflow(parseWorkflow(INLINE))).toBe(written)
  })

  it('两个列表都空等同缺省，序列化不写 agents', () => {
    const agents = agentsOf(step('    agents:\n      executors: []\n      reviewers: []\n'))
    expect(agents).toBeUndefined()
    expect(serializeWorkflow(parseWorkflow(step('    agents:\n      executors: []\n      reviewers: []\n'))))
      .not.toContain('agents:')
  })

  const parseErrors: readonly [string, string, string][] = [
    ['未知块字段', '    agents:\n      lanes: []\n', '未知字段'],
    ['执行者未知键', '    agents:\n      executors:\n        - agent: a\n          block_at: high\n', '未知字段'],
    ['评审者未知键', '    agents:\n      reviewers:\n        - agent: a\n          producer: b\n', '未知字段'],
    ['block_at 越界', '    agents:\n      reviewers:\n        - agent: a\n          block_at: blocker\n', 'block_at'],
    ['required 非布尔', '    agents:\n      reviewers:\n        - agent: a\n          required: yes\n', 'required'],
    ['重复 executors', '    agents:\n      executors:\n        - agent: a\n      executors:\n        - agent: b\n', '重复'],
  ]
  for (const [title, block, hint] of parseErrors) {
    it(`parse 拒绝：${title}`, () => {
      expect(() => parseWorkflow(step(block))).toThrowError(new RegExp(hint))
    })
  }
})

describe('agents 编译', () => {
  const build = (agents: unknown): WorkflowDef => ({
    name: 'flow',
    steps: [{
      id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [], guards: [],
      transitions: [{ event: 'done', to: 'build' }],
      ...(agents === undefined ? {} : { agents }),
    }] as WorkflowDef['steps'],
  })

  it('名称非法', () => {
    expect(() => compileWorkflow(build({ reviewers: [{ agent: 'Bad', required: true, block_at: 'high' }] })))
      .toThrowError(/agent 名称非法/u)
  })

  it('同一列表重复声明', () => {
    expect(() => compileWorkflow(build({
      reviewers: [
        { agent: 'a', required: true, block_at: 'high' },
        { agent: 'a', required: true, block_at: 'high' },
      ],
    }))).toThrowError(/重复声明 agent 'a'/u)
  })

  it('同一步骤既是执行者又是评审者', () => {
    expect(() => compileWorkflow(build({
      executors: [{ agent: 'a' }],
      reviewers: [{ agent: 'a', required: true, block_at: 'high' }],
    }))).toThrowError(/既是执行者又是评审者/u)
  })

  it('结构化输入必须显式给 required 与 block_at', () => {
    expect(() => compileWorkflow(build({ reviewers: [{ agent: 'a' }] }))).toThrowError(/required/u)
    expect(() => compileWorkflow(build({ reviewers: [{ agent: 'a', required: true }] }))).toThrowError(/block_at/u)
  })

  it('附加键闭集', () => {
    expect(() => compileWorkflow(build({ lanes: [] }))).toThrowError(/附加键 'lanes'/u)
  })

  it('两个列表都空编译成无 agents 键', () => {
    const ir = compileWorkflow(build({ executors: [], reviewers: [] }))
    expect(ir.steps[0]).not.toHaveProperty('agents')
    expect(compileWorkflow(build(undefined)).steps[0]).not.toHaveProperty('agents')
  })
})

describe('agents 校验', () => {
  const definition = (agents: unknown, tests?: unknown): WorkflowDef => ({
    name: 'flow',
    steps: [{
      id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [], guards: [],
      transitions: [{ event: 'done', to: 'build' }],
      ...(tests === undefined ? {} : { tests }),
      ...(agents === undefined ? {} : { agents }),
    }] as WorkflowDef['steps'],
  })

  it('depends_on 目标不在同一身份列表', () => {
    expect(validateWorkflow(definition({
      executors: [{ agent: 'a' }],
      reviewers: [{ agent: 'r', required: true, block_at: 'high', depends_on: ['a'] }],
    }))).toContain("step 'build' 的 agent 'r' 依赖了同一身份列表内不存在的 'a'")
  })

  it('循环依赖', () => {
    expect(validateWorkflow(definition({
      reviewers: [
        { agent: 'a', required: true, block_at: 'high', depends_on: ['b'] },
        { agent: 'b', required: true, block_at: 'high', depends_on: ['a'] },
      ],
    })).some((error) => error.includes('循环依赖'))).toBe(true)
  })

  it('reads_tests 未在本步骤声明', () => {
    expect(validateWorkflow(definition({
      reviewers: [{ agent: 'a', required: true, block_at: 'high', reads_tests: ['unit'] }],
    }))).toContain("step 'build' 的评审者 'a' 读取的测试 'unit' 未在本步骤声明")
    expect(validateWorkflow(definition(
      { reviewers: [{ agent: 'a', required: true, block_at: 'high', reads_tests: ['unit'] }] },
      [{ id: 'unit', direction: 'unit', command: 'npm test' }],
    ))).toEqual([])
  })

  it('track 分支错误带 tracks 前缀', () => {
    const errors = validateWorkflow({
      name: 'flow',
      steps: [],
      tracks: {
        frontend: {
          steps: [{
            id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [], guards: [],
            transitions: [{ event: 'done', to: 'build' }],
            agents: { executors: [], reviewers: [{ agent: 'a', required: true, block_at: 'high', depends_on: ['b'] }] },
          }],
        },
      },
    } as WorkflowDef)
    expect(errors.some((error) => error.startsWith('tracks.frontend: '))).toBe(true)
  })
})

describe('有效计划投影', () => {
  it('capabilities.agents 只列声明了 agent 的步骤', () => {
    const plan = compileEffectiveWorkflowPlan('flow', parseWorkflow(BLOCK))
    expect(plan.capabilities.agents.steps).toEqual([{
      stepId: 'build',
      executors: [{ agent: 'builder', dependsOn: [] }, { agent: 'builder-ui', dependsOn: ['builder'] }],
      reviewers: [
        { agent: 'frontend-quality', required: true, blockAt: 'high', dependsOn: [], readsTests: [] },
        { agent: 'code-size', required: true, blockAt: 'medium', dependsOn: [], readsTests: ['unit'] },
        { agent: 'architecture', required: false, blockAt: 'high', dependsOn: ['frontend-quality', 'code-size'], readsTests: [] },
      ],
    }])
  })

  it('未声明 agent 的工作流投影为空', () => {
    expect(compileEffectiveWorkflowPlan('flow', parseWorkflow(step(''))).capabilities.agents.steps).toEqual([])
  })
})
