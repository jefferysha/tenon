/**
 * 回归锚：`tenon check` 与 `tenon transition` 必须对同一份状态给出同一个答案。
 *
 * 0.1.0 的实测事故（真机 headless 会话，backend track）：
 *   $ tenon check health-endpoint          → [PASS] 所有检查通过，exits[explore-complete] ready=true
 *   $ tenon transition health-endpoint explore-complete
 *   ERROR: step 'explore' 尚未完成声明的 skill： …  exit=2
 * 技能 DAG 那时只有 transition 看得见，check 与 status 的 exits[].blockers 投影都没有它，
 * 于是用户被一条命令告知「全过了」、又被下一条拒绝，无从判断哪句是真的。
 *
 * 本文件用真 harness（真 fs、真 manifest 派生的 mandatory_skills、真 PostToolUse skill-tracker
 * 记账）在一个非 review 相位（open：`open._all: [openspec-propose]`）上，把两条命令跑在同一个
 * 状态上逐条对齐：技能缺失时两条都拒、技能齐备时两条都过。
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, recordWorkflowPhaseSkill, rm, type Harness } from './integration-harness.js'

const CHANGE = 'skillagree'
const TRACK = 'backend'

describe('check ⇔ transition：技能门不得只有一边看得见', () => {
  let h: Harness
  let changeDir: string

  beforeEach(async () => {
    h = await freshHarness()
    changeDir = join(h.cwd, 'openspec', 'changes', CHANGE)
    expect(await h.run(['init', CHANGE, '--track', TRACK, '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    // autoSkills:false —— 技能证据正是本用例要观察的变量，夹具不许替它补上。
    await h.seedGovernedDocumentEvidence(CHANGE, { autoSkills: false })
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('技能未完成：check 退 2 并点名该 token，transition 拒绝同一个 token', async () => {
    const check = await h.run(['check', CHANGE])
    const checkOut = h.out.join('\n')
    expect(check, `check 应随 transition 一起拒绝：\n${checkOut}`).toBe(2)
    expect(checkOut).toContain("[FAIL] skill: step 'open' 尚未完成声明的 skill：openspec-propose")

    const transition = await h.run(['transition', CHANGE, 'open-complete'])
    const transitionErr = h.err.join('\n')
    expect(transition, `transition 应退 2：\n${transitionErr}`).toBe(2)
    expect(transitionErr).toContain("step 'open' 尚未完成声明的 skill")
    expect(transitionErr).toContain('openspec-propose')
    // 拒绝必须真拦住：相位不动。
    expect(await h.read(CHANGE)).toMatch(/^phase: open$/m)
  })

  test('status 的出边投影与 check / transition 同源：blockers 里带 skill 来源', async () => {
    expect(await h.run(['status', CHANGE, '--json'])).toBe(0)
    const payload = JSON.parse(h.out.join('\n')) as {
      step: {
        exits: readonly { event: string; ready: boolean; blockers: readonly { source: string; message: string }[] }[]
        next: readonly { action: string }[]
      }
    }
    const exit = payload.step.exits.find((candidate) => candidate.event === 'open-complete')
    expect(exit?.ready, 'ready=true 曾经是这条 bug 的门面').toBe(false)
    expect(exit?.blockers.some((blocker) =>
      blocker.source === 'skill' && blocker.message.includes('openspec-propose'))).toBe(true)
  })

  test('技能齐备：两条命令一起放行', async () => {
    await recordWorkflowPhaseSkill(h.cwd, changeDir, 'tenon')
    await recordWorkflowPhaseSkill(h.cwd, changeDir, 'openspec-propose')

    const check = await h.run(['check', CHANGE])
    expect(check, `check 应放行：\n${h.out.join('\n')}`).toBe(0)
    expect(h.out.join('\n')).toContain('[PASS] 所有检查通过')

    expect(await h.run(['transition', CHANGE, 'open-complete']), h.err.join('\n')).toBe(0)
    expect(await h.read(CHANGE)).toMatch(/^phase: explore$/m)
  })
})
