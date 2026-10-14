import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateStepGuards } from './stepGuard.js'
import type { StepDef } from './types.js'
import { emptyFields } from '../state/parse.js'
import type { PipelineState } from '../types.js'

function state(fields: Partial<Record<string, string>>): PipelineState {
  return { fields: { ...emptyFields(), ...fields } as PipelineState['fields'], opaqueTail: '' }
}

function step(overrides: Partial<StepDef>): StepDef {
  return { id: 's1', label: 'x', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...overrides }
}

describe('evaluateStepGuards', () => {
  it('outputs 声明的字段已设置（非 null 哨兵）→ pass', async () => {
    const s = step({ outputs: [{ field: 'design_doc', type: 'file_path' }], guards: [{ type: 'nonempty-output' }] })
    const result = await evaluateStepGuards(state({ design_doc: '/tmp/x/design.md' }), s, { changeDirAbs: '/tmp/x' })
    expect(result.pass).toBe(true)
  })

  it('outputs 声明的字段仍是 null 哨兵 → fail，failures 里点名具体字段', async () => {
    const s = step({ outputs: [{ field: 'design_doc', type: 'file_path' }], guards: [{ type: 'nonempty-output' }] })
    const result = await evaluateStepGuards(state({ design_doc: 'null' }), s, { changeDirAbs: '/tmp/x' })
    expect(result.pass).toBe(false)
    expect(result.failures.some((f) => f.includes('design_doc'))).toBe(true)
  })

  it('没有 nonempty-output guard 时，字段是否设置不影响结果（guards 列表说了算，不是隐式全查）', async () => {
    const s = step({ outputs: [{ field: 'design_doc', type: 'file_path' }], guards: [] })
    const result = await evaluateStepGuards(state({ design_doc: 'null' }), s, { changeDirAbs: '/tmp/x' })
    expect(result.pass).toBe(true)
  })

  // ── G2 P2 兼容回退：nonempty-output 下沉到列表/未知惰性 output（output-present）在运行期产生
  //    普通 guard failure（非 load/compile 报错，非 throw），保留 pre-P2 旧 stepGuard 语义 ──
  it('nonempty-output 指列表字段 output → 运行期 guard failure（数组折 ""，非空列表也 fail；非 load 报错、非 throw）', async () => {
    const s = step({ outputs: [{ field: 'scope', type: 'string' }], guards: [{ type: 'nonempty-output' }] })
    const st: PipelineState = { fields: { ...emptyFields(), scope: ['a', 'b'] } as PipelineState['fields'], opaqueTail: '' }
    const result = await evaluateStepGuards(st, s, { changeDirAbs: '/tmp/x' })
    expect(result.pass).toBe(false)
    expect(result.failures.some((f) => f.includes('scope'))).toBe(true)
  })

  it('nonempty-output 指未知惰性 output（custom_doc）→ 运行期 guard failure（永不落值恒 fail）', async () => {
    const s = step({ outputs: [{ field: 'custom_doc', type: 'string' }], guards: [{ type: 'nonempty-output' }] })
    const result = await evaluateStepGuards(state({}), s, { changeDirAbs: '/tmp/x' })
    expect(result.pass).toBe(false)
    expect(result.failures.some((f) => f.includes('custom_doc'))).toBe(true)
  })
})

describe('evaluateStepGuards —— tasks-at-least（B2：复用 flow/guard.ts taskCount 真实计数，勿无条件卡死）', () => {
  let changeDirAbs: string
  beforeEach(async () => {
    changeDirAbs = await mkdtemp(join(tmpdir(), 'pl-stepguard-'))
  })
  afterEach(async () => {
    await rm(changeDirAbs, { recursive: true, force: true })
  })

  it('tasks.md 任务数 ≥ n → pass（回归：老实现无条件 fail，任何满足量的自定义 workflow 也卡死）', async () => {
    await writeFile(join(changeDirAbs, 'tasks.md'), '- [ ] a\n- [x] b\n- [ ] c\n', 'utf8')
    const s = step({ guards: [{ type: 'tasks-at-least', n: 3 }] })
    const result = await evaluateStepGuards(state({}), s, { changeDirAbs })
    expect(result.pass).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('tasks.md 任务数 < n → fail，且 failures 点名要求的任务数', async () => {
    await writeFile(join(changeDirAbs, 'tasks.md'), '- [ ] only one\n', 'utf8')
    const s = step({ guards: [{ type: 'tasks-at-least', n: 3 }] })
    const result = await evaluateStepGuards(state({}), s, { changeDirAbs })
    expect(result.pass).toBe(false)
    expect(result.failures.some((f) => f.includes('3'))).toBe(true)
  })

  it('tasks.md 缺失 → 计 0 个任务，n≥1 时 fail（与 flow/guard.ts 缺文件语义一致）', async () => {
    const s = step({ guards: [{ type: 'tasks-at-least', n: 1 }] })
    const result = await evaluateStepGuards(state({}), s, { changeDirAbs })
    expect(result.pass).toBe(false)
  })

  it('大写 [X] 不计（照 taskCount 老仓 regex），仅 [ ]/[x] 计数', async () => {
    await writeFile(join(changeDirAbs, 'tasks.md'), '- [X] 不计\n- [x] 计\n', 'utf8')
    const s = step({ guards: [{ type: 'tasks-at-least', n: 2 }] })
    const result = await evaluateStepGuards(state({}), s, { changeDirAbs })
    expect(result.pass).toBe(false) // 只有 1 个计数（[x]），< 2
  })
})

describe('evaluateStepGuards —— required-output（必须产出）', () => {
  const guarded = step({ guards: [{ type: 'required-output', path: 'docs/superpowers/specs/*.md' }] })
  const HEAD = "step 's1' 要求产出匹配 docs/superpowers/specs/*.md 的文件"

  it('buildStepGuardInput 把 requiredOutput 能力连同当前步骤一起交给 handler', async () => {
    const seen: Array<readonly [string, string]> = []
    const result = await evaluateStepGuards(state({}), guarded, {
      changeDirAbs: '/tmp/x',
      currentStep: 's1',
      requiredOutput: async (stepId, pattern) => { seen.push([stepId, pattern]); return true },
    })
    expect(result).toEqual({ pass: true, failures: [] })
    expect(seen).toEqual([['s1', 'docs/superpowers/specs/*.md']])
  })

  it('不满足：文案说清要的路径模式和「本任务里这一步还没有写出」', async () => {
    const result = await evaluateStepGuards(state({}), guarded, {
      changeDirAbs: '/tmp/x', currentStep: 's1', requiredOutput: async () => false,
    })
    expect(result.pass).toBe(false)
    expect(result.failures).toEqual([`${HEAD}（本任务里这一步还没有写出这样的文件）`])
  })

  describe('路径模式里的 {change} 占位', () => {
    const withPlaceholder = step({ guards: [{ type: 'required-output', path: 'openspec/changes/{change}/proposal.md' }] })
    const changeDirAbs = '/tmp/project/openspec/changes/demo'
    const RENDERED = "step 's1' 要求产出匹配 openspec/changes/demo/proposal.md 的文件"

    it('不满足的文案显示渲染成任务名的真实路径，而不是 {change} 原样', async () => {
      const result = await evaluateStepGuards(state({}), withPlaceholder, {
        changeDirAbs, currentStep: 's1', requiredOutput: async () => false,
      })
      expect(result.failures).toEqual([`${RENDERED}（本任务里这一步还没有写出这样的文件）`])
    })

    it('能力缺失、能力抛错、当前步骤未知的文案同样渲染', async () => {
      const missing = await evaluateStepGuards(state({}), withPlaceholder, { changeDirAbs, currentStep: 's1' })
      expect(missing.failures).toEqual([`${RENDERED}，但缺少能力 requiredOutput，无法判定`])
      const broken = await evaluateStepGuards(state({}), withPlaceholder, {
        changeDirAbs, currentStep: 's1', requiredOutput: async () => { throw new Error('boom') },
      })
      expect(broken.failures).toEqual([`${RENDERED}，评估出错，已按未满足处理`])
      const unknown = await evaluateStepGuards(state({ phase: '' }), withPlaceholder, {
        changeDirAbs, requiredOutput: async () => false,
      })
      expect(unknown.failures).toEqual([`${RENDERED}，但当前步骤未知，无法判定`])
    })

    it('能力拿到的仍是原样的路径模式（占位由能力自己展开）', async () => {
      const seen: string[] = []
      await evaluateStepGuards(state({}), withPlaceholder, {
        changeDirAbs, currentStep: 's1', requiredOutput: async (_step, pattern) => { seen.push(pattern); return true },
      })
      expect(seen).toEqual(['openspec/changes/{change}/proposal.md'])
    })
  })

  it('能力缺失与能力抛错：失败关闭，文案分别说明缺能力 / 评估出错，不带异常原文', async () => {
    const missing = await evaluateStepGuards(state({}), guarded, { changeDirAbs: '/tmp/x', currentStep: 's1' })
    expect(missing.failures).toEqual([`${HEAD}，但缺少能力 requiredOutput，无法判定`])
    const broken = await evaluateStepGuards(state({}), guarded, {
      changeDirAbs: '/tmp/x', currentStep: 's1', requiredOutput: async () => { throw new Error('/secret/path 读失败') },
    })
    expect(broken.failures).toEqual([`${HEAD}，评估出错，已按未满足处理`])
  })
})

// G2 P2：v1 经 compile 下沉 + handler 求值后，collect-all 逐条列全部未过项的旧语义必须逐字保留
// （非 first-stop）——此前无测试覆盖多失败项，这里钉死顺序与文案，防新 handler 路径悄悄改成首错即停。
describe('evaluateStepGuards —— collect-all 多失败项全列（旧语义逐字保留）', () => {
  it('tasks-at-least + nonempty-output(2 输出) 同时不满足 → 3 条 failures，按 guard/输出声明序、文案逐字', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pl-stepguard-multi-'))
    try {
      const s = step({
        outputs: [{ field: 'design_doc', type: 'file_path' }, { field: 'plan', type: 'file_path' }],
        guards: [{ type: 'tasks-at-least', n: 1 }, { type: 'nonempty-output' }],
      })
      const result = await evaluateStepGuards(state({ design_doc: '', plan: '' }), s, { changeDirAbs: dir })
      expect(result.pass).toBe(false)
      expect(result.failures).toEqual([
        "step 's1' 要求 tasks.md 至少 1 个任务（当前=0）",
        "字段 'design_doc' 未设置（step 's1' 声明为必须产出）",
        "字段 'plan' 未设置（step 's1' 声明为必须产出）",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
