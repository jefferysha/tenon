/**
 * 步骤 test_policy 的解析 / 编译 / 写回，与旧 tests[] 编译成内联套件的兼容路径。
 */
import { describe, expect, it } from 'vitest'
import { stepTestRequirements, testPolicyDigest } from '../test-system/policy.js'
import { compileWorkflow } from './compile.js'
import { compileStepTestPolicy } from './compile-test-policy.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import type { StepDef, WorkflowDef } from './types.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'

function workflow(policyLines: readonly string[], tests = false): string {
  return [
    'name: policy-demo',
    'steps:',
    '  - id: build',
    '    label: Build',
    '    gate: null',
    '    skills: []',
    '    inputs: []',
    '    outputs: []',
    ...(tests ? [
      '    tests:',
      '      - id: unit',
      '        direction: unit',
      '        command: npm test',
      '        label: 单测',
    ] : []),
    ...policyLines,
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

const FULL = [
  '    test_policy:',
  '      plan: required',
  '      kinds: [unit, regression, playwright]',
  '      run: [unit, typecheck]',
  '      run_if_registered: [a11y, visual]',
  '      scope: changed',
  '      files: registered',
  '      scenarios: passing',
  '      coverage: { lines: 80, branches: 70, changed_lines: 90 }',
  '      flaky:',
  '        max: 2',
  '        fail_on_new: true',
  '      benchmark: { require_baseline: false }',
  '      browsers: [chromium, Mobile Chrome]',
]

describe('test_policy 解析与写回', () => {
  it('块形态解析为定义层；写回再解析深等', () => {
    const def = parseWorkflow(workflow(FULL))
    expect(def.steps[0]?.test_policy).toEqual({
      plan: 'required',
      kinds: ['unit', 'regression', 'playwright'],
      run: ['unit', 'typecheck'],
      run_if_registered: ['a11y', 'visual'],
      scope: 'changed',
      files: 'registered',
      scenarios: 'passing',
      coverage: { lines: 80, branches: 70, changed_lines: 90 },
      flaky: { max: 2, fail_on_new: true },
      benchmark: { require_baseline: false },
      browsers: ['chromium', 'Mobile Chrome'],
    })
    expect(parseWorkflow(serializeWorkflow(def))).toEqual(def)
  })

  it('单行形态与空策略', () => {
    expect(parseWorkflow(workflow(['    test_policy: { run: [smoke], scope: full }'])).steps[0]?.test_policy).toEqual({ run: ['smoke'], scope: 'full' })
    const empty = parseWorkflow(workflow(['    test_policy: {}']))
    expect(empty.steps[0]?.test_policy).toEqual({})
    expect(parseWorkflow(serializeWorkflow(empty))).toEqual(empty)
  })

  it.each([
    ['未知键', ['    test_policy:', '      speed: fast'], /未知键 'speed'/],
    ['重复键', ['    test_policy:', '      scope: full', '      scope: changed'], /重复声明 scope/],
    ['列表写成标量', ['    test_policy:', '      kinds: unit'], /必须是 \[a, b\] 列表/],
    ['标量写成列表', ['    test_policy:', '      scope: [full]'], /必须是单个值/],
    ['映射写成标量', ['    test_policy:', '      coverage: 80'], /必须是 \{ k: v \} 映射/],
    ['键缺值', ['    test_policy:', '      scope:'], /scope 缺值/],
    ['单行形态不支持嵌套映射', ['    test_policy: { coverage: 80 }'], /单行形态不支持 coverage/],
    ['嵌套块重复键', ['    test_policy:', '      flaky:', '        max: 1', '        max: 2'], /重复声明 max/],
    ['嵌套映射给列表', ['    test_policy:', '      flaky: { max: [1] }'], /不接受列表/],
    ['重复声明 test_policy', ['    test_policy: {}', '    test_policy: {}'], /重复声明 test_policy/],
  ])('%s → 解析失败', (_name, lines, pattern) => {
    expect(() => parseWorkflow(workflow(lines))).toThrow(pattern)
  })
})

describe('test_policy 编译', () => {
  it('补齐默认值', () => {
    expect(compileStepTestPolicy({}, 'p')).toEqual({
      plan: 'required', kinds: [], run: [], run_if_registered: [], scope: 'full', files: 'any', scenarios: 'off',
      benchmark: { require_baseline: false }, browsers: [],
    })
    expect(compileStepTestPolicy(undefined, 'p')).toBeUndefined()
    const ir = compileWorkflow(parseWorkflow(workflow(FULL)))
    expect(ir.steps[0]?.test_policy).toMatchObject({ scope: 'changed', flaky: { max: 2, fail_on_new: true }, coverage: { lines: 80 } })
    expect(Object.isFrozen(ir.steps[0]?.test_policy)).toBe(true)
  })

  it.each([
    ['非对象', 'x', /必须是对象/],
    ['未知键', { speed: 1 }, /不接受的键 'speed'/],
    ['种类未知', { kinds: ['ui'] }, /测试种类 'ui' 不在闭集/],
    ['种类不是列表', { run: 'unit' }, /必须是种类列表/],
    ['种类重复', { run: ['unit', 'unit'] }, /'unit' 重复/],
    ['必跑与有则跑重叠', { run: ['unit'], run_if_registered: ['unit'] }, /不能同时是「有则跑」/],
    ['plan optional 却要登记', { plan: 'optional', kinds: ['unit'] }, /不能与 plan: optional 同用/],
    ['plan 值非法', { plan: 'maybe' }, /plan: 只支持 required \| optional/],
    ['scope 非法', { scope: 'some' }, /scope: 只支持 changed \| full/],
    ['files 非法', { files: 'all' }, /files: 只支持 registered \| any/],
    ['scenarios 非法', { scenarios: 'yes' }, /scenarios: 只支持/],
    ['覆盖率越界', { coverage: { lines: 120 } }, /0–100/],
    ['覆盖率未知项', { coverage: { mutation: 10 } }, /不接受的键 'mutation'/],
    ['覆盖率为空', { coverage: {} }, /至少声明/],
    ['flaky 上限非法', { flaky: { max: -1 } }, /0–1000 的整数/],
    ['flaky fail_on_new 非布尔', { flaky: { max: 1, fail_on_new: 'yes' } }, /必须是布尔/],
    ['benchmark 非布尔', { benchmark: { require_baseline: 'no' } }, /必须是布尔/],
    ['浏览器名非法', { browsers: ['@@'] }, /project 名 '@@' 非法/],
    ['浏览器重复', { browsers: ['a', 'a'] }, /project 'a' 重复/],
    ['浏览器不是列表', { browsers: 'a' }, /必须是 Playwright project 名列表/],
  ])('%s → 编译失败', (_name, raw, pattern) => {
    expect(() => compileStepTestPolicy(raw, 'steps[0].test_policy')).toThrow(pattern)
  })

  it('结构化输入同样经 compileWorkflow 校验', () => {
    const def = parseWorkflow(workflow([]))
    const bad = { ...def, steps: def.steps.map((step, index) => (index === 0 ? { ...step, test_policy: { kinds: ['ui'] } } : step)) }
    expect(() => compileWorkflow(bad as unknown as WorkflowDef)).toThrow(/steps\[0\]\.test_policy\.kinds/)
  })
})

describe('兼容：未声明策略的工作流 IR 与指纹逐字不变；旧 tests[] 编译成内联套件', () => {
  it('不写 test_policy → IR 无该键、指纹与不支持该键的形状相同', () => {
    const ir = compileWorkflow(parseWorkflow(workflow([], true)))
    expect(Object.hasOwn(ir.steps[0] ?? {}, 'test_policy')).toBe(false)
    const withPolicy = compileWorkflow(parseWorkflow(workflow(['    test_policy: {}'], true)))
    const plan = compileEffectiveWorkflowPlan('policy-demo', parseWorkflow(workflow([], true)))
    const planWith = compileEffectiveWorkflowPlan('policy-demo', parseWorkflow(workflow(['    test_policy: {}'], true)))
    expect(plan.workflowFingerprint).not.toBe(planWith.workflowFingerprint)
    expect(withPolicy.steps[0]?.tests).toEqual(ir.steps[0]?.tests)
  })

  it('stepTestRequirements：策略 + step: 内联套件并存', () => {
    const ir = compileWorkflow(parseWorkflow(workflow(FULL, true)))
    const step = ir.steps[0]
    if (step === undefined) throw new Error('step')
    const requirements = stepTestRequirements(step)
    expect(requirements.inline).toEqual([{ id: 'step:unit', testId: 'unit', kind: 'unit', label: '单测', required: true, command: 'npm test', cwd: '.' }])
    expect(requirements.policy?.run).toEqual(['unit', 'typecheck'])
    if (requirements.policy === undefined) throw new Error('policy')
    expect(testPolicyDigest(requirements.policy)).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(testPolicyDigest({ ...requirements.policy, scope: 'full' })).not.toBe(testPolicyDigest(requirements.policy))
  })
})

describe('default 工作流的默认策略（设计 §4）', () => {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  const policy = (track: string, step: string): StepDef['test_policy'] =>
    def.tracks?.[track]?.steps.find((candidate) => candidate.id === step)?.test_policy

  it('对话 / 自由：spec 要求 unit；build 跑 unit+typecheck（changed）；verify 跑 unit+regression（full）', () => {
    for (const track of ['chat', 'free']) {
      expect(policy(track, 'spec')).toEqual({ plan: 'required', kinds: ['unit'] })
      expect(policy(track, 'build')).toEqual({ run: ['unit', 'typecheck'], scope: 'changed', files: 'registered' })
      expect(policy(track, 'verify')).toEqual({ run: ['unit', 'regression'], scope: 'full', files: 'registered' })
    }
  })

  it('前端加 playwright（chromium+webkit）、a11y / visual 有则跑、覆盖率 lines 80', () => {
    expect(policy('frontend', 'verify')).toEqual({
      run: ['unit', 'regression', 'playwright'], run_if_registered: ['a11y', 'visual'], scope: 'full', files: 'registered',
      coverage: { lines: 80 }, browsers: ['chromium', 'webkit'],
    })
  })

  it('后端加 integration、regression（full）、benchmark 有则跑、覆盖率 lines 80', () => {
    expect(policy('backend', 'spec')).toEqual({ plan: 'required', kinds: ['unit', 'integration'] })
    expect(policy('backend', 'verify')).toEqual({
      run: ['unit', 'integration', 'regression'], run_if_registered: ['benchmark'], scope: 'full', files: 'registered',
      coverage: { lines: 80 }, benchmark: { require_baseline: false },
    })
  })

  it('产品：spec 要求场景映射；verify 跑冒烟', () => {
    expect(policy('pm', 'spec')).toEqual({ plan: 'required', scenarios: 'required' })
    expect(policy('pm', 'verify')).toEqual({ run: ['smoke'], scope: 'full' })
    expect(policy('pm', 'build')).toBeUndefined()
  })

  it('旧 tests[] 仍在并与策略并存', () => {
    const build = def.tracks?.frontend?.steps.find((step) => step.id === 'build')
    expect(build?.tests?.map((test) => test.id)).toEqual(['typecheck', 'unit'])
    expect(build?.test_policy?.run).toEqual(['unit', 'typecheck'])
  })
})
