import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compileEffectiveWorkflowPlan, createLoopLedgerStore, loadRegistry,
  nodeLoopIoStrict, registryContentEpoch,
  workflowPlanSnapshot,
  type EffectiveSkillResolver, type LoopEntry, type LoopLedgerStore, type LoopRegistry, type StepIR,
  type VerificationResult, type WorkflowDef,
} from '@tenon/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFsSkillContentLocator, SkillContentInvalidError } from '../skills/content-locator.js'
import { materializeSkillSnapshot, SkillSnapshotIoError } from '../skills/snapshot-store.js'
import type {
  CapturedExecutionCoordinate, ExecutionContext, ExecutionCoordinatePort,
  LoopPreparedExecutionContext, PreparedExecutionContext,
} from './execution-context.js'
import { markLoopPrepared } from './execution-context.js'
import {
  createExecutionPreparation, createLoopAdmission, SkillProfileValidatorUnconfiguredError,
  type ExecutionPreparationDeps, type LoopAdmissionDeps,
} from './loop-admission.js'

/**
 * H10 r1 复审阻断3/D5 返工（任务B1）：`PreparedExecutionContext` 是判别联合，`skillBundle` 只在
 * `preparedKind==='loop-bundle'` 分支上存在。本文件大量用例需要断言 skillBundle 内容——用一个共享
 * 断言函数收窄，不在每个用例里重复 if/throw。
 */
function assertLoopBundle(ctx: PreparedExecutionContext): asserts ctx is LoopPreparedExecutionContext {
  if (ctx.preparedKind !== 'loop-bundle') {
    throw new Error(`预期 preparedKind='loop-bundle'，实际是 '${ctx.preparedKind}'`)
  }
}

/** 最小合法 H7 VerificationResult（settleWon 透传断言用）。 */
const trustedPass = (sha: string): VerificationResult => ({
  schema_version: 1,
  verification_id: 'ver-1',
  subject: {
    workflow_run_id: 'wfr-1', attempt_id: 'att-1', change: 'lp-x',
    revision: { kind: 'named-branch-head', sha },
  },
  binding: { kind: 'default-transition', event: 'verify-pass' },
  verdict: 'passed',
  evidence: [{ kind: 'command-result', command_id: 'test', exit_code: 0 }],
  issuer: { kind: 'host-verifier', verifier: 'test-verifier', version: '1', trusted: true },
  evaluated_at: '2026-07-17T08:05:00.000Z',
})

/**
 * 最小 loop 工厂。H10 §1/§5：默认带 `skill_bundle_id: '_all'`（合法、恒 known、无需
 * isSkillProfileKnown）——保持本文件里全部既有（与 skill bundle 无关的）用例继续通过 reserve() 新增
 * 的 wiring 硬闸；只有本文件新增的 skill-bundle-* 专项用例才显式覆盖成 `null`/具名 profile。
 */
const loop = (over: Partial<LoopEntry> = {}): LoopEntry => ({
  id: 'lp', name: 'lp loop', kind: 'orchestrator', goal: 'do the thing well', cadence: '1h', risk: 'low',
  runner: 'claude-code', change_prefix: 'lp-', phases: ['a', 'b'], human_gates: ['g'], state: 's', design_doc: 'd',
  status: 'active', budget: { max_runs_per_day: 24, max_in_flight: 2, on_exceed: 'skip' }, kill_criteria: ['k'],
  autonomy_level: 'L1', allowlist: [], denylist: [], skill_bundle_id: '_all', ...over,
})

const registry = (loops: LoopEntry[]): { data: LoopRegistry | null; errors: string[] } => ({ data: { version: 1, loops }, errors: [] })

const buildStep = {
  id: 'build', label: 'Build', gate: null,
  skills: [], inputs: [], outputs: [], guards: [], transitions: [],
}
/**
 * AFK 项目层只读冻结计划里任务所在分支的 `automation`：backend / frontend 声明可进 AFK，lite 没写 automation
 * （失败关闭）；`flat` 是没有 `tracks:` 的平铺工作流，只有一条隐式分支，同样不可进入 AFK。
 */
const afkWorkflow = (mode: 'interactive' | 'afk', name = `automation-${mode}`): WorkflowDef => ({
  name,
  interaction: { version: 'v1', mode },
  steps: [],
  tracks: {
    backend: { steps: [buildStep], automation: { eligible: true, enqueueAfterSpec: false } },
    frontend: { steps: [buildStep], automation: { eligible: true, enqueueAfterSpec: false } },
    lite: { steps: [buildStep] },
  },
})
const policySnapshot = (mode: 'interactive' | 'afk') => workflowPlanSnapshot(
  compileEffectiveWorkflowPlan(`automation-${mode}`, afkWorkflow(mode), { track: 'backend' }),
)
const AFK_PLAN = policySnapshot('afk')
const FLAT_AFK_PLAN = workflowPlanSnapshot(compileEffectiveWorkflowPlan('automation-flat', {
  name: 'automation-flat',
  interaction: { version: 'v1', mode: 'afk' },
  steps: [buildStep],
}))
/** 宿主只报告平台 / Skill / Run 三层事实和任务记着的轨道；项目层由准入自己读冻结计划。 */
const AUTHORIZED_AFK_LAYERS = {
  platform: { status: 'valid', grants: ['enter-afk'] },
  skill: { status: 'valid', grants: ['enter-afk'] },
  run: { status: 'valid', grants: ['enter-afk'] },
  trackId: 'backend',
} as const
const runBoundTo = (snapshot: ReturnType<typeof policySnapshot>) =>
  async (_change: string, policy: Parameters<NonNullable<LoopAdmissionDeps['bindAutomationPolicy']>>[1], binding: { readonly loopId: string; readonly iterationId: string }) => ({
    id: `workflow-${binding.iterationId.replace(/^iteration-/, '')}`,
    automationPolicy: policy,
    ...binding,
    workflowId: snapshot.workflowId,
    workflowPlanFingerprint: snapshot.workflowFingerprint,
    workflowPlanSnapshot: snapshot,
  })

const DEFAULT_COORDINATE_CAPABILITY = compileEffectiveWorkflowPlan('default', undefined, { track: 'backend' }).capabilities.skills

let dir: string
let idc = 0
const admission = (over: Partial<LoopAdmissionDeps> & { loops?: LoopEntry[] } = {}) => {
  idc = 0
  return createLoopAdmission({
    repoRoot: dir,
    ledger: createLoopLedgerStore(),
    loadRegistry: over.loadRegistry ?? (() => registry(over.loops ?? [loop()])),
    clock: over.clock ?? (() => new Date('2026-07-17T08:00:00.000Z').toISOString()),
    level: 'L1',
    getAutomation: over.getAutomation ?? (async () => ''),
    newId: over.newId ?? ((p) => `${p}-${idc++}`),
    bindAutomationPolicy: over.bindAutomationPolicy ?? runBoundTo(AFK_PLAN),
    bindWorkflowActionAuthority: over.bindWorkflowActionAuthority ?? (async (_change, snapshot) => ({
      id: snapshot.workflow_run_id,
      workflowId: snapshot.workflow_id,
      workflowPlanFingerprint: snapshot.workflow_fingerprint,
      loopId: snapshot.loop_id,
      iterationId: snapshot.iteration_id,
      workflowActionAuthority: snapshot,
    })),
    workflowActionAuthority: over.workflowActionAuthority ?? (async () => AUTHORIZED_AFK_LAYERS),
    ...over,
  })
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'loop-adm-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('reserve · 原子 preflight 放行', () => {
  it('PR3：allowed attempt 冻结分支 automation 的 authority binding 供 claim 前复核', async () => {
    const result = await admission().reserve('lp-x')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context).toMatchObject({
      workflow_action_authority: {
        version: 1,
        action: 'enter-afk',
        track_id: 'backend',
        // 项目层来源就是这份冻结计划：持久字段沿用旧名，值取计划指纹前 16 位。
        track_registry_revision: AFK_PLAN.workflowFingerprint.slice(0, 16),
        workflow_run_id: result.context.workflow_run_id,
        workflow_id: AFK_PLAN.workflowId,
        workflow_fingerprint: AFK_PLAN.workflowFingerprint,
      },
    })
  })

  it('PR3：stable authority 在最终复核后只调用一次 claim', async () => {
    const order: string[] = []
    const adm = admission({
      bindWorkflowActionAuthority: async (_change, snapshot) => {
        order.push('bind-authority')
        return {
          id: snapshot.workflow_run_id,
          workflowId: snapshot.workflow_id,
          workflowPlanFingerprint: snapshot.workflow_fingerprint,
          loopId: snapshot.loop_id,
          iterationId: snapshot.iteration_id,
          workflowActionAuthority: snapshot,
        }
      },
    })
    const reserved = await adm.reserve('lp-x')
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    let claims = 0

    const result = await adm.claimWithFreshWorkflowAuthority(reserved.context, async (trackId) => {
      claims++
      order.push('claim-state')
      expect(trackId).toBe('backend')
      return true
    })

    expect(result).toMatchObject({ ok: true, claimed: true })
    expect(claims).toBe(1)
    expect(order).toEqual(['bind-authority', 'bind-authority', 'claim-state'])
  })

  it('PR3：最终 durable authority rebind 失败时零 claim、零扣费', async () => {
    let binds = 0
    const adm = admission({
      bindWorkflowActionAuthority: async (_change, snapshot) => {
        if (binds++ > 0) throw new Error('authority bind EIO')
        return {
          id: snapshot.workflow_run_id,
          workflowId: snapshot.workflow_id,
          workflowPlanFingerprint: snapshot.workflow_fingerprint,
          loopId: snapshot.loop_id,
          iterationId: snapshot.iteration_id,
          workflowActionAuthority: snapshot,
        }
      },
    })
    const reserved = await adm.reserve('lp-x')
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    let claims = 0

    await expect(adm.claimWithFreshWorkflowAuthority(reserved.context, async () => {
      claims++
      return true
    })).rejects.toThrow('authority bind EIO')

    expect(claims).toBe(0)
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
    expect(win.runs[0]).toMatchObject({
      result: 'failed', reason: 'infrastructure-error',
      accounting: { charged_tokens: 0, charge_source: 'none' },
    })
  })

  it('PR3：分支没写 automation（lite）→ 项目层拒绝，零 reservation、零扣费', async () => {
    const adm = admission({ workflowActionAuthority: async () => ({ ...AUTHORIZED_AFK_LAYERS, trackId: 'lite' }) })

    const result = await adm.reserve('lp-x')

    expect(result).toMatchObject({
      ok: false,
      reason: 'workflow-action-denied',
      authorization: { allowed: false, status: 'denied' },
    })
    if (!result.ok) {
      expect(result.authorization?.denials).toContainEqual(expect.objectContaining({
        layer: 'project', code: 'project-denied',
      }))
    }
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
    expect(win.runs[0]?.accounting).toMatchObject({ charged_tokens: 0, charge_source: 'none' })
  })

  it('PR3：宿主不能代授项目层——哪怕它在事实里夹带 project 授权，没写 automation 的分支照样被拒', async () => {
    const adm = admission({
      workflowActionAuthority: async () => ({
        ...AUTHORIZED_AFK_LAYERS,
        trackId: 'lite',
        project: { status: 'valid', grants: ['enter-afk'] },
      }),
    })

    const result = await adm.reserve('lp-x')

    expect(result).toMatchObject({ ok: false, reason: 'workflow-action-denied' })
  })

  it('PR3：平铺工作流没有可声明 automation 的分支 → 失败关闭', async () => {
    const adm = admission({
      bindAutomationPolicy: runBoundTo(FLAT_AFK_PLAN),
      workflowActionAuthority: async () => ({ ...AUTHORIZED_AFK_LAYERS, trackId: 'automation-flat' }),
    })

    const result = await adm.reserve('lp-x')

    expect(result).toMatchObject({ ok: false, reason: 'workflow-action-denied' })
    if (!result.ok) {
      expect(result.authorization?.denials).toContainEqual(expect.objectContaining({
        layer: 'project', code: 'project-denied',
      }))
    }
  })

  it('PR3：任务记着冻结计划里不存在的轨道 → 项目层 malformed（硬拒绝，不回落到任何缺省）', async () => {
    const adm = admission({ workflowActionAuthority: async () => ({ ...AUTHORIZED_AFK_LAYERS, trackId: 'ghost' }) })

    const result = await adm.reserve('lp-x')

    expect(result).toMatchObject({
      ok: false,
      reason: 'workflow-action-hard-blocked',
      authorization: { status: 'hard-blocked' },
    })
    if (!result.ok) {
      expect(result.authorization?.denials).toContainEqual(expect.objectContaining({
        layer: 'project', code: 'project-malformed',
      }))
    }
  })

  it('PR3：宿主没报告任务轨道 → 项目层 malformed', async () => {
    const adm = admission({
      workflowActionAuthority: async () => ({
        platform: AUTHORIZED_AFK_LAYERS.platform,
        skill: AUTHORIZED_AFK_LAYERS.skill,
        run: AUTHORIZED_AFK_LAYERS.run,
      }),
    })

    const result = await adm.reserve('lp-x')

    expect(result).toMatchObject({ ok: false, reason: 'workflow-action-hard-blocked' })
  })

  it('PR3：reserve 后任务改记成没写 automation 的轨道 → claim 前复核拒绝，零 claim、零扣费', async () => {
    let resolutions = 0
    const adm = admission({
      workflowActionAuthority: async () => ({
        ...AUTHORIZED_AFK_LAYERS,
        trackId: resolutions++ === 0 ? 'backend' : 'lite',
      }),
    })
    const reserved = await adm.reserve('lp-x')
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    let claims = 0

    const result = await adm.claimWithFreshWorkflowAuthority(reserved.context, async () => {
      claims++
      return true
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'workflow-action-denied',
      authorization: { status: 'denied' },
    })
    expect(claims).toBe(0)
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
    expect(win.runs[0]).toMatchObject({
      result: 'skipped', reason: 'admission-denied',
      accounting: { charged_tokens: 0, charge_source: 'none' },
    })
  })

  it('PR3：project track identity 改绑时以 stale 拒绝且不 claim', async () => {
    let resolutions = 0
    const adm = admission({
      workflowActionAuthority: async () => ({
        ...AUTHORIZED_AFK_LAYERS,
        trackId: resolutions++ === 0 ? 'backend' : 'frontend',
      }),
    })
    const reserved = await adm.reserve('lp-x')
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    let claims = 0

    const result = await adm.claimWithFreshWorkflowAuthority(reserved.context, async () => {
      claims++
      return true
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'workflow-action-stale',
      authorization: { status: 'stale' },
    })
    if (!result.ok) {
      expect(result.authorization?.denials).toContainEqual(expect.objectContaining({
        layer: 'project', code: 'project-identity-mismatch',
      }))
    }
    expect(claims).toBe(0)
  })

  it('PR3：最终 authority provider 失败时 fail-loud、零 claim、零扣费', async () => {
    let resolutions = 0
    const adm = admission({
      workflowActionAuthority: async () => {
        if (resolutions++ > 0) throw new Error('authority EIO')
        return AUTHORIZED_AFK_LAYERS
      },
    })
    const reserved = await adm.reserve('lp-x')
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    let claims = 0

    await expect(adm.claimWithFreshWorkflowAuthority(reserved.context, async () => {
      claims++
      return true
    })).rejects.toThrow('authority EIO')

    expect(claims).toBe(0)
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
    expect(win.runs[0]).toMatchObject({
      result: 'failed', reason: 'infrastructure-error',
      accounting: { charged_tokens: 0, charge_source: 'none' },
      error: { cause: 'workflow-action-authority-failed' },
    })
  })

  it('PR3：缺失冻结 authority binding 时 fail-closed 且不调用 claim', async () => {
    const adm = admission()
    const reserved = await adm.reserve('lp-x')
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    const { workflow_action_authority: _missing, ...unbound } = reserved.context
    let claims = 0

    const result = await adm.claimWithFreshWorkflowAuthority(unbound, async () => {
      claims++
      return true
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'workflow-action-hard-blocked',
      authorization: { status: 'hard-blocked' },
    })
    expect(claims).toBe(0)
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.runs[0]?.accounting).toMatchObject({ charged_tokens: 0, charge_source: 'none' })
  })

  it('空账本 + active loop → ok，context 带 loop_id/tokens/basis，且落一条 reservation', async () => {
    const adm = admission({ loops: [loop({ id: 'lp', change_prefix: 'lp-' })] })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.context.loop_id).toBe('lp')
      expect(r.context.iteration_id).toBe(`iteration-${r.context.attempt_id}`)
      expect(r.context.change).toBe('lp-x')
      expect(r.context.reservation.tokens).toBe(2000) // risk low 预设
      expect(r.context.reservation.token_basis).toBe('risk-default')
      expect(r.context.runner).toBe('claude-code')
      expect(r.context.automation_policy).toMatchObject({
        policy_id: 'lp', goal: 'do the thing well', skill_bundle_id: '_all',
        budget: { on_exceed: 'skip-run' },
      })
    }
    const store = createLoopLedgerStore()
    const win = await store.readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(1)
  })

  it('H2：历史 terminal RunRecord → 本次 reservation/context 固化裁剪摘要与重复失败停滞事实', async () => {
    const store = createLoopLedgerStore()
    for (const [index, attemptId] of ['old-a1', 'old-a2', 'old-a3'].entries()) {
      await store.append(dir, {
        schema_version: 1,
        record_id: `rec-old-${index + 1}`,
        recorded_at: `2026-07-17T07:0${index}:00.000Z`,
        kind: 'run',
        run_record_id: `run-old-${index + 1}`,
        attempt_id: attemptId,
        loop_id: 'lp',
        change: 'lp-x',
        level: 'L1',
        runner: 'codex',
        admitted_at: `2026-07-17T07:0${index}:00.000Z`,
        finished_at: `2026-07-17T07:0${index}:30.000Z`,
        result: 'failed',
        reason: 'infrastructure-error',
        usage_record_ids: [],
        accounting: { reserved_tokens: 2000, charged_tokens: 2000, charge_source: 'reserved-estimate' },
        error: { cause: 'agent-exit', message: `compile failed at /tmp/run-${index}/src/a.ts:${40 + index}` },
      })
    }

    const result = await admission({ ledger: store }).reserve('lp-x')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.attempt_context).toMatchObject({
      source_run_record_ids: ['run-old-1', 'run-old-2', 'run-old-3'],
      omitted_attempt_ids: [],
      stagnation: {
        stagnant: true,
        repeated_attempt_ids: ['old-a1', 'old-a2', 'old-a3'],
      },
    })
    expect(result.context.attempt_context?.rendered).toContain('compile failed at <tmp>/src/a.ts:<line>')
    const read = await store.read(dir)
    const reservation = read.records.find((record) => record.kind === 'budget-reservation' && record.attempt_id === result.context.attempt_id)
    expect(reservation?.kind === 'budget-reservation' ? reservation.attempt_context : undefined).toEqual(result.context.attempt_context)
  })

  it('H4：锁释放后把完整 policy snapshot 绑定到 WorkflowRun，并把稳定 run id 放回 context', async () => {
    const bound: Array<{ change: string; policyVersion: string }> = []
    const adm = admission({
      bindAutomationPolicy: async (change, policy, binding) => {
        bound.push({ change, policyVersion: policy.policy_version })
        return {
          id: 'workflow-run-1', automationPolicy: policy, ...binding,
          workflowId: AFK_PLAN.workflowId,
          workflowPlanFingerprint: AFK_PLAN.workflowFingerprint,
          workflowPlanSnapshot: AFK_PLAN,
        }
      },
    })
    const result = await adm.reserve('lp-x')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.workflow_run_id).toBe('workflow-run-1')
    expect(result.context.iteration_id).toMatch(/^iteration-/)
    expect(bound).toEqual([{ change: 'lp-x', policyVersion: result.context.automation_policy?.policy_version }])
  })

  it('H4：WorkflowRun policy 绑定抛错 → 原错误 fail-loud，且已落 reservation 零扣费关闭、不泄漏 in-flight', async () => {
    const adm = admission({
      bindAutomationPolicy: async () => { throw new Error('bind boom') },
    })

    await expect(adm.reserve('lp-x')).rejects.toThrow('bind boom')

    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
    expect(win.runs).toHaveLength(1)
    expect(win.runs[0]).toMatchObject({
      change: 'lp-x', result: 'failed', reason: 'automation-policy-bind-failed',
      accounting: { charged_tokens: 0, charge_source: 'none' },
    })
  })

  it('H4：WorkflowRun 回读的 policy_version 不匹配 → fail-loud 且同样补偿关闭 reservation', async () => {
    const adm = admission({
      bindAutomationPolicy: async (_change, policy, binding) => ({
        id: 'workflow-run-forged',
        automationPolicy: { ...policy, policy_version: '0'.repeat(64) },
        ...binding,
      }),
    })

    await expect(adm.reserve('lp-x')).rejects.toThrow('did not persist')

    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
    expect(win.runs).toHaveLength(1)
    expect(win.runs[0]).toMatchObject({
      result: 'failed', reason: 'automation-policy-bind-failed',
      accounting: { charged_tokens: 0, charge_source: 'none' },
    })
  })

  it('PR3：exact Run grant 缺失时在 claim 前结构化拒绝，并零扣费关闭 reservation', async () => {
    const adm = admission({
      workflowActionAuthority: async () => ({
        ...AUTHORIZED_AFK_LAYERS,
        run: { status: 'missing', grants: [] },
      }),
    })

    const result = await adm.reserve('lp-x')

    expect(result).toMatchObject({
      ok: false,
      action: 'skip-run',
      reason: 'workflow-action-hard-blocked',
      authorization: { allowed: false, status: 'hard-blocked' },
    })
    if (result.ok) return
    expect(result.authorization?.denials).toContainEqual(expect.objectContaining({
      layer: 'run', code: 'run-missing', remediation: 'repair-authority-binding',
    }))
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
    expect(win.runs).toContainEqual(expect.objectContaining({
      result: 'skipped', reason: 'admission-denied',
      accounting: expect.objectContaining({ charged_tokens: 0, charge_source: 'none' }),
    }))
  })

  it('PR3：frozen interactive Workflow 不因四层动态 grant 齐全而获得 AFK 权限', async () => {
    const interactive = policySnapshot('interactive')
    const adm = admission({
      bindAutomationPolicy: async (_change, policy, binding) => ({
        id: 'workflow-interactive', automationPolicy: policy, ...binding,
        workflowId: interactive.workflowId,
        workflowPlanFingerprint: interactive.workflowFingerprint,
        workflowPlanSnapshot: interactive,
      }),
    })

    const result = await adm.reserve('lp-x')

    expect(result).toMatchObject({
      ok: false,
      reason: 'workflow-action-denied',
      authorization: { allowed: false, status: 'denied' },
    })
    if (!result.ok) {
      expect(result.authorization?.denials).toContainEqual(expect.objectContaining({
        layer: 'workflow', code: 'workflow-denied',
      }))
    }
  })

  it('PR3：缺 canonical WorkflowRun bridge 时失败关闭，不允许 SDK compatibility 路径绕过', async () => {
    const adm = admission({ bindAutomationPolicy: undefined, workflowActionAuthority: undefined })

    const result = await adm.reserve('lp-x')

    expect(result).toMatchObject({
      ok: false,
      reason: 'workflow-action-hard-blocked',
      authorization: { allowed: false, status: 'hard-blocked' },
    })
    if (!result.ok) {
      expect(result.authorization?.denials).toEqual(expect.arrayContaining([
        expect.objectContaining({ layer: 'workflow', code: 'workflow-missing' }),
        expect.objectContaining({ layer: 'run', code: 'run-missing' }),
      ]))
    }
    expect((await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })).openReservations).toHaveLength(0)
  })
})

describe('C 验收 · 两个并发 round 对同一预算只能一个 reserve 成功', () => {
  it('max_in_flight=1：并发两 change 只一个 ok，另一个 max-in-flight 拒（仓级锁串行，不会都读旧值）', async () => {
    const adm = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })] })
    const [a, b] = await Promise.all([adm.reserve('lp-a'), adm.reserve('lp-b')])
    const oks = [a, b].filter((x) => x.ok)
    expect(oks).toHaveLength(1)
    const denied = [a, b].find((x) => !x.ok)!
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('max-in-flight')
  })

  it('max_runs_per_day=1：并发两 change 只一个 ok（另一个 max-runs-per-day 拒 + on_exceed action）', async () => {
    const adm = admission({ loops: [loop({ budget: { max_runs_per_day: 1, max_in_flight: 9, on_exceed: 'halt' } })] })
    const [a, b] = await Promise.all([adm.reserve('lp-a'), adm.reserve('lp-b')])
    expect([a, b].filter((x) => x.ok)).toHaveLength(1)
    const denied = [a, b].find((x) => !x.ok)!
    if (!denied.ok) {
      expect(denied.reason).toBe('max-runs-per-day')
      expect(denied.action).toBe('halt-round') // legacy halt 归一
    }
  })
})

describe('C 验收 · kill-switch：status !== active 硬拒（零 claim 零 docker）', () => {
  it('paused → 拒（loop-inactive），零 reservation 落盘', async () => {
    const adm = admission({ loops: [loop({ status: 'paused' })] })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('loop-inactive')
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
  })
  it('retired → 拒', async () => {
    const adm = admission({ loops: [loop({ status: 'retired' })] })
    expect((await adm.reserve('lp-x')).ok).toBe(false)
  })
})

describe('C 验收 · max 超限时零 reservation', () => {
  it('max_tokens_per_day 超限 → 拒（on_exceed action）', async () => {
    const adm = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 9, on_exceed: 'pause', max_tokens_per_day: 1500 } })] })
    // low risk 预占 2000 > 1500 → 首次即超
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.reason).toBe('max-tokens-per-day'); expect(r.action).toBe('pause-loop') }
  })
  it('同 change 重复活跃预占 → duplicate-change 拒', async () => {
    const adm = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 9, on_exceed: 'skip' } })] })
    expect((await adm.reserve('lp-x')).ok).toBe(true)
    const r2 = await adm.reserve('lp-x')
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toBe('duplicate-change')
  })
})

describe('C 验收 · 坏行 fail-closed', () => {
  it('账本有坏行 → reserve 拒（ledger-degraded），不放行', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, '.pipeline', 'loops'), { recursive: true })
    await writeFile(join(dir, '.pipeline', 'loops', 'ledger.jsonl'), '{not valid json\n', 'utf8')
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('ledger-degraded')
  })
})

describe('H10 §1/§5：reserve() 的 skill bundle wiring 硬闸（admission 拒绝，无 reservation）', () => {
  it('skill_bundle_id: null → skill-bundle-unwired，action=pause-loop，零 reservation 落盘', async () => {
    const adm = admission({ loops: [loop({ skill_bundle_id: null })] })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.reason).toBe('skill-bundle-unwired'); expect(r.action).toBe('pause-loop'); expect(r.loopId).toBe('lp') }
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
  })

  it('skill_bundle_id 字段缺省（旧登记表，undefined）→ 同 null，视为 unwired', async () => {
    const withoutField = loop()
    delete (withoutField as { skill_bundle_id?: string | null }).skill_bundle_id
    const adm = admission({ loops: [withoutField] })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('skill-bundle-unwired')
  })

  it('具名 profile + 未装配 isSkillProfileKnown → throw SkillProfileValidatorUnconfiguredError（不是 profile-not-found，不建 reservation）', async () => {
    const adm = admission({ loops: [loop({ skill_bundle_id: 'frontend' })] })
    await expect(adm.reserve('lp-x')).rejects.toBeInstanceOf(SkillProfileValidatorUnconfiguredError)
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
  })

  it('具名 profile + isSkillProfileKnown 返回 false → skill-bundle-profile-not-found，action=pause-loop', async () => {
    const adm = admission({ loops: [loop({ skill_bundle_id: 'ghost-profile' })], isSkillProfileKnown: (id) => id === 'frontend' })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.reason).toBe('skill-bundle-profile-not-found'); expect(r.action).toBe('pause-loop') }
  })

  it('具名 profile + isSkillProfileKnown 返回 true → 正常放行，context 带 policy_epoch/skill_bundle_id', async () => {
    const adm = admission({ loops: [loop({ skill_bundle_id: 'frontend' })], isSkillProfileKnown: (id) => id === 'frontend' })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.context.skill_bundle_id).toBe('frontend')
      expect(typeof r.context.policy_epoch).toBe('string')
      expect(r.context.policy_epoch.length).toBeGreaterThan(0)
    }
  })

  it('_all 恒 known，即便未装配 isSkillProfileKnown 也放行（默认工厂已验证；这里再显式断言 policy_epoch/skill_bundle_id）', async () => {
    const adm = admission({ loops: [loop({ skill_bundle_id: '_all' })] })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.context.skill_bundle_id).toBe('_all')
  })
})

describe('binding 拒绝面（fail-closed，不静默无 loop 语境跑）', () => {
  it('无匹配 → binding-no-match', async () => {
    const adm = admission({ loops: [loop({ change_prefix: 'other-' })] })
    const r = await adm.reserve('nomatch-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('binding-no-match')
  })
  it('H14 r1 P1-1：selector 读到 A 后 durable binding 追加 B → expected A 以 binding-changed 拒绝，零 reservation', async () => {
    const store = createLoopLedgerStore()
    await store.append(dir, {
      schema_version: 1,
      record_id: 'binding-a',
      recorded_at: '2026-07-19T01:00:00.000Z',
      kind: 'change-loop-binding',
      change: 'job-x',
      loop_id: 'loop-a',
      source: 'explicit',
    })
    const selectorSnapshot = await store.read(dir)
    const selectedOwner = selectorSnapshot.records.find(
      (record) => record.kind === 'change-loop-binding' && record.change === 'job-x',
    )
    if (selectedOwner?.kind !== 'change-loop-binding') throw new Error('selector fixture 缺 binding A')

    // selector 已完成后，另一进程把同一 change 的 durable owner 改为 B。
    await store.append(dir, {
      schema_version: 1,
      record_id: 'binding-b',
      recorded_at: '2026-07-19T01:00:01.000Z',
      kind: 'change-loop-binding',
      change: 'job-x',
      loop_id: 'loop-b',
      source: 'explicit',
    })
    const adm = admission({
      loops: [
        loop({ id: 'loop-a', change_prefix: 'job-' }),
        loop({ id: 'loop-b', change_prefix: 'other-' }),
      ],
    })

    const r = await adm.reserve('job-x', { expectedLoopId: selectedOwner.loop_id })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('binding-changed')
      expect(r.loopId).toBe('loop-b')
    }
    const after = await store.read(dir)
    expect(after.records.filter((record) => record.kind === 'budget-reservation')).toHaveLength(0)
    expect(after.records.filter((record) => record.kind === 'reservation-activated')).toHaveLength(0)
  })
  it('H14 r2 P1-1：selector 读到 L3 后 owner 未变但治理已降为 L1 → policy-changed，零 reservation', async () => {
    const store = createLoopLedgerStore()
    const adm = admission({ loops: [loop({ id: 'loop-a', change_prefix: 'job-', autonomy_level: 'L1' })] })

    const r = await adm.reserve('job-x', {
      expectedLoopId: 'loop-a',
      expectedAutonomyLevel: 'L3',
    })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('policy-changed')
      expect(r.loopId).toBe('loop-a')
      expect(r.detail).toMatch(/L3.*L1|autonomy/i)
    }
    const after = await store.read(dir)
    expect(after.records.filter((record) => record.kind === 'budget-reservation')).toHaveLength(0)
  })
  it('真正用户显式 enqueue binding 仍是 durable authority：无 targeted expected 时覆盖名字前缀', async () => {
    const store = createLoopLedgerStore()
    await store.append(dir, {
      schema_version: 1,
      record_id: 'user-explicit-binding',
      recorded_at: '2026-07-19T01:00:00.000Z',
      kind: 'change-loop-binding',
      change: 'job-x',
      loop_id: 'loop-b',
      source: 'explicit',
    })
    const adm = admission({
      loops: [
        loop({ id: 'loop-a', change_prefix: 'job-' }),
        loop({ id: 'loop-b', change_prefix: 'other-' }),
      ],
    })

    const r = await adm.reserve('job-x')

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.context.loop_id).toBe('loop-b')
  })
  it('最长前缀首次发现 → 物化 change-loop-binding（source=longest-prefix）', async () => {
    const adm = admission({ loops: [loop({ id: 'lp', change_prefix: 'lp-' })] })
    await adm.reserve('lp-x')
    const read = await createLoopLedgerStore().read(dir)
    const bind = read.records.find((r) => r.kind === 'change-loop-binding')
    expect(bind).toBeDefined()
    if (bind && bind.kind === 'change-loop-binding') { expect(bind.loop_id).toBe('lp'); expect(bind.source).toBe('longest-prefix') }
  })
})

describe('C 验收 · settle 关闭 reservation', () => {
  const usage = {
    provider: 'openai-codex' as const,
    request_id: 'thread-h6',
    tokens: { input: 120, cached_input: 20, output: 30, reasoning: 10, total: 150 },
  }

  it('H6：provider usage 先 durable 落盘，terminal 改用 actual 并关联 usage id', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    await adm.activate(r.context)
    const usageId = await adm.recordProviderUsage(r.context, usage)
    await adm.settleWon(r.context, { result: 'paused', reason: 'completed', charge: 'reserved-estimate' })
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.filter((record) => record.kind === 'usage')).toHaveLength(1)
    const fact = records.find((record) => record.kind === 'usage')
    expect(fact).toMatchObject({
      kind: 'usage', usage_id: usageId, attempt_id: r.context.attempt_id,
      loop_id: 'lp', provider: 'openai-codex', source: 'provider-structured', tokens: usage.tokens,
    })
    const terminal = records.find((record) => record.kind === 'run' && record.reservation_id === r.context.reservation_id)
    expect(terminal).toMatchObject({
      usage_record_ids: [usageId],
      accounting: { reserved_tokens: 2000, charged_tokens: 150, charge_source: 'provider-structured' },
    })
  })

  it('H6：同一 attempt 同值 replay 幂等；冲突 provider fact fail-closed，原事实不改', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    await adm.activate(r.context)
    const first = await adm.recordProviderUsage(r.context, usage)
    expect(await adm.recordProviderUsage(r.context, usage)).toBe(first)
    await expect(adm.recordProviderUsage(r.context, {
      ...usage, tokens: { ...usage.tokens, total: 151 },
    })).rejects.toThrow(/usage|conflict|冲突/i)
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.filter((record) => record.kind === 'usage')).toHaveLength(1)
  })

  it('H6：reservation 未 activate 时拒写 provider usage，不能制造幽灵实际用量', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    await expect(adm.recordProviderUsage(r.context, usage)).rejects.toThrow(/activate/i)
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.some((record) => record.kind === 'usage')).toBe(false)
  })

  it('H9：伪造 iteration_id 的 context 不能 activate 或写 provider usage', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    const forged = { ...r.context, iteration_id: 'iteration-forged' }
    await expect(adm.activate(forged)).rejects.toThrow(/iteration|context.*reservation/i)
    await adm.activate(r.context)
    await expect(adm.recordProviderUsage(forged, usage)).rejects.toThrow(/iteration|context.*reservation/i)
  })

  it('settleLost → RunRecord skipped/claim-lost 扣 0，reservation 关闭（inFlight 归 0）', async () => {
    const adm = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })] })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await adm.settleLost(r.context)
    const store = createLoopLedgerStore()
    const win = await store.readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0) // 已关闭
    const run = win.runs.find((x) => x.reservation_id === r.context.reservation_id)!
    expect(run.result).toBe('skipped')
    expect(run.reason).toBe('claim-lost')
    expect(run.accounting.charged_tokens).toBe(0)
    // 关闭后 in-flight 腾出 → 再 reserve 同 loop 另一 change 可通过
    expect((await adm.reserve('lp-y')).ok).toBe(true)
  })

  it('settleWon（reserved-estimate）→ 按预占扣账、关闭 reservation', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    await adm.settleWon(r.context, { result: 'paused', reason: 'completed', charge: 'reserved-estimate', verify: { result: 'pass' } })
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(0)
    const run = win.runs[0]!
    expect(run.result).toBe('paused')
    expect(run.accounting.charged_tokens).toBe(2000)
    expect(run.accounting.charge_source).toBe('reserved-estimate')
    expect(run.verify).toEqual({ result: 'pass', source: 'sandbox-output', trusted: false })
  })

  it('H7 verifier Phase 2：settleWon 把 RunSettlement.verification 原样透传进 terminal RunRecord.verification', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    const verification = trustedPass('a'.repeat(40))
    await adm.settleWon(r.context, { result: 'merged', reason: 'completed', charge: 'reserved-estimate', verification })
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    const run = win.runs.find((x) => x.reservation_id === r.context.reservation_id)!
    expect(run.verification).toEqual(verification)
  })

  it('H7 verifier Phase 2：未传 verification → terminal RunRecord.verification 为 undefined（旧调用点零回归）', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    await adm.settleWon(r.context, { result: 'paused', reason: 'completed', charge: 'reserved-estimate' })
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    const run = win.runs.find((x) => x.reservation_id === r.context.reservation_id)!
    expect(run.verification).toBeUndefined()
  })
})

describe('C 验收 · reservation 崩溃恢复', () => {
  it('H7 r6 P1-B：未 activate 的过期 reservation 已处于 scheduled → 先 owner CAS 回 queued，再 close none', async () => {
    const automation = new Map<string, string>([['lp-x', 'queued'], ['lp-y', 'queued']])
    const budget = { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' as const }
    const first = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      getAutomation: async (change) => automation.get(change) ?? '',
    })
    const r1 = await first.reserve('lp-x')
    expect(r1.ok).toBe(true)
    automation.set('lp-x', 'scheduled') // 模拟 claim 已成功、activate 前进程崩溃

    const order: string[] = []
    const second = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      clock: () => '2026-07-17T09:00:00.000Z',
      getAutomation: async (change) => automation.get(change) ?? '',
      resetScheduledToQueued: async (change) => {
        order.push(`cas:${change}`)
        if (automation.get(change) !== 'scheduled') return false
        automation.set(change, 'queued')
        return true
      },
    })
    const r2 = await second.reserve('lp-y')
    expect(r2.ok).toBe(true)
    expect(order).toEqual(['cas:lp-x'])
    expect(automation.get('lp-x')).toBe('queued')
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    const expired = win.runs.find((x) => x.reason === 'reservation-expired')
    expect(expired).toBeDefined()
    expect(expired!.accounting.charged_tokens).toBe(0)
  })

  it('H7 r6 P1-B：未 activate 的过期 reservation 已是 queued → 不取 scheduled CAS，直接 close none', async () => {
    const automation = new Map<string, string>([['lp-x', 'queued'], ['lp-y', 'queued']])
    const budget = { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' as const }
    const first = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      getAutomation: async (change) => automation.get(change) ?? '',
    })
    const r1 = await first.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')

    const second = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      clock: () => '2026-07-17T09:00:00.000Z',
      getAutomation: async (change) => automation.get(change) ?? '',
      resetScheduledToQueued: async () => { throw new Error('queued 过期不应取 scheduled CAS') },
    })
    expect((await second.reserve('lp-y')).ok).toBe(true)
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.filter((record) => record.kind === 'run' && record.reservation_id === r1.context.reservation_id)).toHaveLength(1)
    expect(records.find((record) => record.kind === 'run' && record.reservation_id === r1.context.reservation_id)).toMatchObject({
      result: 'skipped', reason: 'reservation-expired',
      accounting: { charged_tokens: 0, charge_source: 'none' },
    })
  })

  it.each([
    ['CAS 返回 false', async () => false],
    ['CAS 抛错', async () => { throw new Error('state CAS I/O failed') }],
  ] as const)('H7 r6 P1-B：scheduled 过期但%s → reservation 保持 open，绝不先 close', async (_case, reset) => {
    const automation = new Map<string, string>([['lp-x', 'queued'], ['lp-y', 'queued']])
    const budget = { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' as const }
    const first = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      getAutomation: async (change) => automation.get(change) ?? '',
    })
    const r1 = await first.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')
    automation.set('lp-x', 'scheduled')

    const second = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      clock: () => '2026-07-17T09:00:00.000Z',
      getAutomation: async (change) => automation.get(change) ?? '',
      resetScheduledToQueued: reset,
    })
    const blocked = await second.reserve('lp-y')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('max-in-flight')
    expect(automation.get('lp-x')).toBe('scheduled')
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations.map((record) => record.reservation_id)).toContain(r1.context.reservation_id)
    expect(win.runs.some((record) => record.reservation_id === r1.context.reservation_id)).toBe(false)
  })

  it('H7 r6 P1-B：scheduled 过期但 state read 抛错 → 不猜 queued/scheduled，reservation 保持 open', async () => {
    const budget = { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' as const }
    const first = admission({ loops: [loop({ budget })], reservationTtlMs: 0 })
    const r1 = await first.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')
    let resetCalls = 0
    const second = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      clock: () => '2026-07-17T09:00:00.000Z',
      getAutomation: async () => { throw new Error('state read I/O failed') },
      resetScheduledToQueued: async () => { resetCalls++; return true },
    })
    const blocked = await second.reserve('lp-y')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('max-in-flight')
    expect(resetCalls).toBe(0)
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations.map((record) => record.reservation_id)).toContain(r1.context.reservation_id)
    expect(win.runs.some((record) => record.reservation_id === r1.context.reservation_id)).toBe(false)
  })

  it('H7 r6 P1-B：CAS 已把 scheduled→queued 后在 close 前崩溃 → 本轮保留 open，下轮 queued 直关且不双扣', async () => {
    const automation = new Map<string, string>([['lp-x', 'queued'], ['lp-y', 'queued']])
    const budget = { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' as const }
    const first = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      getAutomation: async (change) => automation.get(change) ?? '',
    })
    const r1 = await first.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')
    automation.set('lp-x', 'scheduled')

    const crashed = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      clock: () => '2026-07-17T09:00:00.000Z',
      getAutomation: async (change) => automation.get(change) ?? '',
      resetScheduledToQueued: async (change) => {
        automation.set(change, 'queued') // CAS 已 durable
        throw new Error('process died before ledger close')
      },
    })
    const blocked = await crashed.reserve('lp-y')
    expect(blocked.ok).toBe(false)
    expect(automation.get('lp-x')).toBe('queued')
    let win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations.map((record) => record.reservation_id)).toContain(r1.context.reservation_id)
    expect(win.runs.some((record) => record.reservation_id === r1.context.reservation_id)).toBe(false)

    const next = admission({
      loops: [loop({ budget })], reservationTtlMs: 0,
      clock: () => '2026-07-17T10:00:00.000Z',
      getAutomation: async (change) => automation.get(change) ?? '',
      resetScheduledToQueued: async () => { throw new Error('queued 恢复不得重复取 scheduled CAS') },
    })
    expect((await next.reserve('lp-y')).ok).toBe(true)
    win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    const terminals = win.runs.filter((record) => record.reservation_id === r1.context.reservation_id)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ reason: 'reservation-expired', accounting: { charged_tokens: 0, charge_source: 'none' } })
  })

  it('activated 但 automation 已 terminal → recover 成 recovered，按 estimate 扣账', async () => {
    const adm = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })] })
    const r1 = await adm.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')
    await adm.activate(r1.context) // 标 activated 但不结算（模拟 CAS 成功后 ledger 写失败崩溃）
    // 下次 reserve：getAutomation('lp-x')=merged（terminal）→ recover 成 recovered
    const adm2 = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })], getAutomation: async (c) => (c === 'lp-x' ? 'merged' : '') })
    const r2 = await adm2.reserve('lp-y')
    expect(r2.ok).toBe(true)
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    const rec = win.runs.find((x) => x.reason === 'recovered')!
    expect(rec.result).toBe('merged')
    expect(rec.accounting.charge_source).toBe('reserved-estimate')
  })

  it('activated 但 automation 仍 running → orphan 占 in-flight，拒新 admission（要求 reconcile）', async () => {
    const adm = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })] })
    const r1 = await adm.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')
    await adm.activate(r1.context)
    const adm2 = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })], getAutomation: async () => 'running' })
    const r2 = await adm2.reserve('lp-y')
    expect(r2.ok).toBe(false) // orphan 仍占 in-flight
    if (!r2.ok) expect(r2.reason).toBe('max-in-flight')
  })
})

describe('H7 durable merge journal · intent / landed / crash recovery', () => {
  const preparedFor = async (ctx: ExecutionContext): Promise<LoopPreparedExecutionContext> => {
    const prepared = markLoopPrepared(ctx, {
      snapshotSha256: 'e'.repeat(64),
      casRelativePath: `.pipeline/loops/skill-snapshots/sha256/${'e'.repeat(64)}`,
      resolutionSource: 'default',
      workflow: 'default',
      step: 'verify',
      track: 'pm',
      coordinateDigest: 'd'.repeat(64),
      slots: [],
    })
    await createLoopLedgerStore().append(dir, {
      schema_version: 1, record_id: `snapshot-${ctx.attempt_id}`, recorded_at: '2026-07-18T00:00:01.000Z',
      kind: 'skill-bundle-snapshot', attempt_id: ctx.attempt_id, reservation_id: ctx.reservation_id,
      loop_id: ctx.loop_id, skill_bundle_id: ctx.skill_bundle_id!, policy_epoch: ctx.policy_epoch,
      resolution_source: 'default', workflow_run_id: ctx.workflow_run_id ?? ctx.attempt_id,
      workflow: 'default', step: 'verify', track: 'pm', coordinate_digest: 'd'.repeat(64),
      snapshot_sha256: 'e'.repeat(64),
      cas_relative_path: `.pipeline/loops/skill-snapshots/sha256/${'e'.repeat(64)}`,
      slots: [],
    })
    return prepared
  }

  const intentInput = (context: LoopPreparedExecutionContext) => {
    const revision = 'a'.repeat(40)
    const verification: VerificationResult = {
      ...trustedPass(revision),
      subject: {
        workflow_run_id: context.workflow_run_id ?? context.attempt_id,
        attempt_id: context.attempt_id,
        change: context.change,
        revision: { kind: 'named-branch-head', sha: revision },
      },
    }
    return {
      context,
      baseRef: 'refs/heads/main',
      baseBefore: 'BASE_SHORT',
      branchRef: `refs/heads/sandcastle-pipeline/${context.change}`,
      branchTip: revision,
      mergedCommit: 'MERGED_SHORT',
      verification,
      verifyResult: 'pass' as const,
      buildSha: revision,
      branch: `sandcastle-pipeline/${context.change}`,
      commitShas: [revision],
    }
  }

  it('H9：merge intent 拒绝与 reservation 不同 iteration 的伪造 context', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    const prepared = await preparedFor(r.context)
    await adm.activate(prepared)
    const forged = { ...prepared, iteration_id: 'iteration-forged' } as LoopPreparedExecutionContext
    await expect(adm.recordMergeIntent(intentInput(forged))).rejects.toThrow(/iteration|context.*reservation/i)
  })

  it('activated reservation 才能追加 intent；landed 必须绑定同一 intent/attempt/ref facts', async () => {
    const adm = admission({ loops: [loop()] })
    const reserved = await adm.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const prepared = await preparedFor({ ...reserved.context, workflow_run_id: 'wfr-real-1' })

    await expect(adm.recordMergeIntent(intentInput(prepared))).rejects.toThrow(/activate|activated/i)
    await adm.activate(prepared)
    const intentRecordId = await adm.recordMergeIntent(intentInput(prepared))
    await expect(adm.recordMergeLanded({
      context: { ...prepared, iteration_id: 'iteration-forged' } as LoopPreparedExecutionContext,
      intentRecordId,
      baseRef: 'refs/heads/main',
      baseBefore: 'BASE_SHORT',
      branchTip: 'a'.repeat(40),
      mergedCommit: 'MERGED_SHORT',
      hostSynced: true,
    })).rejects.toThrow(/intent|iteration|事实/i)
    await adm.recordMergeLanded({
      context: prepared,
      intentRecordId,
      baseRef: 'refs/heads/main',
      baseBefore: 'BASE_SHORT',
      branchTip: 'a'.repeat(40),
      mergedCommit: 'MERGED_SHORT',
      hostSynced: false,
      hostSyncError: 'dirty host path',
    })

    const { records } = await createLoopLedgerStore().read(dir)
    const intent = records.find((record) => record.kind === 'merge-intent')
    const landed = records.find((record) => record.kind === 'merge-landed')
    expect(intent).toMatchObject({
      record_id: intentRecordId,
      attempt_id: prepared.attempt_id,
      workflow_run_id: 'wfr-real-1',
      expected_base_sha: 'BASE_SHORT',
      expected_branch_sha: 'a'.repeat(40),
      merged_commit_sha: 'MERGED_SHORT',
      skill_bundle_snapshot_sha256: 'e'.repeat(64),
      verification: intentInput(prepared).verification,
      artifacts: { build_sha: 'a'.repeat(40), commit_shas: ['a'.repeat(40)] },
    })
    expect(landed).toMatchObject({
      intent_record_id: intentRecordId,
      host_synced: false,
      host_sync_error: { cause: 'host-sync-failed', message: 'dirty host path' },
    })

    await expect(adm.recordMergeLanded({
      context: prepared,
      intentRecordId,
      baseRef: 'refs/heads/main',
      baseBefore: 'WRONG_BASE',
      branchTip: 'a'.repeat(40),
      mergedCommit: 'MERGED_SHORT',
      hostSynced: true,
    })).rejects.toThrow(/intent|base/i)
  })

  it('H10 r4：合法工厂签发但 ledger 无对应 skill-bundle-snapshot → activate fail-closed', async () => {
    const adm = admission({ loops: [loop()] })
    const reserved = await adm.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const invented = markLoopPrepared(reserved.context, {
      snapshotSha256: 'a'.repeat(64),
      casRelativePath: `.pipeline/loops/skill-snapshots/sha256/${'a'.repeat(64)}`,
      resolutionSource: 'default', workflow: 'default', step: 'verify', track: 'pm',
      coordinateDigest: 'b'.repeat(64), slots: [],
    })
    await expect(adm.activate(invented)).rejects.toThrow(/skill-bundle-snapshot|snapshot/i)
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.some((record) => record.kind === 'reservation-activated')).toBe(false)
  })

  it('H10 r4：ledger 有 snapshot 但 prepared digest/CAS 与其不符 → activate fail-closed', async () => {
    const adm = admission({ loops: [loop()] })
    const reserved = await adm.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const valid = await preparedFor(reserved.context)
    const forged = markLoopPrepared(reserved.context, {
      ...valid.skillBundle,
      snapshotSha256: 'a'.repeat(64),
      casRelativePath: `.pipeline/loops/skill-snapshots/sha256/${'a'.repeat(64)}`,
    })
    await expect(adm.activate(forged)).rejects.toThrow(/skill-bundle-snapshot|snapshot/i)
    expect((await adm.activate(valid)).status).toBe('activated')
  })

  it('crash after ref CAS but before landed fsync：intent + 真实 ref 恢复 merged，完整保留核验/产物/快照', async () => {
    const first = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })] })
    const reserved = await first.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const prepared = await preparedFor({ ...reserved.context, workflow_run_id: 'wfr-real-2' })
    await first.activate(prepared)
    const usageId = await first.recordProviderUsage(prepared, {
      provider: 'openai-codex', request_id: 'thread-recovery',
      tokens: { input: 120, cached_input: 20, output: 30, reasoning: 10, total: 150 },
    })
    await first.recordMergeIntent(intentInput(prepared))

    const recoveredStates: Array<{ change: string; cause: string; message: string }> = []
    const second = admission({
      loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })],
      getAutomation: async (change) => change === 'lp-x' ? 'running' : '',
      getExecutionLiveness: async () => 'dead',
      readGitRef: async (ref) => ref === 'refs/heads/main' ? 'MERGED_SHORT' : '',
      commitRecoveredMerge: async (change, state) => { recoveredStates.push({ change, ...state }) },
    })
    expect((await second.reserve('lp-y')).ok).toBe(true)

    expect(recoveredStates).toEqual([{
      change: 'lp-x', cause: 'merge-journal-pending',
      message: 'base ref 已落地，但 merge-landed receipt 缺失；已由 intent + ref CAS 事实恢复',
    }])
    const { records } = await createLoopLedgerStore().read(dir)
    const terminal = records.find((record) => record.kind === 'run' && record.reservation_id === prepared.reservation_id)
    expect(terminal).toMatchObject({
      kind: 'run', result: 'merged', reason: 'merge-journal-pending',
      workflow_run_id: 'wfr-real-2', verification: intentInput(prepared).verification,
      artifacts: { build_sha: 'a'.repeat(40), commit_shas: ['a'.repeat(40)] },
      skill_bundle_snapshot_sha256: 'e'.repeat(64),
      usage_record_ids: [usageId],
      accounting: { reserved_tokens: 2000, charged_tokens: 150, charge_source: 'provider-structured' },
    })
  })

  it('intent-only：base tip 已前进到后继 N 且 M 是 N 祖先 → 仍恢复 canonical merged，不落普通 orphan failed', async () => {
    const first = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })] })
    const reserved = await first.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const prepared = await preparedFor({ ...reserved.context, workflow_run_id: 'wfr-descendant-tip' })
    await first.activate(prepared)
    await first.recordMergeIntent(intentInput(prepared))

    const probes: Array<{ ancestor: string; descendant: string }> = []
    const recovered: string[] = []
    const second = admission({
      loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })],
      getAutomation: async (change) => change === 'lp-x' ? 'running' : '',
      getExecutionLiveness: async () => 'dead',
      readGitRef: async () => 'DESCENDANT_N',
      isCommitAncestor: async (ancestor, descendant) => {
        probes.push({ ancestor, descendant })
        return ancestor === 'MERGED_SHORT' && descendant === 'DESCENDANT_N'
      },
      commitRecoveredMerge: async (_change, state) => { recovered.push(state.cause) },
    })

    expect((await second.reserve('lp-y')).ok).toBe(true)
    expect(probes).toEqual([{ ancestor: 'MERGED_SHORT', descendant: 'DESCENDANT_N' }])
    expect(recovered).toEqual(['merge-journal-pending'])
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.find((record) => record.kind === 'run' && record.reservation_id === prepared.reservation_id)).toMatchObject({
      result: 'merged', reason: 'merge-journal-pending', workflow_run_id: 'wfr-descendant-tip',
    })
  })

  it.each([
    ['probe 明确返回 false', async () => false],
    ['probe 命令错误抛异常', async () => { throw new Error('git merge-base failed: exit 128') }],
  ])('intent-only 且%s：祖先关系未获证明 → 保留 reservation，绝不落普通 orphan failed', async (_case, probe) => {
    const first = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })] })
    const reserved = await first.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const prepared = await preparedFor(reserved.context)
    await first.activate(prepared)
    await first.recordMergeIntent(intentInput(prepared))

    const ordinaryOrphanFailures: string[] = []
    const second = admission({
      loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })],
      getAutomation: async (change) => change === 'lp-x' ? 'running' : '',
      getExecutionLiveness: async () => 'dead',
      failRunningToTerminal: async (change) => { ordinaryOrphanFailures.push(change); return true },
      readGitRef: async () => 'DESCENDANT_OR_DIVERGED',
      isCommitAncestor: probe,
      commitRecoveredMerge: async () => { throw new Error('未证明 merged 时不得调用') },
    })

    const next = await second.reserve('lp-y')
    expect(next.ok).toBe(false)
    if (!next.ok) expect(next.reason).toBe('max-in-flight')
    expect(ordinaryOrphanFailures).toEqual([])
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.some((record) => record.kind === 'run' && record.reservation_id === prepared.reservation_id)).toBe(false)
  })

  it('intent-only + automation 已是 terminal：recoverLoopInLock 不得抢先吞 merge facts 落 generic recovered', async () => {
    const first = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })] })
    const reserved = await first.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const prepared = await preparedFor(reserved.context)
    await first.activate(prepared)
    await first.recordMergeIntent(intentInput(prepared))

    const second = admission({
      loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })],
      getAutomation: async (change) => change === 'lp-x' ? 'failed' : '',
      readGitRef: async () => 'DIVERGED_TIP',
      isCommitAncestor: async () => false,
      commitRecoveredMerge: async () => { throw new Error('未证明 merged 时不得调用') },
    })

    const next = await second.reserve('lp-y')
    expect(next.ok).toBe(false)
    if (!next.ok) expect(next.reason).toBe('max-in-flight')
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.some((record) => record.kind === 'run' && record.reservation_id === prepared.reservation_id)).toBe(false)
  })

  it('H7 r6 P1-A：landed 后 state 写失败留下 running + open → 下一轮先 commit merged，再落唯一 canonical terminal', async () => {
    const first = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })] })
    const reserved = await first.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const prepared = await preparedFor(reserved.context)
    await first.activate(prepared)
    const intentRecordId = await first.recordMergeIntent(intentInput(prepared))
    await first.recordMergeLanded({
      context: prepared, intentRecordId, baseRef: 'refs/heads/main', baseBefore: 'BASE_SHORT',
      branchTip: 'a'.repeat(40), mergedCommit: 'MERGED_SHORT', hostSynced: false,
      hostSyncError: 'read-tree blocked by dirty path',
    })

    let beforeRecovery = await createLoopLedgerStore().read(dir)
    expect(beforeRecovery.records.some(
      (record) => record.kind === 'run' && record.reservation_id === prepared.reservation_id,
    )).toBe(false)
    expect((await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })).openReservations.map(
      (record) => record.reservation_id,
    )).toContain(prepared.reservation_id)

    const automation = new Map<string, string>([['lp-x', 'running'], ['lp-y', 'queued']])
    const recovered: string[] = []
    const second = admission({
      loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })],
      getAutomation: async (change) => automation.get(change) ?? '',
      getExecutionLiveness: async () => 'dead',
      commitRecoveredMerge: async (change, state) => {
        expect(automation.get(change)).toBe('running')
        automation.set(change, 'merged')
        recovered.push(state.cause)
      },
    })
    expect((await second.reserve('lp-y')).ok).toBe(true)
    expect(automation.get('lp-x')).toBe('merged')
    expect(recovered).toEqual(['host-sync-pending'])
    beforeRecovery = await createLoopLedgerStore().read(dir)
    const { records } = beforeRecovery
    expect(records.filter(
      (record) => record.kind === 'run' && record.reservation_id === prepared.reservation_id,
    )).toHaveLength(1)
    const terminal = records.find((record) => record.kind === 'run' && record.reservation_id === prepared.reservation_id)
    expect(terminal).toMatchObject({
      kind: 'run', result: 'merged', reason: 'host-sync-pending',
      error: { cause: 'host-sync-failed', message: 'read-tree blocked by dirty path' },
    })
  })

  it('H7 r6 P1-A：recovery 第一步 commit state 失败 → 不落 terminal；下一轮重试后唯一收口', async () => {
    const budget = { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' as const }
    const first = admission({ loops: [loop({ budget })] })
    const reserved = await first.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const prepared = await preparedFor(reserved.context)
    await first.activate(prepared)
    const intentRecordId = await first.recordMergeIntent(intentInput(prepared))
    await first.recordMergeLanded({
      context: prepared, intentRecordId, baseRef: 'refs/heads/main', baseBefore: 'BASE_SHORT',
      branchTip: 'a'.repeat(40), mergedCommit: 'MERGED_SHORT', hostSynced: true,
    })

    const automation = new Map<string, string>([['lp-x', 'running'], ['lp-y', 'queued']])
    let commitAttempts = 0
    const failed = admission({
      loops: [loop({ budget })],
      getAutomation: async (change) => automation.get(change) ?? '',
      commitRecoveredMerge: async () => {
        commitAttempts++
        throw new Error('state fsync failed')
      },
    })
    await expect(failed.reserve('lp-y')).rejects.toThrow(/state fsync failed/)
    expect(automation.get('lp-x')).toBe('running')
    let window = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(window.openReservations.map((record) => record.reservation_id)).toContain(prepared.reservation_id)
    expect(window.runs.some((record) => record.reservation_id === prepared.reservation_id)).toBe(false)

    const retried = admission({
      loops: [loop({ budget })],
      getAutomation: async (change) => automation.get(change) ?? '',
      commitRecoveredMerge: async (change) => {
        commitAttempts++
        automation.set(change, 'merged')
      },
    })
    expect((await retried.reserve('lp-y')).ok).toBe(true)
    expect(commitAttempts).toBe(2)
    expect(automation.get('lp-x')).toBe('merged')
    window = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    const terminals = window.runs.filter((record) => record.reservation_id === prepared.reservation_id)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ result: 'merged', reason: 'completed' })
  })

  it('H7 r6 P1-A：recovery 已 commit merged、第二步 terminal close 失败 → 下轮幂等重做且不双扣', async () => {
    const realLedger = createLoopLedgerStore()
    let failNextClose = true
    const flakyLedger: LoopLedgerStore = {
      ...realLedger,
      closeReservationIfOpen: async (repoRoot, reservationId, create) => {
        if (failNextClose) {
          failNextClose = false
          throw new Error('terminal fsync failed')
        }
        return realLedger.closeReservationIfOpen(repoRoot, reservationId, create)
      },
    }
    const budget = { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' as const }
    const first = admission({ ledger: flakyLedger, loops: [loop({ budget })] })
    const reserved = await first.reserve('lp-x')
    if (!reserved.ok) throw new Error('reserve failed')
    const prepared = await preparedFor(reserved.context)
    await first.activate(prepared)
    const intentRecordId = await first.recordMergeIntent(intentInput(prepared))
    await first.recordMergeLanded({
      context: prepared, intentRecordId, baseRef: 'refs/heads/main', baseBefore: 'BASE_SHORT',
      branchTip: 'a'.repeat(40), mergedCommit: 'MERGED_SHORT', hostSynced: true,
    })

    const automation = new Map<string, string>([['lp-x', 'running'], ['lp-y', 'queued']])
    let commitAttempts = 0
    const commitRecoveredMerge = async (change: string): Promise<void> => {
      commitAttempts++
      automation.set(change, 'merged') // 幂等 state commit：第二次写同值仍安全
    }
    const failed = admission({
      ledger: flakyLedger, loops: [loop({ budget })],
      getAutomation: async (change) => automation.get(change) ?? '', commitRecoveredMerge,
    })
    await expect(failed.reserve('lp-y')).rejects.toThrow(/terminal fsync failed/)
    expect(automation.get('lp-x')).toBe('merged')
    let window = await realLedger.readRunWindow(dir, { limit: 10 })
    expect(window.openReservations.map((record) => record.reservation_id)).toContain(prepared.reservation_id)
    expect(window.runs.some((record) => record.reservation_id === prepared.reservation_id)).toBe(false)

    const retried = admission({
      ledger: flakyLedger, loops: [loop({ budget })],
      getAutomation: async (change) => automation.get(change) ?? '', commitRecoveredMerge,
    })
    expect((await retried.reserve('lp-y')).ok).toBe(true)
    expect(commitAttempts).toBe(2)
    window = await realLedger.readRunWindow(dir, { limit: 10 })
    const terminals = window.runs.filter((record) => record.reservation_id === prepared.reservation_id)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      result: 'merged', reason: 'completed',
      accounting: { charged_tokens: 2000, charge_source: 'reserved-estimate' },
    })
  })
})

describe('Stage B 返工 #1 · 统一幂等关闭（settle 全走 closeReservationIfOpen，不双结算）', () => {
  it('settleWon 调两次 → 幂等，账本只一条 terminal', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    await adm.settleWon(r.context, { result: 'paused', reason: 'completed', charge: 'reserved-estimate' })
    await adm.settleWon(r.context, { result: 'paused', reason: 'completed', charge: 'reserved-estimate' }) // 幂等第二次
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.filter((x) => x.kind === 'run' && x.reservation_id === r.context.reservation_id)).toHaveLength(1)
  })

  it('recovery 与 settleWon 并发关同一 reservation → 只一条 terminal（token 只扣一次）', async () => {
    // activated + automation=merged（terminal）：一路 settleWon，一路 reserve('lp-y') 锁内 recover 同一 reservation。
    const adm = admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 9, on_exceed: 'skip' } })], getAutomation: async () => 'merged' })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    await adm.activate(r.context)
    await Promise.all([
      adm.settleWon(r.context, { result: 'merged', reason: 'completed', charge: 'reserved-estimate' }),
      adm.reserve('lp-y'), // 锁内 recoverLoopInLock 见 lp-x activated+merged → 尝试同关
    ])
    const { records } = await createLoopLedgerStore().read(dir)
    const terminals = records.filter((x) => x.kind === 'run' && x.reservation_id === r.context.reservation_id)
    expect(terminals).toHaveLength(1) // 绝不双结算
    expect(terminals[0]!.accounting.charged_tokens).toBe(2000) // token 只算一次
  })

  it('activate 已关闭 reservation → already-terminal，不追加晚到 activation', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    await adm.settleLost(r.context) // 先关闭
    const act = await adm.activate(r.context)
    expect(act.status).toBe('already-terminal')
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.filter((x) => x.kind === 'reservation-activated' && x.reservation_id === r.context.reservation_id)).toHaveLength(0)
  })

  it('activate open reservation → activated', async () => {
    const adm = admission({ loops: [loop()] })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    expect((await adm.activate(r.context)).status).toBe('activated')
  })

  it('H7 r7 P1-B：claim→prepare 窗口跨过 expires_at → activate 锁内关闭 expired，零 activation；重复 activate/reconcile 不双关', async () => {
    let now = '2026-07-17T08:00:00.000Z'
    const budget = { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' as const }
    const adm = admission({
      loops: [loop({ budget })],
      reservationTtlMs: 1_000,
      clock: () => now,
      getAutomation: async () => 'queued',
    })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    now = '2026-07-17T08:00:02.000Z'

    expect(await adm.activate(r.context)).toEqual({ status: 'already-terminal' })
    expect(await adm.activate(r.context)).toEqual({ status: 'already-terminal' })
    expect((await adm.reserve('lp-y')).ok).toBe(true) // reserve 前 reconcile 看见已关闭，只能幂等跳过

    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.filter((record) =>
      record.kind === 'reservation-activated' && record.reservation_id === r.context.reservation_id,
    )).toHaveLength(0)
    const terminals = records.filter((record) =>
      record.kind === 'run' && record.reservation_id === r.context.reservation_id,
    )
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      result: 'skipped', reason: 'reservation-expired',
      accounting: { charged_tokens: 0, charge_source: 'none' },
    })
  })

  it('H7 r7 P1-B：clock 恰等于 expires_at 尚未过期 → activate 仍放行（与 reconcile 的严格 > 口径一致）', async () => {
    let now = '2026-07-17T08:00:00.000Z'
    const adm = admission({ reservationTtlMs: 1_000, clock: () => now })
    const r = await adm.reserve('lp-x')
    if (!r.ok) throw new Error('reserve failed')
    now = '2026-07-17T08:00:01.000Z'
    expect(await adm.activate(r.context)).toEqual({ status: 'activated' })
  })
})

describe('Stage B 返工 #4 · registry 快照→物化 TOCTOU（epoch 复验）', () => {
  it('临界区内 epoch 持续变化 → 不写 binding/reservation，返回 registry-concurrent-update', async () => {
    let calls = 0
    // 每次 loadRegistry 返回不同 budget（epoch 每次都变），但 prefix 稳定（binding 仍解析到 lp）。
    const adm = admission({
      loadRegistry: () => { calls++; return registry([loop({ id: 'lp', change_prefix: 'lp-', budget: { max_runs_per_day: 20 + calls, max_in_flight: 9, on_exceed: 'skip' } })]) },
    })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('registry-concurrent-update')
    // 关键：epoch 变则绝不写 binding/reservation。
    const read = await createLoopLedgerStore().read(dir)
    expect(read.records.filter((x) => x.kind === 'change-loop-binding')).toHaveLength(0)
    expect(read.records.filter((x) => x.kind === 'budget-reservation')).toHaveLength(0)
  })

  it('epoch 变一次后稳定 → 重试后成功 reserve（不活锁）', async () => {
    let calls = 0
    const adm = admission({
      loadRegistry: () => { calls++; return registry([loop({ id: 'lp', change_prefix: 'lp-', budget: { max_runs_per_day: calls <= 1 ? 21 : 22, max_in_flight: 9, on_exceed: 'skip' } })]) },
    })
    const r = await adm.reserve('lp-x') // attempt1 reg1(21)≠reg2(22) 重试；attempt2 reg1(22)=reg2(22) 成功
    expect(r.ok).toBe(true)
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    expect(win.openReservations).toHaveLength(1)
  })

  it('registry 稳定 → epoch 不变，正常一次通过（无重试开销可观测）', async () => {
    let calls = 0
    const adm = admission({ loadRegistry: () => { calls++; return registry([loop({ id: 'lp', change_prefix: 'lp-' })]) } })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(true)
    expect(calls).toBe(2) // reg1 + reg2 各一次，一轮过（isActive 未调）
  })
})

describe('Stage B 返工 #5 · activated orphan reconcile（liveness 注入，不加 lease/CLI）', () => {
  const orphanAdm = (over: Parameters<typeof admission>[0] = {}) =>
    admission({ loops: [loop({ budget: { max_runs_per_day: 99, max_in_flight: 1, on_exceed: 'skip' } })], getAutomation: async () => 'running', ...over })

  it('running + liveness alive → 保持 open（不误杀真长任务），新 admission 被 in-flight 挡', async () => {
    const adm = orphanAdm({ getExecutionLiveness: async () => 'alive' })
    const r1 = await adm.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')
    await adm.activate(r1.context)
    const r2 = await adm.reserve('lp-y')
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toBe('max-in-flight')
  })

  it('running + liveness unknown → 不擅自关闭（保持 open）', async () => {
    const adm = orphanAdm({ getExecutionLiveness: async () => 'unknown' })
    const r1 = await adm.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')
    await adm.activate(r1.context)
    expect((await adm.reserve('lp-y')).ok).toBe(false) // 仍占 in-flight
  })

  it('running + liveness dead → reconcile 关闭（running CAS + close infrastructure-error），in-flight 腾出', async () => {
    const cas: string[] = []
    const adm = orphanAdm({ getExecutionLiveness: async () => 'dead', failRunningToTerminal: async (c) => { cas.push(c); return true } })
    const r1 = await adm.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')
    await adm.activate(r1.context)
    const r2 = await adm.reserve('lp-y')
    expect(r2.ok).toBe(true) // orphan 被 reconcile，in-flight 腾出
    expect(cas).toContain('lp-x')
    const win = await createLoopLedgerStore().readRunWindow(dir, { limit: 10 })
    const closed = win.runs.find((x) => x.reservation_id === r1.context.reservation_id)
    expect(closed?.reason).toBe('infrastructure-error')
    expect(closed?.result).toBe('failed')
  })

  it('dead 但 CAS 失败（ownership 丢）→ 不 close（保持 open，下轮再试）', async () => {
    const adm = orphanAdm({ getExecutionLiveness: async () => 'dead', failRunningToTerminal: async () => false })
    const r1 = await adm.reserve('lp-x')
    if (!r1.ok) throw new Error('reserve failed')
    await adm.activate(r1.context)
    expect((await adm.reserve('lp-y')).ok).toBe(false) // CAS 输 → 不 close → 仍占 in-flight
  })
})

describe('isActive · kill-switch 重查', () => {
  it('active → true；paused → false；registry 消失 → false（fail-closed）', async () => {
    expect(await admission({ loops: [loop({ status: 'active' })] }).isActive('lp')).toBe(true)
    expect(await admission({ loops: [loop({ status: 'paused' })] }).isActive('lp')).toBe(false)
    expect(await admission({ loadRegistry: () => ({ data: null, errors: [] }) }).isActive('lp')).toBe(false)
  })
})

describe('Stage B 返工 #2 · registry 真实 I/O 故障是 round failure，不是 no-registry denial（假 ok=true）', () => {
  const ioThrow = (): never => { throw Object.assign(new Error('EACCES: permission denied'), { _tag: 'RegistryReadError' }) }

  it('reserve：loadRegistry 抛 I/O 故障 → 上抛（经 scheduler 归 failures 使 ok=false），绝不吞成 skip-run denial', async () => {
    const adm = admission({ loadRegistry: ioThrow })
    await expect(adm.reserve('lp-x')).rejects.toMatchObject({ _tag: 'RegistryReadError' })
    // 关键：ENOENT→no-registry 才是 denial（下一个用例）；真实 I/O 故障必 fail-loud，绝不静默放行一轮。
  })

  it('reserve：loops.yaml 是目录（真 EISDIR）+ strict loader → throw RegistryReadError（真 fs 端到端）', async () => {
    await mkdir(join(dir, '.pipeline', 'loops.yaml'), { recursive: true }) // 路径被目录占据 → readFileSync EISDIR
    const adm = createLoopAdmission({
      repoRoot: dir, ledger: createLoopLedgerStore(),
      loadRegistry: (r) => loadRegistry(r, nodeLoopIoStrict), // 真 strict loader：ENOENT→null，其它 I/O→throw
      clock: () => new Date('2026-07-17T08:00:00.000Z').toISOString(), level: 'L1', getAutomation: async () => '',
    })
    await expect(adm.reserve('lp-x')).rejects.toMatchObject({ _tag: 'RegistryReadError' })
  })

  it('ENOENT（loops.yaml 缺失）→ 合法 no-registry denial（skip-run），非 failure', async () => {
    // strict loader：文件缺失 → data:null/errors:[] → no-registry denial（治理常态，不 throw）
    const adm = createLoopAdmission({
      repoRoot: dir, ledger: createLoopLedgerStore(),
      loadRegistry: (r) => loadRegistry(r, nodeLoopIoStrict),
      clock: () => new Date('2026-07-17T08:00:00.000Z').toISOString(), level: 'L1', getAutomation: async () => '',
    })
    const r = await adm.reserve('lp-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no-registry')
  })

  it('isActive：loadRegistry 抛 I/O 故障 → fail-closed 返 false（保守判不 active，不上抛）', async () => {
    const adm = admission({ loadRegistry: ioThrow })
    expect(await adm.isActive('lp')).toBe(false)
  })
})

describe('H10 §3/§8任务5：createExecutionPreparation（真 fs 定位/物化 + 真 ledger，覆盖设计 §5 reason 表准备期 8 项）', () => {
  let skillsRoot: string
  beforeEach(async () => { skillsRoot = await mkdtemp(join(tmpdir(), 'skill-prep-')) })
  afterEach(async () => { await rm(skillsRoot, { recursive: true, force: true }) })

  async function makeSkillDir(id: string, content: string): Promise<string> {
    const d = join(skillsRoot, id)
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'SKILL.md'), content, 'utf8')
    return d
  }

  const fakeResolver = (over: Partial<EffectiveSkillResolver> = {}): EffectiveSkillResolver => ({
    resolveDefault: over.resolveDefault ?? (() => [{ token: 'demo-skill', alternatives: ['demo-skill'] }]),
    resolveExplicitProfile: over.resolveExplicitProfile ?? (() => [{ token: 'demo-skill', alternatives: ['demo-skill'] }]),
    resolveCustom: over.resolveCustom ?? (() => [{ token: 'demo-skill', alternatives: ['demo-skill'] }]),
  })

  const fakeCoordinates = (
    over: Partial<{
      resolution: CapturedExecutionCoordinate['resolution']; workflow: string; track: string
      inputsDigest: string; currentInputsDigest: string; workflowRunId: string
    }> = {},
  ): ExecutionCoordinatePort => {
    const resolution = over.resolution ?? {
      kind: 'default' as const,
      stepId: 'open',
      capability: DEFAULT_COORDINATE_CAPABILITY,
    }
    const workflow = over.workflow ?? 'default'
    const track = over.track ?? 'pm'
    // coordinate_digest 现在真落 skill-bundle-snapshot 记录（codec 用 checkSha256 窄校验），默认值须是
    // 合法 64 位小写十六进制——不能再用 'digest-1' 这类人类可读占位符（那是本字段只做内存态 TOCTOU
    // 比对、不落盘时代的遗留写法）。
    const inputsDigest = over.inputsDigest ?? '1'.repeat(64)
    const currentInputsDigest = over.currentInputsDigest ?? inputsDigest
    return {
      capture: async () => ({ resolution, workflow, track, inputsDigest, workflowRunId: over.workflowRunId }),
      readCurrentInputsDigest: async () => currentInputsDigest,
    }
  }

  // 默认 loop/registry 固定形状 → 真实 registryContentEpoch 可预先算出，供 ctxFor() 默认 policy_epoch
  // 使用（这不是随便填的占位字符串——registryStable 判定要求真实相等，随手写的字面量永远对不上）。
  const DEFAULT_PREP_LOOP = loop({ id: 'lp', skill_bundle_id: '_all' })
  const DEFAULT_PREP_EPOCH = registryContentEpoch(registry([DEFAULT_PREP_LOOP]).data)

  const ctxFor = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
    attempt_id: 'att-1', reservation_id: 'res-1', loop_id: 'lp', change: 'lp-x',
    level: 'L1', runner: 'claude-code', admitted_at: '2026-07-18T00:00:00.000Z',
    reservation: { runs: 1, tokens: 2000, token_basis: 'risk-default' },
    policy_epoch: DEFAULT_PREP_EPOCH, skill_bundle_id: '_all', ...over,
  })

  let idc = 0
  const prepDeps = (over: Partial<ExecutionPreparationDeps> = {}): ExecutionPreparationDeps => {
    idc = 0
    return {
      repoRoot: dir, ledger: createLoopLedgerStore(),
      loadRegistry: () => registry([DEFAULT_PREP_LOOP]),
      clock: () => '2026-07-18T00:01:00.000Z',
      newId: (p) => `${p}-${idc++}`,
      coordinates: fakeCoordinates(),
      resolver: fakeResolver(),
      locator: createFsSkillContentLocator([skillsRoot]),
      ...over,
    }
  }

  it('成功路径（default 轨）：解析→定位→物化→复核→append skill-bundle-snapshot→返回 PreparedExecutionContext', async () => {
    await makeSkillDir('demo-skill', '# demo')
    const preparation = createExecutionPreparation(prepDeps())
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    assertLoopBundle(result.context)
    expect(result.context.skillBundle.snapshotSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.context.skillBundle.resolutionSource).toBe('default')
    expect(result.context.skillBundle.slots).toEqual([
      { token: 'demo-skill', alternatives: ['demo-skill'], concreteSkillId: 'demo-skill', treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
    expect(result.context.skillBundle.casRelativePath).toBe(`.pipeline/loops/skill-snapshots/sha256/${result.context.skillBundle.snapshotSha256}`)
    // 保留 ExecutionContext 原有字段（结构性扩展，不丢字段）。
    expect(result.context.attempt_id).toBe('att-1')
    expect(result.context.skill_bundle_id).toBe('_all')

    // H10 r1 阻断2/4·D4（任务B1）：CAS descriptor / ledger / PreparedExecutionContext.skillBundle
    // 三处 provenance 必须一致——逐字段核对，不只挑几个字段抽查。
    expect(result.context.skillBundle.workflow).toBe('default')
    expect(result.context.skillBundle.step).toBe('open')
    expect(result.context.skillBundle.track).toBe('pm')
    expect(result.context.skillBundle.coordinateDigest).toBe('1'.repeat(64))

    const { records } = await createLoopLedgerStore().read(dir)
    const snap = records.find((r) => r.kind === 'skill-bundle-snapshot')
    expect(snap).toBeDefined()
    if (snap && snap.kind === 'skill-bundle-snapshot') {
      expect(snap.attempt_id).toBe('att-1')
      expect(snap.reservation_id).toBe('res-1')
      expect(snap.loop_id).toBe('lp')
      expect(snap.skill_bundle_id).toBe('_all')
      expect(snap.policy_epoch).toBe(DEFAULT_PREP_EPOCH)
      expect(snap.resolution_source).toBe('default')
      expect(snap.workflow_run_id).toBe('att-1')
      expect(snap.workflow).toBe('default')
      expect(snap.step).toBe('open')
      expect(snap.track).toBe('pm')
      expect(snap.coordinate_digest).toBe('1'.repeat(64))
      expect(snap.snapshot_sha256).toBe(result.context.skillBundle.snapshotSha256)
      expect(snap.cas_relative_path).toBe(result.context.skillBundle.casRelativePath)
      expect(snap.slots).toEqual([{ token: 'demo-skill', alternatives: ['demo-skill'], concrete_skill_id: 'demo-skill', tree_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])

      // CAS canonical descriptor（manifest.json）同一份 provenance——三处必须一致（D4 裁决字面要求）。
      const manifestRaw = await (await import('node:fs/promises')).readFile(
        join(dir, result.context.skillBundle.casRelativePath, 'manifest.json'), 'utf8',
      )
      const manifest = JSON.parse(manifestRaw) as { provenance?: Record<string, unknown> }
      expect(manifest.provenance).toMatchObject({
        loop_id: 'lp', policy_epoch: DEFAULT_PREP_EPOCH, skill_bundle_id: '_all',
        attempt_id: 'att-1', reservation_id: 'res-1', workflow_run_id: 'att-1',
        workflow: 'default', step: 'open', track: 'pm', coordinate_digest: '1'.repeat(64),
        resolution_source: 'default',
      })
    }
  })

  it('坐标口捕获到真 WorkflowRun ID → Prepared context / CAS provenance / ledger 三处都使用它', async () => {
    await makeSkillDir('demo-skill', '# demo')
    const preparation = createExecutionPreparation(prepDeps({ coordinates: fakeCoordinates({ workflowRunId: 'wfr-real-42' }) }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.workflow_run_id).toBe('wfr-real-42')
    const { records } = await createLoopLedgerStore().read(dir)
    const snap = records.find((record) => record.kind === 'skill-bundle-snapshot')
    expect(snap?.kind === 'skill-bundle-snapshot' ? snap.workflow_run_id : undefined).toBe('wfr-real-42')
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(
      join(dir, result.context.preparedKind === 'loop-bundle' ? result.context.skillBundle.casRelativePath : '', 'manifest.json'), 'utf8',
    )) as { provenance?: { workflow_run_id?: string } }
    expect(manifest.provenance?.workflow_run_id).toBe('wfr-real-42')
  })

  it('custom 轨：resolveCustom 被调用（而非 resolveDefault），resolution_source=custom', async () => {
    await makeSkillDir('demo-skill', '# demo')
    let calledDefault = false
    let calledCustom = false
    const resolver = fakeResolver({
      resolveDefault: () => { calledDefault = true; return [{ token: 'demo-skill', alternatives: ['demo-skill'] }] },
      resolveCustom: () => { calledCustom = true; return [{ token: 'demo-skill', alternatives: ['demo-skill'] }] },
    })
    const preparation = createExecutionPreparation(prepDeps({
      resolver, coordinates: fakeCoordinates({
        workflow: 'release-flow',
        resolution: { kind: 'custom', step: { id: 'verify', prompt: 'Run the release-specific browser matrix.' } as unknown as StepIR },
      }),
    }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(true)
    expect(calledCustom).toBe(true)
    expect(calledDefault).toBe(false)
    if (result.ok) {
      assertLoopBundle(result.context)
      expect(result.context.skillBundle.resolutionSource).toBe('custom')
      expect(result.context.skillBundle.workflow).toBe('release-flow')
      expect(result.context.skillBundle.step).toBe('verify')
      expect(result.context.skillBundle.stepPrompt).toBe('Run the release-specific browser matrix.')
    }
  })

  it('alternative 顺序：第一候选缺失、第二候选存在 → 选中第二个（不依赖隐含顺序静默换成第一个）', async () => {
    await makeSkillDir('skill-b', '# b only')
    const resolver = fakeResolver({ resolveExplicitProfile: () => [{ token: 'skill-a|skill-b', alternatives: ['skill-a', 'skill-b'] }] })
    const preparation = createExecutionPreparation(prepDeps({ resolver }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(true)
    if (result.ok) {
      assertLoopBundle(result.context)
      expect(result.context.skillBundle.slots).toEqual([{ token: 'skill-a|skill-b', alternatives: ['skill-a', 'skill-b'], concreteSkillId: 'skill-b', treeSha256: expect.any(String) }])
    }
  })

  it('alternative 首选候选内容损坏 → 立即失败，不悄悄降级到合法的第二候选：skill-bundle-content-invalid', async () => {
    // skill-a 存在但含目录逃逸 symlink（内容非法）；skill-b 完全合法——若发生降级会错误选中 b。
    const dirA = join(skillsRoot, 'skill-a')
    await mkdir(dirA, { recursive: true })
    const outside = join(skillsRoot, '.outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'nope', 'utf8')
    await symlink(join(outside, 'secret.txt'), join(dirA, 'escape.txt'))
    await makeSkillDir('skill-b', '# valid')
    const resolver = fakeResolver({ resolveExplicitProfile: () => [{ token: 'skill-a|skill-b', alternatives: ['skill-a', 'skill-b'] }] })
    const preparation = createExecutionPreparation(prepDeps({ resolver }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-content-invalid')
  })

  it('全部候选都缺失 → skill-bundle-skill-not-found', async () => {
    const resolver = fakeResolver({ resolveExplicitProfile: () => [{ token: 'ghost-a|ghost-b', alternatives: ['ghost-a', 'ghost-b'] }] })
    const preparation = createExecutionPreparation(prepDeps({ resolver }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-skill-not-found')
  })

  it('同一 skill id 在多根内容分歧 → skill-bundle-source-ambiguous', async () => {
    const rootB = await mkdtemp(join(tmpdir(), 'skill-prep-rootb-'))
    try {
      await makeSkillDir('conflicted', '# version A\n')
      await mkdir(join(rootB, 'conflicted'), { recursive: true })
      await writeFile(join(rootB, 'conflicted', 'SKILL.md'), '# version B\n', 'utf8')
      const resolver = fakeResolver({ resolveExplicitProfile: () => [{ token: 'conflicted', alternatives: ['conflicted'] }] })
      const preparation = createExecutionPreparation(prepDeps({ resolver, locator: createFsSkillContentLocator([skillsRoot, rootB]) }))
      const result = await preparation.prepare(ctxFor())
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('skill-bundle-source-ambiguous')
    } finally {
      await rm(rootB, { recursive: true, force: true })
    }
  })

  it('合法空 slots（resolver 返回 []）→ 成功产出确定性空快照，不视为未接线', async () => {
    const resolver = fakeResolver({ resolveExplicitProfile: () => [] })
    const preparation = createExecutionPreparation(prepDeps({ resolver }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(true)
    if (result.ok) {
      assertLoopBundle(result.context)
      expect(result.context.skillBundle.slots).toEqual([])
      expect(result.context.skillBundle.snapshotSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('governance 复核：registry 内容 epoch 与 ctx.policy_epoch 不符（TOCTOU）→ skill-bundle-policy-changed，不追加 skill-bundle-snapshot', async () => {
    await makeSkillDir('demo-skill', '# demo')
    const preparation = createExecutionPreparation(prepDeps())
    const result = await preparation.prepare(ctxFor({ policy_epoch: 'stale-epoch-does-not-match-anything' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-policy-changed')
    const { records } = await createLoopLedgerStore().read(dir)
    expect(records.filter((r) => r.kind === 'skill-bundle-snapshot')).toHaveLength(0)
  })

  it('governance 复核：admission 后 loop 被改成 paused（真实 registry 编辑竞态）→ skill-bundle-policy-changed', async () => {
    await makeSkillDir('demo-skill', '# demo')
    const preparation = createExecutionPreparation(prepDeps({
      loadRegistry: () => registry([loop({ id: 'lp', skill_bundle_id: '_all', status: 'paused' })]),
    }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-policy-changed')
  })

  it('workflow/manifest 输入 digest 复核：准备期间变化 → skill-bundle-policy-changed', async () => {
    await makeSkillDir('demo-skill', '# demo')
    const preparation = createExecutionPreparation(prepDeps({
      coordinates: fakeCoordinates({ inputsDigest: 'digest-at-capture', currentInputsDigest: 'digest-at-recheck-different' }),
    }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-policy-changed')
  })

  it('复制期间源内容持续变化（每次尝试都变，两遍皆不稳定）→ skill-bundle-source-unstable', async () => {
    const dirC = await makeSkillDir('flaky-skill', '# v1')
    let counter = 0
    const resolver = fakeResolver({ resolveExplicitProfile: () => [{ token: 'flaky-skill', alternatives: ['flaky-skill'] }] })
    const preparation = createExecutionPreparation(prepDeps({
      resolver,
      materialize: (inputs, options) => materializeSkillSnapshot(inputs, {
        ...options,
        onAfterBeforeDigest: async () => { counter += 1; await writeFile(join(dirC, 'SKILL.md'), `# v${counter + 1}`, 'utf8') },
      }),
    }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-source-unstable')
  })

  // H10 r1 阻断2/4·D4（任务B1）：provenance 的 slots[].tree_sha256 在调用 materialize() 之前就用
  // buildCanonicalManifest 预读确定（CAS digest 必须完整覆盖 provenance，见
  // snapshot-store.ts::computePublishDigest 头注）；预读值与 materialize() 真正物化后的
  // publish.manifests[i].treeSha256 必须一致，否则本次快照的 provenance 记录已经与实际发布内容不符
  // ——用受控 materialize 注入伪造一个不一致的返回值，直接、确定性地触达这条复核分支（不依赖真实
  // fs 竞态时序）。
  it('materialize() 物化后的 treeSha256 与 provenance 预读值不一致（模拟预读后/物化前窗口的源内容漂移）→ skill-bundle-source-unstable，不用失真 provenance 发布', async () => {
    await makeSkillDir('demo-skill', '# demo')
    const resolver = fakeResolver({ resolveExplicitProfile: () => [{ token: 'demo-skill', alternatives: ['demo-skill'] }] })
    let materializeCalled = false
    const preparation = createExecutionPreparation(prepDeps({
      resolver,
      materialize: async (inputs, options) => {
        materializeCalled = true
        const real = await materializeSkillSnapshot(inputs, options)
        return { ...real, manifests: real.manifests.map((m) => ({ ...m, treeSha256: 'f'.repeat(64) })) }
      },
    }))
    const result = await preparation.prepare(ctxFor())
    expect(materializeCalled).toBe(true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-source-unstable')
  })

  // H10 r1 阻断2/4·D4（任务B1）：provenance（含 attempt_id/reservation_id）现已纳入 CAS 聚合 digest
  // 覆盖——不同 attempt 即便内容相同也会产出不同 digest/不同 CAS 目录（snapshot-store.ts
  // ::computePublishDigest 头注「已知取舍」，D4 裁决明确要求方向）。要让第二次物化命中同一个已被
  // 篡改的既有 CAS 目录，两次 prepare() 必须携带相同的 attempt_id/reservation_id（模拟同一 attempt
  // 内的重试——例如物化成功但进程在追加 ledger 事件前崩溃后的恢复重跑；这是唯一会让两次 prepare()
  // 产出同一 digest 的真实场景，不同 attempt 的重新 admission 天然产出彼此独立的 CAS 目录）。
  it('既有 CAS 目录被篡改（同一 attempt 重试，同源再次物化逐字节校验不一致）→ skill-bundle-snapshot-corrupt', async () => {
    await makeSkillDir('demo-skill', '# demo')
    const deps = prepDeps()
    const first = await createExecutionPreparation(deps).prepare(ctxFor())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    assertLoopBundle(first.context)
    const tamperedPath = join(dir, first.context.skillBundle.casRelativePath, 'skills', 'demo-skill', 'SKILL.md')
    await writeFile(tamperedPath, '# TAMPERED', 'utf8')
    const second = await createExecutionPreparation(deps).prepare(ctxFor())
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('skill-bundle-snapshot-corrupt')
    // 篡改证据未被"顺手修复"——既有目录必须原样保留（同 task4 snapshot-store.test.ts 的既有断言纪律）。
    expect(await (await import('node:fs/promises')).readFile(tamperedPath, 'utf8')).toBe('# TAMPERED')
  })

  it('CAS I/O 故障（注入 materialize 抛 SkillSnapshotIoError）→ skill-bundle-snapshot-io（task4 自身测试也未覆盖真 fs 触发此错误，此处以受控注入代替，仅测本模块的错误归类映射）', async () => {
    await makeSkillDir('demo-skill', '# demo')
    const preparation = createExecutionPreparation(prepDeps({
      materialize: async () => { throw new SkillSnapshotIoError('模拟 CAS 目录创建失败（磁盘满）') },
    }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-snapshot-io')
  })

  // H10 r1 阻断6（任务B1）：coordinate capture 与 resolver 调用此前在结构化异常捕获之外——workflow
  // parse/compile/step/resolver 失败会穿透 prepare() 整体外抛，被 scheduler.ts::handlePreparationThrow
  // 当成未分类基础设施异常处置，不落 skill-bundle-resolve-failed 语义（H10 r1 复审第5节原文）。
  it('workflow 坐标捕获（coordinates.capture）抛错 → 结构化归 skill-bundle-resolve-failed，workflowKind 缺席（尚未拿到 coordinate，无法判定 default/custom）', async () => {
    let resolverCalled = false
    let locatorCalled = false
    const preparation = createExecutionPreparation(prepDeps({
      coordinates: {
        capture: async () => { throw new Error('workflow 文件解析失败：语法错误') },
        readCurrentInputsDigest: async () => 'd',
      },
      resolver: fakeResolver({ resolveDefault: () => { resolverCalled = true; return [] } }),
      locator: { locate: async () => { locatorCalled = true; throw new Error('不应被调用') } },
    }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('skill-bundle-resolve-failed')
      expect(result.detail).toContain('workflow 文件解析失败')
      expect(result.workflowKind).toBeUndefined()
    }
    expect(resolverCalled).toBe(false) // capture 失败后不应继续调 resolver
    expect(locatorCalled).toBe(false)
  })

  it('resolver（resolveExplicitProfile）抛错 → 结构化归 skill-bundle-resolve-failed，workflowKind=default（coordinate 已知，精确传递）', async () => {
    let locatorCalled = false
    const resolver = fakeResolver({ resolveExplicitProfile: () => { throw new Error('manifest 解析失败') } })
    const preparation = createExecutionPreparation(prepDeps({
      resolver,
      locator: { locate: async () => { locatorCalled = true; throw new Error('不应被调用') } },
    }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('skill-bundle-resolve-failed')
      expect(result.detail).toContain('manifest 解析失败')
      expect(result.workflowKind).toBe('default')
    }
    expect(locatorCalled).toBe(false)
  })

  it('resolver（resolveCustom）抛错 → 结构化归 skill-bundle-resolve-failed，workflowKind=custom（只影响本 change，见 scheduler.ts 处置表）', async () => {
    let locatorCalled = false
    const resolver = fakeResolver({ resolveCustom: () => { throw new Error('step.skills 解析失败') } })
    const preparation = createExecutionPreparation(prepDeps({
      resolver,
      coordinates: fakeCoordinates({ resolution: { kind: 'custom', step: { id: 'verify' } as unknown as StepIR } }),
      locator: { locate: async () => { locatorCalled = true; throw new Error('不应被调用') } },
    }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('skill-bundle-resolve-failed')
      expect(result.workflowKind).toBe('custom')
    }
    expect(locatorCalled).toBe(false)
  })

  it('locator 抛出未识别错误类型 → fail-loud 原样重新抛出（不伪装成任何 PreparationFailureReason）', async () => {
    const boom = Object.assign(new Error('unexpected disk gremlin'), { _tag: 'TotallyUnknownError' })
    const resolver = fakeResolver({ resolveExplicitProfile: () => [{ token: 'x', alternatives: ['x'] }] })
    const locator = { locate: async (): Promise<never> => { throw boom } }
    const preparation = createExecutionPreparation(prepDeps({ resolver, locator }))
    await expect(preparation.prepare(ctxFor())).rejects.toBe(boom)
  })

  it('locate() 抛出 SkillContentInvalidError（非路径不安全，模拟内容层面判定）也正确映射（防止只测 symlink 这一种触发路径）', async () => {
    const resolver = fakeResolver({ resolveExplicitProfile: () => [{ token: 'x', alternatives: ['x'] }] })
    const locator = { locate: async (): Promise<never> => { throw new SkillContentInvalidError('内容非法（构造样例）') } }
    const preparation = createExecutionPreparation(prepDeps({ resolver, locator }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-content-invalid')
  })

  it('locator provenance corruption error is mapped to a stable fail-closed preparation reason', async () => {
    const resolver = fakeResolver({ resolveDefault: () => [{ token: 'x', alternatives: ['x'] }] })
    const provenanceError = Object.assign(new Error('[content-hash-mismatch] drift'), {
      _tag: 'SkillProvenanceLocatorError',
      category: 'content-hash-mismatch',
    })
    const preparation = createExecutionPreparation(prepDeps({
      resolver,
      locator: { locate: async (): Promise<never> => { throw provenanceError } },
    }))
    const result = await preparation.prepare(ctxFor())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('skill-bundle-content-invalid')
  })

  // 二次任务（queued 卡死回归修复）+ H10 r1 阻断3/D5 返工（任务B1）：ctx.skill_bundle_id 缺席/null
  // （非 loop 的 AFK 直跑）→ createExecutionPreparation 本身也直通，不只是 sdk.ts 缺省实现的责任——
  // 真实解析/物化/coordinates 全不调用（none-bundle 语境没有 workflow 坐标可捕获），产出判别联合的
  // NonLoopExecutionContext 分支（preparedKind='non-loop'，类型上没有 skillBundle 概念，不是「省略
  // 了字段」的同一形状）。
  it.each([[null], [undefined]] as const)('ctx.skill_bundle_id=%s（none-bundle）→ 直通产出 NonLoopExecutionContext（preparedKind=non-loop），不调 coordinates/resolver/locator/ledger', async (bundleId) => {
    let coordinatesCalled = false
    let resolverCalled = false
    let locatorCalled = false
    const preparation = createExecutionPreparation(prepDeps({
      coordinates: {
        capture: async () => {
          coordinatesCalled = true
          return {
            resolution: { kind: 'default', stepId: 'open', capability: DEFAULT_COORDINATE_CAPABILITY },
            workflow: 'default', track: 'pm', inputsDigest: 'd',
          }
        },
        readCurrentInputsDigest: async () => 'd',
      },
      resolver: fakeResolver({ resolveDefault: () => { resolverCalled = true; return [] } }),
      locator: { locate: async () => { locatorCalled = true; throw new Error('不应被调用') } },
    }))
    const result = await preparation.prepare(ctxFor({ skill_bundle_id: bundleId }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.context.preparedKind).toBe('non-loop')
    expect(coordinatesCalled).toBe(false)
    expect(resolverCalled).toBe(false)
    expect(locatorCalled).toBe(false)
  })
})
