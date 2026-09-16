import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cmdInternalSkillGate } from './internalSkillGate.js'
import { makeDeps, mockState, spy } from '../test-support.js'
describe('cmdInternalSkillGate', () => {
  it('workflow=default 的 change → 直接放行（这条能力只管非 default workflow）', async () => {
    const deps = makeDeps()
    const code = await cmdInternalSkillGate(deps, 'some-change', 'any-skill')
    expect(code).toBe(0)
  })

  it('workflow 字段空串（历史遗留状态文件）也按 default 处理（`??` 不兜空串的坑，同 transition.ts Task 8 修复口径）', async () => {
    const deps = makeDeps({ state: mockState({ workflow: '' }) })
    const code = await cmdInternalSkillGate(deps, 'some-change', 'any-skill')
    expect(code).toBe(0)
  })

  it('非法 change 名 → fail-open 放行（本命令契约只有 0/2，不是 cmdTransition 的 exit 1 口径）', async () => {
    const deps = makeDeps()
    const code = await cmdInternalSkillGate(deps, 'bad name', 'any-skill')
    expect(code).toBe(0)
  })

  it('store.read 抛错 → fail-open 放行（绝不因内部异常变相锁死用户的工具调用）', async () => {
    const deps = makeDeps()
    deps.store.read = spy(async (_d: string) => {
      throw new Error('ENOENT')
    })
    const code = await cmdInternalSkillGate(deps, 'demo', 'any-skill')
    expect(code).toBe(0)
  })

  it('非 default workflow 但 workflow 文件不存在 → fail-open 放行 + WARN（真 loadWorkflow 调用，非 mock 桩返回值）', async () => {
    // cwd 缺省 /repo（makeDeps 约定），真实文件系统里没有 /repo/.pipeline/workflows/ghost.yaml——
    // 同 transition.test.ts Task 8 用例的技巧：借真 loadWorkflow 的"找不到"分支验证 fail-open。
    const deps = makeDeps({ state: mockState({ workflow: 'ghost', phase: 's1' }) })
    const code = await cmdInternalSkillGate(deps, 'demo', 'any-skill')
    expect(code).toBe(0)
    expect(deps.errLines.join('\n')).toContain("workflow 'ghost' 未找到")
  })

  describe('真实 workflow 定义文件（临时目录，同 loadWorkflow.test.ts 手法）', () => {
    let root: string

    // s1 声明一条到 s2 的 transition，仅为满足 validateWorkflow（Task 3，GOAL E5：非终止 step
    // 必须声明 transitions，否则视为走进死路的配置错误）——本文件里没有一条测试调用
    // cmdTransition 或读取 step.transitions，纯粹是 loadWorkflow 现在会在读入时校验整份
    // workflow，故 fixture 本身必须整体合法，与本文件测的 skill-DAG 判定逻辑无关。
    const WF = `name: custom1
steps:
  - id: s1
    label: step-one
    gate: null
    skills:
      - id: a
      - id: b
      - id: c
        depends_on: [a, b]
      - id: d
        depends_on: [a]
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: s2
  - id: s2
    label: step-two
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'internal-skill-gate-'))
      await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
      await writeFile(join(root, '.pipeline', 'workflows', 'custom1.yaml'), WF, 'utf8')
    })

    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('当前 step 不在 workflow 里 → fail-open 放行 + WARN', async () => {
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 'no-such-step' }) })
      const code = await cmdInternalSkillGate(deps, 'demo', 'a')
      expect(code).toBe(0)
      expect(deps.errLines.join('\n')).toContain("step 'no-such-step' 不在 workflow 'custom1' 里")
    })

    it('无依赖的 skill：即便历史为空也直接放行', async () => {
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }) })
      expect(await cmdInternalSkillGate(deps, 'demo', 'a')).toBe(0)
      expect(await cmdInternalSkillGate(deps, 'demo', 'b')).toBe(0)
    })

    it('正常对话的 Tenon 编排入口不受 phase 内 skill DAG 误拦', async () => {
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }) })
      expect(await cmdInternalSkillGate(deps, 'demo', 'tenon')).toBe(0)
      expect(await cmdInternalSkillGate(deps, 'demo', 'tenon:tenon')).toBe(0)
    })

    it('有依赖但一个都没完成 → exit 2 + stderr 点名缺哪些', async () => {
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }) })
      const code = await cmdInternalSkillGate(deps, 'demo', 'c')
      expect(code).toBe(2)
      expect(deps.errLines.join('\n')).toContain('还需先完成 a, b')
    })

    it('Codex 的 tenon namespace 与 workflow bare id 共用同一 DAG 身份', async () => {
      const historyRaw =
        [
          JSON.stringify({ ts: 't', kind: 'transition', from: 'open', to: 's1' }),
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'Skill: tenon:a' }),
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'Skill: tenon:b' }),
        ].join('\n') + '\n'
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }), historyRaw })
      expect(await cmdInternalSkillGate(deps, 'demo', 'tenon:c')).toBe(0)
    })

    it('依赖部分完成（history 里只有 a 的 tool 记录）→ 仍锁定，stderr 只点名缺的那个 (b)', async () => {
      const historyRaw =
        [
          JSON.stringify({ ts: 't', kind: 'transition', from: 'open', to: 's1' }),
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'Skill: a' }),
        ].join('\n') + '\n'
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }), historyRaw })
      const code = await cmdInternalSkillGate(deps, 'demo', 'c')
      expect(code).toBe(2)
      expect(deps.errLines.join('\n')).toContain('还需先完成 b')
    })

    it('依赖全部完成（history 含 a、b 的 tool 记录）→ 解锁 exit 0', async () => {
      const historyRaw =
        [
          JSON.stringify({ ts: 't', kind: 'transition', from: 'open', to: 's1' }),
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'Skill: a' }),
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'Skill: b' }),
        ].join('\n') + '\n'
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }), historyRaw })
      expect(await cmdInternalSkillGate(deps, 'demo', 'c')).toBe(0)
    })

    it('Codex 对已打包 SKILL.md 的真实读取也满足后续串行 skill 依赖', async () => {
      // Codex 没有 Claude 的 first-class Skill 工具；PostToolUse 会把受控的 bundled
      // SKILL.md read 记录为 CodexSkillRead。若这里只识别 "Skill: ..."，自定义 workflow
      // 的并行根节点虽然已实际加载，依赖它们的串行节点仍会被错误拦截。
      const historyRaw =
        [
          JSON.stringify({ ts: 't', kind: 'transition', from: 'open', to: 's1' }),
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'CodexSkillRead: a' }),
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'CodexSkillRead: b' }),
        ].join('\n') + '\n'
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }), historyRaw })
      expect(await cmdInternalSkillGate(deps, 'demo', 'c')).toBe(0)
    })

    it('交叉依赖：d 只依赖 a，不需要等 b 也能解锁（验证不会被过度串行化）', async () => {
      const historyRaw =
        [
          JSON.stringify({ ts: 't', kind: 'transition', from: 'open', to: 's1' }),
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'Skill: a' }),
        ].join('\n') + '\n'
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }), historyRaw })
      expect(await cmdInternalSkillGate(deps, 'demo', 'd')).toBe(0)
    })

    it('step 声明了 skills 但这个不在列表里 → 锁定 exit 2（未声明 ≠ 无依赖，不能放行）', async () => {
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }) })
      const code = await cmdInternalSkillGate(deps, 'demo', 'not-declared')
      expect(code).toBe(2)
      expect(deps.errLines.join('\n')).toContain("不在 step 's1'")
    })

    it('step 的 skills: []（未声明任何 skill）→ 视为不使用 DAG，任意 skill 直接放行（opt-in 语义，防空列表被误读成"锁死一切"）', async () => {
      // s2 在 fixture 里 skills: []——不能像 s1 那样对"未声明的 skill id"判锁定，否则任何自定义
      // workflow 只要有个不关心 skill 顺序的 step（最常见写法就是留空 skills），该 step 就会
      // 意外变成完全无法调用任何 skill，这是比"没有这个功能"更糟的回归。
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's2' }) })
      expect(await cmdInternalSkillGate(deps, 'demo', 'anything-goes')).toBe(0)
    })

    it('"最近一次进入 step" 语义：re-entry 之前的旧完成记录不算数（防回环 step 误判解锁）', async () => {
      // s1 第一次被进入后完成了 a、b（此时 c 该解锁）；随后离开又回环重新进入 s1，第二次进入
      // 之后什么都还没做——c 应该重新锁定，不能被"上一轮"的旧完成记录蒙混过关。
      const historyRaw =
        [
          { ts: 't1', kind: 'transition', from: 'open', to: 's1' },
          { ts: 't2', kind: 'tool', raw: 'Skill: a' },
          { ts: 't3', kind: 'tool', raw: 'Skill: b' },
          { ts: 't4', kind: 'transition', from: 's1', to: 's2' },
          { ts: 't5', kind: 'transition', from: 's2', to: 's1' }, // 回环重新进入 s1
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n'
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }), historyRaw })
      const code = await cmdInternalSkillGate(deps, 'demo', 'c')
      // 若误用"第一次进入"或对全历史不做分段扫描，这里会错误地放行（exit 0）
      expect(code).toBe(2)
    })

    it('history 含损坏行 → 跳过损坏行、不拖垮判定（其余合法行照常生效）', async () => {
      const historyRaw =
        [
          JSON.stringify({ ts: 't', kind: 'transition', from: 'open', to: 's1' }),
          'this is not json',
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'Skill: a' }),
          JSON.stringify({ ts: 't', kind: 'tool', raw: 'Skill: b' }),
        ].join('\n') + '\n'
      const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom1', phase: 's1' }), historyRaw })
      expect(await cmdInternalSkillGate(deps, 'demo', 'c')).toBe(0)
    })
  })
})
