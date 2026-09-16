import { describe, expect, it } from 'vitest'
import { validateWorkflow } from './validate.js'
import type { WorkflowActionConfig, WorkflowDef, WorkflowDocumentRead, WorkflowDocumentSlot } from './types.js'

function wf(overrides: Partial<WorkflowDef>): WorkflowDef {
  return { name: 'test', steps: [], ...overrides }
}

describe('validateWorkflow', () => {
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
    expect(validateWorkflow(compact)).toEqual([])
    expect(validateWorkflow({
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

    expect(validateWorkflow(branched)).toContain(
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

    expect(validateWorkflow(looped)).toEqual([])
  })

  it('E3/E4：document_contract 需要 openspec: true；有 tracks 时顶层契约被拒', () => {
    const contract = { version: 'v1' as const, slots: [{ kind: 'proposal', ownerStep: 's1', producers: ['writer'] }], reads: [] }
    const step = { id: 's1', label: 'a', gate: null, skills: [{ id: 'writer' }], inputs: [], outputs: [], guards: [], transitions: [] }
    expect(validateWorkflow(wf({ documentContract: contract, steps: [step] }))).toContain('document_contract 需要 openspec: true')
    expect(validateWorkflow(wf({ openspec: true, documentContract: contract, steps: [step] }))).toEqual([])
    expect(validateWorkflow(wf({ openspec: true, documentContract: contract, tracks: { web: { steps: [step] } } })))
      .toContain('有 tracks 时 document_contract 写在 tracks.<id> 下')
    expect(validateWorkflow(wf({ tracks: { web: { documentContract: contract, steps: [step] } } })))
      .toContain('tracks.web: document_contract 需要 openspec: true')
  })

  it('E8-E13：角色、顺序与读取规则逐条报错，分支错误带 tracks.<id> 前缀', () => {
    const ids = ['shape', 'build', 'verify']
    const steps = ids.map((id, index) => ({
      id, label: id, gate: null, inputs: [], outputs: [], guards: [], skills: [{ id: 'writer' }],
      transitions: index + 1 < ids.length ? [{ event: `${id}-done`, to: ids[index + 1] ?? '' }] : [],
    }))
    const errorsOf = (slots: WorkflowDocumentSlot[], reads: WorkflowDocumentRead[] = []): string[] => validateWorkflow(wf({
      openspec: true,
      tracks: { web: { documentContract: { version: 'v1', slots, reads }, steps } },
    }))
    expect(errorsOf([
      { kind: 'tasks', ownerStep: 'shape', producers: ['writer'] },
      { kind: 'tasks', ownerStep: 'build', role: 'update', producers: ['writer'] },
      { kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] },
      { kind: 'design-md', ownerStep: 'verify', role: 'update', producers: ['writer'] },
    ], [{ step: 'verify', kinds: ['tasks'] }])).toEqual([])
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', producers: [] }]))
      .toContain("tracks.web: document_contract document 'tasks' 的 producers 不得为空")
    expect(errorsOf([{ kind: 'design-md', ownerStep: 'shape', role: 'require', producers: ['writer'] }]))
      .toContain("tracks.web: document_contract document 'design-md' 的 role require 不声明 producers")
    expect(errorsOf([{ kind: 'readme', ownerStep: 'shape', producers: ['writer'] }]))
      .toContain("tracks.web: document_contract.slots[0].kind 'readme' 不受支持")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', producers: ['writer'] }, { kind: 'tasks', ownerStep: 'build', producers: ['writer'] }]))
      .toContain("tracks.web: document_contract document 'tasks' 只能有一个 produce")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', producers: ['writer'] }, { kind: 'tasks', ownerStep: 'shape', role: 'update', producers: ['writer'] }]))
      .toContain("tracks.web: document_contract document 'tasks' 在 step 'shape' 重复声明")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'ship', producers: ['writer'] }]))
      .toContain("tracks.web: document_contract document 'tasks' 的 owner_step 'ship' 不存在")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', producers: ['other'] }]))
      .toContain("tracks.web: document_contract document 'tasks' 的 producer 'other' 未在 owner_step 'shape' 声明")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'build', role: 'update', producers: ['writer'] }]))
      .toContain("tracks.web: document_contract document 'tasks' 的 update 需要更早的 produce")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'shape', role: 'require', producers: [] }, { kind: 'tasks', ownerStep: 'build', producers: ['writer'] }]))
      .toContain("tracks.web: document_contract document 'tasks' 的 require 需要更早的 produce")
    expect(errorsOf([{ kind: 'tasks', ownerStep: 'build', producers: ['writer'] }], [{ step: 'shape', kinds: ['tasks'] }]))
      .toContain("tracks.web: document_contract step 'shape' 读取了未声明的 document 'tasks'")
    expect(errorsOf([{ kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] }], [{ step: 'verify', kinds: ['design-md'] }]))
      .toContain("tracks.web: document_contract step 'verify' 读取了未声明的 document 'design-md'，项目文档用 role: require")
  })

  it('default origin 不要求 producer 在阶段技能里（manifest 叠加）', () => {
    const def = wf({
      openspec: true,
      documentContract: { version: 'v1', slots: [{ kind: 'tasks', ownerStep: 's1', producers: ['openspec-propose'] }], reads: [] },
      steps: [{ id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    expect(validateWorkflow(def).some((error) => error.includes("producer 'openspec-propose'"))).toBe(true)
    expect(validateWorkflow(def, { origin: 'default' })).toEqual([])
  })

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

  it('inputs 引用的字段不是任何更早 step 的 outputs → 报错', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'complete', to: 's2' }] },
        { id: 's2', label: 'b', gate: null, skills: [], inputs: [{ field: 'design_doc', type: 'file_path' }], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result.some((e) => e.includes('design_doc'))).toBe(true)
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

  it('G16：inputs/outputs field 名含空格 → 报错', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [{ field: 'bad field', type: 'string' }], guards: [], transitions: [] },
      ],
    }))
    expect(result.some((e) => e.includes("'bad field'") && e.includes('非法字符'))).toBe(true)
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
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [{ field: 'design_doc', type: 'file_path' }], guards: [], transitions: [{ event: 'complete', to: 's2' }] },
        { id: 's2', label: 'b', gate: null, skills: [], inputs: [{ field: 'design_doc', type: 'file_path' }], outputs: [], guards: [], transitions: [{ event: 'pass', to: 's3' }, { event: 'fail', to: 's1' }] },
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

  it('G2 P2 兼容回退：含未知惰性 output（custom_doc，type string，无 guard）+ 后序同名 input → 空数组（能 load；pre-P2 合法行为恢复）', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [{ field: 'custom_doc', type: 'string' }], guards: [], transitions: [{ event: 'go', to: 's2' }] },
        { id: 's2', label: 'b', gate: null, skills: [], inputs: [{ field: 'custom_doc', type: 'string' }], outputs: [], guards: [], transitions: [] },
      ],
    }))
    expect(result).toEqual([])
  })

  it('G2 P2 兼容回退：nonempty-output 指未知惰性 output → validate 不因 compile 深校验而误拒（下沉 output-present，非 load 报错）', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [{ field: 'custom_doc', type: 'string' }], guards: [{ type: 'nonempty-output' }], transitions: [] },
      ],
    }))
    expect(result).toEqual([])
  })

  it('阻断 1：未知 file_path output（custom_report，无显式 artifact）→ 空数组（能 load；不再因 artifact 派生规则误拒）', () => {
    const result = validateWorkflow(wf({
      steps: [
        { id: 's1', label: 'a', gate: null, skills: [], inputs: [], outputs: [{ field: 'custom_report', type: 'file_path' }], guards: [], transitions: [] },
      ],
    }))
    expect(result).toEqual([])
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

  it('G2 P5 · A 契约：custom workflow 显式 effective-step-skills artifact → 不误拒（空数组）', () => {
    const result = validateWorkflow(wf({
      steps: [{
        id: 's1', label: 'a', gate: null, skills: [], inputs: [],
        outputs: [{ field: 'design_doc', type: 'file_path' }],
        artifacts: [{ field: 'design_doc', type: 'file_path', producerPolicy: 'effective-step-skills' }],
        guards: [], transitions: [],
      }],
    }))
    expect(result).toEqual([])
  })
})
