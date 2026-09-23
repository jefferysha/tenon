import { describe, expect, test } from 'vitest'
import { stepNextActions, type StepNextInput } from './statusStep.js'
import type { StepFieldView } from './statusStepParts.js'

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
    gate: null,
    mode: 'interactive',
    runArchived: false,
    governedOpenspec: true,
    exits: [],
    specRehearsalPending: false,
    specApplicationPending: false,
    ownsDeltaSpec: false,
    ownsAppliedSpec: false,
    artifactProducers: [],
    ...overrides,
  }
}

const field = (
  name: string,
  over: Partial<StepFieldView> = {},
): StepFieldView => ({
  field: name,
  kind: 'output',
  writer: 'set',
  status: 'missing',
  value: null,
  allowed: null,
  required: null,
  recommended: null,
  ...over,
})

const doc = (kind: string, status: string, producers: readonly string[] = []) => ({
  kind,
  path: `openspec/changes/demo/${kind}.md`,
  path_template: `openspec/changes/{change}/${kind}.md`,
  producers,
  status,
})

const skill = (id: string, status: 'done' | 'ready' | 'waiting', wave: number) =>
  ({ id, depends_on: [], wave, status })

const agent = (name: string, role: 'executor' | 'reviewer', status: string, ready: boolean) => ({
  agent: name, role, required: true, block_at: 'high', reads_tests: [], wave: 0,
  wave_ready: ready, status: status as 'pending', run_id: null, report_path: null, blocking_findings: 0,
})

const test_ = (id: string, status: string, required = true) =>
  ({ id, direction: id, required, status, run_id: null })

const exit = (event: string, direction: 'forward' | 'back' | 'completion', ready: boolean) =>
  ({ event, to: 'next', direction, ready, blockers: ready ? [] : [{ source: 'guard' as const, code: 'guard-failed', message: 'x' }] })

const actions = (overrides: Partial<StepNextInput>) =>
  stepNextActions(input(overrides)).map((action) => action.action)

describe('step.next 顺序', () => {
  test('进入步骤先重新加载 tenon', () => {
    expect(actions({ loaded: false, skills: [skill('brainstorming', 'ready', 0)] })).toEqual(['load-tenon'])
  })

  test('读取声明的输入文档排在一切产出之前', () => {
    expect(actions({
      documents: { reads: [doc('plan', 'unread')], records: [doc('adr', 'missing')], updates: [] },
      skills: [skill('brainstorming', 'ready', 0)],
    })).toEqual(['read-documents'])
  })

  test('执行者先于本步技能', () => {
    expect(actions({
      executors: [agent('researcher', 'executor', 'pending', true)],
      skills: [skill('brainstorming', 'ready', 0)],
    })).toEqual(['run-agent'])
  })

  test('进行中的执行者先于本步技能：指回那次运行，而不是跳去加载技能', () => {
    const running = { ...agent('researcher', 'executor', 'running', false), run_id: 'r-1', report_path: 'x/r-1.md' }
    expect(stepNextActions(input({
      executors: [running, agent('builder', 'executor', 'pass', false)],
      skills: [skill('brainstorming', 'ready', 0)],
    }))).toEqual([{
      action: 'run-agent', agent: 'researcher', role: 'executor', wave: 0,
      status: 'running', run_id: 'r-1', report_path: 'x/r-1.md',
    }])
  })

  test('必需评审者不通过：不再要结果字段，直接指向回退边（D2）', () => {
    const base = {
      gate: 'review',
      reviewers: [agent('security', 'reviewer', 'fail', false)],
      fields: [field('branch_status', { kind: 'outcome', allowed: ['pending', 'handled'], recommended: 'handled' })],
    } as const
    expect(stepNextActions(input({
      ...base,
      exits: [exit('verify-pass', 'forward', false), exit('verify-fail', 'back', true)],
    }))).toEqual([{ action: 'request-review', event: 'verify-fail' }])
    // 没有回退边：fix，而不是替失败的评审写一条通过的结论。
    expect(actions({ ...base, exits: [exit('verify-pass', 'forward', false)] })).toEqual(['fix'])
    // 评审者都过了，结果字段才出现。
    expect(actions({
      ...base,
      reviewers: [agent('security', 'reviewer', 'pass', false)],
      exits: [exit('verify-pass', 'forward', false), exit('verify-fail', 'back', true)],
    })).toEqual(['set-field'])
  })

  test('技能按波次下发，waiting 的不进本波', () => {
    expect(stepNextActions(input({
      skills: [skill('a', 'done', 0), skill('b', 'ready', 1), skill('c', 'waiting', 2)],
    }))).toEqual([{ action: 'load-skill', skill: 'b', wave: 1 }])
  })

  test('applied-spec 归本步时先应用规格，再登记', () => {
    expect(actions({
      ownsAppliedSpec: true,
      specRehearsalPending: true,
      specApplicationPending: true,
      documents: { reads: [], records: [doc('applied-spec', 'missing')], updates: [] },
    })).toEqual(['apply-spec'])
  })

  test('彩排过但没真应用：仍然是 apply-spec，不是去铺 applied-spec 骨架', () => {
    expect(actions({
      ownsAppliedSpec: true,
      specRehearsalPending: false,
      specApplicationPending: true,
      documents: { reads: [], records: [doc('applied-spec', 'missing')], updates: [] },
    })).toEqual(['apply-spec'])
  })

  test('delta-spec 归本步时，登记完文档再彩排', () => {
    expect(actions({
      ownsDeltaSpec: true,
      specRehearsalPending: true,
      specApplicationPending: true,
      documents: { reads: [], records: [doc('delta-spec', 'missing')], updates: [] },
    })).toEqual(['scaffold-document', 'record-document'])
    expect(actions({
      ownsDeltaSpec: true,
      specRehearsalPending: true,
      specApplicationPending: true,
      documents: { reads: [], records: [doc('delta-spec', 'recorded')], updates: [] },
    })).toEqual(['validate-spec'])
  })

  test('彩排已是最新：spec 步不再重复 validate-spec（彩排满足彩排，应用另算）', () => {
    expect(actions({
      ownsDeltaSpec: true,
      specRehearsalPending: false,
      specApplicationPending: true,
      documents: { reads: [], records: [doc('delta-spec', 'recorded')], updates: [] },
      exits: [exit('spec-complete', 'forward', true)],
    })).toEqual(['transition'])
  })

  test('已登记的文档过期时重新登记，不再铺骨架', () => {
    expect(actions({
      documents: { reads: [], records: [], updates: [doc('tasks', 'stale', ['tenon'])] },
    })).toEqual(['record-document'])
  })

  /**
   * D3（acceptance run）：`tenon document scaffold` 写完文件就返回 0，台账却仍是 `missing`——
   * 只有 `document record` 会登记。从前 `missing` 只发 scaffold，于是 `next` 一轮一轮重发同一条
   * scaffold，文件一再被确认存在、状态一步不动（真机实测卡在 open 相位）。骨架与登记是一对动作。
   */
  test('缺失的产出文档：铺骨架之后紧跟登记，一波下发', () => {
    expect(stepNextActions(input({
      documents: {
        reads: [],
        records: [doc('proposal', 'missing', ['openspec-propose'])],
        updates: [],
      },
    }))).toEqual([
      {
        action: 'scaffold-document',
        kind: 'proposal',
        path: 'openspec/changes/demo/proposal.md',
        path_template: 'openspec/changes/{change}/proposal.md',
        producers: ['openspec-propose'],
      },
      {
        action: 'record-document',
        kind: 'proposal',
        path: 'openspec/changes/demo/proposal.md',
        path_template: 'openspec/changes/{change}/proposal.md',
        producers: ['openspec-propose'],
      },
    ])
  })

  /**
   * D1（acceptance run，五个相位各撞一次）：已登记的输入文档被改后状态是 `stale`，
   * `tenon document read` 当场拒「已变更；先重新 record 后再 read」，而 `next` 仍然只发
   * read-documents——同一条必定失败的命令无限重发。它要的是一次重新登记，producer 必须是
   * **当前步**接受的那个（`explore` 的 proposal 只认 `tenon`，不认当初在 open 写它的
   * `openspec-propose`）。
   */
  test('输入文档过期 → 按当前步的 producer 重新登记，而不是再读一次', () => {
    expect(stepNextActions(input({
      documents: {
        reads: [doc('proposal', 'stale', ['tenon'])],
        records: [],
        updates: [],
      },
    }))).toEqual([{
      action: 'record-document',
      kind: 'proposal',
      path: 'openspec/changes/demo/proposal.md',
      path_template: 'openspec/changes/{change}/proposal.md',
      producers: ['tenon'],
    }])
  })

  test('读清单里只有 unread 才发 read-documents；过期的那条不混进去', () => {
    expect(stepNextActions(input({
      documents: {
        reads: [doc('proposal', 'stale', ['tenon']), doc('tasks', 'unread', ['tenon'])],
        records: [],
        updates: [],
      },
    }))).toEqual([{
      action: 'read-documents',
      documents: ['openspec/changes/demo/tasks.md'],
    }])
  })

  test('同一份文档既在读清单又在可改清单时只发一条动作', () => {
    expect(actions({
      documents: {
        reads: [doc('tasks', 'stale', ['tenon'])],
        records: [],
        updates: [doc('tasks', 'stale', ['tenon'])],
      },
    })).toEqual(['record-document'])
  })

  /**
   * D2（acceptance run，frontend 的 ship）：`role: update` 的槽是「本步可以改它」，不是「本步
   * 必须产出它」——文档取证层早就是这个口径（update 槽从不进 blockers）。当成必须产出时，`next`
   * 会要求 scaffold 一份 contract 里根本没声明为产出的 design-md（命令拒：未在 contract 中声明），
   * 而登记它要的 `hue` 又不在 ship 的 skills 里，`next` 也从不发 load-skill hue：一条谁都执行不了
   * 的动作。没登记过的 update 槽不发任何动作。
   */
  test('未登记的 role:update 槽不发动作，直接走到出口', () => {
    expect(stepNextActions(input({
      documents: {
        reads: [],
        records: [],
        updates: [{
          kind: 'design-md',
          path: 'DESIGN.md',
          path_template: 'DESIGN.md',
          producers: ['hue'],
          status: 'missing',
        }],
      },
      exits: [exit('ship-complete', 'forward', true)],
    }))).toEqual([{ action: 'transition', event: 'ship-complete' }])
  })

  test('当前步没有合法 producer 的过期输入文档不发无法执行的登记', () => {
    const next = stepNextActions(input({
      documents: { reads: [doc('plan', 'stale', [])], records: [], updates: [] },
      exits: [exit('build-complete', 'forward', false)],
    }))
    expect(next[0]?.action).toBe('fix')
  })

  test('只跑必需测试；评审者排在测试之后', () => {
    expect(actions({
      tests: [test_('unit', 'not-run'), test_('code-size', 'not-run', false)],
      reviewers: [agent('security', 'reviewer', 'pending', true)],
    })).toEqual(['run-test'])
    expect(actions({
      tests: [test_('unit', 'passed')],
      reviewers: [agent('security', 'reviewer', 'pending', true)],
    })).toEqual(['run-agent'])
  })

  test('结果字段排在测试与评审者之后', () => {
    const outcome = field('branch_status', {
      kind: 'outcome', allowed: ['handled'], recommended: 'handled',
    })
    expect(actions({ fields: [outcome], tests: [test_('unit', 'not-run')] })).toEqual(['run-test'])
    expect(stepNextActions(input({ fields: [outcome] }))).toEqual([
      { action: 'set-field', field: 'branch_status', allowed: ['handled'], recommended: 'handled' },
    ])
  })

  /**
   * D7：artifact 声明过的字段被 set/set-many/cas 拒写（fields.ts 的 artifact cutover），而本表
   * 从前对任何缺字段都只会发 set-field，运行器照做就撞上「禁止通过 set/set-many/cas 写入；请改用
   * tenon artifact register」，只能自己猜。动作名必须就是能跑通的那条命令。
   */
  test('artifact 字段发 register-field，并带上合法 producer', () => {
    expect(stepNextActions(input({
      fields: [field('design_doc', { writer: 'artifact-register' })],
      artifactProducers: ['brainstorming', 'superpowers:brainstorming'],
    }))).toEqual([
      { action: 'register-field', field: 'design_doc', producers: ['brainstorming', 'superpowers:brainstorming'] },
    ])
  })

  test('同一波里 artifact 与普通字段各发各的动作', () => {
    expect(stepNextActions(input({
      fields: [
        field('design_doc', { writer: 'artifact-register' }),
        field('build_mode', { allowed: ['direct'], recommended: 'direct' }),
      ],
      artifactProducers: ['hue'],
    }))).toEqual([
      { action: 'register-field', field: 'design_doc', producers: ['hue'] },
      { action: 'set-field', field: 'build_mode', allowed: ['direct'], recommended: 'direct' },
    ])
  })

  /**
   * D15：`archived` 是 archive-run 副作用成对落下的槽，不是运行器要填的值。把它当字段发出去，
   * 就会得到 archived=true / archived_at=null / phase_status=pending 这种半盖章的终态。
   */
  test('转换自己落的槽不发写入动作，直接走到出边', () => {
    expect(stepNextActions(input({
      fields: [field('archived', { writer: 'transition' })],
      exits: [exit('archived', 'completion', true)],
    }))).toEqual([{ action: 'complete', event: 'archived' }])
  })

  test('结果位上的 artifact 字段同样走 register-field', () => {
    expect(stepNextActions(input({
      fields: [field('verification_report', { kind: 'outcome', writer: 'artifact-register' })],
      artifactProducers: ['verification-before-completion'],
    }))).toEqual([
      { action: 'register-field', field: 'verification_report', producers: ['verification-before-completion'] },
    ])
  })

  test('评审门：就绪 → 请求评审；pending → 等待；approved → 转换', () => {
    const exits = [exit('spec-complete', 'forward', true)]
    expect(actions({ gate: 'review', exits })).toEqual(['request-review'])
    expect(actions({ gate: 'review', exits, review: { status: 'pending', event: 'spec-complete' } }))
      .toEqual(['await-review'])
    expect(actions({ gate: 'review', exits, review: { status: 'approved', event: 'spec-complete' } }))
      .toEqual(['transition'])
  })

  test('自动门：唯一就绪前进边直接转换；完结边走 complete', () => {
    expect(actions({ exits: [exit('build-complete', 'forward', true)] })).toEqual(['transition'])
    expect(actions({ exits: [exit('archived', 'completion', true)] })).toEqual(['complete'])
  })

  test('必需评审者不通过且存在回退边 → 选择出口，不再重跑评审者', () => {
    expect(actions({
      reviewers: [agent('security', 'reviewer', 'fail', true)],
      exits: [exit('verify-pass', 'forward', false), exit('verify-fail', 'back', true)],
    })).toEqual(['choose-exit'])
  })

  /**
   * D6（acceptance run）：评审门上的回退边也要人工确认。真机实测里 `next` 直接给
   * `choose-exit: [verify-fail]`，照做却得到「phase 'verify' 的 event 'verify-fail' 尚未取得
   * 人工确认；先运行 tenon review request … --event verify-fail」——review 回执逐边绑定，
   * 一次「回到实现」的决定不能顺便授权 verify-pass，所以回退边同样走 request → await → transition。
   */
  test('评审门上唯一的回退边：先请求评审，再等待，再转换', () => {
    const exits = [exit('verify-pass', 'forward', false), exit('verify-fail', 'back', true)]
    const failed = { reviewers: [agent('security', 'reviewer', 'fail', true)], gate: 'review', exits }
    expect(stepNextActions(input(failed)))
      .toEqual([{ action: 'request-review', event: 'verify-fail' }])
    expect(stepNextActions(input({
      ...failed,
      review: { status: 'pending', event: 'verify-fail' },
    }))).toEqual([{ action: 'await-review', event: 'verify-fail' }])
    expect(stepNextActions(input({
      ...failed,
      review: { status: 'approved', event: 'verify-fail' },
    }))).toEqual([{ action: 'transition', event: 'verify-fail' }])
  })

  test('回退时挂着的是前进边的评审回执 → 改为请求回退边的评审', () => {
    expect(stepNextActions(input({
      reviewers: [agent('security', 'reviewer', 'fail', true)],
      gate: 'review',
      exits: [exit('verify-pass', 'forward', false), exit('verify-fail', 'back', true)],
      review: { status: 'pending', event: 'verify-pass' },
    }))).toEqual([{ action: 'request-review', event: 'verify-fail' }])
  })

  test('多条回退边仍然交给人选，不替他选一条去请求评审', () => {
    expect(actions({
      reviewers: [agent('security', 'reviewer', 'fail', true)],
      gate: 'review',
      exits: [exit('a', 'back', true), exit('b', 'back', true)],
    })).toEqual(['choose-exit'])
  })

  test('失败的执行者直接重跑', () => {
    expect(actions({ executors: [agent('builder', 'executor', 'fail', true)] })).toEqual(['run-agent'])
  })

  test('多条前进边就绪 → 选择出口；都不就绪 → 修', () => {
    expect(actions({ exits: [exit('a', 'forward', true), exit('b', 'forward', true)] }))
      .toEqual(['choose-exit'])
    const fix = stepNextActions(input({ exits: [exit('a', 'forward', false)] }))
    expect(fix[0]?.action).toBe('fix')
    expect(fix[0]?.blockers).toHaveLength(1)
  })

  test('终态自边 → complete', () => {
    expect(stepNextActions(input({ exits: [exit('archived', 'completion', true)] })))
      .toEqual([{ action: 'complete', event: 'archived' }])
  })

  /**
   * 真机实测的 P0（acceptance run）：`tenon transition <c> archived` 之后、`openspec archive`
   * 之前，状态机没有出边了，`next` 只剩 `{action: fix, blockers: []}`——一个没有可修项的 fix。
   * 同一刻 `tenon list` 按 `archived != true` 把它滤掉、`tenon list --finished` 只读 archive
   * 目录，两边都看不见它。治理归档那条命令必须由 `next` 自己点名。
   */
  test('状态机已归档 → 点名治理归档命令，而不是空 fix', () => {
    expect(stepNextActions(input({ runArchived: true, exits: [] }))).toEqual([{
      action: 'finish-change',
      change: 'demo',
      command: 'openspec archive demo --skip-specs --yes --json',
    }])
  })

  test('非 OpenSpec 治理的工作流归档后直接停', () => {
    const next = stepNextActions(input({ runArchived: true, governedOpenspec: false, exits: [] }))
    expect(next[0]).toMatchObject({ action: 'stop', code: 'run-archived' })
  })

  /**
   * 终态自边开出的步骤访问不会再前进，`tenon` 的加载证据在那次访问里也落不下来——先发
   * `load-tenon` 就变成新的死循环（真机实测里它连打 4 轮）。动作自带整条命令，先做归档即可。
   */
  test('已归档时不再回头发加载、技能、文档或出口动作', () => {
    expect(actions({
      runArchived: true,
      loaded: false,
      skills: [skill('brainstorming', 'ready', 0)],
      documents: { reads: [doc('plan', 'missing')], records: [doc('adr', 'missing')], updates: [] },
      exits: [exit('a', 'forward', true)],
    })).toEqual(['finish-change'])
  })
})
