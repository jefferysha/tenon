/**
 * compileWorkflow 单测（G2 P1）——v1 → IR 下沉规则、默认值补齐、artifact 派生/显式声明、
 * 闭集拒绝面（fail-loud 带结构路径）、深冻结与输入免污染。
 * 扩展 guard / edge 级 guards・actions / artifacts 不在 v1 DTO 类型里，用例以
 * `as unknown as WorkflowDef` 喂结构化数据——这正是编译器运行时校验面要接住的输入形态。
 */
import { describe, expect, it } from 'vitest'
import type { StepDef, WorkflowDef } from './types.js'
import type { StepIR } from './ir.js'
import { compileDefaultWorkflow, compileWorkflow } from './compile.js'
import { parseWorkflow } from './parse.js'
import { NON_PM } from './predicates.js'

function v1Step(over: Partial<StepDef> = {}): StepDef {
  return { id: 'draft', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...over }
}

function v1Def(steps: readonly StepDef[], name = 'demo'): WorkflowDef {
  return { name, steps }
}

/** 结构化（越过 parse 的）扩展输入：类型上仍走 WorkflowDef 签名，运行时闭集校验接住。 */
function rawDef(def: unknown): WorkflowDef {
  return def as WorkflowDef
}

describe('v1 → IR 下沉', () => {
  it('document contract 经过 unknown 边界校验并被深冻结', () => {
    const ir = compileWorkflow(rawDef({
      name: 'compact',
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
        reads: [{ step: 'build', kinds: ['proposal'] }],
      },
      steps: [v1Step({ id: 'shape' }), v1Step({ id: 'build' })],
    }))
    expect(ir.documentContract?.version).toBe('v1')
    expect(Object.isFrozen(ir.documentContract)).toBe(true)
    expect(Object.isFrozen(ir.documentContract?.slots[0])).toBe(true)
  })

  it('malformed document contract 在编译边界 fail-loud', () => {
    expect(() => compileWorkflow(rawDef({
      name: 'bad',
      documentContract: { version: 'v2', slots: [], reads: [] },
      steps: [v1Step()],
    }))).toThrow(/documentContract.version/)
  })

  it('nonempty-output 按 outputs 逐字段展开为 field-nonempty（顺序=outputs 声明序）；tasks-at-least 原样保留', () => {
    const ir = compileWorkflow(
      v1Def([
        v1Step({
          outputs: [
            { field: 'design_doc', type: 'file_path' },
            { field: 'branch', type: 'string' },
          ],
          guards: [{ type: 'nonempty-output' }, { type: 'tasks-at-least', n: 2 }],
        }),
      ]),
    )
    expect(ir.steps[0]!.guards).toEqual([
      { type: 'field-nonempty', field: 'design_doc' },
      { type: 'field-nonempty', field: 'branch' },
      { type: 'tasks-at-least', n: 2 },
    ])
  })

  it('nonempty-output + outputs 为空 → 展开为零条（IR 里不残留该变体）', () => {
    const ir = compileWorkflow(v1Def([v1Step({ guards: [{ type: 'nonempty-output' }] })]))
    expect(ir.steps[0]!.guards).toEqual([])
  })

  it('nonempty-output 携带 when → when 传播到每条展开出的 field-nonempty', () => {
    const ir = compileWorkflow(
      rawDef({
        name: 'demo',
        steps: [
          v1Step({
            outputs: [
              { field: 'plan', type: 'file_path' },
              { field: 'branch', type: 'string' },
            ],
            guards: [{ type: 'nonempty-output', when: NON_PM }] as never,
          }),
        ],
      }),
    )
    expect(ir.steps[0]!.guards).toEqual([
      { type: 'field-nonempty', field: 'plan', when: NON_PM },
      { type: 'field-nonempty', field: 'branch', when: NON_PM },
    ])
  })

  it('transitions 补默认值：v1 边（无 guards/actions 键）→ guards:[] actions:[]', () => {
    const ir = compileWorkflow(
      v1Def([v1Step({ transitions: [{ event: 'draft-done', to: 'draft' }] })]),
    )
    expect(ir.steps[0]!.transitions).toEqual([{ event: 'draft-done', to: 'draft', guards: [], actions: [] }])
  })

  it('同一步重复 event 在 canonical 编译边界拒绝，避免 runtime 与 Dashboard 分叉', () => {
    expect(() => compileWorkflow(
      v1Def([v1Step({
        transitions: [
          { event: 'continue', to: 'draft' },
          { event: 'continue', to: 'draft' },
        ],
      })]),
    )).toThrow(/steps\[0\]\.transitions\[1\]\.event.*重复.*continue/)
  })

  it('step 元数据逐字进 IR：id/label/gate/skills（含 depends_on）/inputs/outputs', () => {
    const ir = compileWorkflow(
      v1Def([
        v1Step({
          id: 'build',
          label: '构建',
          gate: 'auto',
          skills: [{ id: 'writer' }, { id: 'reviewer', depends_on: ['writer'] }],
          inputs: [{ field: 'plan', type: 'file_path' }],
          outputs: [{ field: 'branch', type: 'string' }],
        }),
      ]),
    )
    const step = ir.steps[0]!
    expect(step.id).toBe('build')
    expect(step.label).toBe('构建')
    expect(step.gate).toBe('auto')
    expect(step.skills).toEqual([
      { id: 'writer', kind: 'work' },
      { id: 'reviewer', kind: 'work', depends_on: ['writer'] },
    ])
    expect(step.inputs).toEqual([{ field: 'plan', type: 'file_path' }])
    expect(step.outputs).toEqual([{ field: 'branch', type: 'string' }])
  })

  it('step prompt 逐字进入冻结 IR，供运行时 Codex 消费', () => {
    const ir = compileWorkflow(v1Def([v1Step({ prompt: 'Implement API.\nThen verify browser E2E.' })]))
    expect(ir.steps[0]!.prompt).toBe('Implement API.\nThen verify browser E2E.')
    expect(Object.isFrozen(ir.steps[0])).toBe(true)
  })

  it('扩展 guard 六变体（含 when）原样进 IR（结构化输入走同一闭集）', () => {
    const guards = [
      { type: 'field-nonempty', field: 'build_mode' },
      { type: 'file-exists', path: { kind: 'field', field: 'design_doc' } },
      { type: 'field-equals', field: 'branch_status', value: 'handled' },
      { type: 'field-in', field: 'isolation', values: ['branch', 'worktree'] },
      { type: 'full-direct-override' },
      { type: 'build-head-unchanged', field: 'build_sha', when: NON_PM },
    ]
    const ir = compileWorkflow(rawDef({ name: 'demo', steps: [v1Step({ guards: guards as never })] }))
    expect(ir.steps[0]!.guards).toEqual(guards)
  })

  it('edge 级 guards/actions 进 StepTransitionIR；edge 级 nonempty-output 同样按本 step outputs 展开', () => {
    const ir = compileWorkflow(
      rawDef({
        name: 'demo',
        steps: [
          v1Step({
            outputs: [{ field: 'verification_report', type: 'file_path' }],
            transitions: [
              {
                event: 'verify-pass',
                to: 'draft',
                guards: [{ type: 'nonempty-output' }, { type: 'build-head-unchanged', field: 'build_sha' }],
                actions: [{ type: 'mark-verification-passed' }, { type: 'freeze-build-sha' }],
              },
            ] as never,
          }),
        ],
      }),
    )
    expect(ir.steps[0]!.transitions[0]).toEqual({
      event: 'verify-pass',
      to: 'draft',
      guards: [
        { type: 'field-nonempty', field: 'verification_report' },
        { type: 'build-head-unchanged', field: 'build_sha' },
      ],
      actions: [{ type: 'mark-verification-passed' }, { type: 'freeze-build-sha' }],
    })
  })
})

describe('artifact 面', () => {
  it("type:'file_path' 的 output 逐条派生 {kind:'file', field, producerPolicy:'effective-step-skills'}；非 file_path 不派生", () => {
    const ir = compileWorkflow(
      v1Def([
        v1Step({
          outputs: [
            { field: 'design_doc', type: 'file_path' },
            { field: 'branch', type: 'string' },
            { field: 'plan', type: 'file_path' },
          ],
        }),
      ]),
    )
    expect(ir.steps[0]!.artifacts).toEqual([
      { kind: 'file', field: 'design_doc', producerPolicy: 'effective-step-skills' },
      { kind: 'file', field: 'plan', producerPolicy: 'effective-step-skills' },
    ])
  })

  it('显式声明按 field 替换派生条目（requiredWhen 只能经显式声明携带）；kind/producerPolicy 可缺省', () => {
    const ir = compileWorkflow(
      rawDef({
        name: 'demo',
        steps: [
          v1Step({
            outputs: [{ field: 'design_doc', type: 'file_path' }],
            artifacts: [{ field: 'design_doc', requiredWhen: NON_PM }],
          } as never),
        ],
      }),
    )
    expect(ir.steps[0]!.artifacts).toEqual([
      { kind: 'file', field: 'design_doc', producerPolicy: 'effective-step-skills', requiredWhen: NON_PM },
    ])
  })

  it('显式 artifacts: [] 禁用 file_path output 的默认派生（与省略字段区分）', () => {
    const ir = compileWorkflow(
      rawDef({
        name: 'demo',
        steps: [v1Step({
          outputs: [{ field: 'design_doc', type: 'file_path' }],
          artifacts: [],
        } as never)],
      }),
    )
    expect(ir.steps[0]!.artifacts).toEqual([])
  })

  it('显式非空 artifacts 保留派生项，并按 field 覆盖派生 policy', () => {
    const ir = compileWorkflow(
      rawDef({
        name: 'demo',
        steps: [v1Step({
          outputs: [
            { field: 'design_doc', type: 'file_path' },
            { field: 'plan', type: 'file_path' },
          ],
          artifacts: [{ field: 'design_doc', producerPolicy: 'effective-step-skills' }],
        } as never)],
      }),
    )
    expect(ir.steps[0]!.artifacts).toEqual([
      { kind: 'file', field: 'design_doc', producerPolicy: 'effective-step-skills' },
      { kind: 'file', field: 'plan', producerPolicy: 'effective-step-skills' },
    ])
  })

  it('无 file_path 输出且无显式声明 → artifacts 恒 []（默认补齐）', () => {
    const ir = compileWorkflow(v1Def([v1Step({ outputs: [{ field: 'branch', type: 'string' }] })]))
    expect(ir.steps[0]!.artifacts).toEqual([])
  })
})

describe('拒绝面（malformed → fail-loud 抛带结构路径的错误）', () => {
  function expectThrow(def: unknown, pattern: RegExp): void {
    expect(() => compileWorkflow(rawDef(def))).toThrow(pattern)
  }

  it('未知 guard type → 路径定位到 steps[i].guards[j].type', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'set-field' }] as never })] },
      /steps\[0\]\.guards\[0\]\.type.*set-field/,
    )
  })

  it('未知 action type → 路径定位到 transitions[j].actions[k].type', () => {
    expectThrow(
      {
        name: 'demo',
        steps: [v1Step({ transitions: [{ event: 'go', to: 'draft', actions: [{ type: 'set-phase' }] }] as never })],
      },
      /steps\[0\]\.transitions\[0\]\.actions\[0\]\.type.*set-phase/,
    )
  })

  it('field-in values 空数组 → 拒绝（至少一个合法值）', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'field-in', field: 'isolation', values: [] }] as never })] },
      /steps\[0\]\.guards\[0\]\.values.*空数组/,
    )
  })

  it('field-in values 含非字符串 → 拒绝（带下标路径）', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'field-in', field: 'isolation', values: ['branch', 7] }] as never })] },
      /steps\[0\]\.guards\[0\]\.values\[1\]/,
    )
  })

  it('tasks-at-least n 非整数 / 负数 → 拒绝（parse.ts \\d+ 的运行时口径）', () => {
    for (const n of [1.5, -1, 'x'] as const) {
      expectThrow(
        { name: 'demo', steps: [v1Step({ guards: [{ type: 'tasks-at-least', n }] as never })] },
        /steps\[0\]\.guards\[0\]\.n/,
      )
    }
  })

  it('field 类 guard 引用未知 FieldName → 拒绝（FIELD_ORDER 闭集）', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'field-nonempty', field: 'not_a_field' }] as never })] },
      /steps\[0\]\.guards\[0\]\.field.*not_a_field/,
    )
  })

  it('inputs/outputs 的已知 field（file_path/string/boolean）→ 通过（惰性放宽含未知 file_path，见下方兼容回退 describe）', () => {
    const ir = compileWorkflow(
      v1Def([v1Step({ inputs: [{ field: 'plan', type: 'file_path' }], outputs: [{ field: 'branch', type: 'string' }] })]),
    )
    expect(ir.steps[0]!.inputs).toEqual([{ field: 'plan', type: 'file_path' }])
    expect(ir.steps[0]!.outputs).toEqual([{ field: 'branch', type: 'string' }])
  })

  it("file-exists path.kind ≠ 'field' → 拒绝", () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'file-exists', path: { kind: 'literal', field: 'plan' } }] as never })] },
      /steps\[0\]\.guards\[0\]\.path\.kind/,
    )
  })

  it('field-equals value 非字符串 → 拒绝', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'field-equals', field: 'branch_status', value: 1 }] as never })] },
      /steps\[0\]\.guards\[0\]\.value/,
    )
  })

  it("build-head-unchanged field ≠ 'build_sha' → 拒绝（barrier 只定义在 build 冻结 SHA 上）", () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'build-head-unchanged', field: 'plan' }] as never })] },
      /steps\[0\]\.guards\[0\]\.field.*build_sha/,
    )
  })

  it('when 形状非法（kind 不在两谓词内 / values 非字符串数组）→ 拒绝', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'full-direct-override', when: { kind: 'phase-in', values: [] } }] as never })] },
      /steps\[0\]\.guards\[0\]\.when\.kind/,
    )
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'full-direct-override', when: { kind: 'track-in', values: [1] } }] as never })] },
      /steps\[0\]\.guards\[0\]\.when\.values\[0\]/,
    )
  })

  it('未知 file_path 输出（field ∉ FIELD_ORDER）→ 惰性放行、不派生 artifact（阻断 1：新增 artifact IR 不倒推收窄旧 definition 合法域；pre-P2 能载的 file_path 惰性 output 仍能载）', () => {
    const ir = compileWorkflow(v1Def([v1Step({ outputs: [{ field: 'custom_report', type: 'file_path' }] })]))
    expect(ir.steps[0]!.outputs).toEqual([{ field: 'custom_report', type: 'file_path' }])
    expect(ir.steps[0]!.artifacts).toEqual([]) // 未知 file_path 不派生 artifact
  })

  it('对照：已知 file_path 输出（field ∈ FIELD_ORDER）仍派生 artifact（严格面未被惰性放宽波及）', () => {
    const ir = compileWorkflow(v1Def([v1Step({ outputs: [{ field: 'design_doc', type: 'file_path' }] })]))
    expect(ir.steps[0]!.artifacts).toEqual([
      { kind: 'file', field: 'design_doc', producerPolicy: 'effective-step-skills' },
    ])
  })

  it("显式 artifact 挂到非 file_path 输出 → 拒绝（只许挂 type:'file_path' 的 FieldRef）", () => {
    expectThrow(
      {
        name: 'demo',
        steps: [v1Step({ outputs: [{ field: 'branch', type: 'string' }], artifacts: [{ field: 'branch' }] } as never)],
      },
      /steps\[0\]\.artifacts\[0\]\.field.*file_path/,
    )
  })

  it('显式 artifact 的 field 不在本 step outputs → 拒绝', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ artifacts: [{ field: 'design_doc' }] } as never)] },
      /steps\[0\]\.artifacts\[0\]\.field.*outputs/,
    )
  })

  it('显式 artifact 的 field 不是已知 FieldName → 拒绝', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ artifacts: [{ field: 'blob' }] } as never)] },
      /steps\[0\]\.artifacts\[0\]\.field.*blob/,
    )
  })

  it('显式 artifact 同 field 重复声明 → 拒绝', () => {
    expectThrow(
      {
        name: 'demo',
        steps: [
          v1Step({
            outputs: [{ field: 'design_doc', type: 'file_path' }],
            artifacts: [{ field: 'design_doc' }, { field: 'design_doc' }],
          } as never),
        ],
      },
      /steps\[0\]\.artifacts\[1\]\.field.*重复/,
    )
  })

  it("artifact kind ≠ 'file' / producerPolicy ≠ 'effective-step-skills' → 拒绝", () => {
    const outputs = [{ field: 'design_doc', type: 'file_path' }]
    expectThrow(
      { name: 'demo', steps: [v1Step({ outputs, artifacts: [{ field: 'design_doc', kind: 'dir' }] } as never)] },
      /steps\[0\]\.artifacts\[0\]\.kind/,
    )
    expectThrow(
      { name: 'demo', steps: [v1Step({ outputs, artifacts: [{ field: 'design_doc', producerPolicy: 'any' }] } as never)] },
      /steps\[0\]\.artifacts\[0\]\.producerPolicy/,
    )
  })

  it('transition 的 event/to 空串 → 拒绝', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ transitions: [{ event: '', to: 'draft' }] })] },
      /steps\[0\]\.transitions\[0\]\.event/,
    )
    expectThrow(
      { name: 'demo', steps: [v1Step({ transitions: [{ event: 'go', to: '' }] })] },
      /steps\[0\]\.transitions\[0\]\.to/,
    )
  })

  it('workflow name 空 / steps 非数组 / step id 空 / gate 非法 → 拒绝', () => {
    expectThrow({ name: '', steps: [] }, /name/)
    expectThrow({ name: 'demo', steps: 'nope' }, /steps.*数组/)
    expectThrow({ name: 'demo', steps: [v1Step({ id: '' })] }, /steps\[0\]\.id/)
    expectThrow({ name: 'demo', steps: [v1Step({ gate: 'gate' as never })] }, /steps\[0\]\.gate/)
  })

  it('显式 malformed 不被默认值吞：step 级 guards = null/字符串/对象 → 拒绝（undefined 才算未声明）', () => {
    for (const bad of [null, 'nope', {}]) {
      expectThrow({ name: 'demo', steps: [{ ...v1Step(), guards: bad }] }, /steps\[0\]\.guards.*数组/)
    }
  })

  it('edge 级 guards/actions 同口径：null/字符串/对象 → 拒绝', () => {
    for (const bad of [null, 'nope', {}]) {
      expectThrow(
        { name: 'demo', steps: [v1Step({ transitions: [{ event: 'go', to: 'draft', guards: bad }] as never })] },
        /steps\[0\]\.transitions\[0\]\.guards.*数组/,
      )
      expectThrow(
        { name: 'demo', steps: [v1Step({ transitions: [{ event: 'go', to: 'draft', actions: bad }] as never })] },
        /steps\[0\]\.transitions\[0\]\.actions.*数组/,
      )
    }
  })

  it('inputs/outputs/transitions 是 v1 必备键：null/字符串/对象/缺省 → 拒绝（无默认值可吞）', () => {
    for (const key of ['inputs', 'outputs', 'transitions'] as const) {
      for (const bad of [null, 'nope', {}, undefined]) {
        const step = { ...v1Step() } as Record<string, unknown>
        step[key] = bad
        expectThrow({ name: 'demo', steps: [step] }, new RegExp(`steps\\[0\\]\\.${key}.*数组`))
      }
    }
  })

  it('step 级 guards 真未声明（无键）→ 默认 []', () => {
    const step = { ...v1Step() } as Record<string, unknown>
    delete step.guards
    const ir = compileWorkflow(rawDef({ name: 'demo', steps: [step] }))
    expect(ir.steps[0]!.guards).toEqual([])
  })

  it('scalar guard 的 field 指向列表字段（LIST_FIELDS）→ 编译期拒绝（四变体逐一）', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'field-nonempty', field: 'scope' }] as never })] },
      /steps\[0\]\.guards\[0\]\.field.*scope.*列表字段/,
    )
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'file-exists', path: { kind: 'field', field: 'related_files' } }] as never })] },
      /steps\[0\]\.guards\[0\]\.path\.field.*related_files.*列表字段/,
    )
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'field-equals', field: 'spec_scope', value: 'x' }] as never })] },
      /steps\[0\]\.guards\[0\]\.field.*spec_scope.*列表字段/,
    )
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'field-in', field: 'depends_on', values: ['a'] }] as never })] },
      /steps\[0\]\.guards\[0\]\.field.*depends_on.*列表字段/,
    )
  })

  it('列表字段作 output 本身合法（列表闸只挡 scalar guard，不挡 outputs 声明）', () => {
    const ir = compileWorkflow(v1Def([v1Step({ outputs: [{ field: 'scope', type: 'string' }] })]))
    expect(ir.steps[0]!.outputs).toEqual([{ field: 'scope', type: 'string' }])
    expect(ir.steps[0]!.guards).toEqual([])
  })

  it('同 field 重复 file_path outputs → 拒绝（重复声明，不静默合并成一条 artifact）', () => {
    expectThrow(
      {
        name: 'demo',
        steps: [
          v1Step({
            outputs: [
              { field: 'design_doc', type: 'file_path' },
              { field: 'design_doc', type: 'file_path' },
            ],
          }),
        ],
      },
      /steps\[0\]\.outputs\[1\]\.field.*design_doc.*重复/,
    )
  })
})

// ── 阻断 3：guard 附加键闭集校验在 compile 层执行（顶层 + 嵌套 path + when 三处）——server
//    workflows 直调结构化 WorkflowDef→validateWorkflow(依赖 compile)→serialize 落盘，绕过 parse 的
//    早期报错；附加键此前能过 validate/compile 再被 serialize 静默丢弃。这里钉死 compile 层 fail-loud。
describe('阻断 3：结构化输入的 guard 附加键闭集（绕过 parse 也拦，非 serialize 静默吞）', () => {
  function expectThrow(def: unknown, pattern: RegExp): void {
    expect(() => compileWorkflow(rawDef(def))).toThrow(pattern)
  }

  it('顶层附加键：nonempty-output 带 n（无 data 键的变体）→ 拒（此前过 compile 再被 serialize 丢 n）', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'nonempty-output', n: 2 }] as never })] },
      /steps\[0\]\.guards\[0\].*附加键 'n'/,
    )
  })

  it('顶层附加键：tasks-at-least 带 field（只允许 n）→ 拒', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'tasks-at-least', n: 1, field: 'plan' }] as never })] },
      /steps\[0\]\.guards\[0\].*附加键 'field'/,
    )
  })

  it('顶层附加键：field-equals 带 values（只允许 field/value）→ 拒', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'field-equals', field: 'branch_status', value: 'x', values: ['y'] }] as never })] },
      /steps\[0\]\.guards\[0\].*附加键 'values'/,
    )
  })

  it('嵌套 path 附加键：file-exists 的 path 带 extra 键（只允许 kind/field）→ 拒', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'file-exists', path: { kind: 'field', field: 'design_doc', extra: 1 } }] as never })] },
      /steps\[0\]\.guards\[0\]\.path.*附加键 'extra'/,
    )
  })

  it('嵌套 when 附加键：when 带 extra 键（只允许 kind/values）→ 拒', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'full-direct-override', when: { kind: 'track-in', values: ['pm'], extra: 1 } }] as never })] },
      /steps\[0\]\.guards\[0\]\.when.*附加键 'extra'/,
    )
  })

  it('edge 级 guard 同受闭集校验（transitions[].guards 也走 compileGuard）', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ transitions: [{ event: 'go', to: 'draft', guards: [{ type: 'nonempty-output', n: 2 }] }] as never })] },
      /steps\[0\]\.transitions\[0\]\.guards\[0\].*附加键 'n'/,
    )
  })

  it('原型链键名（toString）作 guard type + 附加键 → 报「未知 guard type」而非崩（hasOwnProperty 守闭集查表）', () => {
    expectThrow(
      { name: 'demo', steps: [v1Step({ guards: [{ type: 'toString', n: 2 }] as never })] },
      /steps\[0\]\.guards\[0\]\.type.*toString/,
    )
  })

  it('合法 guard（恰好允许键）不误拒：field-equals{field,value,when} / file-exists{path{kind,field}}', () => {
    expect(() =>
      compileWorkflow(
        rawDef({
          name: 'demo',
          steps: [
            v1Step({
              guards: [
                { type: 'field-equals', field: 'branch_status', value: 'handled', when: { kind: 'track-not-in', values: ['pm'] } },
                { type: 'file-exists', path: { kind: 'field', field: 'design_doc' } },
              ] as never,
            }),
          ],
        }),
      ),
    ).not.toThrow()
  })
})

describe('结构化 Workflow DTO 全树键闭集（未知键不得被 serialize 静默吞掉）', () => {
  const base = (): Record<string, unknown> => ({
    name: 'closed-dto',
    documentContract: {
      version: 'v1',
      slots: [{ kind: 'proposal', ownerStep: 'draft', producers: ['writer'] }],
      reads: [{ step: 'done', kinds: ['proposal'] }],
    },
    steps: [
      {
        ...v1Step({
          skills: [{ id: 'writer', depends_on: [] }],
          inputs: [{ field: 'plan', type: 'file_path' }],
          outputs: [{ field: 'design_doc', type: 'file_path' }],
          artifacts: [{ field: 'design_doc', producerPolicy: 'effective-step-skills' }] as never,
          transitions: [{
            event: 'go',
            to: 'done',
            actions: [{ type: 'mark-verification-passed' }],
          }] as never,
        }),
      },
      v1Step({ id: 'done' }),
    ],
  })

  const mutations: Array<{ label: string; mutate: (value: Record<string, unknown>) => void; path: RegExp }> = [
    { label: 'workflow', mutate: (value) => { value.extra = true }, path: /workflow.*附加键 'extra'/ },
    {
      label: 'step',
      mutate: (value) => { (value.steps as Array<Record<string, unknown>>)[0]!.extra = true },
      path: /steps\[0\].*附加键 'extra'/,
    },
    {
      label: 'skill',
      mutate: (value) => {
        const step = (value.steps as Array<Record<string, unknown>>)[0]!
        ;(step.skills as Array<Record<string, unknown>>)[0]!.extra = true
      },
      path: /steps\[0\]\.skills\[0\].*附加键 'extra'/,
    },
    {
      label: 'input',
      mutate: (value) => {
        const step = (value.steps as Array<Record<string, unknown>>)[0]!
        ;(step.inputs as Array<Record<string, unknown>>)[0]!.extra = true
      },
      path: /steps\[0\]\.inputs\[0\].*附加键 'extra'/,
    },
    {
      label: 'artifact',
      mutate: (value) => {
        const step = (value.steps as Array<Record<string, unknown>>)[0]!
        ;(step.artifacts as Array<Record<string, unknown>>)[0]!.extra = true
      },
      path: /steps\[0\]\.artifacts\[0\].*附加键 'extra'/,
    },
    {
      label: 'transition',
      mutate: (value) => {
        const step = (value.steps as Array<Record<string, unknown>>)[0]!
        ;(step.transitions as Array<Record<string, unknown>>)[0]!.extra = true
      },
      path: /steps\[0\]\.transitions\[0\].*附加键 'extra'/,
    },
    {
      label: 'action',
      mutate: (value) => {
        const step = (value.steps as Array<Record<string, unknown>>)[0]!
        const transition = (step.transitions as Array<Record<string, unknown>>)[0]!
        ;(transition.actions as Array<Record<string, unknown>>)[0]!.extra = true
      },
      path: /steps\[0\]\.transitions\[0\]\.actions\[0\].*附加键 'extra'/,
    },
    {
      label: 'document contract',
      mutate: (value) => { (value.documentContract as Record<string, unknown>).extra = true },
      path: /documentContract.*附加键 'extra'/,
    },
    {
      label: 'document slot',
      mutate: (value) => {
        const contract = value.documentContract as Record<string, unknown>
        ;(contract.slots as Array<Record<string, unknown>>)[0]!.extra = true
      },
      path: /documentContract\.slots\[0\].*附加键 'extra'/,
    },
    {
      label: 'document read',
      mutate: (value) => {
        const contract = value.documentContract as Record<string, unknown>
        ;(contract.reads as Array<Record<string, unknown>>)[0]!.extra = true
      },
      path: /documentContract\.reads\[0\].*附加键 'extra'/,
    },
  ]

  for (const mutation of mutations) {
    it(`拒绝 ${mutation.label} 未知键`, () => {
      const value = base()
      mutation.mutate(value)
      expect(() => compileWorkflow(value)).toThrow(mutation.path)
    })
  }
})

// ── G2 P2 兼容回退（codex review 返工）：pre-P2 的 FieldRef.field 是 string，声明非 FIELD_ORDER
//    的惰性 input/output（三种 type 皆可，且不挂 guard/显式 artifact）的旧 workflow 能加载、能跑
//    转换图、能参与「前序 output→后序 input」依赖校验。P1 把 field 全量强制 ∈ FIELD_ORDER 删除了
//    这条历史合法行为，本 describe 钉死放宽后的精确边界：惰性 ref 放行（含未知 file_path，阻断 1）、
//    guard/显式 artifact/action 仍严格。
describe('G2 P2 兼容回退：惰性 input/output ref + nonempty-output 列表/惰性下沉', () => {
  it('未知 string output（无 guard）→ 编译通过，惰性 ref 原样保留在 IR（pre-P2 能加载的旧 workflow）', () => {
    const ir = compileWorkflow(v1Def([v1Step({ outputs: [{ field: 'custom_doc', type: 'string' }] })]))
    expect(ir.steps[0]!.outputs).toEqual([{ field: 'custom_doc', type: 'string' }])
    expect(ir.steps[0]!.guards).toEqual([])
    expect(ir.steps[0]!.artifacts).toEqual([]) // 惰性 string output 不派生 artifact
  })

  it('未知 string input / boolean output / file_path output 三种 type 惰性放行一视同仁（阻断 1：file_path 未知不再拒）', () => {
    const lazyIn = compileWorkflow(v1Def([v1Step({ inputs: [{ field: 'not_a_field', type: 'string' }] })]))
    expect(lazyIn.steps[0]!.inputs).toEqual([{ field: 'not_a_field', type: 'string' }])
    const lazyOut = compileWorkflow(v1Def([v1Step({ outputs: [{ field: 'also_unknown', type: 'boolean' }] })]))
    expect(lazyOut.steps[0]!.outputs).toEqual([{ field: 'also_unknown', type: 'boolean' }])
    const lazyFile = compileWorkflow(v1Def([v1Step({ outputs: [{ field: 'custom_report', type: 'file_path' }] })]))
    expect(lazyFile.steps[0]!.outputs).toEqual([{ field: 'custom_report', type: 'file_path' }])
    expect(lazyFile.steps[0]!.artifacts).toEqual([]) // 未知 file_path 惰性、不派生 artifact
  })

  it('惰性 output 参与定义层依赖关系：后序 step 声明同名 input 时 IR 原样保留两端（供 validate 依赖校验）', () => {
    const ir = compileWorkflow(
      v1Def([
        v1Step({ id: 's1', outputs: [{ field: 'custom_doc', type: 'string' }], transitions: [{ event: 'go', to: 's2' }] }),
        v1Step({ id: 's2', inputs: [{ field: 'custom_doc', type: 'string' }] }),
      ]),
    )
    expect(ir.steps[0]!.outputs).toEqual([{ field: 'custom_doc', type: 'string' }])
    expect(ir.steps[1]!.inputs).toEqual([{ field: 'custom_doc', type: 'string' }])
  })

  it('nonempty-output 指列表字段 output → 下沉为 output-present（v1 兼容：编译通过、运行期失败，非编译期拒——与 P1 新 scalar guard 列表闸刻意分道）', () => {
    const ir = compileWorkflow(
      rawDef({ name: 'demo', steps: [v1Step({ outputs: [{ field: 'scope', type: 'string' }], guards: [{ type: 'nonempty-output' }] })] }),
    )
    expect(ir.steps[0]!.guards).toEqual([{ type: 'output-present', field: 'scope' }])
  })

  it('nonempty-output 指未知惰性 output → 下沉为 output-present（保留 v1 旧运行期失败语义）', () => {
    const ir = compileWorkflow(
      rawDef({ name: 'demo', steps: [v1Step({ outputs: [{ field: 'custom_doc', type: 'string' }], guards: [{ type: 'nonempty-output' }] })] }),
    )
    expect(ir.steps[0]!.guards).toEqual([{ type: 'output-present', field: 'custom_doc' }])
  })

  it('nonempty-output 指未知 file_path output → 同下沉为 output-present（阻断 1：未知 file_path 与未知 string 同为惰性，nonempty-output 走 output-present 而非 field-nonempty）', () => {
    const ir = compileWorkflow(
      rawDef({ name: 'demo', steps: [v1Step({ outputs: [{ field: 'custom_report', type: 'file_path' }], guards: [{ type: 'nonempty-output' }] })] }),
    )
    expect(ir.steps[0]!.guards).toEqual([{ type: 'output-present', field: 'custom_report' }])
  })

  it('nonempty-output 混合 output（已知标量 file_path + 列表 + 未知惰性）→ 逐字段分流 field-nonempty / output-present（when 传播到每条）', () => {
    const ir = compileWorkflow(
      rawDef({
        name: 'demo',
        steps: [
          v1Step({
            outputs: [
              { field: 'design_doc', type: 'file_path' },
              { field: 'scope', type: 'string' },
              { field: 'custom_doc', type: 'string' },
            ],
            guards: [{ type: 'nonempty-output', when: NON_PM }] as never,
          }),
        ],
      }),
    )
    expect(ir.steps[0]!.guards).toEqual([
      { type: 'field-nonempty', field: 'design_doc', when: NON_PM },
      { type: 'output-present', field: 'scope', when: NON_PM },
      { type: 'output-present', field: 'custom_doc', when: NON_PM },
    ])
  })

  it('严格面保留：未知惰性 output 上挂 typed guard（field-nonempty）仍编译期拒（guard 要真求值，只能引用 FIELD_ORDER）', () => {
    expect(() =>
      compileWorkflow(
        rawDef({ name: 'demo', steps: [v1Step({ outputs: [{ field: 'custom_doc', type: 'string' }], guards: [{ type: 'field-nonempty', field: 'custom_doc' }] })] }),
      ),
    ).toThrow(/steps\[0\]\.guards\[0\]\.field.*custom_doc/)
  })

  it('field-equals value 不可表示（空串/换行/回车/tab/首尾空白）→ 编译期拒（阻断 2：serialize→parse 往返域）', () => {
    for (const value of ['', 'a\nb', 'a\rb', 'a\tb', ' pad', 'pad ']) {
      expect(() =>
        compileWorkflow(rawDef({ name: 'demo', steps: [v1Step({ guards: [{ type: 'field-equals', field: 'branch_status', value }] as never })] })),
      ).toThrow(/steps\[0\]\.guards\[0\]\.value/)
    }
  })
})

describe('冻结性与输入免污染', () => {
  const DEF = v1Def([
    v1Step({
      outputs: [{ field: 'design_doc', type: 'file_path' }],
      guards: [{ type: 'nonempty-output' }, { type: 'tasks-at-least', n: 1 }],
      transitions: [{ event: 'go', to: 'draft' }],
    }),
  ])

  it('IR 全树 Object.isFrozen（顶层/steps/step/guards/guard/transitions/edge/artifacts/artifact）', () => {
    const ir = compileWorkflow(DEF)
    const step = ir.steps[0]!
    for (const node of [ir, ir.steps, step, step.guards, step.guards[0], step.outputs, step.outputs[0], step.transitions, step.transitions[0], step.transitions[0]!.guards, step.artifacts, step.artifacts[0]] as const) {
      expect(Object.isFrozen(node)).toBe(true)
    }
  })

  it('改动冻结产物抛 TypeError（严格模式）：改 name / push steps / 改 guard 字段', () => {
    const ir = compileWorkflow(DEF)
    expect(() => { (ir as { name: string }).name = 'x' }).toThrow(TypeError)
    expect(() => { (ir.steps as unknown as unknown[]).push({}) }).toThrow(TypeError)
    expect(() => { (ir.steps[0]!.guards[0] as { type: string }).type = 'x' }).toThrow(TypeError)
  })

  it('输入 def 不被冻结、不被改动；IR 与 def 零共享引用（改 def 不影响已编译 IR）', () => {
    const def = v1Def([
      v1Step({
        outputs: [{ field: 'design_doc', type: 'file_path' }],
        guards: [{ type: 'tasks-at-least', n: 1 }],
        transitions: [{ event: 'go', to: 'draft' }],
      }),
    ])
    const ir = compileWorkflow(def)
    expect(Object.isFrozen(def)).toBe(false)
    expect(Object.isFrozen(def.steps[0])).toBe(false)
    expect(Object.isFrozen(def.steps[0]!.guards[0])).toBe(false)
    expect(ir.steps[0]!.outputs).not.toBe(def.steps[0]!.outputs)
    ;(def.steps[0]!.guards[0] as { n: number }).n = 99
    expect((ir.steps[0]!.guards[0] as { n: number }).n).toBe(1)
  })

  it('when 谓词也是编译期拷贝：冻结 IR 不冻结调用方传入的谓词实例', () => {
    const def = rawDef({
      name: 'demo',
      steps: [v1Step({ guards: [{ type: 'field-nonempty', field: 'plan', when: NON_PM }] as never })],
    })
    const ir = compileWorkflow(def)
    const guard = ir.steps[0]!.guards[0] as { when?: typeof NON_PM }
    expect(guard.when).toEqual(NON_PM)
    expect(guard.when).not.toBe(NON_PM)
    expect(Object.isFrozen(NON_PM)).toBe(false)
  })
})

describe('parse.ts 产物直通编译（v1 定义文件的真实入口形态）', () => {
  const YAML = [
    'name: demo',
    'steps:',
    '  - id: draft',
    '    gate: null',
    '    skills:',
    '      - id: writer',
    '    inputs: []',
    '    outputs:',
    '      - field: design_doc',
    '        type: file_path',
    '    guards:',
    '      - type: nonempty-output',
    '      - type: tasks-at-least',
    '        n: 2',
    '    transitions:',
    '      - event: draft-done',
    '        to: ship',
    '  - id: ship',
    '    gate: review',
    '    skills: []',
    '    inputs:',
    '      - field: design_doc',
    '        type: file_path',
    '    outputs: []',
    '    guards: []',
    '    transitions: []',
    '',
  ].join('\n')

  it('parseWorkflow → compileWorkflow：下沉 + 派生 + 默认值一步到位', () => {
    const ir = compileWorkflow(parseWorkflow(YAML))
    expect(ir.name).toBe('demo')
    const draft = ir.steps[0]!
    expect(draft.guards).toEqual([
      { type: 'field-nonempty', field: 'design_doc' },
      { type: 'tasks-at-least', n: 2 },
    ])
    expect(draft.artifacts).toEqual([
      { kind: 'file', field: 'design_doc', producerPolicy: 'effective-step-skills' },
    ])
    expect(draft.transitions).toEqual([{ event: 'draft-done', to: 'ship', guards: [], actions: [] }])
    const ship: StepIR = ir.steps[1]!
    expect(ship.gate).toBe('review')
    expect(ship.guards).toEqual([])
    expect(ship.artifacts).toEqual([])
  })
})

describe('artifact producer policy · A 契约（G2 P5：custom 拒 effective-phase-skills / default 专用入口允许）', () => {
  it('通用 compileWorkflow（custom 契约）：显式 effective-phase-skills → fail-loud（A 契约钉死）', () => {
    expect(() =>
      compileWorkflow(
        rawDef({
          name: 'demo',
          steps: [v1Step({ outputs: [{ field: 'design_doc', type: 'file_path' }], artifacts: [{ field: 'design_doc', producerPolicy: 'effective-phase-skills' }] } as never)],
        }),
      ),
    ).toThrow(/steps\[0\]\.artifacts\[0\]\.producerPolicy/)
  })

  it('通用 compileWorkflow 的 A 契约错误消息点名 custom 不允许 effective-phase-skills', () => {
    expect(() =>
      compileWorkflow(
        rawDef({
          name: 'demo',
          steps: [v1Step({ outputs: [{ field: 'design_doc', type: 'file_path' }], artifacts: [{ field: 'design_doc', producerPolicy: 'effective-phase-skills' }] } as never)],
        }),
      ),
    ).toThrow(/custom .*不允许.*effective-phase-skills|A 契约/)
  })

  it('default 专用入口 compileDefaultWorkflow：显式 effective-phase-skills → 接受并原样保留', () => {
    const ir = compileDefaultWorkflow(
      rawDef({
        name: 'default',
        steps: [v1Step({ outputs: [{ field: 'design_doc', type: 'file_path' }], artifacts: [{ field: 'design_doc', producerPolicy: 'effective-phase-skills' }] } as never)],
      }),
    )
    expect(ir.steps[0]!.artifacts).toEqual([{ kind: 'file', field: 'design_doc', producerPolicy: 'effective-phase-skills' }])
  })

  it('compileDefaultWorkflow：effective-phase-skills + requiredWhen（track-not-in:[pm]）→ 两者都保留', () => {
    const ir = compileDefaultWorkflow(
      rawDef({
        name: 'default',
        steps: [v1Step({ outputs: [{ field: 'plan', type: 'file_path' }], artifacts: [{ field: 'plan', producerPolicy: 'effective-phase-skills', requiredWhen: NON_PM }] } as never)],
      }),
    )
    expect(ir.steps[0]!.artifacts).toEqual([{ kind: 'file', field: 'plan', producerPolicy: 'effective-phase-skills', requiredWhen: NON_PM }])
  })

  it('缺省 producerPolicy（file_path output 派生 / 显式不给）→ 仍补 effective-step-skills（custom 派生默认不变）', () => {
    const ir = compileWorkflow(
      rawDef({
        name: 'demo',
        steps: [v1Step({ outputs: [{ field: 'plan', type: 'file_path' }], artifacts: [{ field: 'plan' }] } as never)],
      }),
    )
    expect(ir.steps[0]!.artifacts).toEqual([{ kind: 'file', field: 'plan', producerPolicy: 'effective-step-skills' }])
  })

  it('custom 显式 effective-step-skills → 接受（A 契约不误伤 custom 合法 policy）', () => {
    const ir = compileWorkflow(
      rawDef({
        name: 'demo',
        steps: [v1Step({ outputs: [{ field: 'plan', type: 'file_path' }], artifacts: [{ field: 'plan', producerPolicy: 'effective-step-skills' }] } as never)],
      }),
    )
    expect(ir.steps[0]!.artifacts).toEqual([{ kind: 'file', field: 'plan', producerPolicy: 'effective-step-skills' }])
  })

  it('闭集外 producerPolicy（effective-galaxy-skills）两入口都 fail-loud', () => {
    const bad = rawDef({
      name: 'demo',
      steps: [v1Step({ outputs: [{ field: 'plan', type: 'file_path' }], artifacts: [{ field: 'plan', producerPolicy: 'effective-galaxy-skills' }] } as never)],
    })
    expect(() => compileWorkflow(bad)).toThrow(/steps\[0\]\.artifacts\[0\]\.producerPolicy/)
    expect(() => compileDefaultWorkflow(bad)).toThrow(/steps\[0\]\.artifacts\[0\]\.producerPolicy/)
  })

  it('旧 file_path 派生（无显式 artifacts）→ 仍 effective-step-skills（custom 契约下语义不变）', () => {
    const ir = compileWorkflow(
      rawDef({ name: 'demo', steps: [v1Step({ outputs: [{ field: 'design_doc', type: 'file_path' }] })] }),
    )
    expect(ir.steps[0]!.artifacts).toEqual([{ kind: 'file', field: 'design_doc', producerPolicy: 'effective-step-skills' }])
  })

  it('parseWorkflow → compileDefaultWorkflow：YAML artifacts 块（effective-phase-skills + required_when）流经编译进 IR', () => {
    const yaml =
      'name: default\nsteps:\n  - id: spec\n    outputs:\n      - field: plan\n        type: file_path\n' +
      '    artifacts:\n      - field: plan\n        type: file_path\n        producer_policy: effective-phase-skills\n        required_when:\n          track_not_in: [pm]\n    transitions: []\n'
    const ir = compileDefaultWorkflow(parseWorkflow(yaml))
    expect(ir.steps[0]!.artifacts).toEqual([
      { kind: 'file', field: 'plan', producerPolicy: 'effective-phase-skills', requiredWhen: { kind: 'track-not-in', values: ['pm'] } },
    ])
  })
})
