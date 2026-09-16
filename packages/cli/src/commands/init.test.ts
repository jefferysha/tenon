import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { InitOptions } from '@tenon/kernel'
import { cmdInit, type InitPrompter, type InitWizardEnv } from './init.js'
import { makeDeps, spy } from '../test-support.js'

/** 与 init-workflow.integration.test.ts 同一份两步 workflow 定义（intake -> done，event=complete）。 */
const TWO_STEP_WF = `name: onboarding
steps:
  - id: intake
    label: intake
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: done
  - id: done
    label: done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/** 脚本化 Prompter：按注入顺序弹出应答（'' = 回车收默认）。 */
function scriptedPrompter(answers: string[]): InitPrompter {
  let i = 0
  return { ask: async () => answers[i++] ?? '', close: () => {} }
}

describe('init —— stdout 空 / [INIT] 走 stderr；0/1（oracle 实测回写）', () => {
  test('成功：stdout 无输出，创建路径以 [INIT] 走 stderr，exit 0', async () => {
    const deps = makeDeps()
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' })
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines).toEqual(['[INIT] /repo/openspec/changes/demo'])
  })

  test('成功记一条 kind=init 历史，actor 为当前声明身份', async () => {
    const deps = makeDeps()
    await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' })
    expect(deps.historyEntries).toEqual([
      ['/repo/openspec/changes/demo', { ts: '2026-07-06T00:00:00Z', kind: 'init', actor: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } }],
    ])
  })

  test('身份缺失：exit 1 + 设置提示，不调用 init', async () => {
    const deps = makeDeps({ user: () => ({ missing: true }) })
    expect(await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' })).toBe(1)
    expect(deps.store.init.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain('ERROR: 未设置用户身份')
  })

  test('InitOptions 装配：repoRoot=cwd、track/preset/creator/clock 透传', async () => {
    const deps = makeDeps()
    await cmdInit(deps, 'demo', { track: 'pm', preset: 'hotfix' })
    const opts = deps.store.init.calls[0]?.[0]
    expect(opts?.repoRoot).toBe('/repo')
    expect(opts?.name).toBe('demo')
    expect(opts?.track).toBe('pm')
    expect(opts?.reviewSeed).toBe('skipped')
    expect(opts?.preset).toBe('hotfix')
    expect(opts?.creator).toEqual({ id: 'tester@tenon.test', name: 'Tester', trust: 'declared' })
    expect(opts?.clock).toBe(deps.clock)
  })

  test('非法 track：exit 1，init 不被调用', async () => {
    const deps = makeDeps()
    const code = await cmdInit(deps, 'demo', { track: 'devops', preset: 'full' })
    expect(code).toBe(1)
    expect(deps.store.init.calls).toHaveLength(0)
    expect(deps.errLines.length).toBeGreaterThan(0)
  })

  test('空 preset：exit 1，init 不被调用', async () => {
    const deps = makeDeps()
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: '' })
    expect(code).toBe(1)
    expect(deps.store.init.calls).toHaveLength(0)
  })

  test('store.init 抛错（已存在等）：exit 1', async () => {
    const deps = makeDeps()
    deps.store.init = spy(async (_o: InitOptions): Promise<string> => {
      throw new Error('已存在')
    })
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' })
    expect(code).toBe(1)
    expect(deps.outLines).toEqual([])
  })

  test('非法 change 名：exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdInit(deps, 'a b', { track: 'backend', preset: 'full' })
    expect(code).toBe(1)
    expect(deps.store.init.calls).toHaveLength(0)
  })
})

/**
 * --workflow（whole-branch review 补：此前没有支持的命令能把 change 摆到自定义 workflow 的
 * 首个 step 上）。真实 fs 全链路（workflow 文件真存在 + steps[0] 真读出）在
 * init-workflow.integration.test.ts；这里 mock 层只覆盖不需要真文件系统的分支：省略/default
 * 零回归、找不到 workflow fail-loud 且不落盘。
 */
describe('init --workflow（GOAL E，自定义 workflow 首个 step 落点）', () => {
  test('省略 --workflow：不触发任何 setMany 调用（零回归，同此前行为逐字一致）', async () => {
    const deps = makeDeps()
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' })
    expect(code).toBe(0)
    expect(deps.store.setMany.calls).toHaveLength(0)
  })

  test('显式 --workflow default：等同省略，不触发 setMany（default 走 store.init 自身的老路径）', async () => {
    const deps = makeDeps()
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full', workflow: 'default' })
    expect(code).toBe(0)
    expect(deps.store.setMany.calls).toHaveLength(0)
  })

  test('--workflow 指向不存在的文件：exit 1，store.init 完全不被调用（先校验后落盘，不留半成品 change）', async () => {
    const deps = makeDeps()
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full', workflow: 'ghost' })
    expect(code).toBe(1)
    expect(deps.store.init.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain("workflow 'ghost' 未找到")
  })

  test('合法自定义 workflow：customStart 随 initChange 一次调用整体发布，不再有第二次 setMany' +
    '（第 7 轮 codex review P1：此前 initChange 建出 default/open 后再补一次 setMany 改成' +
    'custom/首 step，两次写之间的并发 transition 会对 provisional default/open 提交' +
    'canonical record，且第二次写失败会留下一个错误的 default change——真实 fs 落盘结果的覆盖见' +
    'init-workflow.integration.test.ts，这里专门证明"只有一次写"这个调用形状本身：loadWorkflow' +
    '是硬 fs 依赖、不经 deps 注入，故只为它开一个真实临时目录，store/runRepo/history 仍全 mock）',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'init-custom-wf-'))
    try {
      await mkdir(join(cwd, '.pipeline', 'workflows'), { recursive: true })
      await writeFile(join(cwd, '.pipeline', 'workflows', 'onboarding.yaml'), TWO_STEP_WF, 'utf8')
      const deps = makeDeps({ cwd })
      const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full', workflow: 'onboarding' })
      expect(code).toBe(0)
      // 核心断言：initialWorkflow 随 initChange（内部真调 store.init，见 mockWorkflowRunRepository）
      // 唯一一次调用整体传入，且 setMany 完全不再被调用（旧实现会在这里留一条
      // setMany({workflow:'onboarding', phase:'intake'}) 调用记录——两次写的第二次）。
      expect(deps.store.setMany.calls).toHaveLength(0)
      expect(deps.store.init.calls).toHaveLength(1)
      expect(deps.store.init.calls[0]?.[0]?.initialWorkflow).toMatchObject({
        workflow: 'onboarding',
        phase: 'intake',
        workflowPlanFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        workflowPlanSnapshot: {
          version: 4,
          workflowId: 'onboarding',
          workflowFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          decomposition: { version: 'v1', mode: 'off' },
          interaction: { version: 'v1', mode: 'interactive' },
          workflow: {
            decomposition: { version: 'v1', mode: 'off' },
            interaction: { version: 'v1', mode: 'interactive' },
          },
        },
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * 项目注册表 best-effort 自动登记（v5 T2 决策 D）：init 成功后把 repoRoot 交给
 * deps.registerProject；铁律 = 注册表任何故障都不得让 init 失败（exit 0 + WARN 走 stderr）。
 */
describe('init 项目注册表登记（决策 D，best-effort）', () => {
  test('成功：registerProject 收到 deps.cwd（repoRoot），exit 0', async () => {
    const deps = makeDeps()
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' })
    expect(code).toBe(0)
    expect(deps.registeredRoots).toEqual(['/repo'])
  })

  test('registerProject 抛错（注册表损坏/目录不可写）：exit 0 不受影响，stderr 出 WARN 行', async () => {
    const deps = makeDeps()
    deps.registerProject = async () => {
      throw new Error('EACCES: permission denied')
    }
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' })
    expect(code).toBe(0)
    expect(deps.errLines.some((l) => l.startsWith('WARN:') && l.includes('EACCES'))).toBe(true)
    // [INIT] 主输出不受注册表故障影响
    expect(deps.errLines).toContain('[INIT] /repo/openspec/changes/demo')
  })

  test('registerProject 未注入（可选依赖缺省）：行为与此前完全一致，exit 0', async () => {
    const deps = makeDeps()
    deps.registerProject = undefined
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' })
    expect(code).toBe(0)
    expect(deps.errLines).toEqual(['[INIT] /repo/openspec/changes/demo'])
  })

  test('init 失败（store.init 抛错）：不触发登记', async () => {
    const deps = makeDeps()
    deps.store.init = spy(async (_o: InitOptions): Promise<string> => {
      throw new Error('已存在')
    })
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' })
    expect(code).toBe(1)
    expect(deps.registeredRoots).toEqual([])
  })

  test('前置校验失败（非法 track）：不触发登记', async () => {
    const deps = makeDeps()
    const code = await cmdInit(deps, 'demo', { track: 'devops', preset: 'full' })
    expect(code).toBe(1)
    expect(deps.registeredRoots).toEqual([])
  })
})

/**
 * 交互向导（BT6 小白友好）：track/preset 缺失且 TTY → 逐项问答收齐；非 TTY 缺参 fail-loud；
 * 已给 flag → 向导整体跳过走原路径（golden-oracle 双跑守的非交互主线零回归）。
 * 注入 fake InitWizardEnv（isInteractive + 脚本化 makePrompter）驱动，无真 TTY。
 */
describe('init —— 交互向导（fake InitWizardEnv 注入）', () => {
  test('① 交互态缺 track/preset：向导问答 → 用答案建 change（track/preset 正确透传 store.init）', async () => {
    // 问题顺序：track, preset, workflow —— 计数断言恰好 3 问（防「多问了问题」被
    // scriptedPrompter 的 ?? '' 兜底吞掉的回归）
    const deps = makeDeps()
    let asked = 0
    const inner = scriptedPrompter(['pm', 'full', ''])
    const env: InitWizardEnv = {
      isInteractive: () => true,
      makePrompter: () => ({ ask: (q) => { asked++; return inner.ask(q) }, close: inner.close }),
    }
    const code = await cmdInit(deps, 'demo', {}, env)
    expect(code).toBe(0)
    expect(asked).toBe(3)
    const opts = deps.store.init.calls[0]?.[0]
    expect(opts?.track).toBe('pm')
    expect(opts?.preset).toBe('full')
    expect(deps.errLines).toContain('[INIT] /repo/openspec/changes/demo')
  })

  test('② 已给 track+preset：向导跳过，不造 prompter，走原非交互路径', async () => {
    const deps = makeDeps()
    let made = 0
    const env: InitWizardEnv = {
      isInteractive: () => true,
      makePrompter: () => { made++; return scriptedPrompter([]) },
    }
    const code = await cmdInit(deps, 'demo', { track: 'backend', preset: 'full' }, env)
    expect(code).toBe(0)
    expect(made).toBe(0) // prompter 从未被创建 = 向导整段跳过
    expect(deps.store.init.calls[0]?.[0]?.track).toBe('backend')
    expect(deps.store.init.calls[0]?.[0]?.preset).toBe('full')
    expect(deps.outLines).toEqual([]) // stdout 零回归
  })

  test('③ 非交互缺参：exit 1 + 明确 err，store.init 不被调用', async () => {
    const deps = makeDeps()
    const env: InitWizardEnv = { isInteractive: () => false, makePrompter: () => scriptedPrompter([]) }
    const code = await cmdInit(deps, 'demo', { preset: 'full' }, env)
    expect(code).toBe(1)
    expect(deps.store.init.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain('非交互模式缺少必填项')
  })

  test('④ 向导 track 非法就地重问：收下一个合法值', async () => {
    const deps = makeDeps()
    // 首答 devops 非法 → 打错误提示后重问 → pm 合法
    const env: InitWizardEnv = {
      isInteractive: () => true,
      makePrompter: () => scriptedPrompter(['devops', 'pm', 'full', '']),
    }
    const code = await cmdInit(deps, 'demo', {}, env)
    expect(code).toBe(0)
    expect(deps.store.init.calls[0]?.[0]?.track).toBe('pm')
    expect(deps.errLines.join('\n')).toContain('非法 track')
  })

  test('⑤ 向导 preset 非法（如笔误 ful）就地重问：仅收标准枚举（评审应修——提示列枚举就必须校验）', async () => {
    const deps = makeDeps()
    // 首答 ful 非法 → 错误提示后重问 → full 合法（flag 路径的开放集语义不受影响）
    const env: InitWizardEnv = {
      isInteractive: () => true,
      makePrompter: () => scriptedPrompter(['pm', 'ful', 'full', '']),
    }
    const code = await cmdInit(deps, 'demo', {}, env)
    expect(code).toBe(0)
    expect(deps.store.init.calls[0]?.[0]?.preset).toBe('full')
    expect(deps.errLines.join('\n')).toContain("非法 preset 'ful'")
  })

  test('⑥ flag 已给自定义 preset + 只缺 track：向导回车收下预授权值，不被枚举倒灌拒绝（codex P2）', async () => {
    const deps = makeDeps()
    // --preset my-custom 已给（专家开放集）,缺 --track 进向导:track 答 pm,preset 回车收 flag 默认,
    // workflow 回车空——自定义 preset 必须原样透传,绝不反复重问。
    const env: InitWizardEnv = {
      isInteractive: () => true,
      makePrompter: () => scriptedPrompter(['pm', '', '']),
    }
    const code = await cmdInit(deps, 'demo', { preset: 'my-custom' }, env)
    expect(code).toBe(0)
    expect(deps.store.init.calls[0]?.[0]?.track).toBe('pm')
    expect(deps.store.init.calls[0]?.[0]?.preset).toBe('my-custom')
    expect(deps.errLines.join('\n')).not.toContain('非法 preset')
  })
})
