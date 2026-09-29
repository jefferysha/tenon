/**
 * 真实 e2e —— 测试体系接入流程：`tenon status` 的测试动作、豁免的评审批准、评审者读测试摘要。
 *
 * 零 mock：真临时项目、真 CLI（buildProgram）、真 kernel 落盘。`tenon test discover|plan|register|run` 是
 * 另一批的命令，这里经 kernel 的写入口（计划 CLI 写入口、哈希链记录追加）替作者做同样的事——
 * integration-test-flow-support.ts。默认工作流从 open 到完结的整条链见 next-action-runner.integration.test.ts。
 */
import { appendFile, mkdir, readFile, rm as removeFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptyTestPlan, evaluateTestEvidence, readTestPlanState, testSystemPaths, writeTestPlan,
  type TestPlan,
} from '@tenon/kernel'
import { fixtureCase } from '@tenon/kernel/test-system/test-support'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cmdStatus } from './commands/status.js'
import { appendFlowRecord, FLOW_CATALOG, performFlowAction, type FlowContext } from './integration-test-flow-support.js'
import { FIXED_CLOCK, freshHarness, realDeps, rm, type Harness } from './integration-harness.js'

const CHANGE = 'flowchg'
const SESSION = '019f92c7-6e66-7290-9352-f9d915266f14'
const ME = 'tester@tenon.test'

/** spec：登记计划；build：按策略运行且测试文件要登记；verify：全量运行 + 覆盖率，一个评审者读旧测试与新摘要。 */
const WORKFLOW = `name: flowwf
tracks:
  backend:
    steps:
      - id: spec
        label: 规格
        gate: review
        skills: []
        inputs: []
        outputs: []
        guards: []
        test_policy:
          plan: required
          kinds: [unit]
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
        test_policy:
          run: [unit]
          scope: changed
          files: registered
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
          - id: lint
            direction: unit
            command: node -e 'process.exit(0)'
            label: 静态检查
            timeout_s: 60
        agents:
          reviewers:
            - agent: security
              required: true
              block_at: medium
              reads_tests: [lint]
            - agent: spec-consistency
              required: true
              block_at: medium
        guards: []
        test_policy:
          run: [unit]
          scope: full
          coverage: { lines: 80 }
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
  readonly id: string
  readonly next: readonly { readonly action: string; readonly [key: string]: unknown }[]
  readonly exits: readonly { readonly event: string; readonly ready: boolean; readonly blockers: readonly { readonly code: string; readonly message: string }[] }[]
}

let h: Harness
let toolUse = 0

beforeEach(async () => {
  h = await freshHarness()
  await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(h.cwd, '.pipeline', 'workflows', 'flowwf.yaml'), WORKFLOW, 'utf8')
  await writeFile(join(h.cwd, 'package.json'), '{"name":"flow-fixture","private":true,"scripts":{"test":"exit 0"}}\n', 'utf8')
  expect(await h.run(['init', CHANGE, '--track', 'backend', '--workflow', 'flowwf', '--preset', 'full']), h.err.join('\n')).toBe(0)
  expect(await h.run(['session', 'activate', CHANGE, '--host-session', SESSION]), h.err.join('\n')).toBe(0)
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

function changeDir(): string {
  return join(h.cwd, 'openspec', 'changes', CHANGE)
}

/** 宿主加载 tenon 技能的回执（每次步骤访问一次）。 */
async function loadTenon(): Promise<void> {
  toolUse += 1
  await appendFile(join(changeDir(), '.pipeline-history.jsonl'), `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: tenon' })}\n`, 'utf8')
  expect(await h.run(['internal-native-skill-receipt', CHANGE, 'tenon', 'flow-session', `tool-${toolUse}`, FIXED_CLOCK]), h.err.join('\n')).toBe(0)
}

async function toPhase(phase: string): Promise<void> {
  await h.seedPhase(CHANGE, phase)
  await loadTenon()
}

async function readStep(changedFiles?: readonly string[]): Promise<StepJson> {
  const out: string[] = []
  const err: string[] = []
  const deps = realDeps(h.cwd, out, err)
  // 宿主的 diff 文件列表由 T2 接入；这里用注入的列表走同一条真实判定。
  const withDiff = changedFiles === undefined
    ? deps
    : {
        ...deps,
        testEvidence: (input: Parameters<typeof evaluateTestEvidence>[0]) => evaluateTestEvidence({
          ...input,
          context: input.context === undefined ? undefined : { ...input.context, changedFiles: async () => changedFiles },
        }),
      }
  expect(await cmdStatus(withDiff, CHANGE, { json: true }), err.join('\n')).toBe(0)
  return (JSON.parse(out.join('\n')) as { step: StepJson }).step
}

function context(stepId: string): FlowContext {
  return { deps: realDeps(h.cwd, [], []), cwd: h.cwd, change: CHANGE, stepId, recordedAt: FIXED_CLOCK }
}

async function writeCatalog(): Promise<void> {
  const path = testSystemPaths(h.cwd).catalog
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, FLOW_CATALOG, 'utf8')
}

async function writePlan(patch: Partial<TestPlan>): Promise<void> {
  const state = await readTestPlanState(changeDir(), CHANGE)
  const base = state.state === 'ok' ? state.plan : emptyTestPlan(CHANGE)
  await writeTestPlan(changeDir(), { ...base, ...patch }, { actor: { id: ME, name: 'Tester', trust: 'declared' }, recordedAt: FIXED_CLOCK })
}

async function readPlan(): Promise<TestPlan> {
  const state = await readTestPlanState(changeDir(), CHANGE)
  if (state.state !== 'ok') throw new Error(`计划不可读：${state.state}`)
  return state.plan
}

const names = (step: StepJson): string[] => step.next.map((action) => action.action)

describe('spec：目录 → 计划 → 映射 → 评审', () => {
  test('没有目录先 test-discover，再 test-plan-seed，再 test-plan-map；映射完成后才进评审', async () => {
    await loadTenon()
    const discover = (await readStep()).next
    expect(discover).toEqual([expect.objectContaining({ action: 'test-discover', command: 'tenon test discover --write' })])

    await writeCatalog()
    const seed = (await readStep()).next
    expect(seed).toEqual([expect.objectContaining({ action: 'test-plan-seed', command: `tenon test plan ${CHANGE} --seed` })])

    await writePlan({})
    const map = (await readStep()).next
    expect(map).toEqual([expect.objectContaining({
      action: 'test-plan-map',
      show: `tenon test plan ${CHANGE} --json`,
      items: [expect.objectContaining({ code: 'test-kind-missing', subject: 'unit', fix: `tenon test register ${CHANGE} --suite unit` })],
    })])

    expect(await performFlowAction({ ...context('spec') }, map[0] as Parameters<typeof performFlowAction>[1])).toBe(true)
    expect(names(await readStep())).toEqual(['request-review'])
  })
})

describe('豁免的评审批准', () => {
  async function waivedSpec(): Promise<void> {
    await loadTenon()
    await writeCatalog()
    await writePlan({ waivers: [{ kind: 'unit', reason: '纯文档改动', approved_by: null }] })
  }

  test('request 列出待批准的豁免；acknowledge 只批准列出的那几条并留审计；批准后放行 transition', async () => {
    await waivedSpec()
    const before = await readStep()
    // 只剩豁免待批准：可以发起评审，请求里带上豁免；出口本身仍把它当阻塞。
    expect(before.next).toEqual([{ action: 'request-review', event: 'spec-done', waivers: ['unit'] }])
    expect(before.exits[0]).toMatchObject({ ready: false, blockers: [expect.objectContaining({ message: expect.stringContaining('豁免尚未经评审批准') })] })
    expect(await h.run(['transition', CHANGE, 'spec-done'])).toBe(1)

    expect(await h.run(['review', 'request', CHANGE, '--event', 'spec-done']), h.err.join('\n')).toBe(0)
    const requested = h.out.join('\n')
    expect(requested).toContain('待批准的豁免 1 项')
    expect(requested).toContain('kind:unit — 纯文档改动')
    expect(existsSync(join(changeDir(), '.pipeline-review-waivers.json'))).toBe(true)

    // 请求之后才加进计划的豁免不在这次确认里。
    const plan = await readPlan()
    await writePlan({ waivers: [...plan.waivers, { kind: 'lint', reason: '请求之后才加的', approved_by: null }] })

    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('已批准豁免 1 项：kind:unit')
    const approved = await readPlan()
    expect(approved.waivers).toEqual([
      { kind: 'lint', reason: '请求之后才加的', approved_by: null },
      { kind: 'unit', reason: '纯文档改动', approved_by: ME },
    ])
    expect(existsSync(join(changeDir(), '.pipeline-review-waivers.json'))).toBe(false)
    const history = await readFile(join(changeDir(), '.pipeline-history.jsonl'), 'utf8')
    expect(history).toMatch(new RegExp(`"raw":"test:waiver-approve waivers=kind:unit by=${ME.replace('.', '\\.')} plan=sha256:[0-9a-f]{64}"`))
    // 计划的每次真实写入（含请求之后加的那条豁免）也各有一行审计。
    expect(history.match(/"raw":"test:plan-write plan=sha256:[0-9a-f]{64}"/gu)).toHaveLength(2)

    expect(await h.run(['transition', CHANGE, 'spec-done']), h.err.join('\n')).toBe(0)
  })

  test('请求之后又加了豁免：next 先要求重新发起（幂等），重新发起后这次确认一并批准', async () => {
    await waivedSpec()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'spec-done']), h.err.join('\n')).toBe(0)
    expect(names(await readStep())).toEqual(['await-review'])

    const plan = await readPlan()
    await writePlan({ waivers: [...plan.waivers, { kind: 'lint', reason: '请求之后才加的', approved_by: null }] })
    // 挡着出口的只有 unit 的豁免；lint 不是策略要求的种类，但冻结清单要与计划里的待批准清单一致。
    expect((await readStep()).next).toEqual([{ action: 'request-review', event: 'spec-done', waivers: ['unit'] }])

    expect(await h.run(['review', 'request', CHANGE, '--event', 'spec-done']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('仍待确认')
    expect(h.out.join('\n')).toContain('待批准的豁免 2 项')
    expect(names(await readStep())).toEqual(['await-review'])

    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect((await readPlan()).waivers.map((item) => item.approved_by)).toEqual([ME, ME])
    expect(await h.run(['transition', CHANGE, 'spec-done']), h.err.join('\n')).toBe(0)
  })

  test('委托确认（--delegated）不批准豁免：出口继续被挡，直到人工确认', async () => {
    expect(await h.run(['session', 'activate', CHANGE, '--continuous', '--host-session', SESSION]), h.err.join('\n')).toBe(0)
    await waivedSpec()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'spec-done']), h.err.join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', CHANGE, '--delegated'], { env: { TENON_HOST_SESSION_ID: SESSION } }), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('委托确认不批准豁免：kind:unit 仍待人工批准')
    expect((await readPlan()).waivers).toEqual([{ kind: 'unit', reason: '纯文档改动', approved_by: null }])
    // 评审已确认却还有豁免没批准：next 不再发一条必被拒的 transition。
    const step = await readStep()
    expect(step.next).toEqual([expect.objectContaining({ action: 'fix', blockers: [expect.objectContaining({ code: 'waiver-unapproved' })] })])
    expect(await h.run(['transition', CHANGE, 'spec-done'])).toBe(1)
    expect(h.err.join('\n')).toContain('豁免尚未经评审批准')
  })

  test('计划被手改（摘要不符）：确认不批准任何豁免，并说明原因', async () => {
    await waivedSpec()
    expect(await h.run(['review', 'request', CHANGE, '--event', 'spec-done'])).toBe(0)
    await appendFile(join(changeDir(), 'test-plan.yaml'), '# 手改\n', 'utf8')
    expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
    expect(h.err.join('\n')).toContain('测试计划不可信')
    await removeFile(join(changeDir(), '.pipeline-test-plan.json'))
    expect(await h.run(['transition', CHANGE, 'spec-done'])).toBe(1)
  })
})

describe('build：未登记的测试文件与运行', () => {
  async function buildWithUnitSuite(): Promise<void> {
    await writeCatalog()
    await writePlan({ suites: [{ suite: 'unit', scope: 'changed' }] })
    await toPhase('build')
  }

  test('diff 里的测试文件没登记 → test-register-files；登记后 run-tests；运行通过才放行出口', async () => {
    await buildWithUnitSuite()
    const files = ['src/login.test.ts', 'src/login.ts']
    const register = (await readStep(files)).next
    expect(register).toEqual([{
      action: 'test-register-files',
      files: [expect.objectContaining({
        code: 'test-file-unregistered', subject: 'src/login.test.ts',
        fix: `tenon test register ${CHANGE} --file src/login.test.ts --suite unit`,
      })],
    }])

    await writePlan({ files: [{ path: 'src/login.test.ts', suite: 'unit' }] })
    const run = (await readStep(files)).next
    expect(run).toEqual([expect.objectContaining({
      action: 'run-tests', command: `tenon test run ${CHANGE} --stage`, suites: [expect.objectContaining({ subject: 'unit', code: 'test-not-run' })],
    })])

    // 运行了，但报告里没有登记的测试文件：不是「没跑」，是要改的失败，不再发 run-tests。
    await appendFlowRecord(context('build'), ['unit'])
    const failed = (await readStep(files)).next
    expect(failed).toEqual([expect.objectContaining({
      action: 'fix', blockers: [expect.objectContaining({ source: 'test', code: 'registered-test-not-executed' })],
    })])

    await appendFlowRecord(context('build'), ['unit'], () => ({
      cases: [fixtureCase({ file: 'src/login.test.ts', name: 'logs in' })],
    }))
    const done = (await readStep(files)).next
    expect(done.map((action) => action.action)).toEqual(['transition'])
  })

  test('代码变了：已有的运行过期，重新 run-tests', async () => {
    await buildWithUnitSuite()
    await appendFlowRecord(context('build'), ['unit'])
    expect(names(await readStep())).toEqual(['transition'])
    await mkdir(join(h.cwd, 'src'), { recursive: true })
    await writeFile(join(h.cwd, 'src', 'feature.ts'), 'export const x = 1\n', 'utf8')
    const stale = (await readStep()).next
    expect(stale).toEqual([expect.objectContaining({ action: 'run-tests', suites: [expect.objectContaining({ code: 'test-stale' })] })])
  })
})

describe('verify：追溯矩阵与评审者的测试摘要', () => {
  async function verifyWithFailures(): Promise<void> {
    await writeCatalog()
    await writePlan({ suites: [{ suite: 'unit', scope: 'full' }] })
    await toPhase('verify')
    await appendFlowRecord(context('verify'), ['unit'], () => ({
      result: 'fail',
      exit_code: 1,
      cases: [
        fixtureCase({ file: 'src/a.test.ts', name: '登录成功' }),
        fixtureCase({ file: 'src/b.test.ts', name: '退出失败', status: 'fail', failure: { message: 'boom' } }),
        fixtureCase({ file: 'src/c.test.ts', name: '偶发', status: 'flaky', attempts: 2 }),
      ],
      totals: { cases: 3, pass: 1, fail: 1, skip: 0, flaky: 1, known_fail: 0 },
      coverage: { lines: 71.5, branches: 66, changed_lines: 90 },
    }))
  }

  test('评审门上运行失败：走回退边，而不是继续派评审者', async () => {
    await verifyWithFailures()
    expect(await h.run(['test', 'run', CHANGE, 'lint']), h.err.join('\n')).toBe(0)
    // 没有验证报告文档时不发 test-report：直接是评审门上的回退边。
    const step = await readStep()
    expect(step.next).toEqual([{ action: 'request-review', event: 'verify-fail' }])
    expect(step.exits.find((item) => item.event === 'verify-pass')?.ready).toBe(false)
  })

  test('评审者提示词附带失败用例、flaky、覆盖率对照门槛；未声明 reads_tests 的评审者不附', async () => {
    await verifyWithFailures()
    expect(await h.run(['test', 'run', CHANGE, 'lint']), h.err.join('\n')).toBe(0)
    expect(await h.run(['agent', 'prompt', CHANGE, 'security', '--host', 'claude', '--json']), h.err.join('\n')).toBe(0)
    const prompt = (JSON.parse(h.out.join('')) as { prompt: string }).prompt
    const lines = prompt.split('\n')
    expect(lines).toContain('测试摘要（目录套件的最新运行）：')
    expect(lines.find((line) => line.startsWith('- 单测（unit）'))).toBe(
      '- 单测（unit） unit 不通过；1/3 通过，1 失败，1 flaky；覆盖率 lines 71.5%（门槛 80%，不足），branches 66%，changed_lines 90%',
    )
    expect(lines).toContain('  失败用例：src/b.test.ts › 退出失败')
    expect(lines).toContain('  flaky 用例：src/c.test.ts › 偶发')
    // 旧步骤测试仍按原样给出。
    expect(lines).toContain('测试：')
    expect(lines.some((line) => line.startsWith('- lint 通过 exit=0'))).toBe(true)

    // 没声明 reads_tests 的评审者：提示词里没有测试块，与之前逐字相同的形状。
    expect(await h.run(['agent', 'prompt', CHANGE, 'spec-consistency', '--host', 'claude', '--json']), h.err.join('\n')).toBe(0)
    const other = (JSON.parse(h.out.join('')) as { prompt: string }).prompt
    expect(other).not.toContain('测试摘要')
    expect(other).not.toContain('测试：')
  })
})
