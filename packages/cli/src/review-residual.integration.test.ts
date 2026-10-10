/**
 * 真实 e2e —— 验证轮次上限与剩余阻断：真临时项目、真 CLI（buildProgram）、真落盘；评审者的报告由用例直接写进
 * `report_path`（模型不跑），`agent record` 读它得到真实的「不通过」结论。
 *
 * 覆盖：未用完时一切照旧；用完后 `next` 改发前进边的评审请求（带待接受的剩余阻断）或 stop；回退边的
 * `review request` / `transition` 被拒；评审请求冻结、委托确认被拒、人工确认接受、转换放行并记历史；
 * 代码变了、评审者有了新运行（含同一候选上带 --rerun-reason 的重跑）接受失效；`tenon set max_rounds` 调整上限。
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { testSystemPaths } from '@tenon/kernel'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FLOW_CATALOG } from './integration-test-flow-support.js'
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'residualchg'
const SESSION = '019f92c7-6e66-7290-9352-f9d915266f14'
const ME = 'tester@tenon.test'
const CJK = /[㐀-鿿＀-￯　-〿]/u
const FINDING = { severity: 'high', location: 'src/a.ts:3', message: 'SQL 拼接' }

const workflow = (name: string, tests: string, verifyEdges = ''): string => `name: ${name}
tracks:
  backend:
    steps:
      - id: spec
        label: 规格
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: spec-done
            to: build
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: build-done
            to: verify
          - event: requirements-changed
            to: spec
      - id: verify
        label: 验证
        gate: review
        max_rounds: 2
        skills: []
        inputs: []
        outputs: []
${tests}        agents:
          reviewers:
            - agent: security
              required: true
              block_at: medium
        guards: []
        transitions:
          - event: verify-pass
            to: done
          - event: verify-fail
            to: build
${verifyEdges}      - id: done
        label: 完结
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

const PLAIN = workflow('residualwf', '')
/** verify 自己再声明一条回 spec 的边：它是 verify 的回退目标，落到 spec 不会让轮次清零，用完后也和 verify-fail 一样被拒。 */
const SELF_SPEC = workflow('residualselfspecwf', '', `          - event: rework-spec
            to: spec
`)
const WITH_SIZE = workflow('residualsizewf', `        tests:
          - id: size
            direction: unit
            command: node -e "process.exit(Number(require('fs').existsSync('FAIL_SIZE')))"
            label: 规模
            timeout_s: 60
        test_policy:
          plan: optional
`)

interface Action { readonly action: string; readonly [key: string]: unknown }
interface StepJson {
  readonly rounds: { readonly current: number; readonly max: number; readonly source: string } | null
  readonly exits: readonly { readonly event: string; readonly ready: boolean; readonly blockers: readonly { readonly code: string }[] }[]
  readonly next: readonly Action[]
}

let h: Harness
let toolUse = 0

async function setup(name: string, body: string): Promise<void> {
  h = await freshHarness()
  await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(h.cwd, '.pipeline', 'workflows', `${name}.yaml`), body, 'utf8')
  await writeFile(join(h.cwd, 'package.json'), '{"name":"residual-fixture","private":true}\n', 'utf8')
  expect(await h.run(['init', CHANGE, '--track', 'backend', '--workflow', name, '--preset', 'full']), h.err.join('\n')).toBe(0)
  expect(await h.run(['session', 'activate', CHANGE, '--host-session', SESSION]), h.err.join('\n')).toBe(0)
}

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

const changeDir = (): string => join(h.cwd, 'openspec', 'changes', CHANGE)

async function loadTenon(): Promise<void> {
  toolUse += 1
  await appendFile(join(changeDir(), '.pipeline-history.jsonl'), `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: tenon' })}\n`, 'utf8')
  expect(await h.run(['internal-native-skill-receipt', CHANGE, 'tenon', 'flow-session', `tool-${toolUse}`, FIXED_CLOCK]), h.err.join('\n')).toBe(0)
}

/** 前几轮都真实走完：进入 verify → 发起 verify-fail 评审 → 确认 → 回到实现 → 再进入 verify。 */
async function enterVerify(): Promise<void> {
  expect(await h.run(['transition', CHANGE, 'build-done']), h.err.join('\n')).toBe(0)
}
async function failBackToBuild(): Promise<void> {
  expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-fail']), h.err.join('\n')).toBe(0)
  expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
  expect(await h.run(['transition', CHANGE, 'verify-fail']), h.err.join('\n')).toBe(0)
}

/** 第 N 轮的验证步：已经真实进入 verify N 次（之前每一轮都经 verify-fail 回到实现）。 */
async function atRound(round: number): Promise<void> {
  expect(await h.run(['transition', CHANGE, 'spec-done']), h.err.join('\n')).toBe(0)
  for (let index = 1; index <= round; index += 1) {
    await enterVerify()
    if (index < round) await failBackToBuild()
  }
  await loadTenon()
}

/** security 评审者在当前候选上给出结论（findings 空 = 通过）；返回这次运行的 id。 */
async function review(findings: readonly typeof FINDING[] = [FINDING], rerunReason?: string): Promise<string> {
  const flags = rerunReason === undefined ? [] : ['--rerun-reason', rerunReason]
  expect(await h.run(['agent', 'prompt', CHANGE, 'security', '--host', 'claude', '--json', ...flags]), h.err.join('\n')).toBe(0)
  const started = JSON.parse(h.out.join('')) as { run_id: string; report_path: string }
  await writeFile(
    join(h.cwd, started.report_path),
    `# security\n\n\`\`\`tenon-result\n${JSON.stringify({ findings })}\n\`\`\`\n`,
    'utf8',
  )
  expect(await h.run(['agent', 'record', CHANGE, started.run_id]), h.err.join('\n')).toBe(0)
  return started.run_id
}

async function step(): Promise<StepJson> {
  expect(await h.run(['status', CHANGE, '--json']), h.err.join('\n')).toBe(0)
  return (JSON.parse(h.out.join('\n')) as { step: StepJson }).step
}

async function historyRows(): Promise<Record<string, unknown>[]> {
  return (await h.readIn(CHANGE, '.pipeline-history.jsonl')).split('\n')
    .filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function sidecar(): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await h.readIn(CHANGE, '.pipeline-review-waivers.json')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const names = (current: StepJson): string[] => current.next.map((action) => action.action)

/** 改一个源文件：代码候选随之变化。 */
async function changeCode(content: string): Promise<void> {
  await mkdir(join(h.cwd, 'src'), { recursive: true })
  await writeFile(join(h.cwd, 'src', 'feature.ts'), content, 'utf8')
}

describe('上限未用完：一切照旧', () => {
  beforeEach(async () => { await setup('residualwf', PLAIN) })

  test('第 1 轮、上限 2，评审者不通过：next 是 verify-fail 的评审请求（没有新字段），verify-pass 的评审请求照旧被拒', async () => {
    await atRound(1)
    await review()
    const current = await step()
    expect(current.rounds).toEqual({ current: 1, max: 2, source: 'workflow' })
    expect(current.next).toEqual([{ action: 'request-review', event: 'verify-fail' }])
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass'])).toBe(2)
    expect(h.out.join('\n')).toContain("评审者 'security' 未通过")
    expect(await sidecar()).toBeUndefined()
  })

  test('第 1 轮：verify-fail 的评审请求 → 确认 → 转换回实现，都照常（真实走完一轮再进入第 2 轮）', async () => {
    await atRound(1)
    await review()
    await failBackToBuild()
    await enterVerify()
    await loadTenon()
    expect((await step()).rounds).toEqual({ current: 2, max: 2, source: 'workflow' })
  })
})

describe('上限用完：next 与强制层', () => {
  beforeEach(async () => { await setup('residualwf', PLAIN) })

  test('第 2 轮仍不通过：next 不再给 verify-fail，改发 verify-pass 的评审请求（residual / rounds / 三条出路）', async () => {
    await atRound(2)
    await review()
    const current = await step()
    expect(current.rounds).toEqual({ current: 2, max: 2, source: 'workflow' })
    expect(current.next).toEqual([{
      action: 'request-review',
      event: 'verify-pass',
      residual: ['reviewer:security'],
      rounds: { current: 2, max: 2, source: 'workflow' },
      alternatives: [
        expect.stringContaining(`tenon set ${CHANGE} max_rounds <N>`),
        // verify 上没有直达 requirements-changed 的边（它声明在 build 上）：先经 verify-fail 回 build，再在 build 上执行。
        expect.stringMatching(new RegExp(`verify-fail.*在 build 上执行 tenon transition ${CHANGE} requirements-changed`, 'u')),
        expect.stringContaining('终止'),
      ],
    }])
    // exits 与命令的拒绝一致：回退边不再就绪（带 rounds-exhausted 阻断），前进边只被评审者的不通过挡着。
    const back = current.exits.find((candidate) => candidate.event === 'verify-fail')
    expect(back).toMatchObject({ ready: false, blockers: [expect.objectContaining({ code: 'rounds-exhausted' })] })
    expect(current.exits.find((candidate) => candidate.event === 'verify-pass')?.blockers.map((blocker) => blocker.code))
      .toEqual(['reviewer-failed'])
  })

  test('回退边的 review request 与 transition 被拒：exit 1，写出已用轮次 2/2、上限与调高上限的命令；zh / en 成对', async () => {
    await atRound(2)
    await review()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-fail'])).toBe(1)
    const zh = h.err.join('\n')
    expect(zh).toContain('2/2')
    expect(zh).toContain(`tenon set ${CHANGE} max_rounds <N>`)
    // 回规格的出路不暗示在 verify 上直接执行就行：当前步骤没有直达的边，要先调高上限经回退边回到实现步。
    expect(zh).toContain('没有直达的边')
    expect(await h.run(['transition', CHANGE, 'verify-fail'])).toBe(1)
    expect(h.err.join('\n')).toContain('2/2')
    expect(h.err.join('\n')).toContain(`tenon set ${CHANGE} max_rounds <N>`)

    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-fail'], { env: { TENON_LANG: 'en' } })).toBe(1)
    const en = h.err.join('\n')
    expect(en).toContain('2/2')
    expect(en).toContain(`tenon set ${CHANGE} max_rounds <N>`)
    expect(en).toContain('no direct edge')
    expect(CJK.test(en.replace(/"确认继续"/gu, ''))).toBe(false)
    // 什么都没写：没有评审请求，任务仍在 verify。
    expect(await h.run(['get', CHANGE, 'phase'])).toBe(0)
    expect(h.out.at(-1)).toBe('verify')
    expect(await sidecar()).toBeUndefined()
  })

  test('调整上限：第 2 轮时设为 1 或 2 仍视为用完，设为 3 才恢复回退（verify-fail 的评审请求可发）', async () => {
    await atRound(2)
    await review()
    for (const value of ['1', '2']) {
      expect(await h.run(['set', CHANGE, 'max_rounds', value]), h.err.join('\n')).toBe(0)
      const current = await step()
      expect(current.rounds, value).toMatchObject({ current: 2, source: 'task' })
      expect(current.next[0], value).toMatchObject({ action: 'request-review', event: 'verify-pass', residual: ['reviewer:security'] })
      expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-fail']), value).toBe(1)
    }
    expect(await h.run(['set', CHANGE, 'max_rounds', '3']), h.err.join('\n')).toBe(0)
    const restored = await step()
    expect(restored.next).toEqual([{ action: 'request-review', event: 'verify-fail' }])
    expect(restored.exits.find((candidate) => candidate.event === 'verify-fail')).toMatchObject({ ready: true, blockers: [] })
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-fail']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', CHANGE, 'verify-fail']), h.err.join('\n')).toBe(0)
  })

  test('不受约束的步骤不受影响：上限用完时 build 的 requirements-changed 照常可用，回到规格后重新计数', async () => {
    await atRound(2)
    // 把上限压到 1（第 2 轮 → 用完），再临时调高到 3 让用户走回实现步；回到实现步后上限又压回 1，build 仍不受约束。
    expect(await h.run(['set', CHANGE, 'max_rounds', '3']), h.err.join('\n')).toBe(0)
    await failBackToBuild()
    expect(await h.run(['set', CHANGE, 'max_rounds', '1']), h.err.join('\n')).toBe(0)
    expect((await step()).rounds).toBeNull()
    expect(await h.run(['transition', CHANGE, 'requirements-changed']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', CHANGE, 'spec-done']), h.err.join('\n')).toBe(0)
    await enterVerify()
    await loadTenon()
    expect((await step()).rounds).toEqual({ current: 1, max: 1, source: 'task' })
  })
})

describe('上限用完：verify 自己声明了回 spec 的边', () => {
  beforeEach(async () => { await setup('residualselfspecwf', SELF_SPEC) })

  test('这条边用完后同样被拒（exits 带 rounds-exhausted、transition exit 1），next 因此不把它当直达命令，回规格不能让轮次清零', async () => {
    await atRound(2)
    await review()
    const current = await step()
    expect(current.exits.find((candidate) => candidate.event === 'rework-spec'))
      .toMatchObject({ ready: false, blockers: [expect.objectContaining({ code: 'rounds-exhausted' })] })
    const alternatives = current.next[0]?.alternatives as readonly string[]
    expect(alternatives[1]).toContain('清零')
    expect(alternatives[1]).not.toContain(`tenon transition ${CHANGE} rework-spec`)
    expect(alternatives[1]).not.toContain(`tenon transition ${CHANGE} requirements-changed`)
    expect(await h.run(['transition', CHANGE, 'rework-spec'])).toBe(1)
    expect(h.err.join('\n')).toContain('2/2')
    expect(await h.run(['get', CHANGE, 'phase'])).toBe(0)
    expect(h.out.at(-1)).toBe('verify')
  })
})

describe('接受剩余阻断', () => {
  beforeEach(async () => {
    await setup('residualwf', PLAIN)
    await atRound(2)
  })

  test('request 放行并逐条列出 reviewer:security、运行、候选与阻断级发现；委托确认被拒、评审保持待确认；人工确认后转换放行并记历史', async () => {
    // 评审者的发现里带终端转义序列：冻结、列出、历史里都只剩去掉控制字符之后的文字。
    const runId = await review([{ ...FINDING, message: `${FINDING.message}\u001b[2K` }])
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    const listed = h.out.join('\n')
    expect(listed).toContain('待接受的剩余阻断 1 项')
    expect(listed).toContain('reviewer:security')
    expect(listed).toContain(runId)
    expect(listed).toContain(`high ${FINDING.location} ${FINDING.message}[2K`)
    expect(listed).not.toContain('\u001b')
    expect(listed).toMatch(/候选 workspace:sha256:[0-9a-f]{64}/u)
    expect((await sidecar())?.residual).toEqual([expect.objectContaining({ key: 'reviewer:security', runId, findings: 1, summary: [`high ${FINDING.location} ${FINDING.message}[2K`] })])
    expect(names(await step())).toEqual(['await-review'])
    expect(await h.run(['transition', CHANGE, 'verify-pass'])).toBe(2)
    expect(await h.run(['check', CHANGE])).toBe(2)

    // 委托确认不接受剩余阻断：拒绝，评审保持待确认，什么都没写。
    expect(await h.run(['session', 'activate', CHANGE, '--continuous', '--host-session', SESSION]), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', CHANGE, '--delegated'], { env: { TENON_HOST_SESSION_ID: SESSION } })).toBe(1)
    expect(h.err.join('\n')).toContain('reviewer:security')
    expect(names(await step())).toEqual(['await-review'])
    expect((await sidecar())?.accepted).toBeUndefined()

    // 人工确认：同一把锁内接受，历史留一行。
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('已接受剩余阻断 1 项：reviewer:security')
    expect((await sidecar())?.accepted).toEqual([expect.objectContaining({
      key: 'reviewer:security', runId, findings: 1, acceptedBy: ME, candidate: expect.stringMatching(/^workspace:sha256:[0-9a-f]{64}$/u),
    })])
    expect((await sidecar())?.residual).toBeUndefined()
    // 接受之后 check 放行，并另出提示（评审者仍不通过，但已被接受）。
    expect(await h.run(['check', CHANGE]), h.out.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain("[WARN] 评审者 'security' 仍不通过")
    const accepted = (await historyRows()).filter((row) => typeof row.raw === 'string' && row.raw.startsWith('review.residual-accepted'))
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.raw).toContain('reviewer=security')
    expect(accepted[0]?.raw).toContain(`run=${runId}`)
    expect(accepted[0]?.raw).toContain('findings=1')
    expect(accepted[0]?.raw).toMatch(/candidate=workspace:sha256:[0-9a-f]{64}/u)
    expect(accepted[0]?.raw).toContain(`by=${ME} summary=high_${FINDING.location}_SQL_拼接[2K`)
    expect(accepted[0]?.raw).not.toContain('\u001b')

    expect((await step()).next).toEqual([{ action: 'transition', event: 'verify-pass' }])
    expect(await h.run(['transition', CHANGE, 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['get', CHANGE, 'phase'])).toBe(0)
    expect(h.out.at(-1)).toBe('done')
  })

  test('AFK 不接受剩余阻断：TENON_AFK=1 的确认被拒，评审保持待确认', async () => {
    await review()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', CHANGE], { env: { TENON_AFK: '1' } })).toBe(1)
    expect(h.err.join('\n')).toContain('reviewer:security')
    expect((await sidecar())?.accepted).toBeUndefined()
    expect(names(await step())).toEqual(['await-review'])
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
  })

  test('代码变了接受失效：评审者在新候选上重跑仍不通过，前进边重新被阻断，next 要求撤回回执重新确认', async () => {
    const first = await review()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(names(await step())).toEqual(['transition'])

    await changeCode('export const x = 1\n')
    const second = await review()
    expect(second).not.toBe(first)
    expect(await h.run(['transition', CHANGE, 'verify-pass'])).toBe(2)
    expect(h.err.join('\n')).toContain('security')
    const stranded = await step()
    expect(stranded.next).toEqual([expect.objectContaining({
      action: 'fix', blockers: [expect.objectContaining({ code: 'residual-unaccepted', message: expect.stringContaining('review revoke') })],
    })])

    // 撤回 → 重新请求（列出新的运行与候选）→ 确认 → 放行。
    expect(await h.run(['review', 'revoke', CHANGE, '--reason', '代码变了，剩余阻断要对新的结论重新确认']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain(second)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', CHANGE, 'verify-pass']), h.err.join('\n')).toBe(0)
  })

  test('同一候选上带 --rerun-reason 重跑得到新运行：接受不覆盖新运行，新运行不通过要重新接受', async () => {
    const first = await review()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)

    const second = await review([FINDING], '补充了设计稿后重跑')
    expect(second).not.toBe(first)
    expect(await h.run(['transition', CHANGE, 'verify-pass'])).toBe(2)
    expect(h.err.join('\n')).toContain('security')
    expect((await step()).next).toEqual([expect.objectContaining({ action: 'fix' })])

    expect(await h.run(['review', 'revoke', CHANGE, '--reason', '评审者有了新运行，要对新运行重新确认']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain(second)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect((await sidecar())?.accepted).toEqual([expect.objectContaining({ runId: second })])
    expect(await h.run(['transition', CHANGE, 'verify-pass']), h.err.join('\n')).toBe(0)
  })

  test('撤回已批准的回执后重新请求：仍不通过的评审者再次列给用户，之前接受过也不悄悄不再出现；再次确认幂等', async () => {
    const runId = await review()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'revoke', CHANGE, '--reason', '确认得太快，要重新过目']), h.err.join('\n')).toBe(0)
    expect((await step()).next).toEqual([expect.objectContaining({ action: 'await-review', event: 'verify-pass' })])

    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('待接受的剩余阻断 1 项')
    expect(h.out.join('\n')).toContain(runId)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect((await sidecar())?.accepted).toHaveLength(1)
    expect(await h.run(['transition', CHANGE, 'verify-pass']), h.err.join('\n')).toBe(0)
  })

  test('评审者在当前候选上通过时不冻结任何剩余阻断，request 与以前一致', async () => {
    await review([])
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).not.toContain('剩余阻断')
    expect(await sidecar()).toBeUndefined()
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).not.toContain('剩余阻断')
    expect(await h.run(['transition', CHANGE, 'verify-pass']), h.err.join('\n')).toBe(0)
  })

  test('评审者缺失 / 过期仍然拦着 request：剩余阻断只覆盖「评审者在当前候选上不通过」', async () => {
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass'])).toBe(2)
    await review()
    await changeCode('export const y = 2\n')
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass'])).toBe(2)
    expect(await sidecar()).toBeUndefined()
  })
})

describe('失败的必需测试仍走步骤测试豁免', () => {
  beforeEach(async () => {
    await setup('residualsizewf', WITH_SIZE)
    const catalog = testSystemPaths(h.cwd).catalog
    await mkdir(join(catalog, '..'), { recursive: true })
    await writeFile(catalog, FLOW_CATALOG, 'utf8')
    // 第 1 轮 size 通过（没有 FAIL_SIZE），经 verify-fail 回到实现；第 2 轮放进 FAIL_SIZE（代码变了、记录过期），size 失败。
    expect(await h.run(['transition', CHANGE, 'spec-done']), h.err.join('\n')).toBe(0)
    await enterVerify()
    expect(await h.run(['test', 'run', CHANGE, 'size']), h.err.join('\n')).toBe(0)
    await failBackToBuild()
    await enterVerify()
    await loadTenon()
    await writeFile(join(h.cwd, 'FAIL_SIZE'), '1\n', 'utf8')
    expect(await h.run(['test', 'run', CHANGE, 'size'])).toBe(2)
  })

  test('没有登记豁免：next 是 stop rounds-exhausted（点名 size、登记豁免与三条出路），request 与 transition 照旧被拒', async () => {
    // 必需测试没有豁免，评审者还在等它（agent prompt 被拒）；用完之后 next 不再催着重跑 size，也不给回退边。
    const current = await step()
    expect(current.next).toEqual([expect.objectContaining({ action: 'stop', code: 'rounds-exhausted' })])
    const message = String(current.next[0]?.message)
    expect(message).toContain('2/2')
    expect(message).toContain('size')
    expect(message).toContain(`tenon test waive ${CHANGE} --test`)
    expect(message).toContain(`tenon set ${CHANGE} max_rounds <N>`)
    expect(message).toContain('requirements-changed')
    expect(message).toContain('终止')
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass'])).not.toBe(0)
    expect(await h.run(['transition', CHANGE, 'verify-fail'])).toBe(1)
  })

  test('登记豁免之后：waivers 与 residual 并存的评审请求，一次确认同时批准豁免、接受剩余阻断，转换放行', async () => {
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', '迁移脚本一次性生成，规模超限属实']), h.err.join('\n')).toBe(0)
    await review()
    expect((await step()).next).toEqual([expect.objectContaining({
      action: 'request-review', event: 'verify-pass', waivers: ['test:size'], residual: ['reviewer:security'],
    })])
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('test:size')
    expect(h.out.join('\n')).toContain('reviewer:security')
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('已批准豁免 1 项：test:size')
    expect(h.out.join('\n')).toContain('已接受剩余阻断 1 项：reviewer:security')
    expect(await h.run(['transition', CHANGE, 'verify-pass']), h.err.join('\n')).toBe(0)
  })
})
