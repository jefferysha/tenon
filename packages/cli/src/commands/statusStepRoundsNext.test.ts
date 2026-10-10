/**
 * `next` 的验证轮次上限编排（纯函数）：用完后不再自动回退——只剩评审者不通过（或失败的必需测试都已有豁免）时发前进边的
 * 评审请求（带待接受的剩余阻断），还有没登记豁免的失败必需测试时发 stop；未用完时与修改前逐字一致。
 */
import { describe, expect, test } from 'vitest'
import { stepNextActions, type StepNextInput } from './statusStep.js'
import { blockExhaustedBackExits } from './statusStepRoundsActions.js'
import type { RoundsRoute } from './statusStepRoundsRoute.js'
import type { StepTestFlow } from './statusStepTests.js'
import type { StepBlocker, StepExit } from './stepExitReport.js'

const probe = {
  changeDirTracked: false, workspaceDirty: true, deliverablesDirty: true, stepDirty: true, delivered: false,
  housekeeping: [], untrack: [],
} as const

/** default 的 verify：回退边 verify-fail 回 build，回规格的边 requirements-changed 在 build 上。 */
const DEFAULT_ROUTE: RoundsRoute = {
  back:{ event: 'verify-fail', to: 'build' },
  reset: { event: 'requirements-changed', to: 'spec' },
  resettable: true,
}

function input(overrides: Partial<StepNextInput> = {}): StepNextInput {
  return {
    change: 'demo',
    loaded: true,
    skills: [],
    executors: [],
    reviewers: [],
    tests: [],
    documents: { reads: [], records: [], updates: [] },
    fields: [],
    review: { status: 'none', event: null },
    gate: 'review',
    mode: 'interactive',
    runArchived: false,
    governedOpenspec: true,
    exits: [],
    specRehearsalPending: false,
    specApplicationPending: false,
    ownsDeltaSpec: false,
    ownsAppliedSpec: false,
    artifactProducers: [],
    finish: { git: probe, verified: true },
    testConfigGaps: [],
    delivery: null,
    settle: null,
    reviewBar: [],
    roundsRoute: DEFAULT_ROUTE,
    ...overrides,
  }
}

const reviewer = (name: string, status: string) => ({
  agent: name, role: 'reviewer' as const, required: true, block_at: 'medium', reads_tests: [], wave: 0,
  wave_ready: false, status: status as 'pass', run_id: `run-${name}`, report_path: null, blocking_findings: status === 'fail' ? 1 : 0,
  reruns: 0, flipped: false, rerun_reason: null, required_host: null, route_host: null, host: null, host_source: null, wrong_host: false,
})
const test_ = (id: string, status: string) => ({ id, direction: id, required: true, status, run_id: null })

const FAILED_REVIEWER: StepBlocker = {
  source: 'reviewer', code: 'reviewer-failed', message: "评审者 'security' 未通过（1 个问题 ≥ medium）：a.ts:1 坏",
}
const exit = (event: string, direction: 'forward' | 'back', blockers: readonly StepBlocker[] = []): StepExit =>
  ({ event, to: direction === 'forward' ? 'ship' : 'build', direction, ready: blockers.length === 0, blockers })

/** verify：评审者 security 不通过；前进边被它挡着，回退边就绪。 */
const SECURITY_FAILED = {
  reviewers: [reviewer('security', 'fail')],
  exits: [exit('verify-pass', 'forward', [FAILED_REVIEWER]), exit('verify-fail', 'back')],
}

const ROUNDS_2_OF_2 = { current: 2, max: 2, source: 'workflow' as const }

const flowWith = (over: Partial<StepTestFlow>): StepTestFlow => ({
  discover: [], seed: [], map: [], files: [], run: [], failed: [], waivers: [], report: null, refreshRequest: false, ...over,
})

describe('未用完：行为与修改前一致', () => {
  test('第 1 轮、上限 2，评审者不通过：回退边的评审请求，动作里没有任何新字段', () => {
    expect(stepNextActions(input({ ...SECURITY_FAILED, rounds: { current: 1, max: 2, source: 'workflow' } })))
      .toEqual([{ action: 'request-review', event: 'verify-fail' }])
  })

  test('没有 rounds（不受约束的步骤、旧调用方）与 rounds 为 null：同样是回退边的评审请求', () => {
    expect(stepNextActions(input(SECURITY_FAILED))).toEqual([{ action: 'request-review', event: 'verify-fail' }])
    expect(stepNextActions(input({ ...SECURITY_FAILED, rounds: null }))).toEqual([{ action: 'request-review', event: 'verify-fail' }])
  })

  test('用完了但证据全过：与以前一样发前进边的评审请求，没有 residual / rounds / alternatives', () => {
    expect(stepNextActions(input({
      reviewers: [reviewer('security', 'pass')],
      exits: [exit('verify-pass', 'forward'), exit('verify-fail', 'back')],
      rounds: ROUNDS_2_OF_2,
    }))).toEqual([{ action: 'request-review', event: 'verify-pass' }])
  })
})

describe('用完且只剩评审者不通过：前进边的评审请求带待接受的剩余阻断', () => {
  const next = () => stepNextActions(input({ ...SECURITY_FAILED, rounds: ROUNDS_2_OF_2 }))

  test('第 2 轮、上限 2：不再给 verify-fail 的 request-review / choose-exit / transition，给 verify-pass 的 request-review', () => {
    const actions = next()
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      action: 'request-review',
      event: 'verify-pass',
      residual: ['reviewer:security'],
      rounds: { current: 2, max: 2, source: 'workflow' },
    })
    for (const action of actions) {
      expect(action.event).not.toBe('verify-fail')
      expect(action.exits).toBeUndefined()
    }
  })

  test('另外三条出路写在动作里：调高上限（用户决定，重发评审请求）、requirements-changed 回规格、终止任务', () => {
    const alternatives = next()[0]?.alternatives as readonly string[]
    expect(alternatives).toHaveLength(3)
    expect(alternatives[0]).toContain('tenon set demo max_rounds <N>')
    expect(alternatives[0]).toContain('用户')
    expect(alternatives[0]).toContain('review request')
    expect(alternatives[1]).toContain('requirements-changed')
    expect(alternatives[2]).toContain('终止')
  })

  test('多个评审者不通过：residual 按评审者列出，参考（非必需）评审者不算', () => {
    const optional = { ...reviewer('style', 'fail'), required: false }
    const actions = stepNextActions(input({
      reviewers: [reviewer('security', 'fail'), reviewer('quality', 'fail'), optional],
      exits: [exit('verify-pass', 'forward', [FAILED_REVIEWER]), exit('verify-fail', 'back')],
      rounds: ROUNDS_2_OF_2,
    }))
    expect(actions[0]?.residual).toEqual(['reviewer:security', 'reviewer:quality'])
  })

  test('失败的必需测试都已登记豁免（待批准）：waivers 与 residual 并存', () => {
    const waiverMessage = '测试 code-size 失败，豁免待评审批准'
    const actions = stepNextActions(input({
      ...SECURITY_FAILED,
      tests: [test_('code-size', 'waiver-pending')],
      exits: [
        exit('verify-pass', 'forward', [FAILED_REVIEWER, { source: 'test', code: 'test-evidence', message: waiverMessage }]),
        exit('verify-fail', 'back'),
      ],
      testFlow: flowWith({ waivers: [{ subject: 'test:code-size', text: '豁免', message: waiverMessage }] }),
      rounds: ROUNDS_2_OF_2,
    }))
    expect(actions[0]).toMatchObject({
      action: 'request-review', event: 'verify-pass', waivers: ['test:code-size'], residual: ['reviewer:security'],
    })
  })

  test('通过结论字段（outcome）仍要先填：剩余阻断的前进边需要它们才就绪', () => {
    const outcome = {
      field: 'branch_status', kind: 'outcome' as const, writer: 'set' as const, status: 'missing' as const, value: null,
      allowed: ['pending', 'handled'], required: null, recommended: 'handled',
    }
    const actions = stepNextActions(input({ ...SECURITY_FAILED, fields: [outcome], rounds: ROUNDS_2_OF_2 }))
    expect(actions.map((action) => action.action)).toEqual(['set-field'])
    expect(actions[0]?.field).toBe('branch_status')
  })

  test('评审请求已发出（绑定前进边）：等人确认；已批准：转换', () => {
    const waiting = stepNextActions(input({
      ...SECURITY_FAILED, rounds: ROUNDS_2_OF_2, review: { status: 'pending', event: 'verify-pass' },
    }))
    expect(waiting).toEqual([{ action: 'await-review', event: 'verify-pass' }])
    // 接受生效后前进边不再被评审者挡着（kernel 判定已把它从阻断里去掉）。
    const approved = stepNextActions(input({
      reviewers: [reviewer('security', 'fail')],
      exits: [exit('verify-pass', 'forward'), exit('verify-fail', 'back')],
      rounds: ROUNDS_2_OF_2,
      review: { status: 'approved', event: 'verify-pass' },
    }))
    expect(approved).toEqual([{ action: 'transition', event: 'verify-pass' }])
  })

  test('已批准的前进边仍被评审者挡着（接受没覆盖现在的运行或代码）：fix，要先撤回回执再重新请求', () => {
    const actions = stepNextActions(input({
      ...SECURITY_FAILED, rounds: ROUNDS_2_OF_2, review: { status: 'approved', event: 'verify-pass' },
    }))
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ action: 'fix' })
    const message = JSON.stringify(actions[0]?.blockers)
    expect(message).toContain('review revoke demo')
    expect(message).toContain('security')
  })

  test('已有的评审请求绑在回退边上（用完之前发的）：不再等它，重新发前进边的评审请求', () => {
    for (const status of ['pending', 'approved']) {
      const actions = stepNextActions(input({
        ...SECURITY_FAILED, rounds: ROUNDS_2_OF_2, review: { status, event: 'verify-fail' },
      }))
      expect(actions[0], status).toMatchObject({ action: 'request-review', event: 'verify-pass', residual: ['reviewer:security'] })
    }
  })

  test('前进边还被评审者以外的东西挡着：fix 列出剩下的阻断（评审者的不通过已随请求交给用户，不重复列）', () => {
    const guard: StepBlocker = { source: 'guard', code: 'guard-failed', message: '缺 verification_report' }
    const actions = stepNextActions(input({
      reviewers: [reviewer('security', 'fail')],
      exits: [exit('verify-pass', 'forward', [FAILED_REVIEWER, guard]), exit('verify-fail', 'back')],
      rounds: ROUNDS_2_OF_2,
    }))
    expect(actions).toEqual([{ action: 'fix', blockers: [guard] }])
  })
})

describe('用完且还有没登记豁免的失败必需测试：stop rounds-exhausted', () => {
  const failedTest = {
    tests: [test_('code-size', 'failed')],
    reviewers: [reviewer('security', 'fail')],
    exits: [exit('verify-pass', 'forward', [FAILED_REVIEWER]), exit('verify-fail', 'back')],
    rounds: ROUNDS_2_OF_2,
  }

  test('步骤测试失败且没有豁免：stop，code rounds-exhausted，写出 2/2、失败的测试、登记豁免与三条出路', () => {
    const actions = stepNextActions(input(failedTest))
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ action: 'stop', code: 'rounds-exhausted' })
    const message = String(actions[0]?.message)
    expect(message).toContain('2/2')
    expect(message).toContain('code-size')
    expect(message).toContain('tenon test waive demo --test')
    expect(message).toContain('tenon set demo max_rounds <N>')
    expect(message).toContain('requirements-changed')
    expect(message).toContain('终止')
    expect(message).toContain('用户')
  })

  test('stop 排在 run-test 之前：同一份代码上重跑改变不了失败，用完后不再原地打转', () => {
    expect(stepNextActions(input({ ...failedTest, reviewers: [], exits: [exit('verify-fail', 'back')] }))[0])
      .toMatchObject({ action: 'stop', code: 'rounds-exhausted' })
  })

  test('目录套件的测试失败（testFlow.failed）同样 stop，并点名失败的对象', () => {
    const actions = stepNextActions(input({
      exits: [exit('verify-pass', 'forward'), exit('verify-fail', 'back')],
      testFlow: flowWith({ failed: [{ code: 'suite-failed', subject: 'unit', message: '套件 unit 失败', fix: null }] }),
      rounds: ROUNDS_2_OF_2,
    }))
    expect(actions[0]).toMatchObject({ action: 'stop', code: 'rounds-exhausted' })
    expect(String(actions[0]?.message)).toContain('unit')
  })

  test('上限来源写进文案：任务字段覆盖时说明是 max_rounds 字段', () => {
    const actions = stepNextActions(input({ ...failedTest, rounds: { current: 2, max: 1, source: 'task' } }))
    expect(String(actions[0]?.message)).toContain('2/1')
    expect(String(actions[0]?.message)).toContain('任务')
  })

  test('第 1 轮、上限 2：测试失败仍是 run-test（与修改前一致）', () => {
    expect(stepNextActions(input({ ...failedTest, rounds: { current: 1, max: 2, source: 'workflow' } })))
      .toEqual([{ action: 'run-test', test: 'code-size' }])
  })
})

describe('第 2 条出路：回规格要分两步（受约束步骤上没有直达的边）', () => {
  const COMMAND = 'tenon transition demo requirements-changed'
  const exhausted = (over: Partial<StepNextInput> = {}) => stepNextActions(input({ ...SECURITY_FAILED, rounds: ROUNDS_2_OF_2, ...over }))
  const second = (over: Partial<StepNextInput> = {}): string => String((exhausted(over)[0]?.alternatives as readonly string[])[1])

  test('default 的 verify：先调高上限、经 verify-fail 回 build，再在 build 上执行 requirements-changed；回到 spec 后重新计数', () => {
    const text = second()
    expect(text).toContain('tenon set demo max_rounds <N>')
    expect(text).toContain('verify-fail')
    expect(text).toContain('build')
    expect(text).toContain('spec')
    expect(text).toContain('重新计数')
    // 顺序：调高上限 → 回退边 → 回规格的命令。
    expect(text.indexOf('tenon set demo max_rounds <N>')).toBeLessThan(text.indexOf('verify-fail'))
    expect(text.indexOf('verify-fail')).toBeLessThan(text.indexOf(COMMAND))
  })

  test('回规格的命令只出现一次，且明确写在 build 上执行；不再是在 verify 上直接执行的单步说法', () => {
    const text = second()
    expect(text.split(COMMAND)).toHaveLength(2)
    expect(text).toContain(`在 build 上执行 ${COMMAND}`)
    expect(text).not.toContain('在声明了该事件的步骤上执行')
    expect(text).not.toMatch(/^经 requirements-changed 回到规格重新规划：tenon transition/)
  })

  test('stop 与前进边的评审请求共用同一份文案', () => {
    const stop = stepNextActions(input({
      tests: [test_('code-size', 'failed')], reviewers: [reviewer('security', 'fail')],
      exits: SECURITY_FAILED.exits, rounds: ROUNDS_2_OF_2,
    }))
    expect(stop[0]).toMatchObject({ action: 'stop', code: 'rounds-exhausted' })
    expect(String(stop[0]?.message)).toContain(second())
  })

  test('回退目标步骤上没有落到更早步骤的边（reset 为 null）：不点名事件，只说那一步上回到规格的事件，不给单步命令', () => {
    const text = second({ roundsRoute: { ...DEFAULT_ROUTE, reset: null } })
    expect(text).toContain('verify-fail')
    expect(text).toContain('tenon set demo max_rounds <N>')
    expect(text).toContain('那一步上回到规格的事件')
    expect(text).not.toContain(COMMAND)
  })

  test('没有比回退目标更早的步骤（resettable 为 false）：回规格帮不上忙，等同于调高上限，不给任何 transition 命令', () => {
    const text = second({ roundsRoute: { ...DEFAULT_ROUTE, reset: null, resettable: false } })
    expect(text).toContain('清零')
    expect(text).toContain('verify-fail')
    expect(text).not.toContain('tenon transition demo')
    expect(text).not.toContain('requirements-changed')
  })

  test('自定义计划：事件名与步骤名取自计划，不写死 requirements-changed / build / spec', () => {
    const text = second({
      roundsRoute: { back: { event: 'redo', to: 'impl' }, reset: { event: 'replan', to: 'plan' }, resettable: true },
    })
    expect(text).toContain('经回退边 redo 回到 impl')
    expect(text).toContain('在 impl 上执行 tenon transition demo replan')
    expect(text).not.toContain('requirements-changed')
    expect(text).not.toContain('verify-fail')
  })

  test('调用方没有给 roundsRoute：回退边取自 exits，不给在当前步骤直接执行的单步命令', () => {
    const text = second({ roundsRoute: null })
    expect(text).toContain('verify-fail')
    expect(text).toContain('tenon set demo max_rounds <N>')
    expect(text).not.toContain(COMMAND)
  })
})

describe('exits：用完后回退边不再算就绪（投影与命令的拒绝一致）', () => {
  const exits = [
    exit('verify-pass', 'forward'),
    exit('verify-fail', 'back'),
    { ...exit('scope-expanded', 'back'), to: 'escalated' },
  ]

  test('用完：受约束步骤的回退边带 rounds-exhausted 阻断、ready 为 false；前进边与放弃边原样', () => {
    const blocked = blockExhaustedBackExits('demo', exits, ROUNDS_2_OF_2)
    expect(blocked[0]).toBe(exits[0])
    expect(blocked[2]).toBe(exits[2])
    expect(blocked[1]).toMatchObject({
      event: 'verify-fail', ready: false,
      blockers: [expect.objectContaining({ source: 'guard', code: 'rounds-exhausted', message: expect.stringContaining('tenon set demo max_rounds <N>') })],
    })
    expect(blocked[1]?.blockers[0]?.message).toContain('2/2')
  })

  test('未用完 / 不受约束：原样返回同一份', () => {
    expect(blockExhaustedBackExits('demo', exits, { current: 1, max: 2, source: 'workflow' })).toBe(exits)
    expect(blockExhaustedBackExits('demo', exits, null)).toBe(exits)
    expect(blockExhaustedBackExits('demo', exits, undefined)).toBe(exits)
  })
})

describe('任务覆盖上限（tenon set max_rounds）改变 rounds 之后', () => {
  const at = (rounds: StepNextInput['rounds']) => stepNextActions(input({ ...SECURITY_FAILED, rounds }))

  test('第 2 轮时设为 1：仍视为用完；设为 2（等于当前轮次）：仍用完；设为 3（大于）：恢复 verify-fail 的评审请求', () => {
    expect(at({ current: 2, max: 1, source: 'task' })[0]).toMatchObject({ event: 'verify-pass', residual: ['reviewer:security'] })
    expect(at({ current: 2, max: 2, source: 'task' })[0]).toMatchObject({ event: 'verify-pass', residual: ['reviewer:security'] })
    expect(at({ current: 2, max: 3, source: 'task' })).toEqual([{ action: 'request-review', event: 'verify-fail' }])
  })
})
