/**
 * 步骤 `test:` 档位键：解析 / 编译 / 写回、与 test_policy 互斥、没写时 IR 与指纹逐字不变。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compileDefaultWorkflow, compileWorkflow, decodeWorkflowDef } from './compile.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { compileEffectiveWorkflowPlan, effectiveWorkflowPlanFromSnapshot, workflowPlanSnapshot } from './effective-plan.js'
import type { StepIR } from './ir.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import { TEST_LEVELS, isTestLevel, stepDeclaresTests } from './test-level.js'
import type { WorkflowDef } from './types.js'

function workflow(extra: readonly string[]): string {
  return [
    'name: level-demo',
    'steps:',
    '  - id: build',
    '    label: Build',
    '    gate: null',
    '    skills: []',
    '    inputs: []',
    '    outputs: []',
    ...extra,
    '    guards: []',
    '    transitions:',
    '      - event: done',
    '        to: done',
    '  - id: done',
    '    label: Done',
    '    gate: null',
    '    skills: []',
    '    inputs: []',
    '    outputs: []',
    '    guards: []',
    '    transitions: []',
    '',
  ].join('\n')
}

const INLINE_TESTS = ['    tests:', '      - id: unit', '        direction: unit', '        command: npm test', '        label: 单测']
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

function firstStep(source: string): StepIR {
  const step = compileWorkflow(parseWorkflow(source)).steps[0]
  if (step === undefined) throw new Error('missing step')
  return step
}

describe('档位闭集', () => {
  it('四个档位，守卫只认这四个字符串', () => {
    expect([...TEST_LEVELS]).toEqual(['none', 'plan', 'changed', 'full'])
    for (const level of TEST_LEVELS) expect(isTestLevel(level)).toBe(true)
    for (const bad of ['quick', '', 'Full', 'changed ', undefined, null, 1, ['full']]) expect(isTestLevel(bad)).toBe(false)
  })
})

describe('test: 解析 / 编译 / 写回', () => {
  it.each(TEST_LEVELS)('test: %s 进定义层与 IR，写回再解析深等', (level) => {
    const source = workflow([`    test: ${level}`])
    const def = parseWorkflow(source)
    expect(def.steps[0]?.test).toBe(level)
    expect(firstStep(source).test).toBe(level)
    const text = serializeWorkflow(def)
    expect(text).toContain(`    test: ${level}\n`)
    expect(parseWorkflow(text)).toEqual(def)
    expect(serializeWorkflow(parseWorkflow(text))).toBe(text)
  })

  it('编译后的 IR 只记档位名（冻结的纯字符串），不含任何档位内容', () => {
    const ir = compileWorkflow(parseWorkflow(workflow(['    test: changed'])))
    expect(ir.steps[0]?.test).toBe('changed')
    expect(Object.isFrozen(ir.steps[0])).toBe(true)
    expect(JSON.stringify(ir.steps[0])).not.toContain('required')
    expect(Object.hasOwn(ir.steps[0] ?? {}, 'test_policy')).toBe(false)
  })

  it('同一步可以和旧 tests[] 内联测试并存', () => {
    const step = firstStep(workflow(['    test: changed', ...INLINE_TESTS]))
    expect(step.test).toBe('changed')
    expect(step.tests?.map((test) => test.id)).toEqual(['unit'])
  })

  it('test 写在 tests 与 test_policy 之间的位置也能解析（键序无关）', () => {
    const def = parseWorkflow(workflow([...INLINE_TESTS, '    test: full']))
    expect(def.steps[0]?.test).toBe('full')
    expect(def.steps[0]?.tests?.length).toBe(1)
  })

  it('track 分支里的步骤同样接受 test', () => {
    const source = [
      'name: branched', 'tracks:', '  lite:', '    steps:',
      '      - id: build', '        label: Build', '        gate: null', '        test: full',
      '        skills: []', '        inputs: []', '        outputs: []', '        guards: []', '        transitions: []', '',
    ].join('\n')
    const ir = compileWorkflow(parseWorkflow(source))
    expect(ir.tracks?.lite?.steps[0]?.test).toBe('full')
  })

  it('重复声明 test → 解析失败', () => {
    expect(() => parseWorkflow(workflow(['    test: plan', '    test: full']))).toThrow(/step 'build' 重复声明 test/)
  })

  it('test 缺值 → 解析失败', () => {
    expect(() => parseWorkflow(workflow(['    test:']))).toThrow(/step 'build' 的 test/)
  })
})

describe('test: 与 test_policy 互斥', () => {
  it('同一步同时写 → 编译抛错，点名步骤并说明只能写一个', () => {
    const source = workflow(['    test: full', '    test_policy:', '      run: [unit]'])
    expect(() => compileWorkflow(parseWorkflow(source))).toThrow(/build.*test 与 test_policy 只能写一个/)
  })

  it('不论键序', () => {
    const source = workflow(['    test_policy: {}', '    test: none'])
    expect(() => compileWorkflow(parseWorkflow(source))).toThrow(/build.*test 与 test_policy 只能写一个/)
  })

  it('track 分支里的步骤同样互斥，并带分支路径', () => {
    const source = [
      'name: branched', 'tracks:', '  lite:', '    steps:',
      '      - id: verify', '        label: V', '        gate: null', '        test: full', '        test_policy: {}',
      '        skills: []', '        inputs: []', '        outputs: []', '        guards: []', '        transitions: []', '',
    ].join('\n')
    expect(() => compileWorkflow(parseWorkflow(source))).toThrow(/tracks\.lite\.steps\[0\].*verify.*只能写一个/)
  })

  it('只写 test_policy 时与修改前一致：IR 无 test 键', () => {
    const step = firstStep(workflow(['    test_policy:', '      run: [unit]']))
    expect(step.test_policy?.run).toEqual(['unit'])
    expect(Object.hasOwn(step, 'test')).toBe(false)
  })
})

describe('未知或畸形的档位', () => {
  it('test: quick → 编译失败并列出四个可选值', () => {
    expect(() => compileWorkflow(parseWorkflow(workflow(['    test: quick'])))).toThrow(/none \| plan \| changed \| full/)
    expect(() => compileWorkflow(parseWorkflow(workflow(['    test: quick'])))).toThrow(/quick/)
  })

  it('大小写敏感：Full 不是档位', () => {
    expect(() => compileWorkflow(parseWorkflow(workflow(['    test: Full'])))).toThrow(/none \| plan \| changed \| full/)
  })
})

describe('结构化输入（decodeWorkflowDef）走同一条校验链', () => {
  const base = parseWorkflow(workflow([]))
  const withStep0 = (patch: Record<string, unknown>): unknown => ({
    ...base,
    steps: base.steps.map((step, index) => (index === 0 ? { ...step, ...patch } : step)),
  })

  it('合法档位原样返回定义层', () => {
    const input = withStep0({ test: 'changed' })
    expect(decodeWorkflowDef(input)).toBe(input)
    expect(compileWorkflow(input).steps[0]?.test).toBe('changed')
  })

  it('未知档位、非字符串、空串 → 拒绝', () => {
    for (const bad of ['quick', 5, null, '', ['full'], { level: 'full' }]) {
      expect(() => decodeWorkflowDef(withStep0({ test: bad })), JSON.stringify(bad)).toThrow(/steps\[0\]\.test/)
    }
    expect(() => decodeWorkflowDef(withStep0({ test: 'quick' }))).toThrow(/none \| plan \| changed \| full/)
  })

  it('test 与 test_policy 同时出现 → 拒绝', () => {
    expect(() => decodeWorkflowDef(withStep0({ test: 'full', test_policy: {} }))).toThrow(/build.*test 与 test_policy 只能写一个/)
    expect(() => decodeWorkflowDef(withStep0({ test: 'none', test_policy: { run: ['unit'] } }))).toThrow(/只能写一个/)
  })

  it('default 来源同样校验', () => {
    expect(() => decodeWorkflowDef(withStep0({ test: 'quick' }), 'default')).toThrow(/none \| plan \| changed \| full/)
  })

  it('其余不接受的附加键仍被拒（test 加入闭集不放宽别的键）', () => {
    expect(() => decodeWorkflowDef(withStep0({ tests_level: 'full' }))).toThrow(/附加键 'tests_level'/)
  })
})

describe('冻结的计划快照', () => {
  it('档位名随快照往返，恢复出的计划指纹不变', () => {
    const plan = compileEffectiveWorkflowPlan('level-demo', parseWorkflow(workflow(['    test: changed'])))
    const restored = effectiveWorkflowPlanFromSnapshot(JSON.parse(JSON.stringify(workflowPlanSnapshot(plan))))
    expect(restored.workflow.steps[0]?.test).toBe('changed')
    expect(restored.workflowFingerprint).toBe(plan.workflowFingerprint)
  })
})

describe('stepDeclaresTests', () => {
  const policy = compileWorkflow(parseWorkflow(workflow(['    test_policy: {}']))).steps[0]?.test_policy
  const tests = compileWorkflow(parseWorkflow(workflow(INLINE_TESTS))).steps[0]?.tests

  it('没有任何测试声明 → false', () => {
    expect(stepDeclaresTests({})).toBe(false)
  })

  it('test: none 等同没写', () => {
    expect(stepDeclaresTests({ test: 'none' })).toBe(false)
  })

  it('plan / changed / full 为 true', () => {
    for (const level of ['plan', 'changed', 'full'] as const) expect(stepDeclaresTests({ test: level })).toBe(true)
  })

  it('有 test_policy 或 tests 为 true（旧任务照常）', () => {
    expect(policy).toBeDefined()
    expect(tests).toBeDefined()
    expect(stepDeclaresTests({ test_policy: policy })).toBe(true)
    expect(stepDeclaresTests({ tests })).toBe(true)
  })

  it('空 tests 数组不算声明', () => {
    expect(stepDeclaresTests({ tests: [] })).toBe(false)
  })
})

describe('兼容：没写 test 的工作流编译结果与指纹逐字不变', () => {
  // 以下摘要在引入 test 键之前的代码上取得（同一份输入、同一个 JSON.stringify）。序列化的摘要取自不写空 inputs / outputs 的序列化器。
  it('不写 test、不写策略的工作流', () => {
    const source = workflow([])
    expect(sha(JSON.stringify(compileWorkflow(parseWorkflow(source))))).toBe('88cb7cbc011849f170fad7cf602aad88d8fa3b9f0682756dfa2caf3be2c34cad')
    expect(compileEffectiveWorkflowPlan('level-demo', parseWorkflow(source)).workflowFingerprint)
      .toBe('5c71af2ef5f5792c706a35f36be83c6b3609f2380cdbc6f43cd4e847041b4921')
    expect(sha(serializeWorkflow(parseWorkflow(source)))).toBe('1d3e632330d44d6a9d87227b3cab5abc91f45ec737ec45bea5cff9ff3e9ccce2')
  })

  it('只写旧 tests[] 与 test_policy 的工作流', () => {
    const source = workflow([...INLINE_TESTS, '    test_policy:', '      run: [unit]', '      files: registered'])
    expect(sha(JSON.stringify(compileWorkflow(parseWorkflow(source))))).toBe('c4d85ac75d5bd49dd067b34b7f254869a4a3d650d516144e6288c6e7bb78b0df')
    expect(compileEffectiveWorkflowPlan('level-demo', parseWorkflow(source)).workflowFingerprint)
      .toBe('7419c3b2823952c667adfb10b881cf3962e2c85be542dbbb895fa3fb7166cbcf')
  })

  it('写了 test: none 的工作流与没写的不同（显式声明进 IR），但档位内容不进 IR', () => {
    const plain = compileEffectiveWorkflowPlan('level-demo', parseWorkflow(workflow([]))).workflowFingerprint
    const none = compileEffectiveWorkflowPlan('level-demo', parseWorkflow(workflow(['    test: none']))).workflowFingerprint
    const changed = compileEffectiveWorkflowPlan('level-demo', parseWorkflow(workflow(['    test: changed']))).workflowFingerprint
    expect(new Set([plain, none, changed]).size).toBe(3)
  })

  it('default 模板：IR 只在定义层声明了 test 的步骤上带 test，其余步骤的 IR 逐字不变', () => {
    const def: WorkflowDef = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    const ir = compileDefaultWorkflow(def)
    const declared = Object.values(def.tracks ?? {}).flatMap((branch) => branch.steps).some((step) => step.test !== undefined)
    for (const [id, branch] of Object.entries(ir.tracks ?? {})) {
      branch.steps.forEach((step, index) => {
        const source = def.tracks?.[id]?.steps[index]
        expect(Object.hasOwn(step, 'test'), `${id}/${step.id}`).toBe(source?.test !== undefined)
      })
    }
    // 模板尚未采用档位时，整份 IR 与引入 test 键之前逐字节相同。
    if (!declared) expect(sha(JSON.stringify(ir))).toBe('18ea85d1d01f73e668b94b842cfff20f2d4cb67b83d1007536968c1b6477595f')
  })
})
