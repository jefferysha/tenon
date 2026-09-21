import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_TRACK_DEFINITIONS,
  compileEffectiveWorkflowPlan,
  createLoopLedgerStore,
  createStateStore,
  createTransitionRecordStore,
  createWorkflowRunRepository,
  latestChangeLoopBinding,
  loadRegistry,
  workflowPlanSnapshot,
  type LoopEntry,
  type TrackPolicyProfile,
  type TrackRegistry,
  type VerificationResult,
} from '@tenon/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOutcome } from '../types.js'
import type { ExecutionContext } from '../admission/execution-context.js'
import {
  createExecutionPreparation,
  createLoopAdmission,
  type ActivateResult,
  type LoopAdmission,
  type LoopAdmissionDeps,
} from '../admission/loop-admission.js'
import { type LifecyclePorts, runChangeInSandbox } from '../lifecycle/lifecycle.js'
import { createFsSkillContentLocator } from '../skills/content-locator.js'
import { materializeSkillSnapshot } from '../skills/snapshot-store.js'
import type { VerifierInput } from '../verifier/verifier.js'
import { createAutomation, storeWriter } from './sdk.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const TEST_VERIFIER_IDENTITY = {
  kind: 'host-verifier', verifier: 'test-verifier', version: '1',
} as const
const AFK_WORKFLOW_PLAN = compileEffectiveWorkflowPlan('sdk-afk', {
  name: 'sdk-afk',
  interaction: { version: 'v1', mode: 'afk' },
  steps: [{
    id: 'run', label: 'Run', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [],
  }],
})
const AFK_WORKFLOW_SNAPSHOT = workflowPlanSnapshot(AFK_WORKFLOW_PLAN)
// 技能由 manifest 叠加解析，本用例的 resolver 存根返回空表：坐标能力也必须不自带步骤技能，
// 否则会去仓库里找一个上游技能文件（它按设计不在版本库里）。
const DEFAULT_COORDINATE_CAPABILITY = compileEffectiveWorkflowPlan('sdk-coordinates', {
  name: 'sdk-coordinates',
  interaction: { version: 'v1', mode: 'afk' },
  steps: [{
    id: 'build', label: 'Build', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [],
  }],
}).capabilities.skills
const AFK_GRANT = { status: 'valid', grants: ['enter-afk'] } as const
const AUTH_TRACK_REGISTRY: TrackRegistry = {
  ordered: BUILTIN_TRACK_DEFINITIONS,
  byId: new Map(BUILTIN_TRACK_DEFINITIONS.map((track) => [track.id, track])),
  revision: '0123456789abcdef',
  source: 'builtin-only',
}

const INELIGIBLE_BACKEND_TRACK_REGISTRY: TrackRegistry = (() => {
  const ordered = BUILTIN_TRACK_DEFINITIONS.map((track) => track.id === 'backend'
    ? {
        ...track,
        policyProfile: { ...track.policyProfile, automationEligible: false },
      }
    : track)
  return {
    ordered,
    byId: new Map(ordered.map((track) => [track.id, track])),
    revision: 'fedcba9876543210',
    source: 'project-file',
  }
})()

const authorizedWorkflowPorts = (
  repoRoot: string,
  store: ReturnType<typeof createStateStore>,
  registry: TrackRegistry = AUTH_TRACK_REGISTRY,
): Pick<
  LoopAdmissionDeps,
  'bindAutomationPolicy' | 'bindWorkflowActionAuthority' |
  'withWorkflowActionAuthorityLock' | 'workflowActionAuthority'
> => {
  const runRepo = createWorkflowRunRepository({
    store,
    recordStore: createTransitionRecordStore(),
    clock: () => '2026-07-07T00:00:00Z',
    newId: () => 'workflow-run-sdk',
  })
  return {
    bindAutomationPolicy: (change, automationPolicy, binding) =>
      runRepo.bindAutomationPolicy(join(repoRoot, 'openspec', 'changes', change), automationPolicy, binding),
    bindWorkflowActionAuthority: (change, snapshot) =>
      runRepo.bindWorkflowActionAuthority(join(repoRoot, 'openspec', 'changes', change), snapshot),
    withWorkflowActionAuthorityLock: async (use) => use(registry),
    workflowActionAuthority: async ({ registry }) => ({
      platform: AFK_GRANT,
      skill: AFK_GRANT,
      project: AFK_GRANT,
      run: AFK_GRANT,
      projectAuthority: {
        version: 'v1', track_id: 'backend', track_registry_revision: registry.revision,
      },
    }),
  }
}

/** H7 verifier Phase 2：trusted passed，SHA 对齐下方 fake runChange 的 buildSha——scheduler 的
 *  verification gate（fail-closed）要求 L3 merged 必须有 trusted+SHA 相符的结构化 verdict，光
 *  「跑成功」不再自动授权合并。 */
const trustedPass = (input: VerifierInput): VerificationResult => ({
  schema_version: 1,
  verification_id: 'ver-sdk-it',
  subject: {
    workflow_run_id: input.workflowRunId,
    attempt_id: input.context.attempt_id,
    change: input.context.change,
    revision: { kind: 'named-branch-head', sha: input.revisionSha },
  },
  binding: input.workflowBinding,
  verdict: 'passed',
  evidence: [{ kind: 'command-result', command_id: 'test', exit_code: 0 }],
  issuer: { ...TEST_VERIFIER_IDENTITY, trusted: true },
  evaluated_at: '2026-07-18T00:00:00.000Z',
})

const passAdmissionContext = (level: 'L1' | 'L2' | 'L3', change = 'x'): ExecutionContext => ({
  attempt_id: 'att', reservation_id: 'res', loop_id: 'lp', change, level,
  runner: 'claude-code', admitted_at: 't',
  reservation: { runs: 1, tokens: 2000, token_basis: 'risk-default' },
})

const h14Loop = (id: string, changePrefix: string): LoopEntry => ({
  id,
  name: id,
  kind: 'executor',
  goal: 'H14 targeted admission race test',
  cadence: 'manual',
  risk: 'low',
  runner: 'codex',
  change_prefix: changePrefix,
  phases: ['implement'],
  human_gates: [],
  state: `.pipeline/loops/${id}.md`,
  design_doc: 'GOAL.md',
  status: 'active',
  budget: { max_runs_per_day: 10, max_in_flight: 1, on_exceed: 'skip-run' },
  kill_criteria: [],
  autonomy_level: 'L1',
  allowlist: [],
  denylist: [],
  skill_bundle_id: '_all',
})

/** 极小放行 admission（隔离 runRound 编排测试，不牵扯真 registry/binding）：总放行、settle no-op。 */
const passAdmission = (level: 'L1' | 'L2' | 'L3' = 'L1'): LoopAdmission => ({
  reserve: async (change): Promise<{ ok: true; context: ExecutionContext }> => ({
    ok: true,
    context: passAdmissionContext(level, change),
  }),
  claimWithFreshWorkflowAuthority: async (ctx, claim) => ({
    ok: true, context: ctx, claimed: await claim('backend'),
  }),
  workflowAuthorityClaim: {
    version: 'v1',
    claim: async (ctx, claim) => ({ ok: true, context: ctx, claimed: await claim('backend') }),
  },
  activate: async (): Promise<ActivateResult> => ({ status: 'activated' }),
  settleWon: async () => {},
  settleLost: async () => {},
  recordMergeIntent: async () => 'sdk-intent-1',
  recordMergeLanded: async () => {},
  isActive: async () => true,
})

/** 本文件的显式 fake admission 是测试信任边界；正常执行样例也必须显式装配 wiring 授权。 */
const trustTestAdmissionWiring = async () => ({ ok: true as const })

/**
 * SDK 对外 API 端到端（真 fs kernel store）：enqueue → scanReady → runRound（注入 fake runChange）。
 * 真读写 .pipeline.yaml automation 字段，断言真实落盘的状态机推进。
 */
describe('createAutomation SDK', () => {
  let root: string
  const store = createStateStore()
  const clock = () => '2026-07-07T00:00:00Z'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'afk-sdk-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  const initBuild = async (name: string) => {
    const dir = await store.init({
      repoRoot: root, name, track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock,
    })
    await store.set(dir, 'phase', 'build')
    return dir
  }

  const policy = (automationEligible: boolean): TrackPolicyProfile => ({
    reviewSeed: 'pending',
    automationEligible,
    coverageProfile: 'none',
    routing: { enabled: false },
    skills: { matrix: false, profile: '_all' },
  })
  const eligiblePolicy = (_trackId: string): TrackPolicyProfile => policy(true)

  const seedDefaultAdmissionLoop = async (changePrefix: string): Promise<void> => {
    await mkdir(join(root, '.pipeline'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'loops.yaml'), `version: 1
loops:
  - id: sdk-default
    name: sdk-default
    kind: executor
    goal: SDK default admission test
    cadence: continuous
    risk: low
    runner: codex
    change_prefix: ${changePrefix}
    phases:
      - implement
      - verify
    human_gates:
      - before-merge
    design_doc: GOAL.md
    status: active
    budget:
      max_runs_per_day: 10
      max_in_flight: 1
      on_exceed: skip-run
    kill_criteria:
      - stop-on-policy-change
    autonomy_level: L1
    allowlist: []
    denylist: []
    skill_bundle_id: _all
`, 'utf8')
  }

  const createEmptyBundlePreparation = () => createExecutionPreparation({
    repoRoot: root,
    ledger: createLoopLedgerStore(),
    loadRegistry,
    clock,
    coordinates: {
      capture: async (context) => ({
        resolution: { kind: 'default' as const, stepId: 'build', capability: DEFAULT_COORDINATE_CAPABILITY },
        workflow: AFK_WORKFLOW_PLAN.id,
        track: 'backend',
        inputsDigest: 'f'.repeat(64),
        workflowRunId: context.workflow_run_id,
      }),
      readCurrentInputsDigest: async () => 'f'.repeat(64),
    },
    resolver: {
      resolveDefaultMandatory: () => [],
      resolveDefault: () => [],
      resolveDefaultProfile: () => [],
      resolveCustom: () => [],
    },
    locator: {
      locate: createFsSkillContentLocator([join(process.cwd(), 'skills')]).locate,
    },
    materialize: materializeSkillSnapshot,
  })

  it('enqueue 按调用者解析的 effective policy 判定，动态 track id 本身不参与能力判断', async () => {
    const blocked = await store.init({
      repoRoot: root, name: 'blocked', track: 'data-no-auto', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock,
    })
    const allowed = await store.init({
      repoRoot: root, name: 'allowed', track: 'data-auto', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock,
    })
    await store.setMany(blocked, { phase: 'build', automation: 'queued' })
    await store.set(allowed, 'phase', 'build')
    const afk = createAutomation({ repoRoot: root, store, clock, config: { level: 'L1' } })
    const resolvePolicy = (trackId: string): TrackPolicyProfile =>
      trackId === 'data-no-auto' ? policy(false) : policy(true)

    expect([
      await afk.enqueue('blocked', resolvePolicy),
      await afk.enqueue('allowed', resolvePolicy),
    ]).toEqual([false, true])
  })

  it('enqueue：off → queued + 落 queued_at（真字段）', async () => {
    const dir = await initBuild('x')
    const afk = createAutomation({ repoRoot: root, store, clock, config: { level: 'L1' } })
    expect(await afk.enqueue('x', eligiblePolicy)).toBe(true)
    expect(await store.get(dir, 'automation')).toBe('queued')
    expect(await store.get(dir, 'automation_queued_at')).toBe('2026-07-07T00:00:00Z')
  })

  it('scanReady：真扫出 build+queued 就绪 change', async () => {
    await initBuild('x')
    const afk = createAutomation({ repoRoot: root, store, clock, config: { level: 'L1' } })
    await afk.enqueue('x', eligiblePolicy)
    expect(await afk.scanReady()).toEqual(['x'])
  })

  it('default admission omits Workflow authority ports fail-closed with a structured denial and zero run', async () => {
    const dir = await initBuild('sdk-missing-ports')
    await seedDefaultAdmissionLoop('sdk-')
    const runChange = vi.fn(async (): Promise<RunOutcome> => ({
      commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass',
    }))
    const afk = createAutomation({ repoRoot: root, store, clock, config: { level: 'L1' } })
    await afk.enqueue('sdk-missing-ports', eligiblePolicy)

    const report = await afk.runRound(runChange)

    expect(report).toMatchObject({ candidates: 1, admitted: 0, ok: true })
    expect(report.entries).toContainEqual({
      change: 'sdk-missing-ports',
      loopId: 'sdk-default',
      disposition: 'denied',
      reason: 'workflow-action-hard-blocked',
    })
    expect(runChange).not.toHaveBeenCalled()
    expect(await store.get(dir, 'automation')).toBe('queued')
  })

  it('default admission surfaces Workflow authority provider failures as a failed round with zero charge', async () => {
    const dir = await initBuild('sdk-authority-read-error')
    await seedDefaultAdmissionLoop('sdk-')
    const runChange = vi.fn(async (): Promise<RunOutcome> => ({
      commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass',
    }))
    const {
      bindAutomationPolicy,
      bindWorkflowActionAuthority,
      withWorkflowActionAuthorityLock,
    } = authorizedWorkflowPorts(root, store)
    const afk = createAutomation({
      repoRoot: root,
      store,
      clock,
      config: { level: 'L1' },
      bindAutomationPolicy,
      bindWorkflowActionAuthority,
      withWorkflowActionAuthorityLock,
      workflowActionAuthority: async () => { throw new Error('authority read EIO') },
    })
    await afk.enqueue('sdk-authority-read-error', eligiblePolicy)

    const report = await afk.runRound(runChange)

    expect(report).toMatchObject({ candidates: 1, admitted: 0, ok: false })
    expect(report.failures).toContainEqual(expect.objectContaining({
      change: 'sdk-authority-read-error',
      phase: 'admission',
      kind: 'state-io',
      message: expect.stringContaining('authority read EIO'),
    }))
    expect(runChange).not.toHaveBeenCalled()
    expect(await store.get(dir, 'automation')).toBe('queued')
    const window = await createLoopLedgerStore().readRunWindow(root, { limit: 10 })
    expect(window.openReservations).toHaveLength(0)
    expect(window.runs).toContainEqual(expect.objectContaining({
      change: 'sdk-authority-read-error',
      result: 'failed',
      reason: 'infrastructure-error',
      accounting: expect.objectContaining({ charged_tokens: 0, charge_source: 'none' }),
      error: expect.objectContaining({
        cause: 'workflow-action-authority-failed',
        message: expect.stringContaining('authority read EIO'),
      }),
    }))
  })

  it('default admission forwards explicit Workflow authority ports and runs after explicit bundle preparation', async () => {
    const dir = await store.init({
      repoRoot: root,
      name: 'sdk-authorized',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      clock,
      runId: 'workflow-run-sdk',
      initialWorkflow: {
        workflow: AFK_WORKFLOW_PLAN.id,
        phase: 'build',
        workflowPlanFingerprint: AFK_WORKFLOW_PLAN.workflowFingerprint,
        workflowPlanSnapshot: AFK_WORKFLOW_SNAPSHOT,
      },
    })
    await seedDefaultAdmissionLoop('sdk-')
    const runChange = vi.fn(async (): Promise<RunOutcome> => ({
      commits: [{ sha: SHA }], verifyResult: 'pass', buildSha: SHA, phaseEvent: 'verify-pass',
    }))
    const afk = createAutomation({
      repoRoot: root,
      store,
      clock,
      config: { level: 'L1' },
      ...authorizedWorkflowPorts(root, store),
      preparation: createEmptyBundlePreparation(),
      validateExecutionWiring: trustTestAdmissionWiring,
      interactionReceipts: { verifiedReceiptsFor: async () => [] },
    })
    await afk.enqueue('sdk-authorized', eligiblePolicy)

    const report = await afk.runRound(runChange)
    expect(report).toMatchObject({ candidates: 1, admitted: 1, ok: true })
    expect(runChange).toHaveBeenCalledOnce()
    expect(await store.get(dir, 'automation')).toBe('paused')
  })

  it('default admission derives project authority from the locked registry and rejects an ineligible track despite provider allow', async () => {
    const dir = await store.init({
      repoRoot: root,
      name: 'sdk-ineligible-canonical-track',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      clock,
      runId: 'workflow-run-sdk',
      initialWorkflow: {
        workflow: AFK_WORKFLOW_PLAN.id,
        phase: 'build',
        workflowPlanFingerprint: AFK_WORKFLOW_PLAN.workflowFingerprint,
        workflowPlanSnapshot: AFK_WORKFLOW_SNAPSHOT,
      },
    })
    await seedDefaultAdmissionLoop('sdk-')
    const runChange = vi.fn(async (): Promise<RunOutcome> => ({
      commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass',
    }))
    const afk = createAutomation({
      repoRoot: root,
      store,
      clock,
      config: { level: 'L1' },
      ...authorizedWorkflowPorts(root, store, INELIGIBLE_BACKEND_TRACK_REGISTRY),
      preparation: createEmptyBundlePreparation(),
      validateExecutionWiring: trustTestAdmissionWiring,
    })
    await afk.enqueue('sdk-ineligible-canonical-track', eligiblePolicy)

    const report = await afk.runRound(runChange)

    expect(report).toMatchObject({ candidates: 1, admitted: 0, ok: true })
    expect(report.entries).toContainEqual(expect.objectContaining({
      change: 'sdk-ineligible-canonical-track',
      disposition: 'denied',
      reason: 'workflow-action-denied',
    }))
    expect(runChange).not.toHaveBeenCalled()
    expect(await store.get(dir, 'automation')).toBe('queued')
    const window = await createLoopLedgerStore().readRunWindow(root, { limit: 10 })
    expect(window.openReservations).toHaveLength(0)
    expect(window.runs).toContainEqual(expect.objectContaining({
      change: 'sdk-ineligible-canonical-track',
      result: 'skipped',
      reason: 'admission-denied',
      accounting: expect.objectContaining({ charged_tokens: 0, charge_source: 'none' }),
    }))
  })

  it('default admission keeps bundle-bound execution blocked without explicit preparation', async () => {
    const dir = await store.init({
      repoRoot: root,
      name: 'sdk-no-preparation',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      clock,
      runId: 'workflow-run-sdk',
      initialWorkflow: {
        workflow: AFK_WORKFLOW_PLAN.id,
        phase: 'build',
        workflowPlanFingerprint: AFK_WORKFLOW_PLAN.workflowFingerprint,
        workflowPlanSnapshot: AFK_WORKFLOW_SNAPSHOT,
      },
    })
    await seedDefaultAdmissionLoop('sdk-')
    const runChange = vi.fn(async (): Promise<RunOutcome> => ({
      commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass',
    }))
    const afk = createAutomation({
      repoRoot: root,
      store,
      clock,
      config: { level: 'L1' },
      ...authorizedWorkflowPorts(root, store),
      validateExecutionWiring: trustTestAdmissionWiring,
    })
    await afk.enqueue('sdk-no-preparation', eligiblePolicy)

    const report = await afk.runRound(runChange)

    expect(report).toMatchObject({ candidates: 1, admitted: 1, ok: false })
    expect(report.failures).toContainEqual(expect.objectContaining({
      change: 'sdk-no-preparation', phase: 'preparation', kind: 'config',
    }))
    expect(runChange).not.toHaveBeenCalled()
    expect(await store.get(dir, 'automation')).toBe('queued')
  })

  it('H11：SDK 把 execution wiring validator 真路由到 scheduler，invalid 时零 runChange', async () => {
    const dir = await initBuild('x')
    const settledLost: string[] = []
    const paused: string[] = []
    const validateExecutionWiring = vi.fn(async () => ({
      ok: false as const, status: 'invalid' as const, dimension: 'workflow' as const,
      reason: 'workflow missing',
    }))
    const admission: LoopAdmission = {
      ...passAdmission('L1'),
      settleLost: async (ctx) => { settledLost.push(ctx.change) },
    }
    const afk = createAutomation({
      repoRoot: root,
      store,
      clock,
      admission,
      validateExecutionWiring,
      pauseLoop: async (loopId) => { paused.push(loopId) },
      config: { level: 'L1' },
    })
    await afk.enqueue('x', eligiblePolicy)
    let ran = false

    const report = await afk.runRound(async () => {
      ran = true
      return { commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass' }
    })

    expect(report.ok).toBe(false)
    expect(validateExecutionWiring).toHaveBeenCalledOnce()
    expect(settledLost).toEqual(['x'])
    expect(paused).toEqual(['lp'])
    expect(ran).toBe(false)
    expect(await store.get(dir, 'automation')).toBe('queued')
  })

  it('H11 r4：公开 SDK 对伪造 null bundle 的 loop context 缺 execution wiring validator 时仍 fail-closed，claim/preparation/run 全为 0', async () => {
    const dir = await initBuild('x')
    const settledLost: string[] = []
    const admission: LoopAdmission = {
      ...passAdmission('L1'),
      reserve: async (change): Promise<{ ok: true; context: ExecutionContext }> => ({
        ok: true,
        context: {
          ...passAdmissionContext('L1', change),
          runner: 'cron',
          policy_epoch: 'epoch-real-loop',
          // 恶意/错误 admission 试图用 null 把具名 cron loop 冒充成 non-loop。
          skill_bundle_id: null,
        },
      }),
      settleLost: async (ctx) => { settledLost.push(ctx.change) },
    }
    const preparation = { prepare: vi.fn(async () => { throw new Error('preparation must not run') }) }
    const runChange = vi.fn(async (): Promise<RunOutcome> => ({
      commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass',
    }))
    const afk = createAutomation({
      repoRoot: root,
      store,
      clock,
      admission,
      preparation,
      config: { level: 'L1' },
      // 刻意不注入 validateExecutionWiring：被测的是公开 SDK 的 fail-closed 缺省。
    })
    await afk.enqueue('x', eligiblePolicy)
    const claimCas = vi.spyOn(store, 'cas')

    const report = await afk.runRound(runChange)

    expect(report.ok).toBe(false)
    expect(report.failures).toContainEqual(expect.objectContaining({ phase: 'admission', kind: 'config' }))
    expect(settledLost).toEqual(['x'])
    expect(claimCas).not.toHaveBeenCalled()
    expect(preparation.prepare).not.toHaveBeenCalled()
    expect(runChange).not.toHaveBeenCalled()
    expect(await store.get(dir, 'automation')).toBe('queued')
  })

  it('H14 runTargeted：fresh ready FIFO 与目标取交集，expected owner 真透传；未选 ready 零副作用', async () => {
    const earlyDir = await initBuild('early')
    const skippedDir = await initBuild('skipped')
    const lateDir = await initBuild('late')
    const reserveCalls: { change: string; expectedLoopId?: string; expectedAutonomyLevel?: string | null }[] = []
    const admission: LoopAdmission = {
      ...passAdmission('L1'),
      reserve: async (change, opts): Promise<{ ok: true; context: ExecutionContext }> => {
        reserveCalls.push({ change, expectedLoopId: opts?.expectedLoopId, expectedAutonomyLevel: opts?.expectedAutonomyLevel })
        return {
          ok: true,
          context: { ...passAdmissionContext('L1', change), loop_id: opts?.expectedLoopId ?? 'natural-loop' },
        }
      },
    }
    const afk = createAutomation({
      repoRoot: root, store, clock, admission,
      config: { level: 'L1', maxParallel: 1 },
      validateExecutionWiring: trustTestAdmissionWiring,
    })
    await afk.enqueue('early', eligiblePolicy)
    await afk.enqueue('skipped', eligiblePolicy)
    await afk.enqueue('late', eligiblePolicy)
    await store.set(earlyDir, 'automation_queued_at', '2026-07-07T00:00:01Z')
    await store.set(skippedDir, 'automation_queued_at', '2026-07-07T00:00:02Z')
    await store.set(lateDir, 'automation_queued_at', '2026-07-07T00:00:03Z')
    const skippedAttemptsBefore = await store.get(skippedDir, 'automation_attempts')

    const ran: { change: string; loopId: string }[] = []
    const report = await afk.runTargeted([
      { change: 'late', expectedLoopId: 'loop-late', expectedAutonomyLevel: 'L1' },
      { change: 'early', expectedLoopId: 'loop-early', expectedAutonomyLevel: 'L1' },
      { change: 'not-ready', expectedLoopId: 'loop-ignored', expectedAutonomyLevel: 'L1' },
    ], async (ctx) => {
      ran.push({ change: ctx.change, loopId: ctx.loop_id })
      return { commits: [{ sha: SHA }], verifyResult: 'pass', buildSha: SHA, phaseEvent: 'verify-pass' }
    })

    expect(report.candidates).toBe(2)
    expect(reserveCalls).toEqual([
      { change: 'early', expectedLoopId: 'loop-early', expectedAutonomyLevel: 'L1' },
      { change: 'late', expectedLoopId: 'loop-late', expectedAutonomyLevel: 'L1' },
    ])
    expect(ran).toEqual([
      { change: 'early', loopId: 'loop-early' },
      { change: 'late', loopId: 'loop-late' },
    ])
    expect(await store.get(earlyDir, 'automation')).toBe('paused')
    expect(await store.get(lateDir, 'automation')).toBe('paused')
    expect(await store.get(skippedDir, 'automation')).toBe('queued')
    expect(await store.get(skippedDir, 'automation_attempts')).toBe(skippedAttemptsBefore)
  })

  it('H14 r1 P1-1 真实交错：selector 得到 A 后追加 durable B → A 不 claim、不启动、零 reservation', async () => {
    const change = 'job-x'
    const changeStateDir = await initBuild(change)
    const ledger = createLoopLedgerStore()
    await ledger.append(root, {
      schema_version: 1,
      record_id: 'binding-a',
      recorded_at: '2026-07-19T01:00:00.000Z',
      kind: 'change-loop-binding',
      change,
      loop_id: 'loop-a',
      source: 'explicit',
    })
    const selectorRead = await ledger.read(root)
    const selectedBinding = latestChangeLoopBinding(selectorRead.records, change)
    if (selectedBinding === undefined) throw new Error('selector fixture 缺 binding A')
    const selectorTarget = { change, expectedLoopId: selectedBinding.loop_id, expectedAutonomyLevel: 'L1' as const }

    // selector 返回后、reserve 前，另一进程把 durable owner 改为 B。
    await ledger.append(root, {
      schema_version: 1,
      record_id: 'binding-b',
      recorded_at: '2026-07-19T01:00:01.000Z',
      kind: 'change-loop-binding',
      change,
      loop_id: 'loop-b',
      source: 'explicit',
    })
    const loops = [h14Loop('loop-a', 'job-'), h14Loop('loop-b', 'other-')]
    const admission = createLoopAdmission({
      repoRoot: root,
      ledger,
      loadRegistry: () => ({ data: { version: 1, loops }, errors: [] }),
      clock,
      level: 'L1',
      getAutomation: async () => store.get(changeStateDir, 'automation'),
    })
    const afk = createAutomation({
      repoRoot: root,
      store,
      clock,
      config: { level: 'L1', maxParallel: 1 },
      admission,
    })
    await afk.enqueue(change, eligiblePolicy)
    const attemptsBefore = await store.get(changeStateDir, 'automation_attempts')
    let ran = false

    const report = await afk.runTargeted([selectorTarget], async () => {
      ran = true
      return { commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass' }
    })

    expect(report).toMatchObject({ candidates: 1, admitted: 0, ok: true })
    expect(report.entries).toContainEqual({
      change,
      loopId: 'loop-b',
      disposition: 'denied',
      reason: 'binding-changed',
    })
    expect(ran).toBe(false)
    expect(await store.get(changeStateDir, 'automation')).toBe('queued')
    expect(await store.get(changeStateDir, 'automation_attempts')).toBe(attemptsBefore)
    const after = await ledger.read(root)
    expect(after.records.filter((record) => record.kind === 'budget-reservation')).toHaveLength(0)
    expect(after.records.filter((record) => record.kind === 'reservation-activated')).toHaveLength(0)
  })

  it('H14 r2 P1-1 真实交错：selector 读到 L3 后 owner 未变但 registry 降为 L1 → 不 claim/不启动/零 reservation', async () => {
    const change = 'job-level'
    const changeStateDir = await initBuild(change)
    const ledger = createLoopLedgerStore()
    // selector 快照：同一个 owner 当时是 L3；随后治理面降到 L1，target 保留 selector 观察值。
    const selectorTarget = {
      change,
      expectedLoopId: 'loop-a',
      expectedAutonomyLevel: 'L3' as const,
    }
    const admission = createLoopAdmission({
      repoRoot: root,
      ledger,
      loadRegistry: () => ({
        data: { version: 1, loops: [h14Loop('loop-a', 'job-')] },
        errors: [],
      }),
      clock,
      level: 'L3',
      getAutomation: async () => store.get(changeStateDir, 'automation'),
    })
    const afk = createAutomation({
      repoRoot: root,
      store,
      clock,
      config: { level: 'L3', maxParallel: 1 },
      admission,
    })
    await afk.enqueue(change, eligiblePolicy)
    const attemptsBefore = await store.get(changeStateDir, 'automation_attempts')
    let ran = false

    const report = await afk.runTargeted([selectorTarget], async () => {
      ran = true
      return { commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass' }
    })

    expect(report).toMatchObject({ candidates: 1, admitted: 0, ok: true })
    expect(report.entries).toContainEqual({
      change,
      loopId: 'loop-a',
      disposition: 'denied',
      reason: 'policy-changed',
    })
    expect(ran).toBe(false)
    expect(await store.get(changeStateDir, 'automation')).toBe('queued')
    expect(await store.get(changeStateDir, 'automation_attempts')).toBe(attemptsBefore)
    const after = await ledger.read(root)
    expect(after.records.filter((record) => record.kind === 'budget-reservation')).toHaveLength(0)
    expect(after.records.filter((record) => record.kind === 'reservation-activated')).toHaveLength(0)
  })

  it('H14 runTargeted：同一 change 被绑定到不同 loop → 整轮 fail-loud，零 reserve/claim/run 副作用', async () => {
    const dir = await initBuild('x')
    let reserveCalls = 0
    let ran = false
    const admission: LoopAdmission = {
      ...passAdmission('L1'),
      reserve: async (change, opts): Promise<{ ok: true; context: ExecutionContext }> => {
        reserveCalls++
        return {
          ok: true,
          context: { ...passAdmissionContext('L1', change), loop_id: opts?.expectedLoopId ?? 'natural-loop' },
        }
      },
    }
    const afk = createAutomation({ repoRoot: root, store, clock, config: { level: 'L1' }, admission })
    await afk.enqueue('x', eligiblePolicy)

    await expect(afk.runTargeted([
      { change: 'x', expectedLoopId: 'loop-a', expectedAutonomyLevel: 'L1' },
      { change: 'x', expectedLoopId: 'loop-b', expectedAutonomyLevel: 'L1' },
    ], async () => {
      ran = true
      return { commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass' }
    })).rejects.toThrow('同一 change「x」不能同时声明不同 expected loop')

    expect(reserveCalls).toBe(0)
    expect(ran).toBe(false)
    expect(await store.get(dir, 'automation')).toBe('queued')
  })

  it('H14 runTargeted：零目标 → 返回空成功报告，ready change 保持 queued 且零副作用', async () => {
    const dir = await initBuild('x')
    let reserveCalls = 0
    let ran = false
    const admission: LoopAdmission = {
      ...passAdmission('L1'),
      reserve: async (change): Promise<{ ok: true; context: ExecutionContext }> => {
        reserveCalls++
        return { ok: true, context: passAdmissionContext('L1', change) }
      },
    }
    const afk = createAutomation({ repoRoot: root, store, clock, config: { level: 'L1' }, admission })
    await afk.enqueue('x', eligiblePolicy)

    const report = await afk.runTargeted([], async () => {
      ran = true
      return { commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass' }
    })

    expect(report).toMatchObject({ candidates: 0, admitted: 0, ok: true })
    expect(report.entries).toHaveLength(0)
    expect(reserveCalls).toBe(0)
    expect(ran).toBe(false)
    expect(await store.get(dir, 'automation')).toBe('queued')
  })

  it('runRound L1：真 claim + 跑（fake runChange）→ 落盘 paused（report-only 不自动 merge）', async () => {
    const dir = await initBuild('x')
    const afk = createAutomation({
      repoRoot: root, store, clock, config: { level: 'L1' }, admission: passAdmission('L1'),
      validateExecutionWiring: trustTestAdmissionWiring,
    })
    await afk.enqueue('x', eligiblePolicy)
    const runChange = async (): Promise<RunOutcome> => ({
      commits: [{ sha: 'a'.repeat(40) }],
      verifyResult: 'pass',
      buildSha: 'a'.repeat(40),
      phaseEvent: 'verify-pass',
    })
    const report = await afk.runRound(runChange)
    expect(await store.get(dir, 'automation')).toBe('paused') // L1 默认安全：不 merged
    expect(report.ok).toBe(true)
    expect(report.admitted).toBe(1)
  })

  it('runRound L3：成功 + trusted verification（SHA 符）→ 真落盘 merged', async () => {
    const dir = await initBuild('x')
    const afk = createAutomation({
      repoRoot: root, store, clock, config: { level: 'L3' }, admission: passAdmission('L3'),
      validateExecutionWiring: trustTestAdmissionWiring,
    })
    await afk.enqueue('x', eligiblePolicy)
    const mergeEvents: string[] = []
    const ports: LifecyclePorts = {
      worktree: {
        async create(_repoDir, branch) { return { path: `/wt/${branch}`, branch } },
        async remove() {},
        async hasCancelMarker() { return false },
      },
      async createSandbox(opts) {
        return {
          env: opts.env,
          containerName: 'sdk-integration',
          async exec() { return { stdout: '', stderr: '', exitCode: 0 } },
          async close() {},
        }
      },
      async runWork() { return { verify_result: 'pass', build_sha: SHA, phase_event: 'verify-pass' } },
      async collectCommits() { return [{ sha: SHA }] },
      async diffNames() { return [] },
      async mergeToBase(input) {
        mergeEvents.push('merge:start')
        await input.onIntent?.({
          baseRef: `refs/heads/${input.base}`,
          baseBefore: input.expectedBaseSha,
          branchRef: `refs/heads/${input.branch}`,
          branchTip: input.expectedBranchSha,
          mergedCommit: SHA,
        })
        mergeEvents.push('base-ref:updated')
        const receipt = {
          landed: true as const, hostSynced: true, mergedCommit: SHA,
          baseBefore: input.expectedBaseSha, branchTip: input.expectedBranchSha,
        }
        await input.onLanded?.(receipt)
        return receipt
      },
      git: { async revParse(ref) { return ref === 'main' ? BASE_SHA : SHA } },
      async setStateField() {},
      verifier: { async verify(input) { return trustedPass(input) } },
      verifierExpectedIssuerIdentity: TEST_VERIFIER_IDENTITY,
    }
    const report = await afk.runRound((context, signal) => runChangeInSandbox(ports, {
      hostRepoDir: root,
      name: 'x',
      base: 'main',
      autoMerge: true, allowlist: ['**'],
      context,
      requireMergeJournal: true,
      mergeJournal: {
        async recordMergeIntent() {
          mergeEvents.push('journal:intent')
          return 'sdk-intent-1'
        },
        async recordMergeLanded() { mergeEvents.push('journal:landed') },
      },
    }, signal))
    expect(mergeEvents).toEqual(['merge:start', 'journal:intent', 'base-ref:updated', 'journal:landed'])
    expect(report.ok).toBe(true)
    expect(await store.get(dir, 'automation')).toBe('merged')
  })

  it('runRound L3：成功但 verification 缺席（H7 fail-closed）→ 落盘 paused，不再仅凭「跑成功」自动合并', async () => {
    const dir = await initBuild('x')
    const afk = createAutomation({
      repoRoot: root, store, clock, config: { level: 'L3' }, admission: passAdmission('L3'),
      validateExecutionWiring: trustTestAdmissionWiring,
    })
    await afk.enqueue('x', eligiblePolicy)
    await afk.runRound(async () => ({
      commits: [{ sha: SHA }],
      verifyResult: 'pass',
      buildSha: SHA,
      phaseEvent: 'verify-pass',
    }))
    expect(await store.get(dir, 'automation')).toBe('paused')
    expect(await store.get(dir, 'automation_cause')).toBe('verification-missing')
  })

  // ── 二次任务（queued 卡死回归修复）：SchedulerDeps.preparation 路由 + createDefaultExecutionPreparation ──
  it('runRound：deps.preparation 未注入 + ctx.skill_bundle_id 缺席（none-bundle）→ 缺省 preparation 直通，round 正常推进（不再整轮短路）', async () => {
    const dir = await initBuild('x')
    // passAdmission('L1') 产出的 ExecutionContext 本就不带 skill_bundle_id（见文件顶部 passAdmission
    // 定义——本次执行无 bundle 绑定的诚实 fake）；本用例不覆盖 deps.preparation，走 createAutomation
    // 的缺省 createDefaultExecutionPreparation()，验证它对 none-bundle context 直通而非整轮短路。
    const afk = createAutomation({
      repoRoot: root, store, clock, config: { level: 'L1' }, admission: passAdmission('L1'),
      validateExecutionWiring: trustTestAdmissionWiring,
    })
    await afk.enqueue('x', eligiblePolicy)
    let seenSkillBundle: unknown = 'unset'
    const report = await afk.runRound(async (ctx) => {
      // H10 r1 阻断3/D5 返工（任务B1）：ctx 现是判别联合，读 skillBundle 前必须先判别 preparedKind。
      seenSkillBundle = ctx.preparedKind === 'loop-bundle' ? ctx.skillBundle : undefined
      return { commits: [{ sha: SHA }], verifyResult: 'pass', buildSha: SHA, phaseEvent: 'verify-pass' }
    })
    expect(report.ok).toBe(true)
    expect(report.admitted).toBe(1)
    expect(seenSkillBundle).toBeUndefined() // none-bundle 直通：产出 NonLoopExecutionContext，没有 skillBundle 概念
    expect(await store.get(dir, 'automation')).toBe('paused') // L1 默认安全：不 merged（证明 round 真跑到底，非短路假过）
  })

  it('runRound：admission 产出 bundle 绑定 context（skill_bundle_id 有值）+ deps.preparation 未注入 → 缺省 preparation fail-loud（config 类 round failure），绝不放行也绝不伪造业务判定', async () => {
    const dir = await initBuild('x')
    const boundAdmission: LoopAdmission = {
      ...passAdmission('L1'),
      reserve: async (change): Promise<{ ok: true; context: ExecutionContext }> => ({
        ok: true,
        context: {
          attempt_id: 'att', reservation_id: 'res', loop_id: 'lp', change, level: 'L1', runner: 'claude-code',
          admitted_at: 't', reservation: { runs: 1, tokens: 2000, token_basis: 'risk-default' },
          policy_epoch: 'epoch-1', skill_bundle_id: '_all', // bundle 绑定：真实 loop 走 reserve() 产出的形状
        },
      }),
    }
    const afk = createAutomation({
      repoRoot: root,
      store,
      clock,
      config: { level: 'L1' },
      admission: boundAdmission,
      // 本用例只隔离“缺 preparation”边界；显式放行前一阶段的 H11 wiring validator。
      validateExecutionWiring: async () => ({ ok: true }),
    })
    await afk.enqueue('x', eligiblePolicy)
    let ran = false
    const report = await afk.runRound(async () => { ran = true; return { commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass' } })
    expect(ran).toBe(false) // fail-loud 发生在 preparation 阶段——runChange 绝不会被调用
    expect(report.ok).toBe(false)
    expect(report.failures[0]).toMatchObject({ phase: 'preparation', kind: 'config' })
    expect(await store.get(dir, 'automation')).toBe('queued') // 复位 queued（留给下轮；不误判成业务 denial 持久化）
  })

  it('enabled=false（fail-safe OFF）：enqueue 拒绝（退回纯人工是安全的）', async () => {
    await initBuild('x')
    const afk = createAutomation({ repoRoot: root, store, clock, config: { level: 'L1', enabled: false } })
    expect(await afk.enqueue('x', eligiblePolicy)).toBe(false)
  })

  // ── T21：.pipeline/automation.json 装配（优先级 显式 deps.config > 文件 > DEFAULT）──
  const seedJson = async (obj: unknown) => {
    await mkdir(join(root, '.pipeline'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'automation.json'), JSON.stringify(obj, null, 2), 'utf8')
  }

  it('automation.json 的 max_parallel/max_retries/default_opt_in 真进生效配置（不是假开关）', async () => {
    await seedJson({ version: 1, max_parallel: 2, max_retries: 3, default_opt_in: false })
    const afk = createAutomation({ repoRoot: root, store, clock })
    expect(afk.config.maxParallel).toBe(2)
    expect(afk.config.maxRetries).toBe(3)
    expect(afk.config.defaultOptIn).toBe(false)
  })

  it('文件 default_opt_in=false 覆盖 SDK 内置 true：未显式预置 queued 的 change enqueue 拒绝', async () => {
    await initBuild('x')
    await seedJson({ version: 1, default_opt_in: false })
    const afk = createAutomation({ repoRoot: root, store, clock, config: { level: 'L1' } })
    expect(await afk.enqueue('x', eligiblePolicy)).toBe(false)
  })

  it('显式 deps.config 优先于 automation.json（文件说 2 并发，调用方显式给 6 → 6）', async () => {
    await seedJson({ version: 1, max_parallel: 2 })
    const afk = createAutomation({ repoRoot: root, store, clock, config: { maxParallel: 6 } })
    expect(afk.config.maxParallel).toBe(6)
  })

  it('损坏 automation.json → fail-open 全默认（SDK 内置 enabled/defaultOptIn 仍为 true）', async () => {
    await mkdir(join(root, '.pipeline'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'automation.json'), '{{{broken', 'utf8')
    const afk = createAutomation({ repoRoot: root, store, clock })
    expect(afk.config.maxParallel).toBe(4)
    expect(afk.config.maxRetries).toBe(1)
    expect(afk.config.defaultOptIn).toBe(true)
    expect(afk.config.enabled).toBe(true)
  })

  it('项目文件 enabled 是总开关，level 仍由 loop registry 独占', async () => {
    await seedJson({ version: 1, enabled: false, level: 'L3', max_parallel: 5 })
    const afk = createAutomation({ repoRoot: root, store, clock })
    expect(afk.config.enabled).toBe(false)
    expect(afk.config.level).toBe('L1')
    expect(afk.config.maxParallel).toBe(5)
  })

  // ── F-b：storeWriter.markFailedSync 的 shutdown 写点——last_error/cause 同写（真落盘）──
  it('storeWriter.markFailedSync：中断标 failed + last_error=reason + cause 同写空串（中断非 tag 类，覆盖旧残留，读取端 regex 兜）', async () => {
    const dir = await initBuild('x')
    // 预置上一轮残留 cause——验证同写覆盖（防「消息换了、成因还是旧的」撕裂）
    await store.setMany(dir, { automation: 'running', automation_cause: 'timeout', automation_last_error: 'agent idle timeout' })
    const writer = storeWriter(store, (name) => join(root, 'openspec', 'changes', name))
    writer.markFailedSync('x', 'scheduler interrupted')
    // fire-and-forget（void promise）：轮询等真落盘
    for (let i = 0; i < 100 && (await store.get(dir, 'automation')) !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(await store.get(dir, 'automation')).toBe('failed')
    expect(await store.get(dir, 'automation_last_error')).toBe('scheduler interrupted')
    expect(await store.get(dir, 'automation_cause')).toBe('')
  })
})
