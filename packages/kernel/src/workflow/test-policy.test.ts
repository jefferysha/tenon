/**
 * 步骤 test_policy 的解析 / 编译 / 写回，与旧 tests[] 编译成内联套件的兼容路径。
 */
import { describe, expect, it } from 'vitest'
import { parseTestCatalog } from '../test-system/catalog.js'
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

describe('test_policy.integrity', () => {
  it('块形态与单行形态都能解析，写回再解析深等', () => {
    const block = parseWorkflow(workflow(['    test_policy:', '      run: [unit]', '      integrity: block']))
    expect(block.steps[0]?.test_policy).toEqual({ run: ['unit'], integrity: 'block' })
    expect(parseWorkflow(serializeWorkflow(block))).toEqual(block)
    expect(serializeWorkflow(block)).toContain('      integrity: block')
    expect(parseWorkflow(workflow(['    test_policy: { integrity: notice }'])).steps[0]?.test_policy).toEqual({ integrity: 'notice' })
  })

  it('缺省与 notice 等价：编译后的 IR 与策略摘要逐字相同，不改指纹；block 才进 IR', () => {
    const plain = compileWorkflow(parseWorkflow(workflow(['    test_policy:', '      run: [unit]'])))
    const notice = compileWorkflow(parseWorkflow(workflow(['    test_policy:', '      run: [unit]', '      integrity: notice'])))
    const block = compileWorkflow(parseWorkflow(workflow(['    test_policy:', '      run: [unit]', '      integrity: block'])))
    expect(notice.steps[0]?.test_policy).toEqual(plain.steps[0]?.test_policy)
    expect(Object.hasOwn(plain.steps[0]?.test_policy ?? {}, 'integrity')).toBe(false)
    expect(block.steps[0]?.test_policy).toMatchObject({ integrity: 'block' })
    const policyOf = (ir: typeof plain) => {
      const policy = ir.steps[0]?.test_policy
      if (policy === undefined) throw new Error('policy')
      return policy
    }
    expect(testPolicyDigest(policyOf(notice))).toBe(testPolicyDigest(policyOf(plain)))
    expect(testPolicyDigest(policyOf(block))).not.toBe(testPolicyDigest(policyOf(plain)))
    const fingerprint = (lines: readonly string[]): string =>
      compileEffectiveWorkflowPlan('policy-demo', parseWorkflow(workflow(lines))).workflowFingerprint
    expect(fingerprint(['    test_policy:', '      run: [unit]', '      integrity: notice'])).toBe(fingerprint(['    test_policy:', '      run: [unit]']))
    expect(fingerprint(['    test_policy:', '      run: [unit]', '      integrity: block'])).not.toBe(fingerprint(['    test_policy:', '      run: [unit]']))
  })

  it('值不在 notice | block → 编译失败；标量写成列表 → 解析失败', () => {
    expect(() => compileStepTestPolicy({ integrity: 'off' }, 'p')).toThrow(/integrity: 只支持 notice \| block/)
    expect(() => parseWorkflow(workflow(['    test_policy:', '      integrity: [block]']))).toThrow(/必须是单个值/)
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

  it('stepTestRequirements：档位步骤经 resolveStepTestPolicy 求值（目录 levels 的阈值进策略摘要），none 没有策略', () => {
    const result = parseTestCatalog('schema: tenon-test-catalog/v1\nlevels:\n  full: { coverage: { lines: 80 } }\nsuites: []\n')
    if (!result.ok) throw new Error('catalog')
    const step = { id: 'verify', test: 'full' as const }
    const withDefaults = stepTestRequirements(step)
    expect(withDefaults.policy).toMatchObject({ scope: 'full', level: { name: 'full', source: 'default' } })
    const withCatalog = stepTestRequirements(step, result.catalog)
    expect(withCatalog.policy).toMatchObject({ coverage: { lines: 80 }, level: { source: 'catalog' } })
    if (withDefaults.policy === undefined || withCatalog.policy === undefined) throw new Error('policy')
    expect(testPolicyDigest(withCatalog.policy)).not.toBe(testPolicyDigest(withDefaults.policy))
    expect(stepTestRequirements({ id: 'x', test: 'none' })).toEqual({ stepId: 'x', inline: [] })
  })
})

describe('default 工作流的测试档位（simplify-test-settings：工作流只写档位，含义在测试目录的 levels）', () => {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  const stepOf = (track: string, step: string): StepDef | undefined =>
    def.tracks?.[track]?.steps.find((candidate) => candidate.id === step)
  const level = (track: string, step: string): StepDef['test'] => stepOf(track, step)?.test

  it('轻量：build 跑改动（changed）；verify 全量（full）；其余步骤不写', () => {
    expect(level('lite', 'build')).toBe('changed')
    expect(level('lite', 'verify')).toBe('full')
    expect(level('lite', 'open')).toBeUndefined()
    expect(stepOf('lite', 'build')?.test_policy).toBeUndefined()
    expect(stepOf('lite', 'verify')?.test_policy).toBeUndefined()
  })

  it('前端：spec 写计划（plan）、build 跑改动、verify 全量；覆盖率门槛不再写在工作流里', () => {
    expect(level('frontend', 'spec')).toBe('plan')
    expect(level('frontend', 'build')).toBe('changed')
    expect(level('frontend', 'verify')).toBe('full')
    expect(DEFAULT_WORKFLOW_SOURCE).not.toContain('coverage:')
  })

  it('后端：spec 写计划（plan）、build 跑改动、verify 全量；基准基线门槛不再写在工作流里', () => {
    expect(level('backend', 'spec')).toBe('plan')
    expect(level('backend', 'build')).toBe('changed')
    expect(level('backend', 'verify')).toBe('full')
    expect(DEFAULT_WORKFLOW_SOURCE).not.toContain('require_baseline')
  })

  it('产品：spec 不要求（none，不再要求场景映射）；verify 跑改动；build 不写', () => {
    expect(level('pm', 'spec')).toBe('none')
    expect(level('pm', 'verify')).toBe('changed')
    expect(level('pm', 'build')).toBeUndefined()
  })

  it('全部轨道的全部步骤：没有 test_policy；必需的内联测试只剩 code-size、设计体系校验与轻量的改动风险探针', () => {
    const inline = new Set<string>()
    for (const track of Object.values(def.tracks ?? {})) {
      for (const step of track.steps) {
        expect(step.test_policy, `${step.id} 不应再有 test_policy`).toBeUndefined()
        for (const test of step.tests ?? []) if (test.required !== false) inline.add(test.id)
      }
    }
    expect([...inline].sort()).toEqual(['code-size', 'design-system', 'diff-risk'])
  })

  it('default 里出现的档位只有 none / plan / changed / full，种类与阈值不写在工作流里', () => {
    const used = new Set<string>()
    for (const track of Object.values(def.tracks ?? {})) {
      for (const step of track.steps) if (step.test !== undefined) used.add(step.test)
    }
    expect([...used].sort()).toEqual(['changed', 'full', 'none', 'plan'])
  })
})
