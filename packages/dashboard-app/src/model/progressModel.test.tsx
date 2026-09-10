import { describe, it, expect } from 'vitest'
import {
  PROGRESS_STATES,
  changeProgressState,
  isDashboardGate,
  missingGateArtifacts,
  schedulerHealth,
  selectProgress,
  type ProgressCounts,
  type ProgressRules,
} from './progressModel'
import {
  DEFAULT_RULES,
  rulesFromDef,
  snapshotRulesKey,
  workflowRulesFromSnapshot,
  type WorkflowRules,
} from './workflowModel'
import { CUSTOM_WORKFLOW_FINGERPRINT, DEFAULT_WORKFLOW_FINGERPRINT, makeChange, makeProject, makeSnapshot } from '../testkit'
import type { ChangeSnapshot } from '../types'

/** demo 语境的 release-train：draft → review(review 门) → ship(confirm 门)。 */
const REL_DEF = {
  name: 'release-train',
  steps: [
    { id: 'draft', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'approved', to: 'review' }] },
    { id: 'review', label: '', gate: 'review', skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'shipped', to: 'ship' }] },
    { id: 'ship', label: '', gate: 'auto', skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ],
} as Parameters<typeof rulesFromDef>[0]

/** 裸自定义 rules：没有产出扩展面 → gate 视为「无自动证据」，人可直接拍板。 */
const REL_RULES: WorkflowRules = rulesFromDef(REL_DEF)

/** 带产出扩展面的自定义 rules：review 步声明 nonempty-output guard + outputs=['release_notes']。 */
const REL_RULES_GUARDED: ProgressRules = {
  ...rulesFromDef(REL_DEF),
  outputsByStep: { review: ['release_notes'] },
}
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

/** verify 三轨证据齐（可拍板）的 fields。 */
const VERIFY_OK = { verify_result: 'pass', agent_review_result: 'pass', codex_review_result: 'pass' }

/** 新契约中的 trusted Verify：readiness 是服务端逐 event 的权威结果，测试显式提供它。 */
const TRUSTED_VERIFY_EXECUTION = {
  readinessByTransition: {
    verify: {
      'verify-pass': { ready: true, blockers: [] },
      'verify-fail': { ready: true, blockers: [] },
    },
  },
}
function trustedVerify(name = 'c', over: Partial<ChangeSnapshot> = {}): ChangeSnapshot {
  return makeChange(name, 'verify', { ...over, workflowExecution: TRUSTED_VERIFY_EXECUTION })
}

describe('changeProgressState —— 五态判定（表驱动全覆盖）', () => {
  const table: [string, ChangeSnapshot, ProgressRules | undefined, (typeof PROGRESS_STATES)[number]][] = [
    // ── gate（等你确认）：gate 阶段且证据/产出齐 ──
    ['verify 三轨全 pass + authoritative readiness → gate', trustedVerify('c', { fields: { ...VERIFY_OK } }), DEFAULT_RULES, 'gate'],
    ['verify 有 fail 判定（可打回）+ authoritative readiness → gate', trustedVerify('c', { fields: { ...VERIFY_OK, verify_result: 'fail' } }), DEFAULT_RULES, 'gate'],
    ['Verify 没有 authoritative readiness 时 fail closed', makeChange('c', 'verify', { fields: { ...VERIFY_OK } }), DEFAULT_RULES, 'agent'],
    ['explore 只要求当前事件的 design_doc，不能被未来 spec 的 plan 阻塞', makeChange('c', 'explore', {
      fields: { design_doc: 'docs/d.md' },
      workflowExecution: {
        readinessByTransition: {
          open: { 'open-complete': { ready: true, blockers: [] } },
          explore: { 'explore-complete': { ready: true, blockers: [] } },
          spec: { 'spec-complete': { ready: false, blockers: [{ kind: 'guard-failed', guardType: 'file-exists', field: 'plan', actual: '' }] } },
          build: { 'build-complete': { ready: false, blockers: [{ kind: 'guard-failed', guardType: 'field-nonempty', field: 'build_mode', actual: '' }] }, 'requirements-changed': { ready: true, blockers: [] } },
          verify: { 'verify-pass': { ready: false, blockers: [{ kind: 'guard-failed', guardType: 'file-exists', field: 'verification_report', actual: '' }] }, 'verify-fail': { ready: true, blockers: [] } },
          ship: { 'ship-complete': { ready: false, blockers: [{ kind: 'guard-failed', guardType: 'spec-migration-applied', actual: 'missing' }] } },
          archive: {},
        },
      },
    }), DEFAULT_RULES, 'gate'],
    ['自定义 review 步无产出声明（无自动证据）→ gate', makeChange('c', 'review', {
      workflowExecution: REL_EXECUTION_READY,
    }), REL_RULES, 'gate'],
    ['自定义 review 步 nonempty guard 且产出已设 → gate', makeChange('c', 'review', {
      fields: { release_notes: 'notes.md' },
      workflowExecution: REL_EXECUTION_READY,
    }), REL_RULES_GUARDED, 'gate'],
    // ── agent（等 agent 补产出 / 活在终端里）──
    ['PM spec 不要求 legacy plan → gate', makeChange('c', 'spec', {
      track: 'pm',
      fields: { design_doc: 'docs/d.md' },
      workflowExecution: {
        readinessByTransition: {
          open: { 'open-complete': { ready: true, blockers: [] } },
          explore: { 'explore-complete': { ready: true, blockers: [] } },
          spec: { 'spec-complete': { ready: true, blockers: [] } },
          build: { 'build-complete': { ready: false, blockers: [{ kind: 'guard-failed', guardType: 'field-nonempty', field: 'build_mode', actual: '' }] }, 'requirements-changed': { ready: true, blockers: [] } },
          verify: { 'verify-pass': { ready: false, blockers: [{ kind: 'guard-failed', guardType: 'file-exists', field: 'verification_report', actual: '' }] }, 'verify-fail': { ready: true, blockers: [] } },
          ship: { 'ship-complete': { ready: false, blockers: [{ kind: 'guard-failed', guardType: 'spec-migration-applied', actual: 'missing' }] } },
          archive: {},
        },
      },
    }), DEFAULT_RULES, 'gate'],
    ["explore 的 design_doc 是字面 'null' → agent（cmd_get 口径未设）", makeChange('c', 'explore', { fields: { design_doc: 'null', plan: 'docs/p.md' } }), DEFAULT_RULES, 'agent'],
    ['verify 三轨全 pending 但两个出口 readiness 已明确 → gate', trustedVerify(), DEFAULT_RULES, 'gate'],
    ['自定义 review 步 nonempty guard 且产出未设 → agent', makeChange('c', 'review', {
      workflowExecution: REL_EXECUTION_REQUIRED,
    }), REL_RULES_GUARDED, 'agent'],
    ['default 非门阶段（build）无自动化 → agent', makeChange('c', 'build'), DEFAULT_RULES, 'agent'],
    ['default 非门阶段（open）无自动化 → agent', makeChange('c', 'open'), DEFAULT_RULES, 'agent'],
    ['confirm 门是终端会话内的秒级门，不是 dashboard 拍板点 → agent', makeChange('c', 'ship'), REL_RULES, 'agent'],
    ['automation=merged 回归阶段判定（ship 非门）→ agent', makeChange('c', 'ship', { fields: { automation: 'merged' } }), DEFAULT_RULES, 'agent'],
    ['rules 缺失（定义拉取失败）→ agent（卡不消失，判不了门）', makeChange('c', 'verify', { fields: { ...VERIFY_OK } }), undefined, 'agent'],
    // ── running / queued / failed：automation 态优先于阶段判定 ──
    ['automation=running → running', makeChange('c', 'build', { fields: { automation: 'running' } }), DEFAULT_RULES, 'running'],
    ['automation=scheduled（已认领在飞）→ running', makeChange('c', 'build', { fields: { automation: 'scheduled' } }), DEFAULT_RULES, 'running'],
    ['显式绑定的终端会话新鲜心跳 + automation=off → running', makeChange('c', 'build', {
      fields: { automation: 'off' },
      terminalActivity: {
        sessionId: '019f92c7-6e66-7290-9352-f9d915266f14',
        heartbeatAt: '2026-07-24T06:00:00.000Z',
        expiresAt: '2026-07-24T06:02:00.000Z',
      },
    }), DEFAULT_RULES, 'running'],
    ['gate 阶段但 automation=running 仍是 running（automation 优先）', makeChange('c', 'verify', { fields: { ...VERIFY_OK, automation: 'running' } }), DEFAULT_RULES, 'running'],
    ['automation=queued → queued', makeChange('c', 'open', { fields: { automation: 'queued' } }), DEFAULT_RULES, 'queued'],
    ['automation=failed → failed', makeChange('c', 'build', { fields: { automation: 'failed' } }), DEFAULT_RULES, 'failed'],
    ['automation=conflict（现场保留）→ failed', makeChange('c', 'build', { fields: { automation: 'conflict' } }), DEFAULT_RULES, 'failed'],
    ['rules 缺失但 automation=failed → failed（automation 判定不依赖 rules）', makeChange('c', 'build', { fields: { automation: 'failed' } }), undefined, 'failed'],
    // ── paused：跑完停住（L1/L2 report-only）归等你确认 ──
    ['automation=paused（非门阶段 build）→ gate（跑完停住等人放行）', makeChange('c', 'build', { fields: { automation: 'paused' } }), DEFAULT_RULES, 'gate'],
    ['automation=paused + rules 缺失 → gate', makeChange('c', 'explore', { fields: { automation: 'paused' } }), undefined, 'gate'],
    ['automation=paused 压过终端心跳，不能把待人工复核伪装成运行中', makeChange('c', 'build', {
      fields: { automation: 'paused' },
      terminalActivity: {
        sessionId: 'session-paused', heartbeatAt: '2026-07-24T06:00:00.000Z', expiresAt: '2026-07-24T06:02:00.000Z',
      },
    }), DEFAULT_RULES, 'gate'],
    // ── 未知 automation 值：回落阶段判定 ──
    ['automation 未知值回落阶段判定（verify readiness 齐）→ gate', trustedVerify('c', { fields: { ...VERIFY_OK, automation: 'bogus' } }), DEFAULT_RULES, 'gate'],
  ]

  it.each(table)('%s', (_desc, change, rules, expected) => {
    expect(changeProgressState(change, rules)).toBe(expected)
  })

  it('反序列化后的 default 规则仍逐 event 消费 Change 执行投影', () => {
    const deserializedDefaultRules = structuredClone(DEFAULT_RULES)

    expect(changeProgressState(
      trustedVerify(),
      deserializedDefaultRules,
    )).toBe('gate')
  })
})

describe('changeProgressState —— plan 结构与逐 Change 有效执行投影分层', () => {
  it('def 只声明 outputs；按 Track 求值的必需输出由 Change.workflowExecution 驱动', () => {
    const rules = rulesFromDef({
      ...REL_DEF,
      steps: REL_DEF.steps.map((s) =>
        s.id === 'review'
          ? { ...s, outputs: [{ field: 'release_notes', type: 'file_path' as const }], guards: [{ type: 'nonempty-output' as const }] }
          : s,
      ),
    })
    expect(changeProgressState(makeChange('c', 'review', {
      workflowExecution: REL_EXECUTION_REQUIRED,
    }), rules)).toBe('agent')
    expect(changeProgressState(makeChange('c', 'review', {
      fields: { release_notes: 'notes.md' },
      workflowExecution: REL_EXECUTION_READY,
    }), rules)).toBe('gate')
  })
})

describe('missingGateArtifacts —— 「等 agent 补产出」的欠账清单', () => {
  it('spec 缺 plan → ["plan"]（badge 文案数据源）', () => {
    const c = makeChange('c', 'spec', { fields: { design_doc: 'docs/d.md' } })
    expect(missingGateArtifacts(c, DEFAULT_RULES)).toEqual(['plan'])
  })

  it('verify-fail 出口无字段前置时不把 verify-pass 的字段并集当成欠账', () => {
    const c = makeChange('c', 'verify', { fields: { verify_result: 'pass' } })
    expect(missingGateArtifacts(c, DEFAULT_RULES)).toEqual(['verification_report'])
  })

  it('自定义 nonempty guard：未设产出点名；无 guard 声明 → 空（无自动证据）', () => {
    expect(missingGateArtifacts(makeChange('c', 'review', {
      workflowExecution: REL_EXECUTION_REQUIRED,
    }), REL_RULES_GUARDED)).toEqual(['release_notes'])
    expect(missingGateArtifacts(makeChange('c', 'review', {
      workflowExecution: REL_EXECUTION_READY,
    }), REL_RULES)).toEqual([])
  })

  it('多出口逐 event 求值：任一出口证据齐即 gate；全部未齐时只显示最小可达出口', () => {
    const rules: ProgressRules = {
      executionModel: 'step-graph',
      steps: ['review', 'done'],
      transitions: {
        review: [{ event: 'accept', to: 'done' }, { event: 'revise', to: 'done' }],
        done: [],
      },
      gateByStep: { review: 'review', done: null },
      labelByStep: {},
      outputsByStep: { review: ['plan', 'scope', 'verification_report'], done: [] },
    }
    const blockedExecution = {
      readinessByTransition: {
        review: {
          accept: {
            ready: false,
            blockers: [
              { kind: 'guard-failed' as const, guardType: 'field-nonempty', field: 'plan', actual: '' },
              { kind: 'guard-failed' as const, guardType: 'field-nonempty', field: 'scope', actual: '' },
              { kind: 'guard-failed' as const, guardType: 'field-nonempty', field: 'verification_report', actual: '' },
            ],
          },
          revise: {
            ready: false,
            blockers: [{ kind: 'guard-failed' as const, guardType: 'field-nonempty', field: 'plan', actual: '' }],
          },
        },
        done: {},
      },
    }
    const readyExecution = structuredClone(blockedExecution)
    readyExecution.readinessByTransition.review.revise = { ready: true, blockers: [] }

    expect(missingGateArtifacts(makeChange('ready-via-revise', 'review', {
      fields: { plan: 'docs/plan.md' },
      workflowExecution: readyExecution,
    }), rules)).toEqual([])
    expect(missingGateArtifacts(makeChange('not-ready', 'review', {
      workflowExecution: blockedExecution,
    }), rules)).toEqual(['plan'])
  })

  it('default 非门阶段 / rules 缺失 → 空', () => {
    expect(missingGateArtifacts(makeChange('c', 'build'), DEFAULT_RULES)).toEqual([])
    expect(missingGateArtifacts(makeChange('c', 'verify'), undefined)).toEqual([])
  })

  it('Verify pass blocker is not hidden by a ready rollback edge', () => {
    const mixed = makeChange('revision-blocked', 'verify', {
      workflowExecution: {
        readinessByTransition: {
          verify: {
            'verify-pass': {
              ready: false,
              blockers: [{
                kind: 'verify-build-revision-untrusted',
                code: 'verify-build-revision-untrusted',
                reason: 'revision-stale',
                remediation: 'return-to-build-and-capture-current-revision',
                stateHash: `sha256:${'a'.repeat(64)}`,
                revisionHash: `sha256:${'b'.repeat(64)}`,
              }],
            },
            'verify-fail': { ready: true, blockers: [] },
          },
        },
      },
    })
    expect(missingGateArtifacts(mixed, DEFAULT_RULES)).toEqual([
      'verify-build-revision-untrusted reason=revision-stale remediation=return-to-build-and-capture-current-revision',
    ])
    expect(changeProgressState(mixed, DEFAULT_RULES)).toBe('agent')
  })
})

describe('isDashboardGate —— 收件箱准入同源的门判据（T7 复用点）', () => {
  it('review 门是 dashboard 拍板点；confirm/null/rules 缺失不是', () => {
    expect(isDashboardGate(DEFAULT_RULES, 'verify')).toBe(true)
    expect(isDashboardGate(REL_RULES, 'review')).toBe(true)
    expect(isDashboardGate(REL_RULES, 'ship')).toBe(false)
    expect(isDashboardGate(REL_RULES, 'draft')).toBe(false)
    expect(isDashboardGate(undefined, 'verify')).toBe(false)
  })
})

describe('selectProgress —— 项目×workflow 分组选择器', () => {
  const RULES = new Map<string, WorkflowRules>([
    [snapshotRulesKey('/a', DEFAULT_WORKFLOW_FINGERPRINT), DEFAULT_RULES],
    [snapshotRulesKey('/a', CUSTOM_WORKFLOW_FINGERPRINT), REL_RULES_GUARDED],
    [snapshotRulesKey('/b', DEFAULT_WORKFLOW_FINGERPRINT), DEFAULT_RULES],
  ])

  it('null snapshot → 空组 + 全零计数', () => {
    const sel = selectProgress(null, '', RULES)
    expect(sel.groups).toEqual([])
    expect(sel.total).toBe(0)
    for (const s of PROGRESS_STATES) expect(sel.counts[s]).toBe(0)
  })

  it('分组键 = rulesKey(root,wf)；组序 root 升序、同 root 下 default 在前其余按名升序', () => {
    const snap = makeSnapshot([
      makeProject('/b', [makeChange('b1', 'open')]),
      makeProject('/a', [
        makeChange('a1', 'review', {
          fields: { workflow: 'release-train' },
          workflowExecution: REL_EXECUTION_READY,
        }),
        makeChange('a2', 'open'),
      ]),
    ])
    const sel = selectProgress(snap, '', RULES)
    expect(sel.groups.map((g) => g.key)).toEqual([
      snapshotRulesKey('/a', DEFAULT_WORKFLOW_FINGERPRINT),
      snapshotRulesKey('/a', CUSTOM_WORKFLOW_FINGERPRINT),
      snapshotRulesKey('/b', DEFAULT_WORKFLOW_FINGERPRINT),
    ])
    expect(sel.groups[0]).toMatchObject({ root: '/a', workflow: 'default' })
    expect(sel.groups[1]).toMatchObject({ root: '/a', workflow: 'release-train' })
  })

  it('组内行序：updated_at 倒序，并列按 name 升序', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        makeChange('older', 'open', { updated_at: '2026-07-01T00:00:00Z' }),
        makeChange('tie-b', 'open', { updated_at: '2026-07-08T00:00:00Z' }),
        makeChange('tie-a', 'open', { updated_at: '2026-07-08T00:00:00Z' }),
      ]),
    ])
    const sel = selectProgress(snap, '/a', RULES)
    expect(sel.groups[0]!.rows.map((r) => r.change.name)).toEqual(['tie-a', 'tie-b', 'older'])
  })

  it('同名 workflow 的两个冻结修订按 plan fingerprint 分组且各用自己的 gate 规则', () => {
    const reviewRules = rulesFromDef(REL_DEF)
    const noGateRules = { ...reviewRules, gateByStep: { ...reviewRules.gateByStep, review: null } }
    const firstFingerprint = '2'.repeat(64)
    const secondFingerprint = '3'.repeat(64)
    const snap = makeSnapshot([makeProject('/a', [
      makeChange('old-plan', 'review', {
        fields: { workflow: 'release-train' },
        workflowPlanFingerprint: firstFingerprint,
        workflowRules: {
          executionModel: 'step-graph',
          steps: [...reviewRules.steps],
          transitions: reviewRules.transitions as Record<string, Array<{ event: string; to: string }>>,
          gateByStep: reviewRules.gateByStep,
          labelByStep: reviewRules.labelByStep ?? {},
          outputsByStep: Object.fromEntries(reviewRules.steps.map((step) => [step, []])),
        },
        workflowExecution: {
          readinessByTransition: {
            draft: { approved: { ready: true, blockers: [] } },
            review: { shipped: { ready: true, blockers: [] } },
            ship: {},
          },
        },
      }),
      makeChange('new-plan', 'review', {
        fields: { workflow: 'release-train' },
        workflowPlanFingerprint: secondFingerprint,
        workflowRules: {
          executionModel: 'step-graph',
          steps: [...noGateRules.steps],
          transitions: noGateRules.transitions as Record<string, Array<{ event: string; to: string }>>,
          gateByStep: noGateRules.gateByStep,
          labelByStep: noGateRules.labelByStep ?? {},
          outputsByStep: Object.fromEntries(noGateRules.steps.map((step) => [step, []])),
        },
        workflowExecution: {
          readinessByTransition: {
            draft: { approved: { ready: true, blockers: [] } },
            review: { shipped: { ready: true, blockers: [] } },
            ship: {},
          },
        },
      }),
    ])])
    const rules = new Map([
      [snapshotRulesKey('/a', firstFingerprint), reviewRules],
      [snapshotRulesKey('/a', secondFingerprint), noGateRules],
    ])
    const selection = selectProgress(snap, '/a', rules)
    expect(selection.groups).toHaveLength(2)
    expect(new Map(selection.groups.map((group) => [group.workflowPlanFingerprint, group.rows[0]?.state]))).toEqual(
      new Map([[firstFingerprint, 'gate'], [secondFingerprint, 'agent']]),
    )
  })

  it('同一冻结 plan 的不同 Track 逐 Change 消费自己的有效输出投影', () => {
    const fingerprint = '4'.repeat(64)
    const snap = makeSnapshot([makeProject('/a', [
      makeChange('backend-change', 'review', {
        track: 'backend',
        fields: { workflow: 'release-train' },
        workflowPlanFingerprint: fingerprint,
        workflowRules: {
          executionModel: 'step-graph',
          steps: [...REL_RULES_GUARDED.steps],
          transitions: REL_RULES_GUARDED.transitions as Record<string, Array<{ event: string; to: string }>>,
          gateByStep: REL_RULES_GUARDED.gateByStep,
          labelByStep: REL_RULES_GUARDED.labelByStep ?? {},
          outputsByStep: { review: ['release_notes'], draft: [], ship: [] },
        },
        workflowExecution: {
          readinessByTransition: {
            draft: { approved: { ready: true, blockers: [] } },
            review: {
              shipped: {
                ready: false,
                blockers: [{
                  kind: 'guard-failed',
                  guardType: 'field-nonempty',
                  field: 'release_notes',
                  actual: '',
                }],
              },
            },
            ship: {},
          },
        },
      }),
      makeChange('pm-change', 'review', {
        track: 'pm',
        fields: { workflow: 'release-train' },
        workflowPlanFingerprint: fingerprint,
        workflowRules: {
          executionModel: 'step-graph',
          steps: [...REL_RULES_GUARDED.steps],
          transitions: REL_RULES_GUARDED.transitions as Record<string, Array<{ event: string; to: string }>>,
          gateByStep: REL_RULES_GUARDED.gateByStep,
          labelByStep: REL_RULES_GUARDED.labelByStep ?? {},
          outputsByStep: { review: ['release_notes'], draft: [], ship: [] },
        },
        workflowExecution: {
          readinessByTransition: {
            draft: { approved: { ready: true, blockers: [] } },
            review: { shipped: { ready: true, blockers: [] } },
            ship: {},
          },
        },
      }),
    ])])

    const selection = selectProgress(snap, '/a', workflowRulesFromSnapshot(snap))
    expect(selection.groups).toHaveLength(1)
    expect(new Map(selection.groups[0]?.rows.map((row) => [row.change.track, row.state]))).toEqual(
      new Map([['backend', 'agent'], ['pm', 'gate']]),
    )
  })

  it('currentRoot 非空只看该项目；空串聚合全部且行各自带 root', () => {
    const snap = makeSnapshot([
      makeProject('/a', [makeChange('a1', 'open')]),
      makeProject('/b', [makeChange('b1', 'open')]),
    ])
    const only = selectProgress(snap, '/a', RULES)
    expect(only.groups.map((g) => g.root)).toEqual(['/a'])
    const all = selectProgress(snap, '', RULES)
    expect(all.groups.map((g) => g.root)).toEqual(['/a', '/b'])
    expect(all.groups.flatMap((g) => g.rows.map((r) => r.root))).toEqual(['/a', '/b'])
  })

  it('ok:false 的项目跳过（不产组不计数）', () => {
    const snap = makeSnapshot([
      makeProject('/a', [makeChange('a1', 'open')]),
      makeProject('/broken', [makeChange('x', 'open')], { ok: false, error: 'boom' }),
    ])
    const sel = selectProgress(snap, '', RULES)
    expect(sel.groups.map((g) => g.root)).toEqual(['/a'])
    expect(sel.total).toBe(1)
  })

  it('兼容问题项目保留可读 Change 与其冻结 workflow rules，普通错误项目仍跳过', () => {
    const readable = makeChange('readable', 'review', {
      fields: { workflow: 'release-train' },
      workflowExecution: REL_EXECUTION_READY,
      workflowRules: {
        executionModel: 'step-graph',
        steps: [...REL_RULES.steps],
        transitions: REL_RULES.transitions as Record<string, Array<{ event: string; to: string }>>,
        gateByStep: REL_RULES.gateByStep,
        labelByStep: REL_RULES.labelByStep ?? {},
        outputsByStep: { draft: [], review: [], ship: [] },
      },
    })
    const snap = makeSnapshot([
      makeProject('/mixed', [readable], {
        ok: false,
        compatibilityIssues: [{
          kind: 'unsupported-canonical-version',
          change: 'future',
          foundVersion: 2,
          supportedVersion: 1,
          action: 'upgrade-runtime',
        }],
      }),
      makeProject('/broken', [makeChange('hidden', 'open')], { ok: false, error: 'boom' }),
    ])
    const rules = workflowRulesFromSnapshot(snap)
    const sel = selectProgress(snap, '', rules)

    expect(rules.get(snapshotRulesKey('/mixed', readable.workflowPlanFingerprint))).toBeDefined()
    expect(sel.groups.map((group) => group.root)).toEqual(['/mixed'])
    expect(sel.groups[0]?.rows.map((row) => row.change.name)).toEqual(['readable'])
    expect(sel.total).toBe(1)
  })

  it('archived 一律排除出行，但计入组头 archivedCount', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        makeChange('live', 'open'),
        makeChange('gone', 'archive', { archived: 'true' }),
      ]),
    ])
    const sel = selectProgress(snap, '/a', RULES)
    expect(sel.groups).toHaveLength(1)
    expect(sel.groups[0]).toMatchObject({ workflow: 'default', archivedCount: 1 })
    expect(sel.groups[0]!.rows.map((r) => r.change.name)).toEqual(['live'])
    expect(sel.total).toBe(1)
  })

  it('P1 修复：workflow 组若全部 change 都归档（零活跃行），组仍出现在 groups 里（archived 非空即保留组，供归档折叠区渲染）', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        makeChange('live', 'open'),
        makeChange('rel-gone-1', 'ship', {
          archived: 'true',
          updated_at: '2026-07-05T00:00:00Z',
          fields: { workflow: 'release-train' },
        }),
        makeChange('rel-gone-2', 'review', {
          archived: 'true',
          updated_at: '2026-07-06T00:00:00Z',
          fields: { workflow: 'release-train', release_notes: 'n.md' },
          workflowExecution: REL_EXECUTION_READY,
        }),
      ]),
    ])
    const sel = selectProgress(snap, '/a', RULES)
    expect(sel.groups).toHaveLength(2)
    const relGroup = sel.groups.find((g) => g.workflow === 'release-train')
    expect(relGroup).toBeDefined()
    expect(relGroup!.root).toBe('/a')
    expect(relGroup!.rows).toEqual([])
    expect(relGroup!.archivedCount).toBe(2)
    expect(relGroup!.archived.map((r) => r.change.name)).toEqual(['rel-gone-2', 'rel-gone-1']) // updated_at 倒序
    // 不变式不变：纯归档组不产任何计数，counts/total 仍只认活跃行 'live'
    expect(sel.total).toBe(1)
    expect(sel.counts).toEqual({ gate: 0, agent: 1, running: 0, queued: 0, failed: 0 })
  })

  it('#2：archived 数组含归档行的完整投影（state 判定同源，updated_at 倒序），且不影响 counts/total 不变式', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        makeChange('live', 'open'),
        makeChange('gone-older', 'archive', { archived: 'true', updated_at: '2026-07-01T00:00:00Z' }),
        makeChange('gone-newer', 'build', {
          archived: 'true',
          updated_at: '2026-07-05T00:00:00Z',
          fields: { automation: 'failed' },
        }),
      ]),
    ])
    const sel = selectProgress(snap, '/a', RULES)
    expect(sel.groups).toHaveLength(1)
    const g = sel.groups[0]!
    // archived 数组长度恒等 archivedCount；updated_at 倒序（同 rows 口径）
    expect(g.archivedCount).toBe(2)
    expect(g.archived.map((r) => r.change.name)).toEqual(['gone-newer', 'gone-older'])
    // state 判定同 changeProgressState 同源：failed automation → failed；无自动化的非门阶段 → agent
    expect(g.archived.map((r) => r.state)).toEqual(['failed', 'agent'])
    expect(g.archived.every((r) => r.root === '/a')).toBe(true)
    // 不变式不变：counts/total 仍只统计未归档行（live 一条,'open' 非门阶段无自动化 → agent）
    expect(sel.total).toBe(1)
    expect(sel.counts).toEqual({ gate: 0, agent: 1, running: 0, queued: 0, failed: 0 })
  })

  it('行上的 state 与 changeProgressState 同源；rules 按 rulesKey 查（同名 wf 跨项目不串）', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        trustedVerify('gate-1', { fields: { ...VERIFY_OK } }),
        makeChange('agent-1', 'spec'),
        makeChange('run-1', 'build', { fields: { automation: 'running' } }),
        makeChange('queue-1', 'open', { fields: { automation: 'queued' } }),
        makeChange('fail-1', 'build', { fields: { automation: 'conflict' } }),
      ]),
    ])
    const sel = selectProgress(snap, '/a', RULES)
    const byName = new Map(sel.groups[0]!.rows.map((r) => [r.change.name, r.state]))
    expect(byName.get('gate-1')).toBe('gate')
    expect(byName.get('agent-1')).toBe('agent')
    expect(byName.get('run-1')).toBe('running')
    expect(byName.get('queue-1')).toBe('queued')
    expect(byName.get('fail-1')).toBe('failed')
  })

  it('不变式：五态计数之和 === total === 各组行数之和（聚合双项目混合态）', () => {
    const snap = makeSnapshot([
      makeProject('/a', [
        trustedVerify('a-gate', { fields: { ...VERIFY_OK } }),
        makeChange('a-agent', 'spec'),
        makeChange('a-run', 'build', { fields: { automation: 'running' } }),
        makeChange('a-archived', 'ship', { archived: 'true' }),
        makeChange('a-rel', 'review', {
          fields: { workflow: 'release-train', release_notes: 'n.md' },
          workflowExecution: REL_EXECUTION_READY,
        }),
      ]),
      makeProject('/b', [
        makeChange('b-queue', 'open', { fields: { automation: 'queued' } }),
        makeChange('b-fail', 'build', { fields: { automation: 'failed' } }),
        makeChange('b-paused', 'build', { fields: { automation: 'paused' } }),
      ]),
      makeProject('/broken', [makeChange('x', 'open')], { ok: false }),
    ])
    const sel = selectProgress(snap, '', RULES)
    const sumCounts = PROGRESS_STATES.reduce((n, s) => n + sel.counts[s], 0)
    const sumRows = sel.groups.reduce((n, g) => n + g.rows.length, 0)
    expect(sumCounts).toBe(sel.total)
    expect(sumRows).toBe(sel.total)
    expect(sel.total).toBe(7) // archived 排除、ok:false 排除
    expect(sel.counts).toEqual({ gate: 3, agent: 1, running: 1, queued: 1, failed: 1 })
  })
})

describe('schedulerHealth —— 调度器健康灯聚合（对齐 server afk.ts 判据）', () => {
  const counts = (over: Partial<ProgressCounts>): ProgressCounts => ({ gate: 0, agent: 0, running: 0, queued: 0, failed: 0, ...over })

  it('有 failed（含 conflict 折叠）→ attention，压过 busy', () => {
    expect(schedulerHealth(counts({ failed: 2, running: 3, queued: 1 }))).toEqual({ status: 'attention', running: 3, queued: 1, failed: 2 })
  })

  it('有在跑或排队、无失败 → busy', () => {
    expect(schedulerHealth(counts({ running: 1 }))).toEqual({ status: 'busy', running: 1, queued: 0, failed: 0 })
    expect(schedulerHealth(counts({ queued: 2 }))).toEqual({ status: 'busy', running: 0, queued: 2, failed: 0 })
  })

  it('只有 gate/agent（无自动化活跃）→ ok', () => {
    expect(schedulerHealth(counts({ gate: 5, agent: 3 }))).toEqual({ status: 'ok', running: 0, queued: 0, failed: 0 })
  })
})
