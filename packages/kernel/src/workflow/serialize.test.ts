import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import type { WorkflowDef } from './types.js'

const MINIMAL: WorkflowDef = {
  name: 'onboarding',
  steps: [
    {
      id: 'intake', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [],
      transitions: [{ event: 'complete', to: 'done' }],
    },
    { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ],
}

const RICH: WorkflowDef = {
  name: 'rich',
  steps: [
    {
      id: 's1', label: '第一步', gate: 'review',
      skills: [
        { id: 'a' },
        { id: 'b' },
        { id: 'c', depends_on: ['a', 'b'] },
      ],
      inputs: [],
      outputs: [{ field: 'design_doc', type: 'file_path' }],
      guards: [{ type: 'tasks-at-least', n: 3 }, { type: 'nonempty-output' }],
      transitions: [
        { event: 'pass', to: 's2' },
        { event: 'fail', to: 's1' },
      ],
    },
    {
      id: 's2', label: '', gate: null, skills: [], inputs: [{ field: 'design_doc', type: 'file_path' }],
      outputs: [], guards: [], transitions: [],
    },
  ],
}

describe('serializeWorkflow —— parse 的反向操作，往返等价是唯一正确性判据', () => {
  it('Step 多行 prompt 经 literal block serialize→parse 逐字往返', () => {
    const prompt = 'Implement the selected slice.\n\nRespect `$HOME`, #hash and "quotes".'
    const wf: WorkflowDef = {
      name: 'prompted',
      steps: [{
        id: 'build', label: '构建', gate: null, prompt,
        skills: [], inputs: [], outputs: [], guards: [], transitions: [],
      }],
    }
    const yaml = serializeWorkflow(wf)
    expect(yaml).toContain('    prompt: |-\n      Implement the selected slice.\n      \n      Respect `$HOME`, #hash and "quotes".')
    expect(parseWorkflow(yaml)).toEqual(wf)
  })

  it('openspec + 顶层文档契约：字节稳定往返；produce 不写 role，require 不写 producers；openspec 只在 true 时写', () => {
    const yaml = [
      'name: governed',
      'openspec: true',
      'document_contract:',
      '  version: v1',
      '  slots:',
      '    - kind: tasks',
      '      owner_step: intake',
      '      producers: [openspec-propose]',
      '    - kind: tasks',
      '      owner_step: done',
      '      role: update',
      '      producers: [openspec-propose]',
      '    - kind: design-md',
      '      owner_step: done',
      '      role: require',
      '  reads:',
      '    - step: done',
      '      kinds: [tasks]',
      'steps:',
      ...serializeWorkflow(MINIMAL).split('\n').slice(2),
    ].join('\n')
    const parsed = parseWorkflow(yaml)
    expect(serializeWorkflow(parsed)).toBe(yaml)
    expect(serializeWorkflow({ ...MINIMAL, openspec: false })).not.toContain('openspec')
  })

  it('分支文档契约写在 label 与 steps 之间，字节稳定往返', () => {
    const branchSteps = serializeWorkflow(MINIMAL).split('\n').slice(2).map((line) => (line === '' ? line : `    ${line}`))
    const yaml = [
      'name: branched',
      'openspec: true',
      'tracks:',
      '  web:',
      '    label: 前端',
      '    document_contract:',
      '      version: v1',
      '      slots:',
      '        - kind: proposal',
      '          owner_step: intake',
      '          producers: [openspec-propose]',
      '      reads: []',
      '    steps:',
      ...branchSteps,
    ].join('\n')
    expect(serializeWorkflow(parseWorkflow(yaml))).toBe(yaml)
  })

  it('MINIMAL：serialize→parse 深度等于原始 WorkflowDef', () => {
    const round = parseWorkflow(serializeWorkflow(MINIMAL))
    expect(round).toEqual(MINIMAL)
  })

  it('RICH（多 skill+depends_on+多 guard+多 transition+非空 label/gate/inputs/outputs）：往返等价', () => {
    const round = parseWorkflow(serializeWorkflow(RICH))
    expect(round).toEqual(RICH)
  })

  it('真文件写入 + 真 loadWorkflow 风格读回（真 fs，非纯内存往返）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'serialize-wf-'))
    const p = join(dir, 'rich.yaml')
    await writeFile(p, serializeWorkflow(RICH), 'utf8')
    const content = await readFile(p, 'utf8')
    expect(parseWorkflow(content)).toEqual(RICH)
  })

  it('真实 templates/workflows/default.yaml 解析后再 serialize 再 parse：三重往返仍等价（覆盖真实生产 fixture 形状，不只是手写测试夹具）', async () => {
    const { dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = dirname(dirname(dirname(dirname(__dirname))))
    const defaultYamlPath = join(repoRoot, 'templates', 'workflows', 'default.yaml')
    const original = parseWorkflow(await readFile(defaultYamlPath, 'utf8'))
    const roundTripped = parseWorkflow(serializeWorkflow(original))
    expect(roundTripped).toEqual(original)
  })

  it('skill.depends_on 存在但为空数组（[]）与缺省（undefined）是两种合法且不同的状态：往返必须保留 depends_on: []，不能被静默丢弃', () => {
    const wf: WorkflowDef = {
      name: 'depends-on-empty',
      steps: [
        {
          id: 's1', label: '', gate: null,
          skills: [
            { id: 'a' },
            { id: 'b', depends_on: [] },
          ],
          inputs: [], outputs: [], guards: [], transitions: [],
        },
      ],
    }
    const round = parseWorkflow(serializeWorkflow(wf))
    expect(round).toEqual(wf)
    expect(round.steps[0]!.skills[1]!.depends_on).toEqual([])
    expect(round.steps[0]!.skills[0]!.depends_on).toBeUndefined()
  })

  // ── G2 P2：新 8 guard 变体 + when + edge guards/actions 的确定性往返 ──
  const P2: WorkflowDef = {
    name: 'p2round',
    steps: [
      {
        id: 'verify', label: '验证', gate: 'review', skills: [], inputs: [], outputs: [],
        guards: [
          { type: 'field-nonempty', field: 'verification_report' },
          { type: 'file-exists', path: { kind: 'field', field: 'verification_report' } },
          { type: 'field-equals', field: 'branch_status', value: 'handled', when: { kind: 'track-not-in', values: ['pm'] } },
          { type: 'field-in', field: 'isolation', values: ['branch', 'worktree'] },
          { type: 'full-direct-override' },
          { type: 'build-head-unchanged', field: 'build_sha' },
        ],
        transitions: [
          {
            event: 'pass', to: 'done',
            guards: [{ type: 'field-equals', field: 'agent_review_result', value: 'pass', when: { kind: 'track-in', values: ['backend'] } }],
            actions: [{ type: 'mark-verification-passed' }, { type: 'freeze-build-sha' }],
          },
          { event: 'fail', to: 'done', guards: [], actions: [{ type: 'mark-verification-failed' }] },
        ],
      },
      { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
    ],
  }

  it('P2 全新变体 + when + edge guards/actions：serialize→parse 深度等于原始（含空 guards[]/actions[] 保留）', () => {
    expect(parseWorkflow(serializeWorkflow(P2))).toEqual(P2)
  })

  it('field-equals 的 value 含内部空格 → 往返保留（回归：value 用 (.+?) 而非 (\\S+)，否则 serialize 写出的含空格值 parse 读不回）', () => {
    const wf: WorkflowDef = {
      name: 'spacedval',
      steps: [
        {
          id: 's1', label: '', gate: null, skills: [], inputs: [], outputs: [],
          guards: [{ type: 'field-equals', field: 'branch_status', value: 'needs review' }], transitions: [],
        },
      ],
    }
    const round = parseWorkflow(serializeWorkflow(wf))
    expect(round).toEqual(wf)
    expect((round.steps[0]!.guards[0] as { value: string }).value).toBe('needs review')
  })

  // ── 阻断 2：field-equals value 的 serialize→parse 往返域（representable.ts）——凡 compile/validate
  //    放行（可表示）的 value 都必须结构相等地读回。空串/换行/回车/tab/首尾空白由 compile fail-loud
  //    拒绝（见 compile.test.ts），故不进往返夹具；这里钉死「可表示 value 一律往返保真」。 ──
  it('可表示的各类 field-equals value（内部空格 / 冒号 / 井号 / 逗号 / 歧义标量形）→ serialize→parse 逐字往返', () => {
    for (const value of ['handled', 'needs review', 'a: b', 'has #hash', 'a,b,c', 'true', '123', '~', '*ref']) {
      const wf: WorkflowDef = {
        name: 'reprval',
        steps: [
          {
            id: 's1', label: '', gate: null, skills: [], inputs: [], outputs: [],
            guards: [{ type: 'field-equals', field: 'branch_status', value }], transitions: [],
          },
        ],
      }
      const round = parseWorkflow(serializeWorkflow(wf))
      expect(round).toEqual(wf)
      expect((round.steps[0]!.guards[0] as { value: string }).value).toBe(value)
    }
  })

  // ── G2 P4：显式 artifacts 块（field/type/producer_policy + 可选 required_when）确定性往返 ──
  it('显式 artifacts（含 required_when，两种 producer policy）→ serialize→parse 深度往返等价', () => {
    const wf: WorkflowDef = {
      name: 'p4art',
      steps: [
        {
          id: 'spec', label: '规格', gate: 'review', skills: [], inputs: [],
          outputs: [{ field: 'plan', type: 'file_path' }],
          artifacts: [
            { field: 'plan', type: 'file_path', producerPolicy: 'effective-phase-skills', requiredWhen: { kind: 'track-not-in', values: ['pm'] } },
          ],
          guards: [], transitions: [{ event: 'done', to: 'explore' }],
        },
        {
          id: 'explore', label: '', gate: null, skills: [], inputs: [],
          outputs: [{ field: 'design_doc', type: 'file_path' }],
          artifacts: [{ field: 'design_doc', type: 'file_path', producerPolicy: 'effective-step-skills' }],
          guards: [], transitions: [],
        },
      ],
    }
    expect(parseWorkflow(serializeWorkflow(wf))).toEqual(wf)
  })

  it('artifacts: [] 与缺省 undefined 两态往返保真（空块写 `artifacts: []`，缺省不写该键）', () => {
    const wf: WorkflowDef = {
      name: 'p4empty',
      steps: [
        { id: 'a', label: '', gate: null, skills: [], inputs: [], outputs: [], artifacts: [], guards: [], transitions: [{ event: 'e', to: 'b' }] },
        { id: 'b', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }
    const round = parseWorkflow(serializeWorkflow(wf))
    expect(round).toEqual(wf)
    expect(round.steps[0]!.artifacts).toEqual([])
    expect(Object.prototype.hasOwnProperty.call(round.steps[1]!, 'artifacts')).toBe(false)
  })
})
