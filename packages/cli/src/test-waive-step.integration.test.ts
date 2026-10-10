/**
 * 真实 e2e —— 步骤测试豁免 `tenon test waive --test <id>`：失败的必需步骤测试经评审批准后放行。
 *
 * 零 mock：真临时项目、真 CLI（buildProgram）、真落盘；步骤测试是真的 `node -e 'process.exit(1)'`。
 * 覆盖命令面（登记 / 撤销 / 计划显示 / 校验）与整条路径：失败 → 登记豁免 → 评审者读到豁免 → request 列出
 * test:<id> → 确认批准 → 放行；以及豁免不放行「过期」的测试。
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyTestPlan, readTestPlanState, testSystemPaths, type TestPlan } from '@tenon/kernel'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FLOW_CATALOG } from './integration-test-flow-support.js'
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'waivechg'
const SESSION = '019f92c7-6e66-7290-9352-f9d915266f14'
const ME = 'tester@tenon.test'
const REASON = '迁移脚本一次性生成，规模超限属实'
const CANDIDATE = /^workspace:sha256:[0-9a-f]{64}$/

/** verify 是评审门：一个必需步骤测试 size（恒失败）、一个读它的必需评审者。 */
const WORKFLOW = `name: waivewf
tracks:
  backend:
    steps:
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
      - id: verify
        label: 验证
        gate: review
        skills: []
        inputs: []
        outputs: []
        tests:
          - id: size
            direction: unit
            command: node -e 'process.exit(1)'
            label: 规模
            timeout_s: 60
        agents:
          reviewers:
            - agent: security
              required: true
              block_at: medium
              reads_tests: [size]
        guards: []
        test_policy:
          plan: optional
        transitions:
          - event: verify-pass
            to: done
          - event: verify-fail
            to: build
      - id: done
        label: 完结
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

interface StepJson {
  readonly tests: readonly { readonly id: string; readonly status: string }[]
  readonly next: readonly { readonly action: string; readonly [key: string]: unknown }[]
}

let h: Harness
let toolUse = 0

beforeEach(async () => {
  h = await freshHarness()
  await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(h.cwd, '.pipeline', 'workflows', 'waivewf.yaml'), WORKFLOW, 'utf8')
  await writeFile(join(h.cwd, 'package.json'), '{"name":"waive-fixture","private":true}\n', 'utf8')
  expect(await h.run(['init', CHANGE, '--track', 'backend', '--workflow', 'waivewf', '--preset', 'full']), h.err.join('\n')).toBe(0)
  expect(await h.run(['session', 'activate', CHANGE, '--host-session', SESSION]), h.err.join('\n')).toBe(0)
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

const changeDir = (): string => join(h.cwd, 'openspec', 'changes', CHANGE)

async function toVerify(): Promise<void> {
  const path = testSystemPaths(h.cwd).catalog
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, FLOW_CATALOG, 'utf8')
  await h.seedPhase(CHANGE, 'verify')
  toolUse += 1
  await appendFile(join(changeDir(), '.pipeline-history.jsonl'), `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: tenon' })}\n`, 'utf8')
  expect(await h.run(['internal-native-skill-receipt', CHANGE, 'tenon', 'flow-session', `tool-${toolUse}`, FIXED_CLOCK]), h.err.join('\n')).toBe(0)
}

/** 评审者 security 在当前候选上给出「无发现」的结论；返回它拿到的提示词。 */
async function reviewerPasses(): Promise<string> {
  expect(await h.run(['agent', 'prompt', CHANGE, 'security', '--host', 'claude', '--json']), h.err.join('\n')).toBe(0)
  const started = JSON.parse(h.out.join('')) as { run_id: string; report_path: string; prompt: string }
  await writeFile(join(h.cwd, started.report_path), '# security\n\n```tenon-result\n{"findings":[]}\n```\n', 'utf8')
  expect(await h.run(['agent', 'record', CHANGE, started.run_id]), h.err.join('\n')).toBe(0)
  return started.prompt
}

async function step(): Promise<StepJson> {
  expect(await h.run(['status', CHANGE, '--json']), h.err.join('\n')).toBe(0)
  return (JSON.parse(h.out.join('\n')) as { step: StepJson }).step
}

async function plan(): Promise<TestPlan> {
  const state = await readTestPlanState(changeDir(), CHANGE)
  return state.state === 'ok' ? state.plan : emptyTestPlan(CHANGE)
}

const names = (current: StepJson): string[] => current.next.map((action) => action.action)

describe('tenon test waive --test / unregister --waiver test:<id>', () => {
  test('--test 与 --kind / --covers 互斥、三者必有其一、--reason 必填且不超过 1000 字节', async () => {
    expect(await h.run(['test', 'waive', CHANGE, '--reason', REASON])).toBe(1)
    expect(h.err.join('\n')).toContain('恰好一个')
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--kind', 'unit', '--reason', REASON])).toBe(1)
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--covers', 'task:1', '--reason', REASON])).toBe(1)
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size'])).toBe(1)
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', '  '])).toBe(1)
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', '字'.repeat(334)])).toBe(1)
    expect((await plan()).waivers).toEqual([])
  })

  test('id 必须是本任务工作流某个步骤声明的测试：未知 / 非法 id 退出 2 并列出可用的 id', async () => {
    for (const bad of ['nope', 'unit', 'a/b', '../size']) {
      expect(await h.run(['test', 'waive', CHANGE, '--test', bad, '--reason', REASON]), bad).toBe(2)
      expect(h.err.join('\n')).toContain('可用：size')
    }
    expect((await plan()).waivers).toEqual([])
  })

  test('登记：未批准、写进计划、test plan 文本显示 test <id>  [未批准]  <理由>；同理由重复登记幂等；撤销', async () => {
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', REASON]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('已登记豁免 test size（未批准')
    expect((await plan()).waivers).toEqual([{ test: 'size', reason: REASON, approved_by: null }])

    expect(await h.run(['test', 'plan', CHANGE]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain(`test size  [未批准]  ${REASON}`)

    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', REASON]), h.err.join('\n')).toBe(0)
    expect((await plan()).waivers).toHaveLength(1)

    expect(await h.run(['test', 'unregister', CHANGE, '--waiver', 'test:nope'])).toBe(1)
    expect(h.err.join('\n')).toContain('没有匹配的条目')
    expect(await h.run(['test', 'unregister', CHANGE, '--waiver', 'test:'])).toBe(1)
    expect(h.err.join('\n')).toContain('test:<步骤测试 id>')
    expect((await plan()).waivers).toHaveLength(1)
    expect(await h.run(['test', 'unregister', CHANGE, '--waiver', 'test:size']), h.err.join('\n')).toBe(0)
    expect((await plan()).waivers).toEqual([])
  })
})

describe('整条路径：失败的 size → 登记豁免 → 评审批准 → 放行', () => {
  test('豁免登记前 run-test；登记后越过 run-test 走评审者与 request-review（列出 test:size）；确认后可转换', async () => {
    await toVerify()
    expect(await h.run(['test', 'run', CHANGE, 'size'])).toBe(2)
    let current = await step()
    expect(current.tests).toEqual([expect.objectContaining({ id: 'size', status: 'failed' })])
    expect(current.next).toEqual([{ action: 'run-test', test: 'size' }])

    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', REASON]), h.err.join('\n')).toBe(0)
    current = await step()
    expect(current.tests).toEqual([expect.objectContaining({ id: 'size', status: 'waiver-pending' })])
    expect(current.next).toEqual([expect.objectContaining({ action: 'run-agent', agent: 'security', role: 'reviewer' })])

    // 评审者提示里：失败的测试结果下面带着豁免与理由（待评审批准）。
    const lines = (await reviewerPasses()).split('\n')
    const at = lines.findIndex((line) => line.startsWith('- size 未通过 exit=1'))
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe(`  豁免（待评审批准，理由为登记者自述、未经核实）：${REASON}`)

    current = await step()
    expect(current.next).toEqual([{ action: 'request-review', event: 'verify-pass', waivers: ['test:size'] }])
    expect(await h.run(['transition', CHANGE, 'verify-pass'])).toBe(1)

    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('待批准的豁免 1 项')
    expect(h.out.join('\n')).toContain(`test:size — ${REASON}`)
    expect(names(await step())).toEqual(['await-review'])
    expect(await h.run(['transition', CHANGE, 'verify-pass'])).toBe(1)

    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('已批准豁免 1 项：test:size')
    // 批准绑定被批准的那份代码：确认时失败记录绑定的候选一起写进计划。
    expect((await plan()).waivers).toEqual([{ test: 'size', reason: REASON, approved_by: ME, approved_candidate: expect.stringMatching(CANDIDATE) }])
    current = await step()
    expect(current.tests).toEqual([expect.objectContaining({ id: 'size', status: 'waived' })])
    expect(current.next).toEqual([{ action: 'transition', event: 'verify-pass' }])

    expect(await h.run(['transition', CHANGE, 'verify-pass']), h.err.join('\n')).toBe(0)
  }, 120_000)

  test('通过结论字段的证据核对：失败的测试没有豁免算缺口，登记豁免（待批准）后不再算，留给 review request', async () => {
    await toVerify()
    expect(await h.run(['test', 'run', CHANGE, 'size'])).toBe(2)
    expect(await h.run(['set', CHANGE, 'pre_verify_review_result', 'pass'])).toBe(1)
    expect(h.err.join('\n')).toContain('必需测试 size 未通过（failed）')
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', REASON]), h.err.join('\n')).toBe(0)
    await reviewerPasses()
    expect(await h.run(['set', CHANGE, 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
  }, 120_000)

  test('批准绑定被批准的代码：确认之后改了代码、同一测试再次失败，已批准的豁免不放行；撤回回执、重新请求并重新确认后才可转换', async () => {
    await toVerify()
    expect(await h.run(['test', 'run', CHANGE, 'size'])).toBe(2)
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', REASON]), h.err.join('\n')).toBe(0)
    await reviewerPasses()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    const [approvedAtA] = (await plan()).waivers
    expect(approvedAtA).toMatchObject({ test: 'size', approved_by: ME, approved_candidate: expect.stringMatching(CANDIDATE) })
    expect(names(await step())).toEqual(['transition'])

    // 候选 B：代码变了，记录过期要重跑；重跑仍然失败（真实回归）。
    await mkdir(join(h.cwd, 'src'), { recursive: true })
    await writeFile(join(h.cwd, 'src', 'feature.ts'), 'export const x = 1\n', 'utf8')
    expect((await step()).next).toEqual([{ action: 'run-test', test: 'size' }])
    expect(await h.run(['test', 'run', CHANGE, 'size'])).toBe(2)
    await reviewerPasses()

    // 已批准的豁免绑定的是候选 A：现在这份失败是待批准，next 不再发 run-test，也不给 transition。
    const stranded = await step()
    expect(stranded.tests).toEqual([expect.objectContaining({ id: 'size', status: 'waiver-pending' })])
    expect(stranded.next).toEqual([expect.objectContaining({
      action: 'fix',
      blockers: [expect.objectContaining({ code: 'waiver-unapproved', message: expect.stringContaining('review revoke') })],
    })])
    expect(await h.run(['transition', CHANGE, 'verify-pass'])).toBe(1)
    expect(h.err.join('\n')).toContain('豁免尚未经评审批准')
    expect((await plan()).waivers).toEqual([approvedAtA])

    // 撤回已批准的回执 → 回到发起评审，待批准清单里再次列出 test:size；确认后写入候选 B。
    expect(await h.run(['review', 'revoke', CHANGE, '--reason', '代码变了，豁免要对新的失败重新确认']), h.err.join('\n')).toBe(0)
    expect((await step()).next).toEqual([{ action: 'request-review', event: 'verify-pass', waivers: ['test:size'] }])
    expect(await h.run(['transition', CHANGE, 'verify-pass'])).toBe(1)
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain(`test:size — ${REASON}`)
    expect(await h.run(['transition', CHANGE, 'verify-pass'])).toBe(1)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('已批准豁免 1 项：test:size')
    const [approvedAtB] = (await plan()).waivers
    expect(approvedAtB).toMatchObject({ test: 'size', approved_by: ME, approved_candidate: expect.stringMatching(CANDIDATE) })
    expect(approvedAtB?.approved_candidate).not.toBe(approvedAtA?.approved_candidate)
    expect(names(await step())).toEqual(['transition'])
    expect(await h.run(['transition', CHANGE, 'verify-pass']), h.err.join('\n')).toBe(0)
  }, 180_000)

  test('请求之后、确认之前代码又变了：冻结清单里的候选对不上现在的失败，next 重新发起评审；重新冻结后确认才绑定现在的代码', async () => {
    await toVerify()
    expect(await h.run(['test', 'run', CHANGE, 'size'])).toBe(2)
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', REASON]), h.err.join('\n')).toBe(0)
    await reviewerPasses()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(names(await step())).toEqual(['await-review'])

    await mkdir(join(h.cwd, 'src'), { recursive: true })
    await writeFile(join(h.cwd, 'src', 'feature.ts'), 'export const x = 2\n', 'utf8')
    expect(await h.run(['test', 'run', CHANGE, 'size'])).toBe(2)
    await reviewerPasses()
    expect((await step()).next).toEqual([{ action: 'request-review', event: 'verify-pass', waivers: ['test:size'] }])

    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(names(await step())).toEqual(['await-review'])
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(names(await step())).toEqual(['transition'])
    expect(await h.run(['transition', CHANGE, 'verify-pass']), h.err.join('\n')).toBe(0)
  }, 180_000)

  test('豁免只覆盖新鲜的失败：代码变了测试记录过期，已批准的豁免也不放行，要重新跑', async () => {
    await toVerify()
    expect(await h.run(['test', 'run', CHANGE, 'size'])).toBe(2)
    expect(await h.run(['test', 'waive', CHANGE, '--test', 'size', '--reason', REASON]), h.err.join('\n')).toBe(0)
    await reviewerPasses()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'verify-pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(await step().then((current) => current.tests[0]?.status)).toBe('waived')

    await mkdir(join(h.cwd, 'src'), { recursive: true })
    await writeFile(join(h.cwd, 'src', 'feature.ts'), 'export const x = 1\n', 'utf8')
    const stale = await step()
    expect(stale.tests).toEqual([expect.objectContaining({ id: 'size', status: 'stale' })])
    expect(stale.next).toEqual([{ action: 'run-test', test: 'size' }])
    expect(await h.run(['transition', CHANGE, 'verify-pass'])).not.toBe(0)
    expect(h.err.join('\n')).toContain('过期')
  }, 120_000)
})
