import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseWorkflow } from './parse.js'
import { validateWorkflow } from './validate.js'

const SAMPLE = `name: default
steps:
  - id: open
    label: 立项
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: explore
  - id: explore
    label: 调研
    gate: review
    skills:
      - id: superpowers:brainstorming
      - id: opsx:explore
        depends_on: [superpowers:brainstorming]
    inputs: []
    outputs:
      - field: design_doc
        type: file_path
    guards: []
    transitions: []
  - id: verify
    label: 验证
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: pass
        to: ship
      - event: fail
        to: build
`

const SAMPLE_WITH_GUARDS = `name: workflow-with-guards
steps:
  - id: step1
    label: 步骤一
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: nonempty-output
    transitions: []
  - id: step2
    label: 步骤二
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: tasks-at-least
        n: 3
    transitions: []
  - id: step3
    label: 步骤三
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: nonempty-output
      - type: tasks-at-least
        n: 2
    transitions: []
`

describe('parseWorkflow', () => {
  it('三步 workflow 可声明与图长度解耦的 v1 document contract', () => {
    const wf = parseWorkflow(`name: compact-governed
document_contract:
  version: v1
  slots:
    - kind: proposal
      owner_step: shape
      producers: [openspec-propose]
    - kind: plan
      owner_step: shape
      producers: [writing-plans]
  reads:
    - step: implement
      kinds: [proposal, plan]
    - step: verify
      kinds: [proposal, plan]
steps:
  - id: shape
    label: 定义
    gate: review
    skills:
      - id: openspec-propose
      - id: writing-plans
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: shaped
        to: implement
  - id: implement
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: implemented
        to: verify
  - id: verify
    label: 验证
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`)
    expect(wf.documentContract).toEqual({
      version: 'v1',
      slots: [
        { kind: 'proposal', ownerStep: 'shape', producers: ['openspec-propose'] },
        { kind: 'plan', ownerStep: 'shape', producers: ['writing-plans'] },
      ],
      reads: [
        { step: 'implement', kinds: ['proposal', 'plan'] },
        { step: 'verify', kinds: ['proposal', 'plan'] },
      ],
    })
  })

  it('document contract 未知 version fail-loud；openspec_contract 已移除并提示替代写法', () => {
    expect(() => parseWorkflow('name: bad\ndocument_contract:\n  version: v2\n  slots:\n    - kind: proposal\n      owner_step: one\n      producers: [writer]\n  reads: []\nsteps:\n')).toThrow(/version/)
    expect(() => parseWorkflow('name: bad\nopenspec_contract: required\nsteps:\n')).toThrow('workflow 解析错误：openspec_contract 已移除——改为 openspec: true 并声明 document_contract')
  })

  it('openspec: true 解析为 true；false 归一为缺省；其它值与重复声明 fail-loud', () => {
    expect(parseWorkflow('name: on\nopenspec: true\nsteps:\n').openspec).toBe(true)
    expect(parseWorkflow('name: off\nopenspec: false\nsteps:\n')).not.toHaveProperty('openspec')
    expect(() => parseWorkflow('name: bad\nopenspec: yes\nsteps:\n')).toThrow('workflow 解析错误：openspec 只支持 true 或 false')
    expect(() => parseWorkflow('name: bad\nopenspec: true\nopenspec: true\nsteps:\n')).toThrow('workflow 解析错误：openspec 重复声明')
  })

  it('slot role：produce 归一为缺省，update 保留，require 无 producers；非法 role 与 require 带 producers fail-loud', () => {
    const contract = (slots: string) => `name: roles\nopenspec: true\ndocument_contract:\n  version: v1\n  slots:\n${slots}  reads: []\nsteps:\n`
    const wf = parseWorkflow(contract([
      '    - kind: tasks',
      '      owner_step: shape',
      '      role: produce',
      '      producers: [openspec-propose]',
      '    - kind: tasks',
      '      owner_step: build',
      '      role: update',
      '      producers: [openspec-propose]',
      '    - kind: design-md',
      '      owner_step: build',
      '      role: require',
      '',
    ].join('\n')))
    expect(wf.documentContract?.slots).toEqual([
      { kind: 'tasks', ownerStep: 'shape', producers: ['openspec-propose'] },
      { kind: 'tasks', ownerStep: 'build', role: 'update', producers: ['openspec-propose'] },
      { kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] },
    ])
    expect(() => parseWorkflow(contract('    - kind: tasks\n      owner_step: shape\n      role: consume\n      producers: [a]\n')))
      .toThrow("document slot 'tasks' 的 role 只支持 produce | update | require")
    expect(() => parseWorkflow(contract('    - kind: design-md\n      owner_step: shape\n      role: require\n      producers: [hue]\n')))
      .toThrow("document slot 'design-md' 的 role require 不声明 producers")
    expect(() => parseWorkflow(contract('    - kind: tasks\n      owner_step: shape\n      role: update\n')))
      .toThrow("document slot 'tasks' 缺非空 producers")
  })

  it('slot 与 read 接受单行 flow map', () => {
    const wf = parseWorkflow([
      'name: flow',
      'openspec: true',
      'document_contract:',
      '  version: v1',
      '  slots:',
      '    - { kind: proposal, owner_step: open, producers: [openspec-propose, opsx:propose], role: produce }',
      '    - { kind: design-md, owner_step: build, role: require }',
      '  reads:',
      '    - { step: build, kinds: [proposal] }',
      'steps:',
      '',
    ].join('\n'))
    expect(wf.documentContract).toEqual({
      version: 'v1',
      slots: [
        { kind: 'proposal', ownerStep: 'open', producers: ['openspec-propose', 'opsx:propose'] },
        { kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] },
      ],
      reads: [{ step: 'build', kinds: ['proposal'] }],
    })
  })

  it('tracks 分支可声明自己的 document_contract；有 tracks 时顶层 document_contract fail-loud', () => {
    const branch = [
      'tracks:',
      '  web:',
      '    label: 前端',
      '    document_contract:',
      '      version: v1',
      '      slots:',
      '        - kind: design-md',
      '          owner_step: build',
      '          role: require',
      '      reads: []',
      '    steps:',
      '      - id: build',
      '        label: 实现',
      '        gate: null',
      '        skills: []',
      '        inputs: []',
      '        outputs: []',
      '        guards: []',
      '        transitions: []',
      '',
    ].join('\n')
    const wf = parseWorkflow(`name: branched\nopenspec: true\n${branch}`)
    expect(wf.tracks?.web?.documentContract?.slots).toEqual([{ kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] }])
    expect(wf.documentContract).toBeUndefined()
    expect(() => parseWorkflow(`name: branched\nopenspec: true\ndocument_contract:\n  version: v1\n  slots:\n    - kind: proposal\n      owner_step: build\n      producers: [a]\n  reads: []\n${branch}`))
      .toThrow('workflow 解析错误：有 tracks 时 document_contract 写在 tracks.<id> 下')
  })

  it('Step prompt 使用 YAML literal block，保留多行、引号与模板字符', () => {
    const wf = parseWorkflow(`name: prompted
steps:
  - id: build
    label: 构建
    gate: null
    prompt: |-
      Implement the selected work package.
      Preserve \`$HOME\` and "quoted" text literally.
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`)
    expect(wf.steps[0]?.prompt).toBe('Implement the selected work package.\nPreserve `$HOME` and "quoted" text literally.')
  })

  it('解析出 3 个 step，第二个 step 的第二个 skill 带 depends_on', () => {
    const wf = parseWorkflow(SAMPLE)
    expect(wf.name).toBe('default')
    expect(wf.steps).toHaveLength(3)
    expect(wf.steps[1]?.id).toBe('explore')
    expect(wf.steps[1]?.gate).toBe('review')
    expect(wf.steps[1]?.skills[1]).toEqual({ id: 'opsx:explore', depends_on: ['superpowers:brainstorming'] })
    expect(wf.steps[1]?.outputs[0]).toEqual({ field: 'design_doc', type: 'file_path' })
  })

  it('第一个 step 的 transitions 解析出单条边', () => {
    const wf = parseWorkflow(SAMPLE)
    expect(wf.steps[0]?.transitions).toEqual([{ event: 'complete', to: 'explore' }])
  })

  it('verify step 的 transitions 解析出两条分支边（同一 step 不同 event 走向不同 to）', () => {
    const wf = parseWorkflow(SAMPLE)
    expect(wf.steps[2]?.transitions).toEqual([
      { event: 'pass', to: 'ship' },
      { event: 'fail', to: 'build' },
    ])
  })

  it('格式错误（steps 不是数组）→ 真抛错，不静默返回空', () => {
    expect(() => parseWorkflow('name: x\nsteps: not-a-list\n')).toThrow()
  })

  // Guards block tests
  it('单个 nonempty-output 守卫解析正确', () => {
    const wf = parseWorkflow(SAMPLE_WITH_GUARDS)
    expect(wf.steps[0]?.id).toBe('step1')
    expect(wf.steps[0]?.guards).toEqual([{ type: 'nonempty-output' }])
  })

  it('tasks-at-least 守卫带 n 值解析正确', () => {
    const wf = parseWorkflow(SAMPLE_WITH_GUARDS)
    expect(wf.steps[1]?.id).toBe('step2')
    expect(wf.steps[1]?.guards).toEqual([{ type: 'tasks-at-least', n: 3 }])
  })

  it('多个守卫（nonempty-output + tasks-at-least）在同一 step 解析正确', () => {
    const wf = parseWorkflow(SAMPLE_WITH_GUARDS)
    expect(wf.steps[2]?.id).toBe('step3')
    expect(wf.steps[2]?.guards).toEqual([
      { type: 'nonempty-output' },
      { type: 'tasks-at-least', n: 2 },
    ])
  })
})

// ── G2 P2：定义层 8 guard 变体 + when 谓词 + edge 级 guards/actions ──
describe('parseWorkflow —— G2 P2 新 guard 变体 / when / edge guards+actions', () => {
  const WF = `name: p2
steps:
  - id: verify
    label: 验证
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: field-nonempty
        field: verification_report
      - type: file-exists
        field: verification_report
      - type: field-equals
        field: branch_status
        value: handled
        when:
          track_not_in: [pm]
      - type: field-in
        field: isolation
        values: [branch, worktree]
      - type: full-direct-override
      - type: build-head-unchanged
        field: build_sha
    transitions:
      - event: pass
        to: done
        guards:
          - type: field-equals
            field: agent_review_result
            value: pass
            when:
              track_in: [backend, frontend]
        actions:
          - type: mark-verification-passed
          - type: freeze-build-sha
  - id: done
    label: 完成
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

  it('全部 6 个 step 级新变体解析（file-exists 桥接成嵌套 path、when 谓词 snake→kebab）', () => {
    const g = parseWorkflow(WF).steps[0]!.guards
    expect(g).toEqual([
      { type: 'field-nonempty', field: 'verification_report' },
      { type: 'file-exists', path: { kind: 'field', field: 'verification_report' } },
      { type: 'field-equals', field: 'branch_status', value: 'handled', when: { kind: 'track-not-in', values: ['pm'] } },
      { type: 'field-in', field: 'isolation', values: ['branch', 'worktree'] },
      { type: 'full-direct-override' },
      { type: 'build-head-unchanged', field: 'build_sha' },
    ])
  })

  it('edge 级 guards + actions 解析（含 when: track_in）', () => {
    const t = parseWorkflow(WF).steps[0]!.transitions[0]!
    expect(t.event).toBe('pass')
    expect(t.to).toBe('done')
    expect(t.guards).toEqual([
      { type: 'field-equals', field: 'agent_review_result', value: 'pass', when: { kind: 'track-in', values: ['backend', 'frontend'] } },
    ])
    expect(t.actions).toEqual([{ type: 'mark-verification-passed' }, { type: 'freeze-build-sha' }])
  })

  it('旧 YAML（transition 无 guards/actions 键）→ 这两键为 undefined（逐字不变，不注入空数组）', () => {
    const t = parseWorkflow(SAMPLE).steps[0]!.transitions[0]!
    expect(t).toEqual({ event: 'complete', to: 'explore' })
    expect(Object.prototype.hasOwnProperty.call(t, 'guards')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(t, 'actions')).toBe(false)
  })

  it('未知 guard type → fail-loud', () => {
    expect(() => parseWorkflow('name: x\nsteps:\n  - id: s\n    guards:\n      - type: rm-rf\n    transitions: []\n')).toThrow(/未知 guard type/)
  })

  it('未知 action type → fail-loud', () => {
    const bad = 'name: x\nsteps:\n  - id: s\n    guards: []\n    transitions:\n      - event: e\n        to: s\n        actions:\n          - type: drop-table\n'
    expect(() => parseWorkflow(bad)).toThrow(/未知 action type/)
  })

  it('field-in 空 values → fail-loud（至少一个合法值）', () => {
    const bad = 'name: x\nsteps:\n  - id: s\n    guards:\n      - type: field-in\n        field: isolation\n        values: []\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/field-in/)
  })

  it('field-equals 缺 value → fail-loud', () => {
    const bad = 'name: x\nsteps:\n  - id: s\n    guards:\n      - type: field-equals\n        field: branch_status\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/缺 value/)
  })

  it('when 谓词键非法（既非 track_in 亦非 track_not_in）→ fail-loud', () => {
    const bad = 'name: x\nsteps:\n  - id: s\n    guards:\n      - type: full-direct-override\n        when:\n          track_maybe: [pm]\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/track_in|track_not_in/)
  })

  // ── 阻断 3：guard 变体不认识的附加子字段 → fail-loud（此前 parseGuardEntry 收所有通用子字段、
  //    buildGuard 只取本变体需要的，附加字段被静默丢弃）──
  it('nonempty-output 带 n → fail-loud（该变体无附加子字段，n 不该被静默丢）', () => {
    const bad = 'name: x\nsteps:\n  - id: s\n    guards:\n      - type: nonempty-output\n        n: 2\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/nonempty-output.*n|附加/)
  })

  it('tasks-at-least 带 field → fail-loud（只允许 n）', () => {
    const bad = 'name: x\nsteps:\n  - id: s\n    guards:\n      - type: tasks-at-least\n        n: 1\n        field: plan\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/tasks-at-least.*field|附加/)
  })

  it('field-nonempty 带 value → fail-loud（只允许 field）', () => {
    const bad = 'name: x\nsteps:\n  - id: s\n    guards:\n      - type: field-nonempty\n        field: plan\n        value: x\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/field-nonempty.*value|附加/)
  })

  it('full-direct-override 带 values → fail-loud（无附加子字段，仅可选 when）', () => {
    const bad = 'name: x\nsteps:\n  - id: s\n    guards:\n      - type: full-direct-override\n        values: [a, b]\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/full-direct-override.*values|附加/)
  })

  it('field-equals 合法子字段（field + value + when）不误拒', () => {
    const ok = 'name: x\nsteps:\n  - id: s\n    guards:\n      - type: field-equals\n        field: branch_status\n        value: handled\n        when:\n          track_not_in: [pm]\n    transitions: []\n'
    expect(() => parseWorkflow(ok)).not.toThrow()
  })
})

describe('parseWorkflow —— 显式 artifacts 块（G2 P4）', () => {
  it('artifacts 块解析进 StepDef.artifacts（producer_policy snake→camel producerPolicy）', () => {
    const wf = parseWorkflow(
      'name: x\nsteps:\n  - id: explore\n    outputs:\n      - field: design_doc\n        type: file_path\n' +
        '    artifacts:\n      - field: design_doc\n        type: file_path\n        producer_policy: effective-phase-skills\n    transitions: []\n',
    )
    expect(wf.steps[0]!.artifacts).toEqual([{ field: 'design_doc', type: 'file_path', producerPolicy: 'effective-phase-skills' }])
  })

  it('required_when 块 snake→kebab 归一进 artifact.requiredWhen', () => {
    const wf = parseWorkflow(
      'name: x\nsteps:\n  - id: spec\n    outputs:\n      - field: plan\n        type: file_path\n' +
        '    artifacts:\n      - field: plan\n        type: file_path\n        producer_policy: effective-phase-skills\n        required_when:\n          track_not_in: [pm]\n    transitions: []\n',
    )
    expect(wf.steps[0]!.artifacts).toEqual([
      { field: 'plan', type: 'file_path', producerPolicy: 'effective-phase-skills', requiredWhen: { kind: 'track-not-in', values: ['pm'] } },
    ])
  })

  it('无 artifacts 键 → StepDef 无 artifacts 属性（逐字兼容旧 YAML，不注入）', () => {
    const wf = parseWorkflow(SAMPLE)
    expect(Object.prototype.hasOwnProperty.call(wf.steps[0]!, 'artifacts')).toBe(false)
  })

  it('artifacts: [] → 空数组（与缺省 undefined 两态区分）', () => {
    const wf = parseWorkflow('name: x\nsteps:\n  - id: s\n    artifacts: []\n    transitions: []\n')
    expect(wf.steps[0]!.artifacts).toEqual([])
  })

  it('artifact type ≠ file_path → fail-loud', () => {
    const bad =
      'name: x\nsteps:\n  - id: s\n    artifacts:\n      - field: plan\n        type: string\n        producer_policy: effective-phase-skills\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/type 只支持 file_path/)
  })

  it('artifact 缺 producer_policy → fail-loud', () => {
    const bad = 'name: x\nsteps:\n  - id: s\n    artifacts:\n      - field: plan\n        type: file_path\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/缺 producer_policy/)
  })

  it('artifact 未知子字段行 → fail-loud', () => {
    const bad =
      'name: x\nsteps:\n  - id: s\n    artifacts:\n      - field: plan\n        type: file_path\n        producer_policy: effective-phase-skills\n        bogus: 1\n    transitions: []\n'
    expect(() => parseWorkflow(bad)).toThrow(/未知字段行/)
  })
})

describe('parseWorkflow —— 顶层键顺序无关', () => {
  const STEPS = [
    'steps:',
    '  - id: shape',
    '    label: Shape',
    '    gate: review',
    '    skills: []',
    '    inputs: []',
    '    outputs: []',
    '    guards: []',
    '    transitions: []',
  ].join('\n')
  const CONTRACT = [
    'document_contract:',
    '  version: v1',
    '  slots:',
    '    - kind: proposal',
    '      owner_step: shape',
    '      producers: [writer]',
    '  reads: []',
  ].join('\n')
  const indent = (text: string): string => text.split('\n').map((line) => `    ${line}`).join('\n')

  it('document_contract / openspec 放在 steps 之后与之前解析结果一致', () => {
    const before = parseWorkflow(`name: order\nopenspec: true\n${CONTRACT}\n${STEPS}\n`)
    const after = parseWorkflow(`name: order\n${STEPS}\n${CONTRACT}\nopenspec: true\n`)
    expect(after).toEqual(before)
    expect(after.documentContract?.slots.map((slot) => slot.kind)).toEqual(['proposal'])
  })

  it('tracks.<id> 下 document_contract 写在 steps 之后也可解析', () => {
    const wf = parseWorkflow(`name: branched\nopenspec: true\ntracks:\n  backend:\n${indent(STEPS)}\n${indent(CONTRACT)}\n`)
    expect(wf.tracks?.backend?.documentContract?.version).toBe('v1')
  })

  it('重复顶层键、未知顶层键、缺 steps/tracks 仍 fail-loud', () => {
    expect(() => parseWorkflow(`name: dup\n${STEPS}\n${STEPS}\n`)).toThrow('steps 重复声明')
    expect(() => parseWorkflow(`name: dup\n${CONTRACT}\n${STEPS}\n${CONTRACT}\n`)).toThrow('document_contract 重复声明')
    expect(() => parseWorkflow(`name: odd\n${STEPS}\nextra: 1\n`)).toThrow("无法识别的顶层键 'extra: 1'")
    expect(() => parseWorkflow('name: empty\nopenspec: true\n')).toThrow("缺少 'steps:' 或 'tracks:'")
  })

  it('docs/usage/custom-workflows-and-tracks.md 的示例可解析并通过校验', () => {
    const doc = readFileSync(new URL('../../../../docs/usage/custom-workflows-and-tracks.md', import.meta.url), 'utf8')
    const example = /```yaml\n(name: release-note\n[\s\S]*?)```/u.exec(doc)?.[1]
    expect(example).toBeDefined()
    const wf = parseWorkflow(example ?? '')
    expect(wf.documentContract?.reads.map((read) => read.step)).toEqual(['implement', 'prove'])
    expect(validateWorkflow(wf)).toEqual([])
  })
})
