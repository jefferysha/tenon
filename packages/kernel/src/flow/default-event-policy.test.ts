/**
 * DefaultEventPolicy 单测（G2 P3）——default 轨事件的 typed guard/action 政策 + 逐字 ERROR
 * 文案渲染的回归锚。真相源 = 老仓 skills/pipeline/scripts/state-transition.sh cmd_transition
 * case 块（文案逐字对齐）；本套是 flow/transition-table.ts 两个 legacy switch 迁到 typed handler
 * 后的**新路径**特征化——precondition 逐字文案从「switch 直出字符串」变成「typed guard 判定 +
 * renderer 渲染」，本套钉住新路径产出与老 switch 逐字一致（老 switch 的直测在
 * transition-table.test.ts 删除前一直并存，两套同断言值 = 迁移等价的双重证据）。
 */
import { describe, expect, test } from 'vitest'
import type { FieldName, PipelineState } from '../types.js'
import type { TransitionContext } from './transition-table.js'
import {
  checkDefaultEventPreconditions,
  DEFAULT_EVENT_POLICY,
  defaultEventGuardFields,
  renderPreconditionViolation,
} from './default-event-policy.js'
import { evaluateGuards, type GuardEvaluation } from '../workflow/guard-handlers.js'
import {
  assessBuildRevisionTrust,
  createBuildRevisionToken,
  makeBuildRevisionBlocker,
  safeRevisionHash,
} from '../workflow/build-revision.js'
import { compileEffectiveWorkflowPlan } from '../workflow/effective-plan.js'
import { readinessByTransition } from '../workflow/transition-readiness.js'

/** 最小 PipelineState 构造：只关心被测字段，其余留空串。 */
function mkState(fields: Partial<Record<FieldName, string | string[]>>): PipelineState {
  return { fields: { ...fields } as Record<FieldName, string | string[]>, opaqueTail: '' }
}

/** 文件面注入：全部存在 / 全部不存在。 */
const filesExist = (exists: boolean): TransitionContext => ({ fileExists: () => exists })

describe('DEFAULT_EVENT_POLICY 表结构（穷尽 9 事件 + action 一一映射）', () => {
  test('键穷尽 = TRANSITION_EVENTS 9 事件', () => {
    expect(Object.keys(DEFAULT_EVENT_POLICY).sort()).toEqual(
      [
        'archived', 'build-complete', 'explore-complete', 'open-complete', 'requirements-changed',
        'ship-complete', 'spec-complete', 'verify-fail', 'verify-pass',
      ].sort(),
    )
  })

  test('action 映射：新实现 visit 重置 pre-Verify，build 冻结，verify/archive 保留既有副作用', () => {
    expect(DEFAULT_EVENT_POLICY['build-complete'].actions).toEqual([{ type: 'freeze-build-sha' }])
    expect(DEFAULT_EVENT_POLICY['verify-pass'].actions).toEqual([{ type: 'mark-verification-passed' }])
    expect(DEFAULT_EVENT_POLICY['spec-complete'].actions).toEqual([{ type: 'reset-pre-verify-review' }])
    expect(DEFAULT_EVENT_POLICY['requirements-changed'].actions).toEqual([{ type: 'reset-pre-verify-review' }])
    expect(DEFAULT_EVENT_POLICY['verify-fail'].actions).toEqual([
      { type: 'mark-verification-failed' },
      { type: 'reset-pre-verify-review' },
    ])
    expect(DEFAULT_EVENT_POLICY.archived.actions).toEqual([{ type: 'archive-run' }])
    for (const ev of ['open-complete', 'explore-complete', 'ship-complete'] as const) {
      expect(DEFAULT_EVENT_POLICY[ev].actions).toEqual([])
    }
  })

  test('guard 映射：explore/spec/build/verify-pass 与 Ship 迁移门禁有前置 guard，其余空', () => {
    expect(DEFAULT_EVENT_POLICY['explore-complete'].guards.length).toBe(1)
    expect(DEFAULT_EVENT_POLICY['spec-complete'].guards.length).toBe(1)
    expect(DEFAULT_EVENT_POLICY['build-complete'].guards.length).toBe(5)
    expect(DEFAULT_EVENT_POLICY['verify-pass'].guards.length).toBe(3)
    expect(DEFAULT_EVENT_POLICY['ship-complete'].guards).toEqual([{ type: 'spec-migration-applied' }])
    for (const ev of ['open-complete', 'requirements-changed', 'verify-fail', 'archived'] as const) {
      expect(DEFAULT_EVENT_POLICY[ev].guards).toEqual([])
    }
  })

  test('barrier 是 build-head-unchanged typed guard（不是 action）', () => {
    const g = DEFAULT_EVENT_POLICY['verify-pass'].guards.find((x) => x.type === 'build-head-unchanged')
    expect(g).toEqual({ type: 'build-head-unchanged', field: 'build_sha' })
  })

  test('tasks-through-phase 只约束完成/归档出口，不阻断 requirements-changed 与 verify-fail 回退', () => {
    expect(DEFAULT_EVENT_POLICY['requirements-changed'].enforceTaskExit).toBe(false)
    expect(DEFAULT_EVENT_POLICY['verify-fail'].enforceTaskExit).toBe(false)
    for (const event of [
      'open-complete', 'explore-complete', 'spec-complete', 'build-complete',
      'verify-pass', 'ship-complete', 'archived',
    ] as const) {
      expect(DEFAULT_EVENT_POLICY[event].enforceTaskExit).toBe(true)
    }
  })
})

describe('checkDefaultEventPreconditions —— explore-complete（老仓 L120-126，逐字文案）', () => {
  test('design_doc 字面 null → 拒（文案带当前值）', async () => {
    const r = await checkDefaultEventPreconditions('explore-complete', mkState({ design_doc: 'null' }))
    expect(r).toEqual(['ERROR: explore-complete 要求 design_doc 字段非空且文件存在 (当前=null)'])
  })

  test('design_doc 空串 → 拒', async () => {
    const r = await checkDefaultEventPreconditions('explore-complete', mkState({ design_doc: '' }))
    expect(r).toEqual(['ERROR: explore-complete 要求 design_doc 字段非空且文件存在 (当前=)'])
  })

  test('design_doc 文件不存在（注入 false）→ 拒', async () => {
    const r = await checkDefaultEventPreconditions('explore-complete', mkState({ design_doc: 'docs/d.md' }), filesExist(false))
    expect(r).toEqual(['ERROR: explore-complete 要求 design_doc 字段非空且文件存在 (当前=docs/d.md)'])
  })

  test('design_doc 存在（注入 true）→ 通过', async () => {
    const r = await checkDefaultEventPreconditions('explore-complete', mkState({ design_doc: 'docs/d.md' }), filesExist(true))
    expect(r).toBeNull()
  })

  test('无 ctx（文件面降级跳过）：字段非空即通过', async () => {
    const r = await checkDefaultEventPreconditions('explore-complete', mkState({ design_doc: 'docs/d.md' }))
    expect(r).toBeNull()
  })
})

describe('checkDefaultEventPreconditions —— spec-complete（原流程：仅非 PM track 强制 legacy plan artifact）', () => {
  test('backend 无 plan → 拒（文案带 track 名）', async () => {
    const r = await checkDefaultEventPreconditions('spec-complete', mkState({ track: 'backend', plan: 'null' }))
    expect(r).toEqual(['ERROR: backend track spec-complete 要求 plan 字段非空且文件存在 (当前=null)'])
  })

  test('frontend plan 文件不存在 → 拒', async () => {
    const r = await checkDefaultEventPreconditions('spec-complete', mkState({ track: 'frontend', plan: 'docs/p.md' }), filesExist(false))
    expect(r).toEqual(['ERROR: frontend track spec-complete 要求 plan 字段非空且文件存在 (当前=docs/p.md)'])
  })

  test('pm track 无 legacy plan artifact 仍可通过；其 OpenSpec/Superpower plan 文档由 ledger 单独治理', async () => {
    const r = await checkDefaultEventPreconditions('spec-complete', mkState({ track: 'pm', plan: 'null' }))
    expect(r).toBeNull()
  })

  test('backend plan 存在 → 通过', async () => {
    const r = await checkDefaultEventPreconditions('spec-complete', mkState({ track: 'backend', plan: 'docs/p.md' }), filesExist(true))
    expect(r).toBeNull()
  })

  test.each(['chat', 'ml'])('%s track（未知轨）同样要求 plan，文案逐字（NON_PM 谓词：pm 外都不豁免）', async (tr) => {
    const r = await checkDefaultEventPreconditions('spec-complete', mkState({ track: tr, plan: '' }))
    expect(r).toEqual([`ERROR: ${tr} track spec-complete 要求 plan 字段非空且文件存在 (当前=)`])
  })
})

describe('checkDefaultEventPreconditions —— build-complete（老仓 L139-153，首错优先序）', () => {
  test('缺 build_mode 首拒', async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({}))
    expect(r).toEqual(['ERROR: build_mode 必须设置'])
  })

  test('缺 isolation 次拒', async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({ build_mode: 'direct', isolation: 'null' }))
    expect(r).toEqual(['ERROR: isolation 必须设置'])
  })

  test('isolation 非法枚举防线（绕过 set 闸的脏值）', async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({ build_mode: 'direct', isolation: 'bogus' }))
    expect(r).toEqual(["ERROR: 非法值 'bogus'，允许: branch worktree in-place"])
  })

  test('full+direct 缺 direct_override → 拒', async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({ preset: 'full', build_mode: 'direct', isolation: 'worktree' }))
    expect(r).toEqual(['ERROR: full workflow 使用 build_mode=direct 必须显式设 direct_override=true'])
  })

  test('全量收敛 review 非 pass → 最后一道 Build guard 拒绝冻结', async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({
      preset: 'full',
      build_mode: 'direct',
      isolation: 'worktree',
      direct_override: 'true',
      pre_verify_review_result: 'pending',
    }))
    expect(r).toEqual(['ERROR: build-complete 要求 pre_verify_review_result=pass (当前=pending)'])
  })

  test('full+direct+direct_override=true → 通过', async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({ preset: 'full', build_mode: 'direct', isolation: 'worktree', direct_override: 'true', pre_verify_review_result: 'pass' }))
    expect(r).toBeNull()
  })

  test('hotfix preset + direct 不锁 direct_override → 通过', async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({ preset: 'hotfix', build_mode: 'direct', isolation: 'branch', pre_verify_review_result: 'pass' }))
    expect(r).toBeNull()
  })

  test('full+direct+in-place+direct_override=true → 通过（受限 Codex 沙盒不伪造 Git 隔离）', async () => {
    const r = await checkDefaultEventPreconditions(
      'build-complete',
      mkState({ preset: 'full', build_mode: 'direct', isolation: 'in-place', direct_override: 'true', pre_verify_review_result: 'pass' }),
    )
    expect(r).toBeNull()
  })
})

describe('checkDefaultEventPreconditions —— verify-pass（老仓 L163-199，首错优先序 + barrier）', () => {
  const base = {
    track: 'backend',
    verification_report: 'docs/v.md',
    branch_status: 'handled',
  }

  test('report → branch_status 首错优先序（两个手填评审字段已删除）', async () => {
    const noVr = await checkDefaultEventPreconditions('verify-pass', mkState({ ...base, verification_report: 'null' }), filesExist(true))
    expect(noVr).toEqual(['ERROR: verify-pass 要求 verification_report 字段非空且文件存在 (当前=null)'])
    const noBs = await checkDefaultEventPreconditions('verify-pass', mkState({ ...base, branch_status: 'pending' }), filesExist(true))
    expect(noBs).toEqual(['ERROR: verify-pass 要求 branch_status=handled (当前=pending)'])
  })

  test.each(['chat', 'ml'])('%s track（未知轨）不再有评审字段前置', async (tr) => {
    const token = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change',
    })
    const r = await checkDefaultEventPreconditions(
      'verify-pass',
      mkState({ ...base, track: tr, isolation: 'branch', build_sha: token.value }),
      { fileExists: () => true, assessBuildRevision: async () => ({ trusted: true, token }) },
    )
    expect(r).toBeNull()
  })

  test('pm track 同样只要求报告与分支状态', async () => {
    const token = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change',
    })
    const r = await checkDefaultEventPreconditions(
      'verify-pass',
      mkState({ track: 'pm', verification_report: 'docs/v.md', branch_status: 'handled', isolation: 'branch', build_sha: token.value }),
      { fileExists: () => true, assessBuildRevision: async () => ({ trusted: true, token }) },
    )
    expect(r).toBeNull()
  })

  test('free track 走中性验证分支', async () => {
    const token = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change',
    })
    const r = await checkDefaultEventPreconditions(
      'verify-pass',
      mkState({ track: 'free', verification_report: 'docs/v.md', branch_status: 'handled', isolation: 'branch', build_sha: token.value }),
      { fileExists: () => true, assessBuildRevision: async () => ({ trusted: true, token }) },
    )
    expect(r).toBeNull()
  })

  test('barrier：typed assessor revision stale → stable two-line blocker（无 raw HEAD 文案）', async () => {
    const r = await checkDefaultEventPreconditions('verify-pass', mkState({ ...base, track: 'pm', isolation: 'branch', build_sha: 'CAFEBABE' }), {
      fileExists: () => true,
      assessBuildRevision: async (request) => ({ trusted: false, blocker: makeBuildRevisionBlocker('revision-stale', request.stateHash) }),
    })
    expect(r).toEqual([
      'ERROR: verify-pass revision trust blocked (code=verify-build-revision-untrusted reason=revision-stale)',
      '  修复：return-to-build-and-capture-current-revision',
    ])
  })

  test('barrier：build_sha=null → typed null blocker，绝不跳过', async () => {
    const r = await checkDefaultEventPreconditions('verify-pass', mkState({ ...base, track: 'pm', isolation: 'branch', build_sha: 'null' }), {
      fileExists: () => true,
      assessBuildRevision: async (request) => ({ trusted: false, blocker: makeBuildRevisionBlocker('null', request.stateHash) }),
    })
    expect(r).toEqual([
      'ERROR: verify-pass revision trust blocked (code=verify-build-revision-untrusted reason=null)',
      '  修复：return-to-build-and-capture-current-revision',
    ])
  })

  test('barrier：raw array build_sha 保持 ambiguous（不被 default 归一成 malformed）', async () => {
    const token = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change',
    }).value
    const buildSha = [token]
    let seenBuildSha: unknown
    const result = await checkDefaultEventPreconditions('verify-pass', mkState({
      ...base, track: 'pm', isolation: 'branch', build_sha: buildSha,
    }), {
      fileExists: () => true,
      assessBuildRevision: async (request) => {
        seenBuildSha = request.buildSha
        return assessBuildRevisionTrust({
          ...request,
          observe: async () => ({
            kind: 'git' as const,
            revision: 'a'.repeat(40),
            identity: { repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change' },
          }),
          // The ambiguous candidate is rejected before provenance is consulted.
          provenance: async () => undefined,
        })
      },
    })
    expect(result).toEqual([
      'ERROR: verify-pass revision trust blocked (code=verify-build-revision-untrusted reason=ambiguous)',
      '  修复：return-to-build-and-capture-current-revision',
    ])
    expect(seenBuildSha).toEqual(buildSha)
  })

  test('readiness：raw array build_sha 保持 ambiguous 且不修改 canonical state', async () => {
    const token = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change',
    }).value
    const state = mkState({
      ...base, phase: 'verify', track: 'pm', isolation: 'branch', build_sha: [token],
    })
    const before = structuredClone(state)
    const plan = compileEffectiveWorkflowPlan('default')
    const readiness = await readinessByTransition(plan, state, {
      changeDirAbs: '/tmp/issue-42-default-readiness',
      fileExists: () => true,
      assessBuildRevision: async (request) => assessBuildRevisionTrust({
        ...request,
        observe: async () => ({
          kind: 'git' as const,
          revision: 'a'.repeat(40),
          identity: { repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change' },
        }),
        provenance: async () => undefined,
      }),
    })
    const verifyPass = readiness.verify?.['verify-pass']
    expect(verifyPass).toEqual({
      ready: false,
      blockers: [{
        kind: 'verify-build-revision-untrusted',
        code: 'verify-build-revision-untrusted',
        reason: 'ambiguous',
        remediation: 'return-to-build-and-capture-current-revision',
        stateHash: safeRevisionHash(state.fields),
      }],
    })
    expect(state).toEqual(before)
  })

  test('barrier：只注入旧 gitHeadSha 能力仍 fail-closed（不再静默跳过）', async () => {
    const r = await checkDefaultEventPreconditions('verify-pass', mkState({ ...base, track: 'pm', isolation: 'branch', build_sha: 'CAFEBABE' }), {
      fileExists: () => true, gitHeadSha: async () => '',
    })
    expect(r).toEqual([
      'ERROR: verify-pass revision trust blocked (code=verify-build-revision-untrusted reason=capability-unavailable)',
      '  修复：return-to-build-and-capture-current-revision',
    ])
  })

  test('barrier：无可信 assessor 能力 → stable capability-unavailable blocker', async () => {
    const r = await checkDefaultEventPreconditions('verify-pass', mkState({ ...base, track: 'pm', isolation: 'branch', build_sha: 'CAFEBABE' }), filesExist(true))
    expect(r).toEqual([
      'ERROR: verify-pass revision trust blocked (code=verify-build-revision-untrusted reason=capability-unavailable)',
      '  修复：return-to-build-and-capture-current-revision',
    ])
  })

  test('barrier 通过：build_sha==HEAD', async () => {
    const token = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change',
    })
    const r = await checkDefaultEventPreconditions('verify-pass', mkState({ ...base, track: 'pm', isolation: 'branch', build_sha: token.value }), {
      fileExists: () => true, assessBuildRevision: async () => ({ trusted: true, token }),
    })
    expect(r).toBeNull()
  })

  test('barrier IO 序：verify-pass 前置全过时 assessor 恰调一次（barrier 在末位）', async () => {
    let calls = 0
    const token = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change',
    })
    await checkDefaultEventPreconditions('verify-pass', mkState({ ...base, track: 'pm', isolation: 'branch', build_sha: token.value }), {
      fileExists: () => true,
      assessBuildRevision: async () => { calls++; return { trusted: true, token } },
    })
    expect(calls).toBe(1)
  })

  test('barrier IO 序：前置早错（branch_status 未过）→ 不到 barrier，gitHeadSha 零调用', async () => {
    let calls = 0
    const ctx: TransitionContext = { fileExists: () => true, gitHeadSha: async () => { calls++; return 'CAFEBABE' } }
    const r = await checkDefaultEventPreconditions('verify-pass', mkState({ ...base, track: 'pm', branch_status: 'pending', build_sha: 'CAFEBABE' }), ctx)
    expect(r).toEqual(['ERROR: verify-pass 要求 branch_status=handled (当前=pending)'])
    expect(calls).toBe(0)
  })
})

describe('checkDefaultEventPreconditions —— 无前置 guard 的事件通行（open/verify-fail/archived）', () => {
  test.each(['open-complete', 'verify-fail', 'archived'] as const)('%s → null', async (ev) => {
    expect(await checkDefaultEventPreconditions(ev, mkState({}))).toBeNull()
  })
})

describe('checkDefaultEventPreconditions —— ship-complete 主规格迁移硬门禁', () => {
  test('缺能力失败关闭；not-required/applied 通过；invalid 输出稳定原因', async () => {
    expect(await checkDefaultEventPreconditions('ship-complete', mkState({}))).toEqual([
      'ERROR: ship-complete 要求主规格迁移机器证据有效（当前=capability-unavailable）',
    ])
    expect(await checkDefaultEventPreconditions('ship-complete', mkState({}), {
      specMigrationStatus: async () => ({ kind: 'not-required' }),
    })).toBeNull()
    expect(await checkDefaultEventPreconditions('ship-complete', mkState({}), {
      specMigrationStatus: async () => ({ kind: 'applied' }),
    })).toBeNull()
    expect(await checkDefaultEventPreconditions('ship-complete', mkState({}), {
      specMigrationStatus: async () => ({ kind: 'invalid', reason: 'receipt-mismatch' }),
    })).toEqual([
      'ERROR: ship-complete 要求主规格迁移机器证据有效（当前=receipt-mismatch）',
    ])
  })
})

describe('checkDefaultEventPreconditions —— 数组边界输入（阻断 1：default 轨 fstr 归一，逐字等价老 switch）', () => {
  // 老 checkTransitionPreconditions switch 每个字段读值都过 fstr（Array→join(',')、缺省→''）：
  // build_mode=['direct'] → 'direct' → 放行。P3 typed guard 的 scalarValue 对数组直接 fail-loud
  // throw；本 describe 钉住 default 轨经 fstr 归一后与老 fstr 逐字等价（数组 join 后求值、不 throw），
  // 并对照证明 custom 轨（evaluateGuards 直吃原始 fields）同字段仍 throw——只 default 轨放宽。

  test("build_mode=['direct'] → 归一 'direct' → field-nonempty 放行（不 throw；续查 isolation/override 全过）", async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({
      build_mode: ['direct'],
      isolation: 'branch',
      pre_verify_review_result: 'pass',
    }))
    expect(r).toBeNull()
  })

  test("build_mode=[]（空数组）→ 归一 '' → field-nonempty 拒（逐字等价老 fstr 空串）", async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({ build_mode: [] }))
    expect(r).toEqual(['ERROR: build_mode 必须设置'])
  })

  test("isolation=['branch'] → 归一 'branch' → field-in 放行", async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({
      build_mode: 'direct',
      isolation: ['branch'],
      pre_verify_review_result: 'pass',
    }))
    expect(r).toBeNull()
  })

  test("isolation=['branch','worktree'] → 归一 'branch,worktree' → field-in 拒（join 后非法枚举，逐字等价老 fstr）", async () => {
    const r = await checkDefaultEventPreconditions('build-complete', mkState({ build_mode: 'direct', isolation: ['branch', 'worktree'] }))
    expect(r).toEqual(["ERROR: 非法值 'branch,worktree'，允许: branch worktree in-place"])
  })

  test("design_doc=['a','b'] → 归一 'a,b' 当路径判存在（filesExist=false）→ 拒（当前=a,b）", async () => {
    const r = await checkDefaultEventPreconditions('explore-complete', mkState({ design_doc: ['a', 'b'] }), filesExist(false))
    expect(r).toEqual(['ERROR: explore-complete 要求 design_doc 字段非空且文件存在 (当前=a,b)'])
  })

  test("design_doc=['docs/d.md'] → 归一 'docs/d.md' 判存在（filesExist=true）→ 通过", async () => {
    const r = await checkDefaultEventPreconditions('explore-complete', mkState({ design_doc: ['docs/d.md'] }), filesExist(true))
    expect(r).toBeNull()
  })

  test("verify-pass agent_review_result=['pass'] → 归一 'pass' → field-equals 放行（backend 轨全过）", async () => {
    const token = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change',
    })
    const r = await checkDefaultEventPreconditions(
      'verify-pass',
      mkState({
        track: 'backend', verification_report: 'docs/v.md', branch_status: 'handled',
        agent_review_result: ['pass'], codex_review_result: 'pass', isolation: 'branch', build_sha: token.value,
      }),
      { fileExists: () => true, assessBuildRevision: async () => ({ trusted: true, token }) },
    )
    expect(r).toBeNull()
  })

  test('revision assessor hashes canonical raw fields, not the normalized default guard view', async () => {
    const token = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change',
    }).value
    const state = mkState({
      track: 'backend', verification_report: 'docs/v.md', branch_status: 'handled',
      codex_review_result: 'pass',
      isolation: 'branch',
      build_sha: token,
      agent_review_result: ['pass'],
    })
    const expectedStateHash = safeRevisionHash(state.fields)
    let seenStateHash: string | undefined
    const result = await checkDefaultEventPreconditions('verify-pass', state, {
      fileExists: () => true,
      assessBuildRevision: async (request) => {
        seenStateHash = request.stateHash
        return { trusted: true, token }
      },
    })
    expect(result).toBeNull()
    expect(seenStateHash).toBe(expectedStateHash)
  })

  test('对照 custom 轨：evaluateGuards 直吃数组 build_mode → scalarValue fail-loud throw（default 同输入不 throw）', async () => {
    await expect(
      evaluateGuards(
        [{ type: 'field-nonempty', field: 'build_mode' }],
        { fields: { build_mode: ['direct'] } as Record<FieldName, string | string[]>, track: 'backend' },
      ),
    ).rejects.toThrow(/数组值|绕过编译器/)
    // 同输入走 default 轨：归一后放行（不 throw）——证明放宽只发生在 default 轨。
    expect(
      await checkDefaultEventPreconditions('build-complete', mkState({
        build_mode: ['direct'],
        isolation: 'branch',
        pre_verify_review_result: 'pass',
      })),
    ).toBeNull()
  })

  test('对照 custom 轨：evaluateGuards 直吃数组 isolation → field-in 前 scalarValue 即 throw（default 同输入 join 后判定）', async () => {
    await expect(
      evaluateGuards(
        [{ type: 'field-in', field: 'isolation', values: ['branch', 'worktree'] }],
        { fields: { isolation: ['branch', 'worktree'] } as Record<FieldName, string | string[]>, track: 'backend' },
      ),
    ).rejects.toThrow(/数组值/)
    expect(
      await checkDefaultEventPreconditions('build-complete', mkState({ build_mode: 'direct', isolation: ['branch', 'worktree'] })),
    ).toEqual(["ERROR: 非法值 'branch,worktree'，允许: branch worktree in-place"])
  })
})

/**
 * D12：default 轨的前置 guard 只活在 DEFAULT_EVENT_POLICY 里，不在 workflow IR 的 step.guards 上，
 * 所以 `status --json` 的字段投影此前看不见它们；运行器只能从 `ERROR: build_mode 必须设置` 这类
 * 散文里反推字段名与枚举。投影层与强制层必须读同一张表。
 */
describe('defaultEventGuardFields —— 投影层与强制层同源', () => {
  test('build-complete 给出 build_mode / isolation（含被接受的值）', () => {
    expect(defaultEventGuardFields('build-complete', mkState({ track: 'backend' }))).toEqual([
      { field: 'build_mode' },
      { field: 'isolation' },
      { field: 'isolation', required: ['branch', 'worktree', 'in-place'] },
      { field: 'pre_verify_review_result', required: ['pass'] },
    ].filter((item, index, all) => all.findIndex((seen) => seen.field === item.field) === index))
  })

  test('full + direct 这一种组合才要求 direct_override', () => {
    const withOverride = defaultEventGuardFields(
      'build-complete',
      mkState({ track: 'backend', preset: 'full', build_mode: 'direct' }),
    )
    expect(withOverride).toContainEqual({ field: 'direct_override', required: ['true'] })
    const without = defaultEventGuardFields(
      'build-complete',
      mkState({ track: 'backend', preset: 'full', build_mode: 'parallel-team' }),
    )
    expect(without.some((item) => item.field === 'direct_override')).toBe(false)
  })

  test('verify-pass 给出 verification_report 与 branch_status=handled，不给 build_sha', () => {
    const fields = defaultEventGuardFields('verify-pass', mkState({ track: 'backend' }))
    expect(fields).toEqual([
      { field: 'verification_report' },
      { field: 'branch_status', required: ['handled'] },
    ])
  })

  test('track 谓词生效：pm 轨的 spec-complete 不要求 plan 字段', () => {
    expect(defaultEventGuardFields('spec-complete', mkState({ track: 'backend' })))
      .toEqual([{ field: 'plan' }])
    expect(defaultEventGuardFields('spec-complete', mkState({ track: 'pm' }))).toEqual([])
  })

  test('无字段类 guard 的事件给空表', () => {
    expect(defaultEventGuardFields('open-complete', mkState({ track: 'backend' }))).toEqual([])
    expect(defaultEventGuardFields('ship-complete', mkState({ track: 'backend' }))).toEqual([])
  })
})

describe('renderPreconditionViolation —— 政策表/渲染器漂移 fail-loud', () => {
  test('未覆盖的 (event, guardType) 组合 → 抛错（不静默产出错文案）', () => {
    const rogue: GuardEvaluation = {
      guard: { type: 'field-nonempty', field: 'design_doc' },
      decision: { kind: 'failed', guardType: 'field-nonempty', field: 'design_doc', actual: '' },
    }
    // open-complete 无 guard，任何 failed 落到它 = 漂移
    expect(() => renderPreconditionViolation('open-complete', rogue, 'backend')).toThrow(/未覆盖/)
  })
})
