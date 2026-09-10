import { describe, it, expect } from 'vitest'
import { changeWorkflow, decisionKind, isAwaitingDecision, projectName, selectInbox } from './inbox'
import { DEFAULT_RULES, rulesFromDef, rulesKey, type WorkflowRules } from '../model/workflowModel'
import { makeChange, makeProject, makeSnapshot } from '../testkit'

const REL_RULES = rulesFromDef({
  name: 'release-train',
  steps: [
    { id: 'draft', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'approved', to: 'review' }] },
    { id: 'review', label: '', gate: 'review', skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'shipped', to: 'ship' }] },
    { id: 'ship', label: '', gate: 'auto', skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ],
})

/** review 步声明 release_notes；按 Track 求值后的必需输出由 Change.execution 单独承载。 */
const REL_RULES_GUARDED = rulesFromDef({
  name: 'release-train',
  steps: [
    { id: 'draft', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'approved', to: 'review' }] },
    {
      id: 'review',
      label: '',
      gate: 'review',
      skills: [],
      inputs: [],
      outputs: [{ field: 'release_notes', type: 'file_path' }],
      guards: [{ type: 'nonempty-output' }],
      transitions: [{ event: 'shipped', to: 'ship' }],
    },
    { id: 'ship', label: '', gate: 'auto', skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ],
})
const REL_EXECUTION_REQUIRED = {
  readinessByTransition: {
    draft: { approved: { ready: true, blockers: [] } },
    review: {
      shipped: {
        ready: false,
        blockers: [{
          kind: 'guard-failed' as const,
          guardType: 'field-nonempty',
          field: 'release_notes',
          actual: '',
        }],
      },
    },
    ship: {},
  },
}
const REL_EXECUTION_READY = {
  readinessByTransition: {
    draft: { approved: { ready: true, blockers: [] } },
    review: { shipped: { ready: true, blockers: [] } },
    ship: {},
  },
}

/** verify 门三轨证据齐（可拍板）的 fields（同 progressModel.test 的 VERIFY_OK 口径）。 */
const VERIFY_OK = { verify_result: 'pass', agent_review_result: 'pass', codex_review_result: 'pass' }
/** Trusted Verify fixture: readiness comes from the server-shaped canonical projection. */
const TRUSTED_VERIFY_EXECUTION = {
  readinessByTransition: {
    verify: {
      'verify-pass': { ready: true, blockers: [] },
      'verify-fail': { ready: true, blockers: [] },
    },
  },
}
function trustedVerifyChange(name: string, over: Parameters<typeof makeChange>[2] = {}) {
  return makeChange(name, 'verify', { ...over, workflowExecution: TRUSTED_VERIFY_EXECUTION })
}
/** explore/spec 门双产出齐的 fields。 */
const DOCS_OK = { design_doc: 'docs/d.md', plan: 'docs/p.md' }

// Task 8（G19③）：selectInbox 第三参键从「裸 wf 名」升级为「rulesKey(root,wf)」——本文件既有
// selectInbox 测试全部固定用 root='/a'，迁移只需把 Map 的 key 从 wf 名换成 rulesKey('/a', wf)，
// 断言的期望输出（items 内容/顺序）逐字不变——这就是意图迁移表要证明的"非聚合路径行为不变"。
const RULES = new Map<string, WorkflowRules>([
  [rulesKey('/a', 'default'), DEFAULT_RULES],
  [rulesKey('/a', 'release-train'), REL_RULES],
])

/**
 * T7 准入修订（决策 B）：判据从「gate 阶段就进」改为「人现在能拍板」——与 progressModel
 * 五态判定共享同源谓词（state ∈ {gate, failed}），缺产出的 gate 卡判给进度「等 agent」不进
 * 收件箱。既有 G17 测试的意图迁移：原「门阶段在等」用例补齐证据字段后期望不变；新增「缺产出
 * 不进」「automation paused/failed 进、running/queued 不进」两组判据。
 */
describe('isAwaitingDecision（T7 准入：人现在能拍板）', () => {
  it('default：explore/spec 双产出齐、verify 三轨齐（未归档）→ 在等我决定', () => {
    expect(isAwaitingDecision(makeChange('c', 'explore', { fields: { ...DOCS_OK } }), DEFAULT_RULES)).toBe(true)
    expect(isAwaitingDecision(makeChange('c', 'spec', { fields: { ...DOCS_OK } }), DEFAULT_RULES)).toBe(true)
    expect(isAwaitingDecision(trustedVerifyChange('c', { fields: { ...VERIFY_OK } }), DEFAULT_RULES)).toBe(true)
  })

  it('default：单出口门缺字段时不在等；verify 的无前置 fail 出口仍可交给人决策', () => {
    expect(isAwaitingDecision(makeChange('c', 'explore'), DEFAULT_RULES)).toBe(false)
    expect(isAwaitingDecision(makeChange('c', 'spec', { fields: { design_doc: 'docs/d.md' } }), DEFAULT_RULES)).toBe(false)
    expect(isAwaitingDecision(trustedVerifyChange('c', { fields: { ...VERIFY_OK, codex_review_result: 'pending' } }), DEFAULT_RULES)).toBe(true)
  })

  it('default：verify 三轨齐但 verification_report/build_sha 未设仍在等（产物没产出不等于验证没过）', () => {
    expect(isAwaitingDecision(trustedVerifyChange('c', { fields: { ...VERIFY_OK } }), DEFAULT_RULES)).toBe(true)
  })

  it('default：open/build/ship/archive 非门阶段不在等我决定', () => {
    for (const phase of ['open', 'build', 'ship', 'archive']) {
      expect(isAwaitingDecision(makeChange('c', phase), DEFAULT_RULES)).toBe(false)
    }
  })

  it('已归档（archived=true）即便证据齐/automation failed 也不入收件箱', () => {
    expect(isAwaitingDecision(makeChange('c', 'verify', { archived: 'true', fields: { ...VERIFY_OK } }), DEFAULT_RULES)).toBe(false)
    expect(isAwaitingDecision(makeChange('c', 'build', { archived: 'true', fields: { automation: 'failed' } }), DEFAULT_RULES)).toBe(false)
  })

  it('自定义 workflow：review 门无产出声明（无自动证据）→ 在等；gate=confirm/null 不在等', () => {
    expect(isAwaitingDecision(makeChange('c', 'review', {
      workflowExecution: REL_EXECUTION_READY,
    }), REL_RULES)).toBe(true)
    expect(isAwaitingDecision(makeChange('c', 'ship'), REL_RULES)).toBe(false)
    expect(isAwaitingDecision(makeChange('c', 'draft'), REL_RULES)).toBe(false)
  })

  it('自定义 workflow：逐 Change 有效输出缺失不进，产出齐才进', () => {
    expect(isAwaitingDecision(makeChange('c', 'review', {
      workflowExecution: REL_EXECUTION_REQUIRED,
    }), REL_RULES_GUARDED)).toBe(false)
    expect(isAwaitingDecision(makeChange('c', 'review', {
      fields: { release_notes: 'notes.md' },
      workflowExecution: REL_EXECUTION_READY,
    }), REL_RULES_GUARDED)).toBe(true)
  })

  it('automation ∈ {paused, failed, conflict} → 在等（不论阶段，人要拍板放行/重试/放弃）', () => {
    expect(isAwaitingDecision(makeChange('c', 'build', { fields: { automation: 'paused' } }), DEFAULT_RULES)).toBe(true)
    expect(isAwaitingDecision(makeChange('c', 'build', { fields: { automation: 'failed' } }), DEFAULT_RULES)).toBe(true)
    expect(isAwaitingDecision(makeChange('c', 'build', { fields: { automation: 'conflict' } }), DEFAULT_RULES)).toBe(true)
  })

  it('automation ∈ {running, scheduled, queued} → 不在等（agent 在飞，门阶段证据齐也不进）', () => {
    for (const automation of ['running', 'scheduled', 'queued']) {
      expect(isAwaitingDecision(makeChange('c', 'verify', { fields: { ...VERIFY_OK, automation } }), DEFAULT_RULES)).toBe(false)
    }
  })

  it('rules 缺失（定义拉取失败）→ 不误报；路径字段非空也不进（交叉场景补钉）', () => {
    expect(isAwaitingDecision(makeChange('c', 'verify', { fields: { ...VERIFY_OK } }), undefined)).toBe(false)
    expect(isAwaitingDecision(makeChange('c', 'review', { fields: { ...DOCS_OK } }), undefined)).toBe(false)
  })

  it('rules 缺失但 automation=failed/paused → 仍在等（automation 判定不依赖 rules）', () => {
    expect(isAwaitingDecision(makeChange('c', 'build', { fields: { automation: 'failed' } }), undefined)).toBe(true)
    expect(isAwaitingDecision(makeChange('c', 'build', { fields: { automation: 'paused' } }), undefined)).toBe(true)
  })
})

describe('changeWorkflow（fields.workflow 回落 default）', () => {
  it('未设/空 → default；显式设置 → 原名', () => {
    expect(changeWorkflow(makeChange('c', 'open'))).toBe('default')
    expect(changeWorkflow(makeChange('c', 'open', { fields: { workflow: '' } }))).toBe('default')
    expect(changeWorkflow(makeChange('c', 'draft', { fields: { workflow: 'release-train' } }))).toBe('release-train')
  })
})

describe('selectInbox（currentRoot 语境下摘出人现在能拍板的 change）', () => {
  it('null snapshot → 空', () => {
    expect(selectInbox(null, '/a', RULES)).toEqual([])
  })

  it('只保留能拍板的卡，且只看 currentRoot 项目（其它项目的卡不出现）', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        makeChange('a-open', 'open'),
        trustedVerifyChange('a-verify', { fields: { ...VERIFY_OK } }),
      ]),
      makeProject('/b', [makeChange('b-spec', 'spec', { fields: { ...DOCS_OK } })]),
    ])
    const items = selectInbox(snap, '/a', RULES)
    expect(items.map((i) => i.change.name)).toEqual(['a-verify'])
  })

  it('单出口缺字段不进收件箱；多出口只要无前置的 fail 出口可走就进入', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        trustedVerifyChange('evidence-ok', { fields: { ...VERIFY_OK } }),
        trustedVerifyChange('evidence-missing'),
        makeChange('plan-missing', 'spec', { fields: { design_doc: 'docs/d.md' } }),
      ]),
    ])
    expect(selectInbox(snap, '/a', RULES).map((i) => i.change.name)).toEqual([
      'evidence-missing',
      'evidence-ok',
    ])
  })

  it('automation failed/paused 卡进收件箱，running/queued 不进', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        makeChange('afk-failed', 'build', { fields: { automation: 'failed' } }),
        makeChange('afk-paused', 'build', { fields: { automation: 'paused' }, updated_at: '2026-07-06T00:00:00Z' }),
        makeChange('afk-running', 'build', { fields: { automation: 'running' } }),
        makeChange('afk-queued', 'open', { fields: { automation: 'queued' } }),
      ]),
    ])
    expect(selectInbox(snap, '/a', RULES).map((i) => i.change.name)).toEqual(['afk-failed', 'afk-paused'])
  })

  it('自定义 workflow 的 gate 卡也进收件箱（G17 修复证据；无产出声明 = 无自动证据可直接拍板）', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        makeChange('rel-x', 'review', {
          fields: { workflow: 'release-train' },
          workflowExecution: REL_EXECUTION_READY,
        }),
        makeChange('rel-y', 'draft', { fields: { workflow: 'release-train' } }),
      ]),
    ])
    expect(selectInbox(snap, '/a', RULES).map((i) => i.change.name)).toEqual(['rel-x'])
  })

  it('跳过 ok=false 的项目（不可达 project 不谎报待办）', () => {
    const snap = makeSnapshot([
      makeProject('/bad', [makeChange('x', 'verify', { fields: { ...VERIFY_OK } })], { ok: false, error: 'unreachable' }),
    ])
    expect(selectInbox(snap, '/bad', RULES)).toEqual([])
  })

  it('只含未来版本问题的项目保留可读 sibling 决策徽标，若同时损坏则继续拒绝', () => {
    const compatibilityIssues = [{
      kind: 'unsupported-canonical-version' as const,
      change: 'future',
      foundVersion: 2,
      supportedVersion: 1,
      action: 'upgrade-runtime' as const,
    }]
    const snap = makeSnapshot([
      makeProject('/read-only', [
        trustedVerifyChange('readable-verify', { fields: { ...VERIFY_OK } }),
      ], { ok: false, compatibilityIssues }),
      makeProject('/broken', [
        makeChange('hidden-verify', 'verify', { fields: { ...VERIFY_OK } }),
      ], { ok: false, compatibilityIssues, error: 'corrupt current' }),
    ])

    expect(selectInbox(snap, '/read-only', RULES).map((item) => item.change.name))
      .toEqual(['readable-verify'])
    expect(selectInbox(snap, '/broken', RULES)).toEqual([])
  })

  it('按 updated_at 倒序、并列按 name 升序', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        trustedVerifyChange('old', { updated_at: '2026-07-01T00:00:00Z', fields: { ...VERIFY_OK } }),
        makeChange('new-b', 'spec', { updated_at: '2026-07-07T00:00:00Z', fields: { ...DOCS_OK } }),
        makeChange('new-a', 'explore', { updated_at: '2026-07-07T00:00:00Z', fields: { ...DOCS_OK } }),
      ]),
    ])
    expect(selectInbox(snap, '/a', RULES).map((i) => i.change.name)).toEqual(['new-a', 'new-b', 'old'])
  })
})

describe('selectInbox 聚合语境（currentRoot=""，Task 8/G19③ 前半）', () => {
  it("currentRoot='' → 遍历全部 ok 项目的可拍板卡，每条各自带正确 root（ok=false 项目仍被跳过）", () => {
    const snap = makeSnapshot([
      makeProject('/a', [trustedVerifyChange('a-verify', { updated_at: '2026-07-01T00:00:00Z', fields: { ...VERIFY_OK } })]),
      makeProject('/b', [makeChange('b-spec', 'spec', { updated_at: '2026-07-02T00:00:00Z', fields: { ...DOCS_OK } })]),
      makeProject('/bad', [makeChange('bad-verify', 'verify', { fields: { ...VERIFY_OK } })], { ok: false, error: 'unreachable' }),
    ])
    const rulesByKey = new Map<string, WorkflowRules>([
      [rulesKey('/a', 'default'), DEFAULT_RULES],
      [rulesKey('/b', 'default'), DEFAULT_RULES],
    ])
    const items = selectInbox(snap, '', rulesByKey)
    expect(items.map((i) => ({ root: i.root, name: i.change.name }))).toEqual([
      { root: '/b', name: 'b-spec' }, // updated_at 更新（07-02），倒序排前
      { root: '/a', name: 'a-verify' },
    ])
  })

  it('rulesKey 区分同名自定义 workflow：两个项目都叫它 release-train 但门语义不同，各自按自己项目的规则判定（不串 key）', () => {
    const reviewGates = rulesFromDef({
      name: 'release-train',
      steps: [{ id: 'review', label: '', gate: 'review', skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    const noGates = rulesFromDef({
      name: 'release-train',
      steps: [{ id: 'review', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    const snap = makeSnapshot([
      makeProject('/a', [makeChange('a-review', 'review', { fields: { workflow: 'release-train' } })]),
      makeProject('/b', [makeChange('b-review', 'review', { fields: { workflow: 'release-train' } })]),
    ])
    const rulesByKey = new Map<string, WorkflowRules>([
      [rulesKey('/a', 'release-train'), reviewGates],
      [rulesKey('/b', 'release-train'), noGates],
    ])
    // 若第三参仍按裸 wf 名键（旧契约），两个 Map 条目会共享同一个 'release-train' 键、互相
    // 覆盖（后写的 noGates 会盖掉 reviewGates），a-review 也会被误判成"不在等"，结果变 []。
    // rulesKey(root,wf) 隔离后两条各自命中自己项目的规则，只有 a-review 在等。
    expect(selectInbox(snap, '', rulesByKey).map((i) => i.change.name)).toEqual(['a-review'])
  })
})

describe('decisionKind / projectName', () => {
  it('decisionKind：default 三阶段保留细分文案 key，自定义 step 一律 other', () => {
    expect(decisionKind(makeChange('c', 'explore'))).toBe('explore')
    expect(decisionKind(makeChange('c', 'spec'))).toBe('spec')
    expect(decisionKind(makeChange('c', 'verify'))).toBe('verify')
    expect(decisionKind(makeChange('c', 'build'))).toBe('other')
    expect(decisionKind(makeChange('c', 'review', { fields: { workflow: 'release-train' } }))).toBe('other')
  })

  it('projectName 取路径末段', () => {
    expect(projectName(makeProject('/Users/me/code/my-repo', []))).toBe('my-repo')
  })
})
