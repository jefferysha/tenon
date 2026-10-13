import { describe, expect, it } from 'vitest'
import { compileWorkflow } from './compile.js'
import { validateDocumentContract } from './document-contract.js'
import { parseWorkflow } from './parse.js'
import { selectTrackBranch, validateWorkflow, validateWorkflowForStorage, workflowBranches } from './validate.js'
import { anyContract, branchWith, defaultWithLiteBranch } from './test-support.js'
import type { StepDef, WorkflowActionConfig, WorkflowDef, WorkflowDocumentRead, WorkflowDocumentSlot } from './types.js'

function wf(overrides: Partial<WorkflowDef>): WorkflowDef {
  return { name: 'test', steps: [], ...overrides }
}

const NEEDS_OPENSPEC = 'document_contract 需要分支的 spec 为 openspec（顶层 openspec: true 或分支 spec: openspec）'

function bare(id: string, to?: string): StepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: to === undefined ? [] : [{ event: `${id}-complete`, to }] }
}

// 新定义已被 validateWorkflow 整体拒绝 document_contract（见下面「已删除的旧键」）；契约内容校验只剩给旧快照夹具
// 与外部调用方用，所以这几条直接调 validateDocumentContract，不再经 validateWorkflow。
describe('validateDocumentContract · 旧契约的内容校验', () => {
  it('三步 declarative document contract 不要求七阶段且校验 owner/read 顺序', () => {
    const compact = wf({
      openspec: true,
      documentContract: {
        version: 'v1',
        slots: [
          { kind: 'proposal', ownerStep: 'shape', producers: ['writer'] },
          { kind: 'plan', ownerStep: 'shape', producers: ['planner'] },
        ],
        reads: [
          { step: 'build', kinds: ['proposal', 'plan'] },
          { step: 'verify', kinds: ['proposal', 'plan'] },
        ],
      },
      steps: [
        {
          id: 'shape', label: 'shape', gate: null, inputs: [], outputs: [], guards: [],
          skills: [{ id: 'writer' }, { id: 'planner' }],
          transitions: [{ event: 'shaped', to: 'build' }],
        },
        {
          id: 'build', label: 'build', gate: null, inputs: [], outputs: [], guards: [], skills: [],
          transitions: [{ event: 'built', to: 'verify' }],
        },
        {
          id: 'verify', label: 'verify', gate: null, inputs: [], outputs: [], guards: [], skills: [],
          transitions: [],
        },
      ],
    })
    expect(validateDocumentContract(compact)).toEqual([])
    expect(validateDocumentContract({
      ...compact,
      documentContract: {
        ...compact.documentContract!,
        reads: [{ step: 'shape', kinds: ['proposal'] }],
      },
    }).some((error) => error.includes('只能读取更早 step'))).toBe(true)
  })

  it('declarative document reader 的所有入口路径都必须经过 owner step', () => {
    const branched = wf({
      openspec: true,
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
        reads: [{ step: 'verify', kinds: ['proposal'] }],
      },
      steps: [
        {
          id: 'start', label: 'start', gate: null, inputs: [], outputs: [], guards: [], skills: [],
          transitions: [
            { event: 'shape', to: 'shape' },
            { event: 'bypass', to: 'build' },
          ],
        },
        {
          id: 'shape', label: 'shape', gate: null, inputs: [], outputs: [], guards: [],
          skills: [{ id: 'writer' }],
          transitions: [{ event: 'shaped', to: 'build' }],
        },
        {
          id: 'build', label: 'build', gate: null, inputs: [], outputs: [], guards: [], skills: [],
          transitions: [{ event: 'built', to: 'verify' }],
        },
        {
          id: 'verify', label: 'verify', gate: null, inputs: [], outputs: [], guards: [], skills: [],
          transitions: [],
        },
      ],
    })

    expect(validateDocumentContract(branched)).toContain(
      "document_contract document 'proposal' 的 owner_step 'shape' 不支配 reader step 'verify'",
    )
  })

  it('owner 支配 reader 时允许 reader 之后回环到 owner', () => {
    const looped = wf({
      openspec: true,
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
        reads: [{ step: 'verify', kinds: ['proposal'] }],
      },
      steps: [
        {
          id: 'start', label: 'start', gate: null, inputs: [], outputs: [], guards: [], skills: [],
          transitions: [{ event: 'shape', to: 'shape' }],
        },
        {
          id: 'shape', label: 'shape', gate: null, inputs: [], outputs: [], guards: [],
          skills: [{ id: 'writer' }],
          transitions: [{ event: 'shaped', to: 'verify' }],
        },
        {
          id: 'verify', label: 'verify', gate: null, inputs: [], outputs: [], guards: [], skills: [],
          transitions: [
            { event: 'revise', to: 'shape' },
            { event: 'done', to: 'done' },
          ],
        },
        {
          id: 'done', label: 'done', gate: null, inputs: [], outputs: [], guards: [], skills: [],
          transitions: [],
        },
      ],
    })

    expect(validateDocumentContract(looped)).toEqual([])
  })

  it('E3：document_contract 需要分支的 spec 为 openspec', () => {
    const contract = { version: 'v1' as const, slots: [{ kind: 'proposal', ownerStep: 's1', producers: ['writer'] }], reads: [] }
    const step = { id: 's1', label: 'a', gate: null, skills: [{ id: 'writer' }], inputs: [], outputs: [], guards: [], transitions: [] }
    expect(validateDocumentContract(wf({ documentContract: contract, steps: [step] }))).toContain(NEEDS_OPENSPEC)
    expect(validateDocumentContract(wf({ openspec: true, documentContract: contract, steps: [step] }))).toEqual([])
  })

  it('E8-E13：角色、顺序与读取规则逐条报错', () => {
    const ids = ['shape', 'build', 'verify']
    const steps = ids.map((id, index) => ({
      id, label: id, gate: null, inputs: [], outputs: [], guards: [], skills: [{ id: 'writer' }],
      transitions: index + 1 < ids.length ? [{ event: `${id}-done`, to: ids[index + 1] ?? '' }] : [],
    }))
    const errorsOf = (slots: WorkflowDocumentSlot[], reads: WorkflowDocumentRead[] = []): string[] => [...validateDocumentContract(wf({
      openspec: true,
      documentContract: { version: 'v1', slots, reads },
      steps,
    }))]
    expect(errorsOf([
      { kind: 'tasks', ownerStep: 'shape', producers: ['writer'] },
      { kind: 'tasks', ownerStep: 'build', role: 'update', producers: ['writer'] },
      { kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] },
      { kind: 'design-md', ownerStep: 'verify', role: 'update', producers: ['writer'] },
    ], [{ step: 'verify', kinds: ['tasks'] }])).toEqual([])
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', producers: [] }]))
      .toContain("document_contract document 'tasks' 的 producers 不得为空")
    expect(errorsOf([{ kind: 'design-md', ownerStep: 'shape', role: 'require', producers: ['writer'] }]))
      .toContain("document_contract document 'design-md' 的 role require 不声明 producers")
    expect(errorsOf([{ kind: 'readme', ownerStep: 'shape', producers: ['writer'] }]))
      .toContain("document_contract.slots[0].kind 'readme' 不受支持")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', producers: ['writer'] }, { kind: 'tasks', ownerStep: 'build', producers: ['writer'] }]))
      .toContain("document_contract document 'tasks' 只能有一个 produce")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', producers: ['writer'] }, { kind: 'tasks', ownerStep: 'shape', role: 'update', producers: ['writer'] }]))
      .toContain("document_contract document 'tasks' 在 step 'shape' 重复声明")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'ship', producers: ['writer'] }]))
      .toContain("document_contract document 'tasks' 的 owner_step 'ship' 不存在")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', producers: ['other'] }]))
      .toContain("document_contract document 'tasks' 的 producer 'other' 未在 owner_step 'shape' 声明")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'build', role: 'update', producers: ['writer'] }]))
      .toContain("document_contract document 'tasks' 的 update 需要更早的 produce")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', role: 'require', producers: [] }, { kind: 'tasks', ownerStep: 'build', producers: ['writer'] }]))
      .toContain("document_contract document 'tasks' 的 require 需要更早的 produce")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'build', producers: ['writer'] }], [{ step: 'shape', kinds: ['tasks'] }]))
      .toContain("document_contract step 'shape' 读取了未声明的 document 'tasks'")
    expect(errorsOf([{ kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] }], [{ step: 'verify', kinds: ['design-md'] }]))
      .toContain("document_contract step 'verify' 读取了未声明的 document 'design-md'，项目文档用 role: require")
  })

  it('default origin 不要求 producer 在阶段技能里（manifest 叠加）', () => {
    const def = wf({
      openspec: true,
      documentContract: { version: 'v1', slots: [{ kind: 'tasks', ownerStep: 's1', producers: ['openspec-propose'] }], reads: [] },
      steps: [{ id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    expect(validateDocumentContract(def).some((error) => error.includes("producer 'openspec-propose'"))).toBe(true)
    expect(validateDocumentContract(def, { origin: 'default' })).toEqual([])
  })
})

const REMOVED_KEY_FRAGMENTS = {
  document_contract: 'document_contract 已删除',
  inputs: 'inputs 已删除',
  outputs: 'outputs 已删除',
  artifacts: 'artifacts 已删除',
  'nonempty-output': 'nonempty-output 依赖已删除的 outputs',
} as const

describe('validateWorkflow · 已删除的旧键', () => {
  const contract = { version: 'v1' as const, slots: [{ kind: 'proposal', ownerStep: 'explore', producers: ['writer'] }], reads: [] }

  /** 每个旧键各造一份只带它的最小定义。 */
  const definitionWith = (key: keyof typeof REMOVED_KEY_FRAGMENTS): WorkflowDef => {
    const step = (over: Partial<StepDef>): StepDef => ({ ...bare('explore'), skills: [{ id: 'writer' }], ...over })
    switch (key) {
      case 'document_contract': return wf({ openspec: true, documentContract: contract, steps: [step({})] })
      case 'inputs': return wf({ steps: [step({ inputs: [{ field: 'design_doc', type: 'file_path' }] })] })
      case 'outputs': return wf({ steps: [step({ outputs: [{ field: 'design_doc', type: 'file_path' }] })] })
      case 'artifacts':
        return wf({
          steps: [step({
            outputs: [{ field: 'design_doc', type: 'file_path' }],
            artifacts: [{ field: 'design_doc', type: 'file_path', producerPolicy: 'effective-step-skills' }],
          })],
        })
      case 'nonempty-output': return wf({ steps: [step({ guards: [{ type: 'nonempty-output' }] })] })
    }
  }

  it.each(Object.entries(REMOVED_KEY_FRAGMENTS))('新定义拒绝 %s，文案含「%s」', (key, fragment) => {
    const errors = validateWorkflow(definitionWith(key as keyof typeof REMOVED_KEY_FRAGMENTS))
    expect(errors).toContainEqual(expect.stringContaining(fragment))
    expect(errors.filter((error) => error.includes(fragment))).toHaveLength(1)
  })

  it('报错点名步骤并给出替代写法', () => {
    expect(validateWorkflow(definitionWith('document_contract')).join('\n'))
      .toContain('需要门禁时写 { type: required-output, path: <路径> }')
    expect(validateWorkflow(definitionWith('outputs')))
      .toContainEqual("steps.explore.outputs 已删除：字段门禁写 field-nonempty / field-equals，文档门禁写 required-output")
    expect(validateWorkflow(definitionWith('inputs')).join('\n')).toContain('steps.explore.inputs 已删除')
    expect(validateWorkflow(definitionWith('artifacts')).join('\n')).toContain('steps.explore.artifacts 已删除')
    expect(validateWorkflow(definitionWith('nonempty-output')).join('\n'))
      .toContain('steps.explore.guards 里的 nonempty-output 依赖已删除的 outputs：改用 field-nonempty 或 required-output')
  })

  it('边上的 nonempty-output 同样被拒，并点名边', () => {
    const errors = validateWorkflow(wf({
      steps: [
        { ...bare('explore', 'done'), transitions: [{ event: 'go', to: 'done', guards: [{ type: 'nonempty-output' }] }] },
        bare('done'),
      ],
    }))
    expect(errors).toEqual([expect.stringContaining('steps.explore.transitions[0].guards 里的 nonempty-output 依赖已删除的 outputs')])
  })

  it('有 tracks 时：顶层契约被拒；分支契约、分支步骤的旧键带 tracks.<id> 前缀', () => {
    const step = { ...bare('explore'), outputs: [{ field: 'design_doc', type: 'file_path' as const }] }
    const errors = validateWorkflow(wf({
      openspec: true, documentContract: contract,
      tracks: { web: { documentContract: contract, steps: [step] }, api: { steps: [bare('explore')] } },
    }))
    expect(errors).toEqual([
      expect.stringContaining('document_contract 已删除'),
      expect.stringMatching(/^tracks\.web: document_contract 已删除/u),
      expect.stringMatching(/^tracks\.web: steps\.explore\.outputs 已删除/u),
    ])
  })

  it('分支声明 spec: none 或 spec: openspec 都不改变：契约一律被拒，且只报一条', () => {
    for (const spec of ['none', 'openspec'] as const) {
      expect(validateWorkflow(wf({ tracks: { web: { spec, documentContract: contract, steps: [bare('explore')] } } })))
        .toEqual([expect.stringMatching(/^tracks\.web: document_contract 已删除/u)])
    }
  })

  it('空列表 inputs: [] / outputs: [] / artifacts: [] 照收（Dashboard 以前保存的文件都带它们）', () => {
    expect(validateWorkflow(wf({ steps: [{ ...bare('explore', 'done'), artifacts: [] }, bare('done')] }))).toEqual([])
  })

  it('YAML 里只写了空列表的旧文件解析后通过，非空的被拒', () => {
    const yaml = (extra: string): string => [
      'name: legacy', 'steps:', '  - id: explore', '    label: 调研', '    gate: null', '    skills: []',
      '    inputs: []', '    outputs: []', '    artifacts: []', ...(extra === '' ? [] : [extra]), '    guards: []', '    transitions: []',
    ].join('\n')
    expect(validateWorkflow(parseWorkflow(yaml('')))).toEqual([])
    expect(validateWorkflow(parseWorkflow(yaml('').replace('outputs: []', 'outputs:\n      - field: design_doc\n        type: file_path'))))
      .toEqual([expect.stringContaining('steps.explore.outputs 已删除')])
  })

  it('required-output 守卫通过校验；非法模式在校验里被编译层拒绝并点名步骤', () => {
    const withGuard = (path: string): WorkflowDef => wf({
      steps: [{ ...bare('explore'), guards: [{ type: 'required-output', path }] }],
    })
    expect(validateWorkflow(withGuard('docs/superpowers/specs/*.md'))).toEqual([])
    for (const path of ['', '/abs/x.md', '../x.md', 'docs\\x.md', 'docs/{nope}/x.md']) {
      expect(validateWorkflow(withGuard(path)), path).toEqual([expect.stringMatching(/steps\[0\]\.guards\[0\]\.path.*step 'explore'/u)])
    }
  })
})

describe('validateWorkflow', () => {
  it('skill 依赖成环 → 报错', () => {
    const result = validateWorkflow(wf({
      steps: [{
        id: 's1', label: 'x', gate: null, inputs: [], outputs: [], guards: [], transitions: [],
        skills: [
          { id: 'a', depends_on: ['b'] },
          { id: 'b', depends_on: ['a'] },
        ],
      }],
    }))
    expect(result.some((e) => e.includes('循环依赖'))).toBe(true)
  })

  it('命名空间 skill id（superpowers:brainstorming）通过校验（Bug1：validate 与 parse 对齐，可 gate 插件 skill）', () => {
    const result = validateWorkflow(wf({
      steps: [{
        id: 's1', label: 'x', gate: null, inputs: [], outputs: [], guards: [], transitions: [],
        skills: [
          { id: 'superpowers:brainstorming' },
          { id: 'commit-commands:commit', depends_on: ['superpowers:brainstorming'] },
        ],
      }],
    }))
    expect(result.filter((e) => e.includes('含非法字符'))).toEqual([]) // 冒号命名空间不再被拒
  })

  it('非法 skill id（含空格/前导冒号）仍被拒（命名空间放宽不等于放任）', () => {
    const bad = validateWorkflow(wf({
      steps: [{
        id: 's1', label: 'x', gate: null, inputs: [], outputs: [], guards: [], transitions: [],
        skills: [{ id: 'has space' }],
      }],
    }))
    expect(bad.some((e) => e.includes('含非法字符'))).toBe(true)
    const lead = validateWorkflow(wf({
      steps: [{
        id: 's2', label: 'y', gate: null, inputs: [], outputs: [], guards: [], transitions: [],
        skills: [{ id: ':leading' }],
      }],
    }))
    expect(lead.some((e) => e.includes('含非法字符'))).toBe(true)
  })

  it('depends_on 引用跨 step 不存在的 skill id → 报错', () => {
    const result = validateWorkflow(wf({
      steps: [{
        id: 's1', label: 'x', gate: null, inputs: [], outputs: [], guards: [], transitions: [],
        skills: [{ id: 'a', depends_on: ['does-not-exist'] }],
      }],
    }))
    expect(result.some((e) => e.includes('does-not-exist'))).toBe(true)
  })

  it('transitions 的 to 引用不存在的 step id → 报错', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'complete', to: 'does-not-exist' }] },
      ],
    }))
    expect(result.some((e) => e.includes("'does-not-exist'") && e.includes('不存在'))).toBe(true)
  })

  it('允许多个显式终态，但拒绝从首 step 不可达的节点', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        { id: 's2', label: 'b', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result.some((e) => e.includes("step 's2'") && e.includes('不可达'))).toBe(true)
  })

  // G16：serialize 写出 / parse 用 (\S+) 读回的每一类标识符都必须锁 ^[a-zA-Z0-9_-]+$（与
  // dashboard 客户端、server 路由层同一规则）——否则绕过浏览器直调已鉴权 HTTP 可写入
  // 「保存成功、下次 loadWorkflow 打不开」的坏文件，validateWorkflow 是唯一的服务端后盾。
  it('G16：transition event 名含空格 → 报错', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'bad event', to: 's2' }] },
        { id: 's2', label: 'b', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result.some((e) => e.includes("'bad event'") && e.includes('非法字符'))).toBe(true)
  })

  it('G16：step id 含空格 → 报错（同一往返破坏向量，一并锁死）', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 'bad id', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result.some((e) => e.includes("'bad id'") && e.includes('非法字符'))).toBe(true)
  })

  it('G16：skill id 含空格 → 报错', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [{ id: 'bad skill' }], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result.some((e) => e.includes("'bad skill'") && e.includes('非法字符'))).toBe(true)
  })

  it('G16：workflow name 含空格 → 报错（POST body 的 name 不必等于路由 name，serialize 第一行原样写它）', () => {
    const result = validateWorkflow(wf({
      name: 'bad name',
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result.some((e) => e.includes("'bad name'") && e.includes('非法字符'))).toBe(true)
  })

  it('workflow 名称允许中文，但路径符号与点仍被拒绝', () => {
    expect(validateWorkflow(wf({ name: '发布验收流程' })).filter((e) => e.includes('workflow name'))).toEqual([])
    for (const name of ['发布/验收', '发布.验收', '发布 验收']) {
      expect(validateWorkflow(wf({ name })).some((e) => e.includes('workflow name') && e.includes('非法字符'))).toBe(true)
    }
  })

  it('合法 workflow（含分支 transitions）→ 空数组', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'complete', to: 's2' }] },
        { id: 's2', label: 'b', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'pass', to: 's3' }, { event: 'fail', to: 's1' }] },
        { id: 's3', label: 'c', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result).toEqual([])
  })

  // ── G2 P2：validateWorkflow 复用 compileWorkflow 深校验新 guard/action 变体（loadWorkflow /
  //    server 保存两个入口共用同一 validateWorkflow，故两处都被这层拒） ──
  it('G2 P2：scalar guard 挂列表字段（field-nonempty on scope）→ 经 compile 深校验拒绝', () => {
    const result = validateWorkflow(wf({
      steps: [{
        id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [],
        guards: [{ type: 'field-nonempty', field: 'scope' }], transitions: [],
      }],
    }))
    expect(result.some((e) => e.includes('scope') && e.includes('列表字段'))).toBe(true)
  })

  it('G2 P2：非法 edge action type → 经 compile 深校验拒绝', () => {
    const result = validateWorkflow(wf({
      steps: [
        {
          id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [],
          transitions: [{ event: 'e', to: 's2', actions: [{ type: 'nuke' } as unknown as WorkflowActionConfig] }],
        },
        { id: 's2', label: 'b', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result.some((e) => e.includes('nuke') && e.includes('action'))).toBe(true)
  })

  it('阻断 3：结构化 guard 附加顶层键（nonempty-output 带 n）经 compile 深校验拒（server 直调 validateWorkflow→serialize 落盘路径，不被 serialize 静默吞）', () => {
    const result = validateWorkflow(wf({
      steps: [{
        id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [],
        guards: [{ type: 'nonempty-output', n: 2 } as unknown as WorkflowDef['steps'][number]['guards'][number]], transitions: [],
      }],
    }))
    expect(result.some((e) => e.includes('附加键') && e.includes('n'))).toBe(true)
  })

  it('阻断 3：结构化 guard 嵌套 when 附加键 → 经 compile 深校验拒', () => {
    const result = validateWorkflow(wf({
      steps: [{
        id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [],
        guards: [{ type: 'full-direct-override', when: { kind: 'track-in', values: ['pm'], extra: 1 } } as unknown as WorkflowDef['steps'][number]['guards'][number]],
        transitions: [],
      }],
    }))
    expect(result.some((e) => e.includes('when') && e.includes('附加键'))).toBe(true)
  })

  it('G2 P2：含新变体 + when + edge guards/actions 的合法 workflow → 空数组（不误拒）', () => {
    const result = validateWorkflow(wf({
      steps: [
        {
          id: 'verify', label: 'v', gate: 'review', skills: [], inputs: [], outputs: [],
          guards: [{ type: 'field-equals', field: 'branch_status', value: 'handled', when: { kind: 'track-not-in', values: ['pm'] } }],
          transitions: [{
            event: 'pass', to: 'done',
            guards: [{ type: 'field-in', field: 'isolation', values: ['branch', 'worktree'] }],
            actions: [{ type: 'mark-verification-passed' }],
          }],
        },
        { id: 'done', label: 'd', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result).toEqual([])
  })

  // ── G2 P5 · A 契约：validateWorkflow 经 compileWorkflow(custom 契约) 深校验，故 custom workflow
  //    声明 effective-phase-skills 在保存/加载入口即被拒（loadWorkflow 据此 fail-loud）──
  it('G2 P5 · A 契约：custom workflow 显式 effective-phase-skills artifact → 校验拒（fail-loud）', () => {
    const result = validateWorkflow(wf({
      steps: [{
        id: 's1', label: 'a', gate: null, skills: [], inputs: [],
        outputs: [{ field: 'design_doc', type: 'file_path' }],
        artifacts: [{ field: 'design_doc', type: 'file_path', producerPolicy: 'effective-phase-skills' }],
        guards: [], transitions: [],
      }],
    }))
    expect(result.some((e) => e.includes('producerPolicy') && e.includes('effective-phase-skills'))).toBe(true)
  })
})

describe('分支 spec · 存储校验', () => {
  const storedDefault = (steps: StepDef[]): WorkflowDef => ({ name: 'default', openspec: true, steps: [], tracks: { custom: { steps } } })

  // 内建 default 在模板改写（rework-document-mechanism Task 4）之前仍带已被拒绝的旧键；先剥掉它们再测「非七步分支可存」
  // 这件事本身，模板改写之后这一步是空操作。
  const withoutRemovedKeys = (def: WorkflowDef): WorkflowDef => {
    const stripStep = (step: StepDef): StepDef => {
      const { artifacts: _artifacts, ...rest } = step
      return { ...rest, inputs: [], outputs: [] }
    }
    const { documentContract: _contract, tracks, ...top } = def
    return {
      ...top,
      steps: top.steps.map(stripStep),
      ...(tracks === undefined ? {} : {
        tracks: Object.fromEntries(Object.entries(tracks).map(([id, branch]) => {
          const { documentContract: _branchContract, ...rest } = branch
          return [id, { ...rest, steps: branch.steps.map(stripStep) }]
        })),
      }),
    }
  }

  it('default 的非七步分支通过存储校验', () => {
    expect(validateWorkflowForStorage('default', withoutRemovedKeys(defaultWithLiteBranch()))).toEqual([])
  })

  it('分支声明 document_contract 一律被拒（spec: none、spec: openspec、继承顶层 openspec 都一样），每种只报这一条', () => {
    const rejected = [expect.stringMatching(/^tracks\.main: document_contract 已删除/u)]
    expect(validateWorkflowForStorage('demo', branchWith({ spec: 'none', documentContract: anyContract() }))).toEqual(rejected)
    expect(validateWorkflowForStorage('demo', { ...branchWith({ spec: 'none', documentContract: anyContract() }), openspec: true }))
      .toEqual(rejected)
    expect(validateWorkflowForStorage('demo', branchWith({ spec: 'openspec', documentContract: anyContract() }))).toEqual(rejected)
    expect(validateWorkflowForStorage('demo', { ...branchWith({ documentContract: anyContract() }), openspec: true })).toEqual(rejected)
  })

  it('default 的 spec: openspec 分支只要求 spec 与 ship 步骤，不再要求恰好七步', () => {
    expect(validateWorkflowForStorage('default', storedDefault([bare('spec', 'ship'), bare('ship')]))).toEqual([])
    expect(validateWorkflowForStorage('default', storedDefault([bare('spec', 'done'), bare('done')])))
      .toEqual(["tracks.custom: default 的 spec: openspec 分支必须包含 'ship' 步骤"])
    expect(validateWorkflowForStorage('default', storedDefault([bare('ship', 'done'), bare('done')])))
      .toEqual(["tracks.custom: default 的 spec: openspec 分支必须包含 'spec' 步骤"])
  })

  it('default 的 spec: none 分支不要求 spec / ship；非 default 工作流不受这条约束', () => {
    const lite: WorkflowDef = { name: 'default', openspec: true, steps: [], tracks: { lite: { spec: 'none', steps: [bare('open', 'done'), bare('done')] } } }
    expect(validateWorkflowForStorage('default', lite)).toEqual([])
    expect(validateWorkflowForStorage('demo', { ...storedDefault([bare('open', 'done'), bare('done')]), name: 'demo' })).toEqual([])
  })

  it('平铺的 default 仍须 openspec: true，并按隐式分支要求 spec / ship', () => {
    expect(validateWorkflowForStorage('default', { name: 'default', steps: [bare('open')] })).toEqual(['default 必须保持 openspec: true'])
    expect(validateWorkflowForStorage('default', { name: 'default', openspec: true, steps: [bare('open')] }))
      .toEqual(["default 的 spec: openspec 分支必须包含 'spec' 步骤", "default 的 spec: openspec 分支必须包含 'ship' 步骤"])
  })

  it('分支 route / automation 越界在存储校验里以编译错误报出', () => {
    const errors = validateWorkflowForStorage('demo', branchWith({ route: { keywords: [], exclude: [], priority: -1, fallback: false } }))
    expect(errors).toContainEqual(expect.stringMatching(/tracks\.main\.route\.priority/))
  })
})

describe('workflowBranches · 分支视图', () => {
  it('平铺工作流只有一个隐式分支，spec 取顶层 openspec', () => {
    expect(workflowBranches(wf({ steps: [bare('a')] }))).toMatchObject([{ track: '', implicit: true, spec: 'none' }])
    expect(workflowBranches(wf({ openspec: true, steps: [bare('a')] }))).toMatchObject([{ track: '', implicit: true, spec: 'openspec' }])
  })

  it('有 tracks 时各分支 spec 继承顶层 openspec，显式 spec 优先', () => {
    const def = wf({
      openspec: true,
      tracks: { inherit: { steps: [bare('a')] }, off: { spec: 'none', steps: [bare('a')] } },
    })
    expect(workflowBranches(def).map((b) => [b.track, b.implicit, b.spec])).toEqual([['inherit', false, 'openspec'], ['off', false, 'none']])
    const bare2 = wf({ tracks: { on: { spec: 'openspec', steps: [bare('a')] }, plain: { steps: [bare('a')] } } })
    expect(workflowBranches(bare2).map((b) => [b.track, b.spec])).toEqual([['on', 'openspec'], ['plain', 'none']])
  })

  it('编译后的 IR 同样给出分支视图：平铺只有隐式分支，有 tracks 时折算 spec', () => {
    expect(workflowBranches(compileWorkflow(wf({ steps: [bare('a')] }))).map((b) => [b.track, b.implicit, b.spec])).toEqual([['', true, 'none']])
    const ir = compileWorkflow(wf({
      openspec: true,
      tracks: { full: { steps: [bare('a')] }, lite: { spec: 'none', steps: [bare('a')] } },
    }))
    expect(workflowBranches(ir).map((b) => [b.track, b.implicit, b.spec])).toEqual([['full', false, 'openspec'], ['lite', false, 'none']])
  })

  it('route 与 automation 原样随分支带出', () => {
    const route = { keywords: ['a'], exclude: [], priority: 1, fallback: false }
    const automation = { eligible: true, enqueueAfterSpec: false }
    const [branch] = workflowBranches(wf({ tracks: { x: { route, automation, steps: [bare('a')] } } }))
    expect(branch?.route).toEqual(route)
    expect(branch?.automation).toEqual(automation)
  })

  it('selectTrackBranch 提升的定义按分支 spec 取 openspec；无新键的分支行为不变', () => {
    const def = wf({ openspec: true, tracks: { lite: { spec: 'none', steps: [bare('a')] }, full: { steps: [bare('a')] } } })
    expect(selectTrackBranch(def, 'lite').openspec).toBeUndefined()
    expect(selectTrackBranch(def, 'full').openspec).toBe(true)
    const viaBranch = wf({ tracks: { on: { spec: 'openspec', steps: [bare('a')] }, plain: { steps: [bare('a')] } } })
    expect(selectTrackBranch(viaBranch, 'on').openspec).toBe(true)
    expect(selectTrackBranch(viaBranch, 'plain').openspec).toBeUndefined()
  })
})
