/**
 * 真实 e2e —— 退回边不要求执行者的技能（default 工作流，真 fs、真 harness、真 `tenon init` 冻结的 builder）。
 *
 * 场景：任务刚进入实现步，`test-driven-development` 归执行者 builder（只能在 builder 运行期间加载），本次访问还没有
 * 任何 builder 运行与 TDD 回执。此时 `requirements-changed` 回到规格必须能走（修问题的路不能被「得先开始一个
 * builder」堵住），而前进边 `build-complete` 仍因缺 TDD 被拒。`tenon transition`、`tenon status`、`tenon check`
 * 对同一份状态给出同一个答案。不归属任何 agent 的主线技能在退回边上照旧要求。
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cmdCheck } from './commands/check.js'
import { freshHarness, realDeps, rm, type Harness } from './integration-harness.js'

const CHANGE = 'backedge'

interface StatusExit {
  readonly event: string
  readonly direction: string
  readonly ready: boolean
  readonly blockers: readonly { readonly source: string; readonly code: string; readonly message: string; readonly subject?: string }[]
}

describe('退回边的技能门（CLI）', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full']), h.err.join('\n')).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    // autoSkills:false —— 技能回执正是本用例观察的变量，夹具不许替它补上。
    await h.seedGovernedDocumentEvidence(CHANGE, { autoSkills: false })
    await h.seedPhase(CHANGE, 'build')
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  async function exits(): Promise<readonly StatusExit[]> {
    expect(await h.run(['status', CHANGE, '--json']), h.err.join('\n')).toBe(0)
    return (JSON.parse(h.out.join('\n')) as { step: { exits: readonly StatusExit[] } }).step.exits
  }

  test('requirements-changed 成功回到规格，没有 builder 运行与 TDD 回执也不被拦', async () => {
    expect(await h.run(['transition', CHANGE, 'requirements-changed']), h.err.join('\n')).toBe(0)
    expect(await h.read(CHANGE)).toMatch(/^phase: spec$/m)
  })

  test('build-complete 仍被拒：step-skills-incomplete 点名 test-driven-development，相位不动', async () => {
    // 前进边的其它前置条件都满足，只剩技能门这一个变量。
    await h.seedArtifact(CHANGE, 'build_mode', 'direct')
    await h.seedArtifact(CHANGE, 'direct_override', 'true')
    await h.seedArtifact(CHANGE, 'isolation', 'branch')
    await h.seedArtifact(CHANGE, 'pre_verify_review_result', 'pass')
    const code = await h.run(['transition', CHANGE, 'build-complete'])
    const stderr = h.err.join('\n')
    expect(code, stderr).toBe(2)
    expect(stderr).toContain("step 'build' 尚未完成声明的 skill")
    expect(stderr).toContain('test-driven-development')
    expect(await h.read(CHANGE)).toMatch(/^phase: build$/m)
  })

  test('status --json：requirements-changed 出口 ready 且没有 skill 类阻断；build-complete 仍有 test-driven-development', async () => {
    const list = await exits()
    const back = list.find((exit) => exit.event === 'requirements-changed')
    const forward = list.find((exit) => exit.event === 'build-complete')
    expect(back).toMatchObject({ direction: 'back', ready: true })
    expect(back?.blockers.filter((blocker) => blocker.source === 'skill')).toEqual([])
    expect(forward?.ready).toBe(false)
    expect(forward?.blockers.some((blocker) => blocker.source === 'skill' && blocker.subject === 'test-driven-development')).toBe(true)
  })

  test('check 预览：指定退回边（review request 的预检就是这么调的）不列 TDD；前进边与不指定边时列', async () => {
    const preview = async (event?: string): Promise<string> => {
      const out: string[] = []
      await cmdCheck(realDeps(h.cwd, out, []), CHANGE, event === undefined ? {} : { event })
      return out.join('\n')
    }
    expect(await preview('requirements-changed')).not.toContain('test-driven-development')
    expect(await preview('build-complete')).toContain("step 'build' 尚未完成声明的 skill：test-driven-development")
    expect(await preview()).toContain("step 'build' 尚未完成声明的 skill：test-driven-development")
  })

  test('主线技能在退回边上仍被要求：验证步缺 verification-before-completion 时 verify-fail 被拒，status 的 verify-fail 出口也有 skill 阻断', async () => {
    await h.seedPhase(CHANGE, 'verify')
    const list = await exits()
    const back = list.find((exit) => exit.event === 'verify-fail')
    expect(back).toMatchObject({ direction: 'back', ready: false })
    expect(back?.blockers.some((blocker) =>
      blocker.source === 'skill' && blocker.subject === 'verification-before-completion')).toBe(true)
    const code = await h.run(['transition', CHANGE, 'verify-fail'])
    expect(code, h.err.join('\n')).toBe(2)
    expect(h.err.join('\n')).toContain('verification-before-completion')
    expect(await h.read(CHANGE)).toMatch(/^phase: verify$/m)
  })
})
