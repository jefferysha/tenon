import { describe, expect, it } from 'vitest'
import { builtinTrack } from '../tracks/builtins.js'
import { compileWorkflow, decodeWorkflowDef } from './compile.js'
import {
  compileEffectiveWorkflowPlan,
  DocumentGovernanceBindingError,
  effectiveWorkflowPlanFromSnapshot,
  workflowPlanSnapshot,
} from './effective-plan.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import { effectiveMaxRounds } from './step-rounds.js'
import { validateWorkflow } from './validate.js'
import type { WorkflowPlanSnapshotV4 } from './workflow-plan-snapshot-types.js'

interface YamlOptions {
  /** 写在 verify 步 gate 行之后的额外键（含缩进与换行）。 */
  readonly verifyExtra?: string
  /** 写在 build 步 gate 行之后的额外键。 */
  readonly buildExtra?: string
  readonly verifyGate?: string
  readonly verifyTransitions?: string
}

const BACK_AND_FORWARD = `      - event: verify-pass
        to: ship
      - event: verify-fail
        to: build
`

function workflowYaml(options: YamlOptions = {}): string {
  return `name: rounds-yaml
steps:
  - id: build
    label: 实现
    gate: null
${options.buildExtra ?? ''}    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: build-complete
        to: verify
  - id: verify
    label: 验证
    gate: ${options.verifyGate ?? 'review'}
${options.verifyExtra ?? ''}    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
${options.verifyTransitions ?? BACK_AND_FORWARD}  - id: ship
    label: 交付
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`
}

function stepOf<T extends { readonly id: string }>(steps: readonly T[], id: string): T {
  const found = steps.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`missing step ${id}`)
  return found
}

describe('max_rounds：解析与序列化', () => {
  it('verify 步声明 max_rounds: 2 解析成 maxRounds: 2，没声明的步骤没有该属性', () => {
    const def = parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 2\n' }))
    expect(stepOf(def.steps, 'verify').maxRounds).toBe(2)
    expect(Object.hasOwn(stepOf(def.steps, 'build'), 'maxRounds')).toBe(false)
  })

  it('接受 1 与 20 两个边界', () => {
    expect(stepOf(parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 1\n' })).steps, 'verify').maxRounds).toBe(1)
    expect(stepOf(parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 20\n' })).steps, 'verify').maxRounds).toBe(20)
  })

  it('序列化后原样写回，再解析深度相等；没声明时不写这个键', () => {
    const declared = parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 3\n' }))
    const text = serializeWorkflow(declared)
    expect(text).toContain('    max_rounds: 3\n')
    expect(parseWorkflow(text)).toEqual(declared)

    const plain = serializeWorkflow(parseWorkflow(workflowYaml()))
    expect(plain).not.toContain('max_rounds')
  })

  it('键可以写在步骤里的任意位置（不要求紧跟 gate）', () => {
    const text = workflowYaml().replace(
      '    transitions:\n      - event: verify-pass',
      '    max_rounds: 4\n    transitions:\n      - event: verify-pass',
    )
    expect(stepOf(parseWorkflow(text).steps, 'verify').maxRounds).toBe(4)
  })

  it.each(['0', '21', 'two', '1.5', '-1', '02', '2x', '""'])('max_rounds: %s 解析失败并点名步骤与原因', (value) => {
    expect(() => parseWorkflow(workflowYaml({ verifyExtra: `    max_rounds: ${value}\n` })))
      .toThrow(/step 'verify'.*max_rounds.*1 到 20 的整数/)
  })

  it('空值（只有键名）同样解析失败', () => {
    expect(() => parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds:\n' })))
      .toThrow(/step 'verify'.*max_rounds/)
  })

  it('同一步重复声明解析失败', () => {
    expect(() => parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 2\n    max_rounds: 3\n' })))
      .toThrow(/step 'verify'.*重复.*max_rounds/)
  })

  it('tracks 分支里的步骤同样解析与往返', () => {
    const text = `name: rounds-tracks
tracks:
  alpha:
    steps:
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: build-complete
            to: verify
      - id: verify
        label: 验证
        gate: review
        max_rounds: 5
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: verify-pass
            to: ship
          - event: verify-fail
            to: build
      - id: ship
        label: 交付
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`
    const def = parseWorkflow(text)
    expect(stepOf(def.tracks?.alpha?.steps ?? [], 'verify').maxRounds).toBe(5)
    expect(parseWorkflow(serializeWorkflow(def))).toEqual(def)
    expect(validateWorkflow(def)).toEqual([])
  })
})

describe('max_rounds：只允许在设了评审门且有回退边的步骤上声明', () => {
  it('评审门 + 回退边：合法', () => {
    expect(validateWorkflow(parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 2\n' })))).toEqual([])
  })

  it('没有评审门的步骤（build，哪怕有回退边）声明时报错并点名步骤与原因', () => {
    const def = parseWorkflow(workflowYaml({
      buildExtra: '    max_rounds: 2\n',
    }).replace(
      '      - event: build-complete\n        to: verify\n',
      '      - event: build-complete\n        to: verify\n      - event: requirements-changed\n        to: build\n',
    ))
    const errors = validateWorkflow(def)
    expect(errors.join('\n')).toMatch(/step 'build'.*max_rounds.*评审门/)
  })

  it('有评审门但没有回退边的步骤声明时报错', () => {
    const def = parseWorkflow(workflowYaml({
      verifyExtra: '    max_rounds: 2\n',
      verifyTransitions: '      - event: verify-pass\n        to: ship\n',
    }))
    expect(validateWorkflow(def).join('\n')).toMatch(/step 'verify'.*max_rounds.*回退边/)
  })

  it('gate: auto 的步骤（即便有回退边）声明时报错', () => {
    const def = parseWorkflow(workflowYaml({ verifyGate: 'auto', verifyExtra: '    max_rounds: 2\n' }))
    expect(validateWorkflow(def).join('\n')).toMatch(/step 'verify'.*max_rounds.*评审门/)
  })

  it('没声明时什么都不要求：没有评审门、没有回退边的步骤照常通过', () => {
    expect(validateWorkflow(parseWorkflow(workflowYaml({ verifyGate: 'auto' })))).toEqual([])
  })

  it('结构化输入（server 的 decodeWorkflowDef 直调）走同一条校验：越界、小数、非数字都拒绝', () => {
    const base = parseWorkflow(workflowYaml())
    const withRounds = (maxRounds: unknown) => ({
      ...base,
      steps: base.steps.map((step) => step.id === 'verify' ? { ...step, maxRounds } : step),
    })
    for (const bad of [0, 21, 1.5, '2', null, Number.NaN]) {
      expect(() => decodeWorkflowDef(withRounds(bad)), String(bad)).toThrow(/steps\[1\]\.maxRounds/)
    }
    expect(() => decodeWorkflowDef(withRounds(2))).not.toThrow()
  })

  it('结构化输入把 maxRounds 放在没有评审门的步骤上：compileWorkflow 拒绝并点名步骤', () => {
    const base = parseWorkflow(workflowYaml())
    const def = {
      ...base,
      steps: base.steps.map((step) => step.id === 'ship' ? { ...step, maxRounds: 2 } : step),
    }
    expect(() => compileWorkflow(def)).toThrow(/steps\[2\]\.maxRounds.*step 'ship'.*max_rounds/)
  })
})

describe('max_rounds：编译进 effective plan 并随计划冻结', () => {
  it('编译后的步骤带 maxRounds；没声明的步骤没有这个键（指纹逐字不变的前提）', () => {
    const ir = compileWorkflow(parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 3\n' })))
    expect(stepOf(ir.steps, 'verify').maxRounds).toBe(3)
    expect(Object.hasOwn(stepOf(ir.steps, 'build'), 'maxRounds')).toBe(false)
    const plain = compileWorkflow(parseWorkflow(workflowYaml()))
    expect(plain.steps.every((step) => !Object.hasOwn(step, 'maxRounds'))).toBe(true)
  })

  it('声明与不声明的工作流指纹不同（上限是计划的一部分）', () => {
    const declared = compileEffectiveWorkflowPlan('rounds-yaml', parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 2\n' })))
    const plain = compileEffectiveWorkflowPlan('rounds-yaml', parseWorkflow(workflowYaml()))
    expect(declared.workflowFingerprint).not.toBe(plain.workflowFingerprint)
  })

  it('effectiveMaxRounds：声明的取声明值（workflow），没声明的取内置默认 2（default）', () => {
    const declared = compileEffectiveWorkflowPlan('rounds-yaml', parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 3\n' })))
    expect(effectiveMaxRounds(stepOf(declared.workflow.steps, 'verify'))).toEqual({ max: 3, source: 'workflow' })
    const plain = compileEffectiveWorkflowPlan('rounds-yaml', parseWorkflow(workflowYaml()))
    expect(effectiveMaxRounds(stepOf(plain.workflow.steps, 'verify'))).toEqual({ max: 2, source: 'default' })
  })

  it('冻结进 v4 快照；恢复出来的计划指纹与上限不变，任务开始后再改工作流文件不影响它', () => {
    const plan = compileEffectiveWorkflowPlan('rounds-yaml', parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 3\n' })))
    const snapshot = workflowPlanSnapshot(plan)
    if (snapshot.version !== 4) throw new Error('expected v4 snapshot')
    expect(stepOf(snapshot.workflow.steps, 'verify').maxRounds).toBe(3)

    // 工作流文件之后被改成 1 轮：在途任务按冻结的快照恢复，仍然是 3。
    const edited = compileEffectiveWorkflowPlan('rounds-yaml', parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 1\n' })))
    expect(edited.workflowFingerprint).not.toBe(plan.workflowFingerprint)
    const restored = effectiveWorkflowPlanFromSnapshot(JSON.parse(JSON.stringify(snapshot)) as typeof snapshot)
    expect(restored.workflowFingerprint).toBe(plan.workflowFingerprint)
    expect(effectiveMaxRounds(stepOf(restored.workflow.steps, 'verify'))).toEqual({ max: 3, source: 'workflow' })
  })

  it('快照里的上限被改过（指纹没跟着改）：拒绝恢复', () => {
    const plan = compileEffectiveWorkflowPlan('rounds-yaml', parseWorkflow(workflowYaml({ verifyExtra: '    max_rounds: 3\n' })))
    const snapshot = workflowPlanSnapshot(plan)
    if (snapshot.version !== 4) throw new Error('expected v4 snapshot')
    const tampered: WorkflowPlanSnapshotV4 = {
      ...snapshot,
      workflow: {
        ...snapshot.workflow,
        steps: snapshot.workflow.steps.map((step) => step.id === 'verify' ? { ...step, maxRounds: 20 } : step),
      },
    }
    expect(() => effectiveWorkflowPlanFromSnapshot(tampered)).toThrow(DocumentGovernanceBindingError)
  })
})

describe('max_rounds：内置 default 工作流', () => {
  const DEFAULT_TRACKS = ['chat', 'pm', 'frontend', 'backend', 'free'] as const

  it.each(DEFAULT_TRACKS)('%s 轨道的 verify 步声明 max_rounds: 2，来源 workflow', (track) => {
    const plan = compileEffectiveWorkflowPlan('default', undefined, builtinTrack(track))
    expect(effectiveMaxRounds(stepOf(plan.workflow.steps, 'verify'))).toEqual({ max: 2, source: 'workflow' })
  })

  it('只有 verify 步声明了上限，其余步骤（含没有评审门的 build）都没有', () => {
    for (const track of DEFAULT_TRACKS) {
      const plan = compileEffectiveWorkflowPlan('default', undefined, builtinTrack(track))
      expect(plan.workflow.steps.filter((step) => step.maxRounds !== undefined).map((step) => step.id), track)
        .toEqual(['verify'])
    }
  })
})

describe('max_rounds：升级前冻结的计划（快照里没有该键）', () => {
  /** 由升级前的代码在同一个自定义工作流上生成：IR 里没有 maxRounds，指纹按旧口径算出。 */
  const PRE_UPGRADE_FINGERPRINT = '532f4305e6a97c6eef8ddd9e5e1534a4f135a85e6c336b20d1321069eff9165a'
  const policy = {
    decomposition: {
      version: 'v1', mode: 'off', target: 'work-items', strategy: 'balanced',
      max_items: 16, max_depth: 2, auto_when: [], ask_when: [],
    },
    interaction: { version: 'v1', mode: 'interactive' },
  } as const
  const frozenStep = (id: string, label: string, gate: 'auto' | 'review', transitions: readonly unknown[]) => ({
    id, label, gate, skills: [], inputs: [], outputs: [], guards: [], artifacts: [], transitions,
  })
  const edge = (event: string, to: string) => ({ event, to, guards: [], actions: [] })
  const preUpgradeSnapshot = (): WorkflowPlanSnapshotV4 => JSON.parse(JSON.stringify({
    version: 4,
    workflowId: 'rounds-compat',
    executionModel: 'step-graph',
    workflow: {
      name: 'rounds-compat',
      ...policy,
      steps: [
        frozenStep('build', 'Build', 'auto', [edge('build-complete', 'verify')]),
        frozenStep('verify', 'Verify', 'review', [edge('verify-pass', 'ship'), edge('verify-fail', 'build')]),
        frozenStep('ship', 'Ship', 'auto', []),
      ],
    },
    documentPolicy: null,
    ...policy,
    workflowFingerprint: PRE_UPGRADE_FINGERPRINT,
  })) as WorkflowPlanSnapshotV4

  it('照常解码，指纹与升级前记录一致；上限按内置默认 2，来源 default', () => {
    const plan = effectiveWorkflowPlanFromSnapshot(preUpgradeSnapshot())
    expect(plan.workflowFingerprint).toBe(PRE_UPGRADE_FINGERPRINT)
    expect(effectiveMaxRounds(stepOf(plan.workflow.steps, 'verify'))).toEqual({ max: 2, source: 'default' })
  })

  it('再落盘仍是不带 maxRounds 的 v4，指纹不变', () => {
    const plan = effectiveWorkflowPlanFromSnapshot(preUpgradeSnapshot())
    const again = workflowPlanSnapshot(plan)
    expect(again.version).toBe(4)
    expect(again.workflowFingerprint).toBe(PRE_UPGRADE_FINGERPRINT)
    expect(JSON.stringify(again)).not.toContain('maxRounds')
  })

  it('升级前的 default 计划：去掉各轨道 verify 步的 maxRounds 后，按升级前记录的指纹照常解码', () => {
    // 升级前 default.yaml 编译出的计划指纹；IR 去掉 maxRounds 就是升级前的 IR。
    const preUpgradeDefault = '794972ba10b61ad50bbe17c11c714b516072e93e962d2d5aab7c277618f68979'
    const current = workflowPlanSnapshot(compileEffectiveWorkflowPlan('default', undefined, builtinTrack('frontend')))
    if (current.version !== 4) throw new Error('expected v4 snapshot')
    const strip = <T extends { readonly steps: readonly { readonly id: string }[] }>(branch: T): T => ({
      ...branch,
      steps: branch.steps.map((step) => {
        const { maxRounds: _maxRounds, ...rest } = step as typeof step & { maxRounds?: number }
        return rest
      }),
    })
    const tracks = Object.fromEntries(
      Object.entries(current.workflow.tracks ?? {}).map(([id, branch]) => [id, strip(branch)]),
    )
    const old: WorkflowPlanSnapshotV4 = {
      ...current,
      workflow: { ...strip(current.workflow), tracks },
      workflowFingerprint: preUpgradeDefault,
    }
    expect(JSON.stringify(old)).not.toContain('maxRounds')
    const plan = effectiveWorkflowPlanFromSnapshot(old, builtinTrack('frontend'))
    expect(plan.workflowFingerprint).toBe(preUpgradeDefault)
    expect(effectiveMaxRounds(stepOf(plan.workflow.steps, 'verify'))).toEqual({ max: 2, source: 'default' })
  })
})
