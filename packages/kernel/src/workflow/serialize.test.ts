import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileWorkflow } from './compile.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import type { StepDef, TrackBranchDef, WorkflowDef } from './types.js'

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
      outputs: [],
      guards: [
        { type: 'tasks-at-least', n: 3 },
        { type: 'required-output', path: 'docs/superpowers/specs/*.md' },
      ],
      transitions: [
        { event: 'pass', to: 's2' },
        { event: 'fail', to: 's1' },
      ],
    },
    {
      id: 's2', label: '', gate: null, skills: [], inputs: [],
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

  it('openspec 只在 true 时写；不再写出 document_contract（旧定义里的顶层契约写出后消失）', () => {
    const contract = {
      version: 'v1' as const,
      slots: [{ kind: 'tasks', ownerStep: 'intake', producers: ['openspec-propose'] }],
      reads: [{ step: 'done', kinds: ['tasks'] }],
    }
    const yaml = serializeWorkflow({ ...MINIMAL, openspec: true, documentContract: contract })
    expect(yaml).toContain('openspec: true')
    expect(yaml).not.toContain('document_contract')
    expect(yaml).toBe(serializeWorkflow({ ...MINIMAL, openspec: true }))
    expect(parseWorkflow(yaml).documentContract).toBeUndefined()
    expect(serializeWorkflow({ ...MINIMAL, openspec: false })).not.toContain('openspec')
  })

  it('分支的 documentContract 同样不再写出，分支其余键序不变', () => {
    const contract = {
      version: 'v1' as const,
      slots: [{ kind: 'proposal', ownerStep: 'intake', producers: ['openspec-propose'] }],
      reads: [],
    }
    const withContract = serializeWorkflow({
      name: 'branched', openspec: true, steps: [],
      tracks: { web: { label: '前端', documentContract: contract, steps: MINIMAL.steps } },
    })
    expect(withContract).not.toContain('document_contract')
    expect(withContract).toBe(serializeWorkflow({
      name: 'branched', openspec: true, steps: [],
      tracks: { web: { label: '前端', steps: MINIMAL.steps } },
    }))
    expect(parseWorkflow(withContract).tracks?.web?.documentContract).toBeUndefined()
  })

  it('required-output round-trip：path 写成 `path:`，不写 inputs / outputs / artifacts', () => {
    const yaml = [
      'name: demo',
      'steps:',
      '  - id: write',
      '    label: 写',
      '    gate: null',
      '    skills: []',
      '    guards:',
      '      - type: required-output',
      '        path: docs/superpowers/specs/*.md',
      '    transitions: []',
    ].join('\n')
    const def = parseWorkflow(yaml)
    expect(def.steps[0]?.guards).toEqual([{ type: 'required-output', path: 'docs/superpowers/specs/*.md' }])
    expect(parseWorkflow(serializeWorkflow(def))).toEqual(def)
    expect(serializeWorkflow(def)).toContain('      - type: required-output\n        path: docs/superpowers/specs/*.md\n')
    expect(serializeWorkflow(def)).not.toMatch(/^\s*(inputs|outputs|artifacts):/mu)
  })

  it('required-output 带 when、写在边上、path 含空格与 {change} 占位 → 往返保真', () => {
    const wf: WorkflowDef = {
      name: 'edge',
      steps: [
        {
          id: 'verify', label: '', gate: 'review', skills: [], inputs: [], outputs: [],
          guards: [{ type: 'required-output', path: 'docs/my notes/*.md', when: { kind: 'track-in', values: ['backend'] } }],
          transitions: [{
            event: 'verify-pass', to: 'done',
            guards: [{ type: 'required-output', path: 'docs/superpowers/reports/{change}-verify.md' }],
          }],
        },
        { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }
    expect(parseWorkflow(serializeWorkflow(wf))).toEqual(wf)
  })

  it('inputs / outputs / artifacts 不再写出：旧定义序列化后这些键消失，读回为空输入输出且无 artifacts', () => {
    const legacy: WorkflowDef = {
      name: 'legacy',
      steps: [
        {
          id: 'a', label: '', gate: null, skills: [],
          inputs: [{ field: 'design_doc', type: 'file_path' }],
          outputs: [{ field: 'plan', type: 'file_path' }],
          artifacts: [{ field: 'plan', type: 'file_path', producerPolicy: 'effective-step-skills' }],
          guards: [], transitions: [],
        },
        { id: 'b', label: '', gate: null, skills: [], inputs: [], outputs: [], artifacts: [], guards: [], transitions: [] },
      ],
    }
    const yaml = serializeWorkflow(legacy)
    expect(yaml).not.toMatch(/^\s*(inputs|outputs|artifacts|document_contract):/mu)
    const round = parseWorkflow(yaml)
    expect(round.steps.map((step) => [step.inputs, step.outputs])).toEqual([[[], []], [[], []]])
    expect(round.steps.map((step) => Object.hasOwn(step, 'artifacts'))).toEqual([false, false])
  })

  it('MINIMAL：serialize→parse 深度等于原始 WorkflowDef', () => {
    const round = parseWorkflow(serializeWorkflow(MINIMAL))
    expect(round).toEqual(MINIMAL)
  })

  it('RICH（多 skill+depends_on+多 guard（含 required-output）+多 transition+非空 label/gate）：往返等价', () => {
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
    // 序列化不再写出 inputs / outputs / artifacts / document_contract：模板改写前（Task 4）它们还在，往返后消失，
    // 所以先把这四项从期望里去掉，其余（技能、守卫、转换、分支策略……）必须逐项等价；模板改写后这一步是空操作。
    const stripLegacyKeys = (step: StepDef): StepDef => {
      const { artifacts: _artifacts, ...rest } = step
      return { ...rest, inputs: [], outputs: [] }
    }
    const stripBranch = (branch: TrackBranchDef): TrackBranchDef => {
      const { documentContract: _contract, ...rest } = branch
      return { ...rest, steps: branch.steps.map(stripLegacyKeys) }
    }
    const { documentContract: _contract, ...withoutContract } = original
    const expected: WorkflowDef = {
      ...withoutContract,
      steps: original.steps.map(stripLegacyKeys),
      ...(original.tracks === undefined
        ? {}
        : { tracks: Object.fromEntries(Object.entries(original.tracks).map(([id, branch]) => [id, stripBranch(branch)])) }),
    }
    const roundTripped = parseWorkflow(serializeWorkflow(original))
    expect(roundTripped).toEqual(expected)
    expect(parseWorkflow(serializeWorkflow(roundTripped))).toEqual(roundTripped)
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

  it('分支工作流的测试项：块式往返、键序固定、tests: [] 与缺省两态保真', () => {
    const wf: WorkflowDef = {
      name: 'tested',
      tracks: {
        frontend: {
          label: '前端',
          steps: [
            {
              id: 'build', label: '实现', gate: 'auto', skills: [], inputs: [],
              outputs: [],
              tests: [
                {
                  id: 'unit', direction: 'unit', command: 'npm test', cwd: 'frontend', label: '单测',
                  timeout_s: 900, required: true, keep_runs: 5,
                  pass: { exit_code: 0 },
                  inputs: [{ kind: 'document', ref: 'delta-spec' }],
                  outputs: [{ path: 'frontend/test-results/junit.xml', kind: 'report', required: true }],
                },
                {
                  id: 'bench', direction: 'benchmark', command: 'npm run bench', scope: 'known',
                  metrics_path: 'test-results/benchmark.json',
                  pass: { metrics: [{ name: 'p95_ms', max: 250, better: 'lower' }] },
                  inputs: [], outputs: [],
                },
              ],
              guards: [], transitions: [{ event: 'done', to: 'verify' }],
            },
            { id: 'verify', label: '验证', gate: null, skills: [], inputs: [], outputs: [], tests: [], guards: [], transitions: [] },
          ],
        },
      },
      steps: [],
    }
    const yaml = serializeWorkflow(wf)
    const keys = [...yaml.matchAll(/^ +(?:- )?(id|direction|command|cwd|label|timeout_s|required|keep_runs|pass|inputs|outputs): /gmu)]
      .map((match) => match[1])
    expect(keys.slice(keys.indexOf('direction') - 1, keys.indexOf('direction') + 7))
      .toEqual(['id', 'direction', 'command', 'cwd', 'label', 'timeout_s', 'required', 'keep_runs'])
    expect(yaml).toContain('        tests: []')
    const round = parseWorkflow(yaml)
    expect(round).toEqual(wf)
    expect(Object.prototype.hasOwnProperty.call(round.tracks!.frontend!.steps[0]!, 'tests')).toBe(true)
  })
})

describe('serializeWorkflow · 分支新键 spec / route / automation', () => {
  const OPEN: WorkflowDef['steps'] = [
    { id: 'open', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ]
  const SRC = `name: demo
openspec: true
tracks:
  lite:
    label: 轻量
    spec: none
    route:
      keywords: [修复, typo]
      exclude: [迁移]
      priority: 500
    automation:
      eligible: false
      enqueue_after_spec: false
    steps:
      - id: open
        gate: null
        transitions: []
`

  it('分支新键 round-trip：定义层与编译后的 IR 都深等价', () => {
    const def = parseWorkflow(SRC)
    const again = parseWorkflow(serializeWorkflow(def))
    expect(again).toEqual(def)
    const ir = compileWorkflow(def)
    expect(ir.tracks?.lite?.spec).toBe('none')
    expect(ir.tracks?.lite?.route).toEqual({ keywords: ['修复', 'typo'], exclude: ['迁移'], priority: 500, fallback: false })
    expect(compileWorkflow(again)).toEqual(ir)
  })

  it('键序 label → spec → route → automation → steps；route 的空 exclude 与 false fallback 不写', () => {
    const yaml = serializeWorkflow({
      name: 'demo',
      steps: [],
      tracks: {
        lite: {
          label: '轻量',
          spec: 'openspec',
          route: { keywords: ['a', 'b c'], exclude: [], priority: 7, fallback: true },
          automation: { eligible: true, enqueueAfterSpec: true },
          steps: OPEN,
        },
      },
    })
    expect(yaml).toContain([
      '  lite:',
      '    label: 轻量',
      '    spec: openspec',
      '    route:',
      '      keywords: [a, b c]',
      '      priority: 7',
      '      fallback: true',
      '    automation:',
      '      eligible: true',
      '      enqueue_after_spec: true',
      '    steps:',
    ].join('\n'))
    expect(parseWorkflow(yaml).tracks?.lite?.route).toEqual({ keywords: ['a', 'b c'], exclude: [], priority: 7, fallback: true })
  })

  it('空 keywords 与 exclude 往返保真', () => {
    const def: WorkflowDef = {
      name: 'demo',
      steps: [],
      tracks: { fallbackonly: { route: { keywords: [], exclude: ['x'], priority: 0, fallback: true }, steps: OPEN } },
    }
    expect(serializeWorkflow(def)).toContain('      keywords: []')
    expect(parseWorkflow(serializeWorkflow(def))).toEqual(def)
  })

  it('未声明新键的分支写出的 YAML 不含 spec / route / automation', () => {
    const yaml = serializeWorkflow({ name: 'demo', steps: [], tracks: { plain: { label: '普通', steps: OPEN } } })
    expect(yaml).not.toMatch(/^\s+(spec|route|automation):/mu)
  })
})
