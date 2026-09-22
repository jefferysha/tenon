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
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, recordWorkflowPhaseSkill, rm, type Harness } from './integration-harness.js'

interface StatusStep {
  readonly step: {
    readonly fields: readonly { field: string; status: string; required: readonly string[] | null }[]
    readonly exits: readonly {
      event: string
      ready: boolean
      blockers: readonly { source: string; message: string }[]
    }[]
    readonly next: readonly { action: string; blockers?: readonly { message: string }[] }[]
  }
}

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

/**
 * 同一条 bug 的第二种形态：相位出口规则表（kernel flow/guard.ts 的 EXIT_RULES）此前只有
 * `tenon check` 一个调用点。真机实测的 pm 任务：
 *   $ tenon check pm2                       → [FAIL] ship 出口：要求 prd_path 非空  exit=2
 *   $ tenon status pm2 --json               → exits[ship-complete].ready=true, blockers=[]
 *   $ tenon transition pm2 ship-complete    → [TRANSITION] pm2: ship -> archive      exit=0
 * 两个 pm 任务就这样带着 prd_path=null 归了档。default 的 ship / archive 步 gate=null，
 * `tenon` skill 又只在 request-review 下跑 check，所以那几步没有任何东西在评估这张表。
 */
describe('check ⇔ status ⇔ transition：相位出口规则表不得只有 check 看得见', () => {
  const PM = 'pmgate'
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    expect(await h.run(['init', PM, '--track', 'pm', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', PM])).toBe(0)
    await h.seedGovernedDocumentEvidence(PM)
    await h.seedAppliedSpec(PM)
    // 本用例的主题是 ship 出口规则，不是前面六相位的推进；相位直接置于 ship。
    await h.seedPhase(PM, 'ship')
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  async function status(): Promise<StatusStep['step']> {
    expect(await h.run(['status', PM, '--json']), h.err.join('\n')).toBe(0)
    return (JSON.parse(h.out.join('\n')) as StatusStep).step
  }

  test('pm ship 且 prd_path=null：三条命令同判，且相位不动', async () => {
    expect(await h.run(['get', PM, 'prd_path'])).toBe(0)
    expect(h.out.join('').trim()).toBe('null')

    const check = await h.run(['check', PM])
    const checkOut = h.out.join('\n')
    expect(check, checkOut).toBe(2)
    expect(checkOut).toContain('ship 出口：要求 prd_path 非空')

    const step = await status()
    const exit = step.exits.find((candidate) => candidate.event === 'ship-complete')
    expect(exit?.ready, 'ready=true 曾经是这条 bug 的门面').toBe(false)
    expect(exit?.blockers.some((blocker) =>
      blocker.source === 'guard' && blocker.message.includes('prd_path'))).toBe(true)
    // pm 的 ship 交付物是 PRD，不是 PR：投影点名的字段必须与 guard 点名的是同一个。
    expect(step.fields.some((field) => field.field === 'prd_path' && field.status === 'missing')).toBe(true)
    expect(step.fields.some((field) => field.field === 'pr_url')).toBe(false)

    // 通往 完结（archive）的那条边逐字给出拒绝行；相位不动。
    const transition = await h.run(['transition', PM, 'ship-complete'])
    expect(transition, h.err.join('\n')).toBe(2)
    const stderr = h.err.join('\n')
    expect(stderr).toContain("ERROR: step 'ship' guard 未通过：")
    expect(stderr).toContain("ship 出口：要求 prd_path 非空（当前='null'）")
    expect(stderr).toContain("ship 出口：要求 prd_path 文件存在 (pm track)（当前='null'）")
    expect(await h.read(PM)).toMatch(/^phase: ship$/m)
    expect(await h.read(PM)).toMatch(/^archived: false$/m)
  })

  test('补齐 prd_path 后三条命令一起放行', async () => {
    await writeFile(join(h.cwd, 'docs', 'prd.md'), '# PRD\n', 'utf8')
    expect(await h.run(['set', PM, 'prd_path', 'docs/prd.md']), h.err.join('\n')).toBe(0)

    expect(await h.run(['check', PM]), h.out.join('\n')).toBe(0)
    const step = await status()
    expect(step.exits.find((candidate) => candidate.event === 'ship-complete')?.ready).toBe(true)
    expect(await h.run(['transition', PM, 'ship-complete']), h.err.join('\n')).toBe(0)
    expect(await h.read(PM)).toMatch(/^phase: archive$/m)
  })

  test('pm verify 且 verify_result=pending：check 与 status 同判，字段进投影', async () => {
    await h.seedPhase(PM, 'verify')
    await h.seedArtifact(PM, 'verification_report', `docs/superpowers/reports/${PM}.md`)
    expect(await h.run(['set', PM, 'branch_status', 'handled'])).toBe(0)

    const check = await h.run(['check', PM])
    expect(check, h.out.join('\n')).toBe(2)
    expect(h.out.join('\n')).toContain('verify 出口：要求 verify_result=pass')

    const step = await status()
    const exit = step.exits.find((candidate) => candidate.event === 'verify-pass')
    expect(exit?.ready).toBe(false)
    expect(exit?.blockers.some((blocker) => blocker.message.includes('verify_result'))).toBe(true)
    // 运行器要能照着投影把它填上，而不是在 request-review 上空转。
    const field = step.fields.find((candidate) => candidate.field === 'verify_result')
    expect(field?.status).toBe('missing')
    expect(field?.required).toEqual(['pass'])
  })
})
